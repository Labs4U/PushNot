/**
 * chatAgent Lambda
 *
 * Triggered by: InboundChatQueue (SQS)
 * Purpose:      AI conversational agent with dual-source knowledge context.
 *
 * Context sources (injected into Bedrock system prompt):
 *   1. S3 global    — <associationId>/mission.txt (global association mission)
 *   2. DynamoDB     — CAMP#<id> record's aiKnowledgeContext attribute (campaign FAQs)
 *   3. Rolling mem  — chatAnalysis JSON on the CAMPRUN ledger (conversation history)
 *
 * Engagement tracking:
 *   - Sets hasReplied = true on the CAMPRUN ledger as soon as a ledger key is found
 *   - record_chat_analysis tool updates chatAnalysis + inquirySummary after Bedrock reply
 */

import {
  DynamoDBClient,
  GetItemCommand,
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
const RAG_BUCKET            = "push-notifications-bh";
const WHATSAPP_ACCESS_TOKEN = process.env.WHATSAPP_ACCESS_TOKEN!;
const WHATSAPP_PHONE_ID     = process.env.WHATSAPP_PHONE_ID!;

const BEDROCK_MODEL_ID = "us.amazon.nova-lite-v1:0";

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

// ── Safe S3 text fetch — returns "" on any error including NoSuchKey ──────────
async function fetchS3Text(key: string): Promise<string> {
  try {
    const res = await s3.send(new GetObjectCommand({ Bucket: RAG_BUCKET, Key: key }));
    const text = await (res.Body as any).transformToString("utf-8");
    console.log(`✅ S3 "${key}": ${text.length} chars`);
    return text;
  } catch (err: any) {
    const isNotFound = err.name === "NoSuchKey" || err.$metadata?.httpStatusCode === 404;
    if (!isNotFound) console.warn(`⚠️ S3 "${key}" error: ${err.message}`);
    return "";
  }
}

// ── Safe DynamoDB campaign fetch — returns aiKnowledgeContext or "" ───────────
async function fetchCampaignContext(associationId: string, campIdRaw: string | null): Promise<string> {
  if (!campIdRaw) return "";
  const campSk = campIdRaw.startsWith("CAMP#") ? campIdRaw : `CAMP#${campIdRaw}`;
  try {
    const res = await ddb.send(new GetItemCommand({
      TableName: TABLE_NAME,
      Key: { pk: { S: associationId }, sk: { S: campSk } },
    }));
    const ctx = res.Item?.aiKnowledgeContext?.S ?? "";
    if (ctx) console.log(`✅ DynamoDB campaign context "${campSk}": ${ctx.length} chars`);
    return ctx;
  } catch (err: any) {
    console.warn(`⚠️ Campaign DynamoDB fetch error for ${campSk}: ${err.message}`);
    return "";
  }
}

// ─────────────────────────────────────────────────────────────────────────────

export const handler = async (event: any) => {
  const batchItemFailures: { itemIdentifier: string }[] = [];

  for (const record of event.Records) {
    const messageId = record.messageId;
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

      // ── Strict payload validation ─────────────────────────────────────────
      if (!associationId || !senderPhone || !messageText) {
        console.error(
          `❌ [${messageId}] Missing required fields — ` +
          `associationId="${associationId}", senderPhone="${senderPhone}", ` +
          `messageText=${messageText ? "<present>" : "<empty>"}. ` +
          `Payload: ${JSON.stringify(payload)}`
        );
        continue; // bad payload — do not retry
      }

      // Normalise associationId — guarantee ASSOC# prefix for all DynamoDB keys
      const safeAssocId = associationId.startsWith("ASSOC#")
        ? associationId
        : `ASSOC#${associationId}`;

      const safeCampIdRaw = campIdRaw && String(campIdRaw).trim() || null;
      const gsi2pk        = `${safeAssocId}#MEM#${senderPhone}`;
      const now           = new Date().toISOString();

      console.log(
        `📱 [${messageId}] +${senderPhone} | tenant: ${safeAssocId} | camp: ${safeCampIdRaw ?? "none"}`
      );

      // ── 1. Dual-source context fetch (all three in parallel) ──────────────
      // Source A: S3 global mission text  →  ragContext
      // Source B: DynamoDB campaign FAQs  →  campaignContext
      // Source C: GSI2 ledger history     →  previousSummaryContext + targetLedgerKey
      const [
        missionText,
        campaignDbContext,
        ledgerResult,
      ] = await Promise.all([
        // A: Global association mission from S3
        fetchS3Text(`${safeAssocId}/mission.txt`),

        // B: Campaign-specific knowledge from DynamoDB campaign record
        fetchCampaignContext(safeAssocId, safeCampIdRaw),

        // C: Most recent CAMPRUN ledger record for rolling memory
        ddb.send(new QueryCommand({
          TableName: TABLE_NAME,
          IndexName: "ByMemberHistory",
          KeyConditionExpression: "gsi2pk = :gsi2pk",
          ExpressionAttributeValues: { ":gsi2pk": { S: gsi2pk } },
          ScanIndexForward: false,
          Limit: 1,
        })),
      ]);

      // Also try campaign_info.txt from S3 if a campId is available
      const s3CampaignText = safeCampIdRaw
        ? await fetchS3Text(`${safeAssocId}/CAMP#${safeCampIdRaw}/campaign_info.txt`)
        : "";

      // Merge DynamoDB + S3 campaign context — DynamoDB is primary, S3 is supplemental
      const campaignContext = [campaignDbContext, s3CampaignText].filter(Boolean).join("\n\n");

      // ── 2. Process ledger query result ────────────────────────────────────
      let previousSummaryContext = "No previous interaction history recorded.";
      let targetLedgerKey: { pk: string; sk: string } | null = null;

      if (ledgerResult.Items?.length) {
        const item = ledgerResult.Items[0];

        // Extract pk/sk with composite-key fallback for legacy records
        let derivedPk = item.pk?.S ?? "";
        let derivedSk = item.sk?.S ?? "";

        if (!derivedPk) {
          const rawGsi2pk = item.gsi2pk?.S ?? "";
          const memIndex  = rawGsi2pk.indexOf("#MEM#");
          if (memIndex > 0) {
            derivedPk = rawGsi2pk.slice(0, memIndex);
            console.log(`🔧 [${messageId}] pk derived from gsi2pk: "${derivedPk}"`);
          }
        }

        if (derivedPk && derivedSk) {
          targetLedgerKey = { pk: derivedPk, sk: derivedSk };

          // ── IMMEDIATE hasReplied flag ─────────────────────────────────────
          // Set synchronously before Bedrock invocation so the engagement
          // flag is true even if Bedrock or WhatsApp delivery fails later.
          await ddb.send(new UpdateItemCommand({
            TableName: TABLE_NAME,
            Key: { pk: { S: derivedPk }, sk: { S: derivedSk } },
            UpdateExpression: "SET hasReplied = :true, updatedAt = :now",
            ExpressionAttributeValues: {
              ":true": { BOOL: true },
              ":now":  { S: now },
            },
          }));
          console.log(`✅ [${messageId}] hasReplied = true set on ${derivedSk}`);

        } else if (derivedPk) {
          console.warn(`⚠️ [${messageId}] pk recovered but sk missing — hasReplied write skipped`);
        }

        // Load rolling conversation summary
        if (item.chatAnalysis?.S) {
          try {
            const parsed = JSON.parse(item.chatAnalysis.S);
            previousSummaryContext =
              `Previous Summary: ${parsed.summary} (Sentiment: ${parsed.sentiment})`;
          } catch {
            previousSummaryContext = item.chatAnalysis.S;
          }
        } else if (item.inquirySummary?.S) {
          previousSummaryContext = `Previous Note: ${item.inquirySummary.S}`;
        }
      }

      // ── 3. System prompt — dual-source knowledge injection ────────────────
      const systemPrompt = [
        "You are a friendly, human-like assistant for a charitable association chatting on WhatsApp.",
        "CRITICAL LANGUAGE RULE: Reply 100% in the exact language the user used. If Arabic, reply Arabic. If Spanish, reply Spanish. NEVER mix languages. Translate facts from the context below into the user's language.",
        "EXTREME CONCISENESS: 1–2 short sentences maximum per reply.",
        "NO INFO-DUMPING: One answer, one natural follow-up question.",
        "Do NOT output <thinking> or any XML/reasoning tags.",
        "ALWAYS call the record_chat_analysis tool after every reply.",
        isContrib
          ? "IMPORTANT: The member tapped 'I Contribute' — reply with a warm thank-you: 'Thank you for your generosity! 🙏 A payment link will be shared with you shortly.'"
          : "If the member indicates contribution intent, reply warmly and mention the payment link.",
        "Ground answers strictly in the knowledge sections below. Do not invent facts.",
        "Use flag_for_admin ONLY for complex disputes or requests requiring human intervention.",
        "",
        missionText    ? `## Global Association Context\n${missionText}`        : "",
        campaignContext ? `## Campaign-Specific Context & FAQs\n${campaignContext}` : "",
        "",
        `## Conversation Context So Far\n${previousSummaryContext}`,
      ].filter(Boolean).join("\n");

      // ── 4. Invoke Bedrock ─────────────────────────────────────────────────
      const converseRes = await bedrock.send(new ConverseCommand({
        modelId:  BEDROCK_MODEL_ID,
        system:   [{ text: systemPrompt }],
        messages: [{ role: "user", content: [{ text: messageText }] }],
        inferenceConfig: { maxTokens: 256 },
        toolConfig: {
          tools: [
            {
              toolSpec: {
                name: "record_chat_analysis",
                description: "Record cumulative conversation summary and member sentiment. ALWAYS call after every reply.",
                inputSchema: {
                  json: {
                    type: "object",
                    properties: {
                      summary:   { type: "string", description: "1-2 sentence cumulative summary of the dialogue." },
                      sentiment: { type: "string", enum: ["POSITIVE","NEUTRAL","NEGATIVE","FRUSTRATED"], description: "Member's emotional trajectory." },
                    },
                    required: ["summary", "sentiment"],
                  },
                },
              },
            },
            {
              toolSpec: {
                name: "flag_for_admin",
                description: "Escalate to a human admin. Use ONLY for complex disputes or requests AI cannot resolve.",
                inputSchema: {
                  json: {
                    type: "object",
                    properties: {
                      summary: { type: "string", description: "1-2 sentence summary for the admin." },
                    },
                    required: ["summary"],
                  },
                },
              },
            },
          ],
        },
      }));

      // ── 5. Parse response + execute tool calls ────────────────────────────
      const responseContent = converseRes.output?.message?.content ?? [];
      let aiReplyText = "";
      let escalated   = false;

      for (const block of responseContent) {
        if (block.text) aiReplyText = block.text;

        // ── record_chat_analysis ─────────────────────────────────────────
        if (block.toolUse?.name === "record_chat_analysis" && targetLedgerKey) {
          const { summary = "", sentiment = "NEUTRAL" } = (block.toolUse.input as any) ?? {};
          const analysisPayload = JSON.stringify({ summary, sentiment, lastInteraction: now });

          await ddb.send(new UpdateItemCommand({
            TableName: TABLE_NAME,
            Key: { pk: { S: targetLedgerKey.pk }, sk: { S: targetLedgerKey.sk } },
            UpdateExpression:
              "SET chatAnalysis = :analysis, inquirySummary = :summary, hasReplied = :replied, updatedAt = :now",
            ExpressionAttributeValues: {
              ":analysis": { S: analysisPayload },
              ":summary":  { S: summary },
              ":replied":  { BOOL: true },
              ":now":      { S: now },
            },
          }));
          console.log(`📊 [${messageId}] chatAnalysis updated (${sentiment}): "${summary.slice(0, 60)}…"`);
        }

        // ── flag_for_admin ───────────────────────────────────────────────
        if (block.toolUse?.name === "flag_for_admin") {
          const summary = (block.toolUse.input as any)?.summary ?? "Member requires follow-up.";
          escalated     = true;
          aiReplyText   = aiReplyText || "Thank you — a team member will follow up with you shortly.";

          // Resolve ledger target — use already-found key or re-query
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
            let fbPk = res.Items[0].pk?.S ?? "";
            const fbSk = res.Items[0].sk?.S ?? "";
            if (!fbPk) {
              const rg = res.Items[0].gsi2pk?.S ?? "";
              const mi = rg.indexOf("#MEM#");
              if (mi > 0) fbPk = rg.slice(0, mi);
            }
            return (fbPk && fbSk) ? { pk: fbPk, sk: fbSk } : null;
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
            console.log(`🚨 [${messageId}] Admin flag set: "${summary}"`);
          }
        }
      }

      // ── 6. Sanitise ───────────────────────────────────────────────────────
      aiReplyText = aiReplyText.replace(/<thinking>[\s\S]*?<\/thinking>/g, "").trim();
      if (!aiReplyText) aiReplyText = "Thank you for your message. We will get back to you shortly.";

      // ── 7. Chunked WhatsApp delivery ──────────────────────────────────────
      const chunks = aiReplyText.split(/\n\n+/).map(c => c.trim()).filter(Boolean);

      for (let i = 0; i < chunks.length; i++) {
        const chunkRes = await fetch(
          `https://graph.facebook.com/v20.0/${WHATSAPP_PHONE_ID}/messages`,
          {
            method: "POST",
            headers: {
              Authorization:  `Bearer ${WHATSAPP_ACCESS_TOKEN}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              messaging_product: "whatsapp",
              recipient_type:    "individual",
              to:                senderPhone,
              type:              "text",
              text:              { body: chunks[i] },
              ...(contextWamid && i === 0 ? { context: { message_id: contextWamid } } : {}),
            }),
          }
        );

        if (!chunkRes.ok) {
          const err = await chunkRes.json();
          console.error(`❌ [${messageId}] WhatsApp chunk ${i + 1}/${chunks.length} failed:`, err);
          break;
        }
        console.log(`✅ [${messageId}] Chunk ${i + 1}/${chunks.length} → +${senderPhone}`);
        if (i < chunks.length - 1) await sleep(1500);
      }

      if (escalated) console.log(`🚨 [${messageId}] Escalated for +${senderPhone}`);

    } catch (err: any) {
      console.error(`❌ chatAgent [${messageId}] failed: ${err.message}`);
      batchItemFailures.push({ itemIdentifier: messageId });
    }
  }

  return { batchItemFailures };
};
