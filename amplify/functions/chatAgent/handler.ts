/**
 * chatAgent Lambda
 *
 * Triggered by: InboundChatQueue (SQS)
 * Purpose:      AI-powered conversational agent for member inquiries.
 *
 * Architecture:
 *   1. S3-injection RAG  — fetches ASSOC#<tenantId>/mission.txt from S3 and
 *      injects the raw text into the Bedrock system prompt (no vector DB needed).
 *   2. Long-term memory  — queries GSI2 (ByMemberHistory) to build a campaign
 *      participation summary for the member.
 *   3. Short-term memory — fetches the last 10 CHAT_LOG records for this
 *      member + campaign to maintain conversational context.
 *   4. Bedrock invocation — Amazon Nova Lite via ConverseCommand with a tool definition
 *      for admin escalation.
 *   5. Tool execution     — if the model calls flag_for_admin, updates the ledger
 *      record with requiresAdminAction=true and inquirySummary=<summary>.
 *   6. Chat persistence   — writes both the user message and AI reply as
 *      CHAT_LOG records back to DynamoDB.
 *   7. WhatsApp reply     — sends the AI response via Meta Cloud API.
 *
 * DynamoDB key patterns:
 *   Chat log sk:    CHAT#<campIdRaw>#<phone>#<timestamp>
 *   Ledger sk:      CAMPRUN#<campIdRaw>#MEM#<phone>#<timestamp>
 *   Member profile: MEM#<phone>
 */

import {
  DynamoDBClient,
  QueryCommand,
  PutItemCommand,
  UpdateItemCommand,
} from "@aws-sdk/client-dynamodb";
import {
  S3Client,
  GetObjectCommand,
} from "@aws-sdk/client-s3";
import {
  BedrockRuntimeClient,
  ConverseCommand,
} from "@aws-sdk/client-bedrock-runtime";

const ddb      = new DynamoDBClient({});
const s3       = new S3Client({});
const bedrock  = new BedrockRuntimeClient({ region: process.env.AWS_REGION ?? "us-east-1" });

const TABLE_NAME            = process.env.TABLE_NAME!;
const RAG_BUCKET            = process.env.RAG_BUCKET_NAME!;
const WHATSAPP_ACCESS_TOKEN = process.env.WHATSAPP_ACCESS_TOKEN!;
const WHATSAPP_PHONE_ID     = process.env.WHATSAPP_PHONE_ID!;

// Amazon Nova Lite via US cross-region inference profile.
// The 'us.' prefix routes requests to available US data centers automatically,
// avoiding availability errors when deployed outside primary US regions.
const BEDROCK_MODEL_ID = "us.amazon.nova-lite-v1:0";

// ── Types ─────────────────────────────────────────────────────────────────────
interface ChatMessage { role: "user" | "assistant"; content: string; }

// ─────────────────────────────────────────────────────────────────────────────

