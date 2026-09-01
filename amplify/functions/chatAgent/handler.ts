/**
 * chatAgent Lambda
 *
 * Triggered by: InboundChatQueue (SQS)
 * Purpose:      AI conversational agent with rolling JSON state memory.
 *
 * Architecture:
 *   1. S3 RAG (concurrent)  — global mission.txt + campaign_info.txt
 *   2. Rolling state memory — reads chatAnalysis JSON from the CAMPRUN ledger
 *      record via ByMemberHistory GSI2 (replaces granular CHAT_LOG entities)
 *   3. Bedrock ConverseCommand — Amazon Nova Lite cross-region inference
 *   4. record_chat_analysis tool — writes cumulative summary + sentiment back
 *      to chatAnalysis on the same CAMPRUN ledger record
 *   5. Chunked WhatsApp delivery — \n\n split with 1500ms inter-chunk delay
 *
 * Memory model:
 *   chatAnalysis (JSON stored on CAMPRUN ledger):
 *     { summary: string, sentiment: string, lastInteraction: ISO string }
 *   Replaces granular CHAT_LOG DynamoDB records.
 */

import {
  DynamoDBClient,
  QueryCommand,
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

const ddb     = new DynamoDBClient({});
const s3      = new S3Client({});
const bedrock = new BedrockRuntimeClient({ region: process.env.AWS_REGION ?? "us-east-1" });

const TABLE_NAME            = process.env.TABLE_NAME!;
const RAG_BUCKET            = process.env.RAG_BUCKET_NAME!;
const WHATSAPP_ACCESS_TOKEN = process.env.WHATSAPP_ACCESS_TOKEN!;
const WHATSAPP_PHONE_ID     = process.env.WHATSAPP_PHONE_ID!;

// Cross-region inference profile — routes to available US data centers
const BEDROCK_MODEL_ID = "us.amazon.nova-lite-v1:0";

// ── Utilities ─────────────────────────────────────────────────────────────────
const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

// ─────────────────────────────────────────────────────────────────────────────

export const handler = async (event: any) => {
  const batchItemFailures: { itemIdentifier: string }[] = [];

  for (const record of event.Records) {
    try {
      const payload = JSON.parse(record.body);
      const {
        associationId,
        senderPhone,
        messageText,
        contextWamid,
        campIdRaw,
        isContrib = false,
      } = payload;

      const now    = new Date().toISOString();
      const gsi2pk = `${associationId}#MEM#${senderPhone}`;

      // ── 1. Concurrent S3 RAG fetch ──────────────────────────────────────
      // global: ASSOC#<sub>/mission.txt
      // campaign: ASSOC#<sub>/CAMP#<id>/campaign_info.txt
      const missionKey  = `${associationId}/mission.txt`;
      const campaignKey = campIdRaw
        ? `${associationId}/CAMP#${campIdRaw}/campaign_info.txt`
        : null;

      const [missionResult, campaignResult] = await Promise.allSettled([
        s3.send(new GetObjectCommand({ Bucket: RAG_BUCKET, Key: missionKey })),
        campaignKey
          ? s3.send(new GetObjectCommand({ Bucket: RAG_BUCKET, Key: campaignKey }))
          : Promise.reject(new Error("NoSuchKey")),
      ]);

      let ragContext      = "";
      let campaignContext = "";

      if (missionResult.status === "fulfilled") {
        ragContext = await (missionResult.value as any).Body!.transformToString("utf-8");
        console.log(`✅ RAG global: ${ragContext.length} chars`);
      } else if ((missionResult.reason?.name ?? missionResult.reason?.message) !== "NoSuchKey") {
        console.warn("⚠️ RAG global error:", missionResult.reason?.message);
      }

      if (campaignResult.status === "fulfilled") {
        campaignContext = await (campaignResult.value as any).Body!.transformToString("utf-8");
        console.log(`✅ RAG campaign: ${campaignContext.length} chars`);
      }
      // campaign NoSuchKey is expected — silent

      // ── 2. Rolling state memory — read chatAnalysis from CAMPRUN ledger ──
      // Queries ByMemberHistory (GSI2) with ScanIndexForward: false to get
      // the most recent ledger record for this member.
      // The chatAnalysis field holds a compact JSON summary of all past turns,
      // replacing the granular CHAT_LOG DynamoDB records.
      const ledgerQuery = await ddb.send(new QueryCommand({
        TableName: TABLE_NAME,
        IndexName: "ByMemberHistory",
        KeyConditionExpression: "gsi2pk = :gsi2pk",
        ExpressionAttributeValues: { ":gsi2pk": { S: gsi2pk } },
        ScanIndexForward: false,
        Limit: 1,
      }));

      let previousSummaryContext = "No previous interaction history recorded.";
      let targetLedgerKey: { pk: string; sk: string } | null = null;

      if (ledgerQuery.Items?.length) {
        const item = ledgerQuery.Items[0];
        targetLedgerKey = { pk: item.pk.S!, sk: item.sk.S! };

        if (item.chatAnalysis?.S) {
          try {
            const parsed = JSON.parse(item.chatAnalysis.S);
            previousSummaryContext =
              `Previous Summary: ${parsed.summary} (Overall Sentiment: ${parsed.sentiment})`;
          } catch {
            // If chatAnalysis is not valid JSON, use it as raw text
            previousSummaryContext = item.chatAnalysis.S;
          }
        } else if (item.inquirySummary?.S) {
          // Fallback: use legacy inquirySummary if chatAnalysis not yet written
          previousSummaryContext = `Previous Note: ${item.inquirySummary.S}`;
        }
      }

      // ── 3. System prompt ─────────────────────────────────────────────────
      const systemPrompt = [
        "You are a friendly, human-like assistant for a charitable association chatting on WhatsApp.",
        "CRITICAL LANGUAGE RULE: First, identify the language of the user's latest message. You MUST reply 100% in that exact language. If the user writes in Arabic, reply in Arabic. If they write in Spanish, reply in Spanish. NEVER reply in a language different from the user's last message. Translate any facts from Association Knowledge into the user's language.",
        "TRANSLATION IMPERATIVE: If the Association Knowledge below is in a different language than the user's, internally translate the relevant facts before replying. Never copy-paste text in the wrong language.",
        "EXTREME CONCISENESS: This is WhatsApp. Limit EVERY reply to 1–2 short sentences maximum.",
        "NO INFO-DUMPING: Give a 1-sentence answer and end with one natural follow-up question.",
        "Do NOT output <thinking> or any XML/reasoning tags. Output only the final reply text.",
        "ALWAYS call the record_chat_analysis tool to update the cumulative summary and sentiment after every reply.",
        isContrib
          ? "IMPORTANT: The member just tapped 'I Contribute' — reply with a warm thank-you immediately. E.g.: 'Thank you for your generosity! 🙏 A payment link will be shared with you shortly.'"
          : "If the member indicates a contribution intent, reply warmly and mention the payment link.",
        "For questions about goals, campaigns, or the association, ground answers strictly in the Association Knowledge below.",
        "Use the flag_for_admin tool ONLY for complex disputes, sensitive complaints, or requests requiring human intervention.",
        "",
        ragContext      ? `## Global Association Context\n${ragContext}`   : "",
        campaignContext ? `## Specific Campaign Context\n${campaignContext}` : "",
        "",
        `## Conversation Context So Far\n${previousSummaryContext}`,
      ].filter(Boolean).join("\n");

      // ── 4. Invoke Bedrock ────────────────────────────────────────────────
      const converseRes = await bedrock.send(new ConverseCommand({
        modelId:  BEDROCK_MODEL_ID,
        system:   [{ text: systemPrompt }],
        messages: [{ role: "user", content: [{ text: messageText }] }],
        inferenceConfig: { maxTokens: 256 }, // 1-2 sentences needs far less than 512
        toolConfig: {
          tools: [
            // ── Primary tool: rolling sentiment + summary ──────────────────
            // Always called — maintains the chatAnalysis JSON state on the ledger.
            {
              toolSpec: {
                name: "record_chat_analysis",
                description: "Record the cumulative summary and the member's overall emotional sentiment trajectory. ALWAYS call this after every response.",
                inputSchema: {
                  json: {
                    type: "object",
                    properties: {
                      summary: {
                        type: "string",
                        description: "A 1-2 sentence cumulative summary capturing intent and questions across the dialogue.",
                      },
                      sentiment: {
                        type: "string",
                        enum: ["POSITIVE", "NEUTRAL", "NEGATIVE", "FRUSTRATED"],
                        description: "The member's overall emotional sentiment trajectory.",
                      },
                    },
                    required: ["summary", "sentiment"],
                  },
                },
              },
            },
            // ── Escalation tool: complex issues requiring human follow-up ──
            {
              toolSpec: {
                name: "flag_for_admin",
                description: "Escalate to a human admin. Use ONLY for complex disputes, sensitive complaints, or requests that AI cannot resolve.",
                inputSchema: {
                  json: {
                    type: "object",
                    properties: {
                      summary: {
                        type: "string",
                        description: "1-2 sentence summary of the issue for the admin.",
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

      // ── 5. Parse response + execute tool calls ───────────────────────────
      const responseContent = converseRes.output?.message?.content ?? [];
      let aiReplyText = "";
      let escalated   = false;

      for (const block of responseContent) {
        if (block.text) {
          aiReplyText = block.text;
        }

        // ── record_chat_analysis ──────────────────────────────────────────
        if (block.toolUse?.name === "record_chat_analysis" && targetLedgerKey) {
          const { summary = "", sentiment = "NEUTRAL" } =
            (block.toolUse.input as any) ?? {};

          const analysisPayload = JSON.stringify({
            summary,
            sentiment,
            lastInteraction: now,
          });

          await ddb.send(new UpdateItemCommand({
            TableName: TABLE_NAME,
            Key: {
              pk: { S: targetLedgerKey.pk },
              sk: { S: targetLedgerKey.sk },
            },
            UpdateExpression:
              "SET chatAnalysis = :analysis, inquirySummary = :summary, updatedAt = :now",
            ExpressionAttributeValues: {
              ":analysis": { S: analysisPayload },
              ":summary":  { S: summary },
              ":now":      { S: now },
            },
          }));
          console.log(`📊 chatAnalysis updated (${sentiment}): "${summary.substring(0, 60)}…"`);
        }

        // ── flag_for_admin ────────────────────────────────────────────────
        if (block.toolUse?.name === "flag_for_admin") {
          const summary  = (block.toolUse.input as any)?.summary ?? "Member requires follow-up.";
          escalated      = true;
          aiReplyText    = aiReplyText || "Thank you for your message. A member of our team will follow up with you shortly.";

          // If no targetLedgerKey yet, look up the ledger now
          const ledgerTarget = targetLedgerKey ?? await (async () => {
            const res = await ddb.send(new QueryCommand({
              TableName: TABLE_NAME,
              IndexName: "ByMemberHistory",
              KeyConditionExpression: "gsi2pk = :gsi2pk",
              ExpressionAttributeValues: { ":gsi2pk": { S: gsi2pk } },
              ScanIndexForward: false,
              Limit: 1,
            }));
            if (!res.Items?.length) return null;
            return { pk: res.Items[0].pk.S!, sk: res.Items[0].sk.S! };
          })();

          if (ledgerTarget) {
            await ddb.send(new UpdateItemCommand({
              TableName: TABLE_NAME,
              Key: { pk: { S: ledgerTarget.pk }, sk: { S: ledgerTarget.sk } },
              UpdateExpression:
                "SET requiresAdminAction = :flag, inquirySummary = :summary, updatedAt = :now",
              ExpressionAttributeValues: {
                ":flag":    { BOOL: true },
                ":summary": { S: summary },
                ":now":     { S: now },
              },
            }));
            console.log(`🚨 Admin flag set on ${ledgerTarget.sk}: "${summary}"`);
          }
        }
      }

      // ── 6. Sanitise output ───────────────────────────────────────────────
      // Strip any <thinking>…</thinking> blocks Nova Lite may still emit,
      // then normalise whitespace.
      aiReplyText = aiReplyText
        .replace(/<thinking>[\s\S]*?<\/thinking>/g, "")
        .trim();

      if (!aiReplyText) {
        aiReplyText = "Thank you for your message. We will get back to you shortly.";
      }

      // ── 7. Chunked WhatsApp delivery ─────────────────────────────────────
      // Split on double newlines (\n\n) — the natural paragraph boundary Nova
      // Lite uses. Each chunk is sent sequentially with a 1500ms delay so the
      // conversation feels like a human typing multiple messages.
      // context.message_id (thread anchor) is set only on the first chunk.
      const messageChunks = aiReplyText
        .split(/\n\n+/)
        .map((c: string) => c.trim())
        .filter(Boolean);

      for (let i = 0; i < messageChunks.length; i++) {
        const chunkPayload = {
          messaging_product: "whatsapp",
          recipient_type:    "individual",
          to:                senderPhone,
          type:              "text",
          text:              { body: messageChunks[i] },
          ...(contextWamid && i === 0 ? { context: { message_id: contextWamid } } : {}),
        };

        const chunkRes = await fetch(
          `https://graph.facebook.com/v20.0/${WHATSAPP_PHONE_ID}/messages`,
          {
            method: "POST",
            headers: {
              Authorization:  `Bearer ${WHATSAPP_ACCESS_TOKEN}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify(chunkPayload),
          }
        );

        if (!chunkRes.ok) {
          const err = await chunkRes.json();
          console.error(`❌ WhatsApp chunk ${i + 1}/${messageChunks.length} failed:`, err);
          break;
        }
        console.log(`✅ Chunk ${i + 1}/${messageChunks.length} → ${senderPhone}`);

        if (i < messageChunks.length - 1) await sleep(1500);
      }

      if (escalated) console.log(`🚨 Escalated to admin for ${senderPhone}`);

    } catch (err: any) {
      console.error(`❌ chatAgent failed for record ${record.messageId}:`, err.message);
      batchItemFailures.push({ itemIdentifier: record.messageId });
    }
  }

  return { batchItemFailures };
};