export const handler = async (event: any) => {
  const batchItemFailures: { itemIdentifier: string }[] = [];

  for (const record of event.Records) {
    try {
      const payload = JSON.parse(record.body);
      const {
        associationId,   // ASSOC#<tenantSub>
        senderPhone,     // e.g. "97333787388"
        messageText,     // the member's message
        contextWamid,    // WAMID of the original outbound message (may be undefined)
        campIdRaw,       // campaign ID without CAMP# prefix (may be undefined)
        isContrib = false, // true when the member tapped a contribution button
      } = payload;

      const now = new Date().toISOString();

      // ── 1. S3 RAG: fetch association knowledge document ─────────────────
      // Key format: ASSOC#<tenantSub>/mission.txt
      // If missing, proceed without it — agent still has DB memory.
      let ragContext = "";
      try {
        const s3Key = `${associationId}/mission.txt`;
        const s3Res = await s3.send(new GetObjectCommand({
          Bucket: RAG_BUCKET,
          Key: s3Key,
        }));
        ragContext = await s3Res.Body!.transformToString("utf-8");
        console.log(`✅ RAG: loaded ${ragContext.length} chars from s3://${RAG_BUCKET}/${s3Key}`);
      } catch (err: any) {
        if (err.name === "NoSuchKey" || err.Code === "NoSuchKey") {
          console.log("ℹ️ RAG: no knowledge document found — proceeding without it");
        } else {
          console.warn("⚠️ RAG: S3 error:", err.message);
        }
      }

      // ── 2. Long-term memory: member campaign history via GSI2 ───────────
      const gsi2pk = `${associationId}#MEM#${senderPhone}`;
      const historyRes = await ddb.send(new QueryCommand({
        TableName: TABLE_NAME,
        IndexName: "ByMemberHistory",
        KeyConditionExpression: "gsi2pk = :gsi2pk",
        ExpressionAttributeValues: { ":gsi2pk": { S: gsi2pk } },
        ScanIndexForward: false,
        Limit: 10,
      }));

      const campaignHistory = (historyRes.Items ?? []).map(item => ({
        campaign:      item.gsi2sk?.S ?? "Unknown",
        delivery:      item.deliveryStatus?.S ?? "—",
        payment:       item.paymentStatus?.S ?? "—",
        read:          item.isRead?.BOOL ?? false,
        replied:       item.hasReplied?.BOOL ?? false,
      }));

      const historyText = campaignHistory.length > 0
        ? campaignHistory.map(h =>
            `  • ${h.campaign}: delivery=${h.delivery}, payment=${h.payment}, read=${h.read}, replied=${h.replied}`
          ).join("\n")
        : "  No campaign history found.";

      // ── 3. Short-term memory: recent chat log ────────────────────────────
      // sk pattern: CHAT#<campIdRaw>#<phone>#<timestamp>
      // If campIdRaw is unknown, use a broad CHAT# prefix to get any history
      const chatSkPrefix = campIdRaw
        ? `CHAT#${campIdRaw}#${senderPhone}#`
        : `CHAT#`;

      const chatLogRes = await ddb.send(new QueryCommand({
        TableName: TABLE_NAME,
        KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)",
        ExpressionAttributeValues: {
          ":pk":     { S: associationId },
          ":prefix": { S: chatSkPrefix },
        },
        ScanIndexForward: false, // most recent first
        Limit: 10,
      }));

      // Reverse to get chronological order for the Bedrock messages array
      const chatHistory: ChatMessage[] = (chatLogRes.Items ?? [])
        .reverse()
        .map(item => ({
          role:    (item.name?.S ?? "user") as "user" | "assistant",
          content: item.description?.S ?? "",
        }))
        .filter(m => m.content);

      // ── 4. Build Bedrock payload ─────────────────────────────────────────
      const systemPrompt = [
        "You are a friendly, human-like assistant for a charitable association chatting on WhatsApp.",
        "CRITICAL INSTRUCTION: You MUST reply in the EXACT SAME LANGUAGE the user speaks in their latest message. If they speak Spanish, reply in Spanish. If they speak Arabic, reply in Arabic. Never switch languages.",
        "Keep responses highly conversational, short, and natural. Do not act like a robot.",
        "Do NOT output <thinking> or any XML/reasoning tags. Output only the final message text.",
        "If the user shares meaningful information or completes an interaction, use the update_chat_summary tool to save a concise 1-sentence summary of what they communicated.",
        "If a member says 'I Contribute', indicates they want to donate, or sends any contribution intent,",
        "reply warmly with a heartfelt thank you, e.g.: 'Thank you for your generosity and support! 🙏 A payment link will be shared with you shortly.'",
        "For general questions about goals, projects, or background, ground your answers strictly in the Association Knowledge section below. Do not invent details not found there.",
        "Use the flag_for_admin tool ONLY for complex disputes, sensitive inquiries, or custom admin requests that require a human.",
        isContrib
          ? "IMPORTANT: The member just tapped the contribution button — respond with a warm thank-you immediately."
          : "",
        "",
        ragContext ? `## Association Knowledge\n${ragContext}` : "",
        "",
        "## Member Campaign History",
        historyText,
      ].filter(Boolean).join("\n");

      // Append current message to history for the messages array
      const messages: ChatMessage[] = [
        ...chatHistory,
        { role: "user", content: messageText },
      ];

      // ── 5. Invoke Bedrock via ConverseCommand ────────────────────────────
      // ConverseCommand uses a different schema from InvokeModel:
      //   - system  → array of { text } objects
      //   - messages → content is array of { text } objects (not bare strings)
      //   - inferenceConfig.maxTokens (camelCase, not root-level max_tokens)
      //   - toolConfig uses toolSpec.inputSchema.json (not input_schema)
      //   - response lives at output.message.content[].text / .toolUse

      // Format messages for the Converse API
      const formattedMessages = messages.map(m => ({
        role:    m.role,
        content: [{ text: m.content }],
      }));

      const converseRes = await bedrock.send(new ConverseCommand({
        modelId: BEDROCK_MODEL_ID,
        system:  [{ text: systemPrompt }],
        messages: formattedMessages,
        inferenceConfig: {
          maxTokens: 512,
        },
        toolConfig: {
          tools: [
            {
              toolSpec: {
                name: "flag_for_admin",
                description: "Escalate this member's inquiry to a human admin. Use when the member has a complex issue that AI cannot resolve (e.g., payment dispute, complaint, special request).",
                inputSchema: {
                  json: {
                    type: "object",
                    properties: {
                      summary: {
                        type: "string",
                        description: "A concise 1-2 sentence summary of the member's issue for the admin.",
                      },
                    },
                    required: ["summary"],
                  },
                },
              },
            },
            // ── update_chat_summary tool ─────────────────────────────────────
            // Called by the model when the member shares meaningful information.
            // Writes a concise 1-sentence summary to the member's ledger record.
            {
              toolSpec: {
                name: "update_chat_summary",
                description: "Save a 1-sentence summary of the current conversation to the member's campaign record. Use when the member shares meaningful information or completes an interaction.",
                inputSchema: {
                  json: {
                    type: "object",
                    properties: {
                      summary: {
                        type: "string",
                        description: "A very brief summary of what the member asked or stated.",
                      },
                    },
                    required: ["summary"],
                  },
                },
              },
            },
          ],
        },
      }));

      // ── 6. Parse response and handle tool calls ───────────────────────────
      const responseContent = converseRes.output?.message?.content ?? [];
      let aiReplyText = "";
      let escalated   = false;

      for (const block of responseContent) {
        // Text block — the model's conversational reply
        if (block.text) {
          aiReplyText = block.text;
        }

        // Tool use block — model decided to escalate to admin
        if (block.toolUse && block.toolUse.name === "flag_for_admin") {
          const summary = (block.toolUse.input as any)?.summary ?? "Member requires follow-up.";
          escalated   = true;
          aiReplyText = aiReplyText || "Thank you for your message. A member of our team will follow up with you shortly.";

          // Find the member's most recent ledger record to attach the flag
          const ledgerRes = await ddb.send(new QueryCommand({
            TableName: TABLE_NAME,
            IndexName: "ByMemberHistory",
            KeyConditionExpression: "gsi2pk = :gsi2pk",
            ExpressionAttributeValues: { ":gsi2pk": { S: gsi2pk } },
            ScanIndexForward: false,
            Limit: 1,
          }));

          if (ledgerRes.Items?.length) {
            const { pk, sk } = ledgerRes.Items[0];
            await ddb.send(new UpdateItemCommand({
              TableName: TABLE_NAME,
              Key: { pk: { S: pk.S! }, sk: { S: sk.S! } },
              UpdateExpression: "SET requiresAdminAction = :flag, inquirySummary = :summary, updatedAt = :now",
              ExpressionAttributeValues: {
                ":flag":    { BOOL: true },
                ":summary": { S: summary },
                ":now":     { S: now },
              },
            }));
            console.log(`🚨 Admin flag set on ${sk.S}: "${summary}"`);
          }
        }

        // ── update_chat_summary tool execution ─────────────────────────────
        if (block.toolUse && block.toolUse.name === "update_chat_summary") {
          const summaryText = (block.toolUse.input as any)?.summary ?? "";
          if (summaryText) {
            const ledgerRes = await ddb.send(new QueryCommand({
              TableName: TABLE_NAME,
              IndexName: "ByMemberHistory",
              KeyConditionExpression: "gsi2pk = :gsi2pk",
              ExpressionAttributeValues: { ":gsi2pk": { S: gsi2pk } },
              ScanIndexForward: false,
              Limit: 1,
            }));

            if (ledgerRes.Items?.length) {
              const { pk, sk } = ledgerRes.Items[0];
              await ddb.send(new UpdateItemCommand({
                TableName: TABLE_NAME,
                Key: { pk: { S: pk.S! }, sk: { S: sk.S! } },
                UpdateExpression: "SET inquirySummary = :summary, updatedAt = :now",
                ExpressionAttributeValues: {
                  ":summary": { S: summaryText },
                  ":now":     { S: now },
                },
              }));
              console.log(`📝 Chat summary saved on ${sk.S}: "${summaryText}"`);
            }
          }
        }
      }

      // ── Sanitise: strip any <thinking>...</thinking> tags Nova Lite may emit.
      // The system prompt instructs the model not to output them, but we apply
      // this defence-in-depth regex to guarantee clean output before sending.
      aiReplyText = aiReplyText.replace(/<thinking>[\s\S]*?<\/thinking>/g, "").trim();

      if (!aiReplyText) {
        aiReplyText = "Thank you for your message. We will get back to you soon.";
      }

      // ── 7. Persist chat log ──────────────────────────────────────────────
      // User message
      const chatSkBase = `CHAT#${campIdRaw ?? "GENERAL"}#${senderPhone}`;
      await ddb.send(new PutItemCommand({
        TableName: TABLE_NAME,
        Item: {
          pk:         { S: associationId },
          sk:         { S: `${chatSkBase}#${Date.now()}U` },
          entityType: { S: "CHAT_LOG" },
          __typename: { S: "PushNotSystem" },
          name:       { S: "user" },         // role
          description:{ S: messageText },    // message text
          phone:      { S: senderPhone },
          createdAt:  { S: now },
          updatedAt:  { S: now },
        },
      }));

      // AI response
      await ddb.send(new PutItemCommand({
        TableName: TABLE_NAME,
        Item: {
          pk:         { S: associationId },
          sk:         { S: `${chatSkBase}#${Date.now()}A` },
          entityType: { S: "CHAT_LOG" },
          __typename: { S: "PushNotSystem" },
          name:       { S: "assistant" },    // role
          description:{ S: aiReplyText },    // AI response text
          phone:      { S: senderPhone },
          createdAt:  { S: now },
          updatedAt:  { S: now },
        },
      }));

      // ── 8. Chunk and send WhatsApp reply ────────────────────────────────
      // Splits the AI response into natural conversational chunks and sends
      // them sequentially with human-like typing delays.
      //
      // Algorithm:
      //   1. Split on sentence boundaries (.!?) or paragraph breaks.
      //   2. Merge consecutive short sentences into one chunk (≤ MAX_CHUNK_CHARS).
      //   3. Hard-break oversized sentences at word boundaries.
      //   4. Delay between chunks = BASE_DELAY + prevChunkLength * TYPING_MS_PER_CHAR.
      //   5. context.message_id (thread anchor) only on the FIRST chunk so
      //      follow-on messages appear as natural continuations, not quoted replies.
      const MAX_CHUNK_CHARS    = 120;
      const BASE_DELAY_MS      = 600;
      const TYPING_MS_PER_CHAR = 28; // ~35 chars/sec — natural WhatsApp pace

      function splitIntoChunks(text: string): string[] {
        const sentences = text
          .split(/(?<=[.!?]) +|\n\n+/)
          .map((s: string) => s.trim())
          .filter(Boolean);

        const chunks: string[] = [];
        for (const sentence of sentences) {
          if (sentence.length <= MAX_CHUNK_CHARS) {
            const last = chunks[chunks.length - 1];
            if (last && (last.length + 1 + sentence.length) <= MAX_CHUNK_CHARS) {
              chunks[chunks.length - 1] = last + " " + sentence;
            } else {
              chunks.push(sentence);
            }
          } else {
            let remaining = sentence;
            while (remaining.length > MAX_CHUNK_CHARS) {
              const cutAt = remaining.lastIndexOf(" ", MAX_CHUNK_CHARS);
              const breakAt = cutAt > 0 ? cutAt : MAX_CHUNK_CHARS;
              chunks.push(remaining.slice(0, breakAt).trim());
              remaining = remaining.slice(breakAt).trim();
            }
            if (remaining) chunks.push(remaining);
          }
        }
        return chunks.length > 0 ? chunks : [text];
      }

      const chunks = splitIntoChunks(aiReplyText);
      const delay  = (ms: number) => new Promise<void>(res => setTimeout(res, ms));

      for (let i = 0; i < chunks.length; i++) {
        if (i > 0) {
          await delay(BASE_DELAY_MS + chunks[i - 1].length * TYPING_MS_PER_CHAR);
        }

        const chunkPayload = {
          messaging_product: "whatsapp",
          recipient_type:    "individual",
          to:                senderPhone,
          type:              "text",
          text:              { body: chunks[i] },
          ...(i === 0 && contextWamid ? { context: { message_id: contextWamid } } : {}),
        };

        const chunkRes = await fetch(
          `https://graph.facebook.com/v20.0/${WHATSAPP_PHONE_ID}/messages`,
          {
            method: "POST",
            headers: {
              Authorization: `Bearer ${WHATSAPP_ACCESS_TOKEN}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify(chunkPayload),
          }
        );

        if (!chunkRes.ok) {
          const err = await chunkRes.json();
          console.error(`❌ WhatsApp chunk ${i + 1}/${chunks.length} failed:`, err);
          break; // abort remaining chunks to avoid partial delivery
        }
        console.log(`✅ Chunk ${i + 1}/${chunks.length} sent to ${senderPhone}`);
      }

      if (escalated) console.log(`🚨 Conversation escalated to admin for ${senderPhone}`);

    } catch (err: any) {
      console.error(`❌ chatAgent failed for record ${record.messageId}:`, err.message);
      batchItemFailures.push({ itemIdentifier: record.messageId });
    }
  }

  return { batchItemFailures };
};
