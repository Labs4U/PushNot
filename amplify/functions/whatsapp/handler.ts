/**
 * whatsappWebhook Lambda
 *
 * Handles three event types from Meta:
 *   A. Status receipts (delivered/read) → GSI1 lookup → update deliveryStatus in-place
 *   B. Inbound messages — normalised to a single payload then routed to InboundChatQueue.
 *
 * Tenant resolution priority (associationId):
 *   1. context.id (WAMID) → GSI1 lookup on ByStatusOrWamid — fastest, most precise
 *   2. ACTION_CONTRIBUTE_* button payload — embeds associationId explicitly
 *   3. metadata.display_phone_number → GSI1 query: gsi1pk = PHONE#<displayPhone>
 *      SettingsView sets gsi1pk on the ADMIN_PROFILE when the admin saves their phone.
 *      The index returns pk = ASSOC#<sub> — the associationId.
 *
 * Message type normalisation:
 *   "text"        → message.text.body
 *   "button"      → message.button.text  (quick-reply template button)
 *   "interactive" → message.interactive.button_reply.title
 */

import {
  DynamoDBClient,
  QueryCommand,
  UpdateItemCommand,
} from "@aws-sdk/client-dynamodb";
import {
  SQSClient,
  SendMessageCommand,
} from "@aws-sdk/client-sqs";

const ddb = new DynamoDBClient({});
const sqs = new SQSClient({});

const TABLE_NAME         = process.env.TABLE_NAME!;
const INBOUND_CHAT_QUEUE = process.env.INBOUND_CHAT_QUEUE_URL!;
const VERIFY_TOKEN       = process.env.META_VERIFY_TOKEN ?? "your_secure_verify_token";

// ── Helper: GSI1 WAMID lookup ─────────────────────────────────────────────────
async function resolveContextFromWamid(wamid: string) {
  const res = await ddb.send(new QueryCommand({
    TableName: TABLE_NAME,
    IndexName: "ByStatusOrWamid",
    KeyConditionExpression: "gsi1pk = :gsi1pk",
    ExpressionAttributeValues: { ":gsi1pk": { S: `MSG#${wamid}` } },
    Limit: 1,
  }));
  if (!res.Items?.length) return null;

  const item    = res.Items[0];
  const skParts = (item.sk?.S ?? "").split("#");
  return {
    pk:            item.pk?.S ?? "",
    sk:            item.sk?.S ?? "",
    associationId: item.pk?.S ?? "",
    campIdRaw:     skParts[1] ?? "",   // CAMPRUN#<campIdRaw>#MEM#<phone>#<ts>
  };
}

// ── Helper: display_phone_number → tenant lookup via GSI1 ───────────────────
// Queries ByStatusOrWamid with gsi1pk = PHONE#<displayPhone>.
// The ADMIN_PROFILE record has gsi1pk set to this value when the admin
// saves their WhatsApp business phone in the Settings tab.
// Meta sends display_phone_number WITHOUT the leading '+' — we use it as-is
// because the PROFILE record stores it without '+' too (matching Meta's format).
async function resolveAssocFromDisplayPhone(displayPhone: string): Promise<string | null> {
  if (!displayPhone) return null;

  // Construct the routing key exactly as stored on the ADMIN_PROFILE record
  const routingKey = `PHONE#${displayPhone}`;

  try {
    const queryRes = await ddb.send(new QueryCommand({
      TableName: TABLE_NAME,
      IndexName: "ByStatusOrWamid",
      KeyConditionExpression: "gsi1pk = :gsi1pk",
      ExpressionAttributeValues: { ":gsi1pk": { S: routingKey } },
      Limit: 1,
    }));

    if (queryRes.Items?.length) {
      const associationId = queryRes.Items[0].pk?.S ?? "";
      console.log(`📱 ${routingKey} → ${associationId}`);
      return associationId;
    }
  } catch (err: any) {
    console.warn(`⚠️ Phone→tenant lookup error for ${routingKey}:`, err.message);
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────

export const handler = async (event: any) => {
  console.log("🔥 WEBHOOK HIT:", event.body || event.queryStringParameters);

  // ── Meta webhook verification (GET) ──────────────────────────────────────
  if (event.requestContext?.http?.method === "GET") {
    const q = event.queryStringParameters || {};
    if (q["hub.mode"] === "subscribe" && q["hub.verify_token"] === VERIFY_TOKEN) {
      return { statusCode: 200, body: q["hub.challenge"] };
    }
    return { statusCode: 403, body: "Forbidden" };
  }

  try {
    const body  = JSON.parse(event.body);
    const value = body.entry?.[0]?.changes?.[0]?.value;

    // Extract display_phone_number for fallback tenant resolution
    // Meta sends this on every webhook event under value.metadata
    const displayPhone: string = value?.metadata?.display_phone_number ?? "";

    // ────────────────────────────────────────────────────────────────────────
    // A. Delivery / Read status receipts
    // ────────────────────────────────────────────────────────────────────────
    if (value?.statuses) {
      const statusEvent = value.statuses[0];
      const wamid       = statusEvent.id;
      const newStatus   = statusEvent.status;

      if (newStatus === "delivered" || newStatus === "read") {
        const found = await resolveContextFromWamid(wamid);
        if (found) {
          await ddb.send(new UpdateItemCommand({
            TableName: TABLE_NAME,
            Key: { pk: { S: found.pk }, sk: { S: found.sk } },
            UpdateExpression: "SET deliveryStatus = :status, isRead = :isRead, updatedAt = :now",
            ExpressionAttributeValues: {
              ":status": { S: newStatus === "read" ? "READ" : "DELIVERED" },
              ":isRead": { BOOL: newStatus === "read" },
              ":now":    { S: new Date().toISOString() },
            },
          }));
          console.log(`✅ Status updated: ${found.sk} → ${newStatus.toUpperCase()}`);
        }
      }
    }

    // ────────────────────────────────────────────────────────────────────────
    // B. Inbound messages
    // ────────────────────────────────────────────────────────────────────────
    if (value?.messages) {
      const msg         = value.messages[0];
      const senderPhone = msg.from;
      const msgType     = msg.type as string;
      const contextWamid: string | undefined = msg.context?.id;

      // ── 1. Normalise messageText ──────────────────────────────────────────
      let messageText = "";

      if (msgType === "text") {
        messageText = msg.text?.body ?? "";

      } else if (msgType === "button") {
        messageText = msg.button?.text ?? msg.button?.payload ?? "Button clicked";

      } else if (msgType === "interactive") {
        const ir = msg.interactive;
        if (ir?.type === "button_reply") {
          messageText = ir.button_reply?.title ?? ir.button_reply?.id ?? "Button reply";
        } else if (ir?.type === "list_reply") {
          messageText = ir.list_reply?.title ?? ir.list_reply?.id ?? "List reply";
        } else {
          messageText = "Interactive reply";
        }
      }

      if (!messageText) {
        console.warn(`⚠️ Empty messageText for type="${msgType}" from ${senderPhone} — skipping`);
        return { statusCode: 200, body: "OK" };
      }

      // ── 2. Detect contribution intent ─────────────────────────────────────
      const isContrib =
        (msgType === "button" && msg.button?.payload?.startsWith("ACTION_CONTRIBUTE_")) ||
        messageText.toLowerCase().includes("i contribute") ||
        messageText.toLowerCase().includes("أتبرع");

      // ── 3. Resolve associationId — three-tier cascade ─────────────────────
      //
      //  Tier 1 (most precise): context.id → GSI1 ByStatusOrWamid
      //    Identifies the exact campaign ledger record. Available on all direct
      //    replies to a specific outbound message.
      //
      //  Tier 2 (button fallback): ACTION_CONTRIBUTE_* payload embeds assocId.
      //    Used when context.id is absent on first-tap template buttons.
      //
      //  Tier 3 (display_phone_number): GSI1 query on ByStatusOrWamid.
      //    gsi1pk = PHONE#<displayPhone> is set on ADMIN_PROFILE by SettingsView.
      //    Covers all messages — unsolicited first-contact and no-context replies.
      //
      let associationId = "";
      let campIdRaw     = "";
      let ledgerPk      = "";
      let ledgerSk      = "";

      // Tier 1
      if (contextWamid) {
        const found = await resolveContextFromWamid(contextWamid);
        if (found) {
          associationId = found.associationId;
          campIdRaw     = found.campIdRaw;
          ledgerPk      = found.pk;
          ledgerSk      = found.sk;
          console.log(`🎯 Tier 1 resolved: ${associationId} via WAMID ${contextWamid}`);
        }
      }

      // Tier 2
      if (!associationId && msgType === "button" && msg.button?.payload?.startsWith("ACTION_CONTRIBUTE_")) {
        const raw = msg.button.payload.replace("ACTION_CONTRIBUTE_", "");
        if (raw.startsWith("ASSOC#")) {
          associationId = raw.split("_CAMP#")[0];
          campIdRaw     = raw.split("_CAMP#")[1] ?? "";
          console.log(`🎯 Tier 2 resolved: ${associationId} via button payload`);
        }
      }

      // Tier 3
      if (!associationId && displayPhone) {
        const fromPhone = await resolveAssocFromDisplayPhone(displayPhone);
        if (fromPhone) {
          associationId = fromPhone;
          console.log(`🎯 Tier 3 resolved: ${associationId} via display_phone_number ${displayPhone}`);
        }
      }

      if (!associationId) {
        console.warn(
          `⚠️ Cannot map Meta phone "${displayPhone}" to any active association profile. ` +
          `Ensure the WhatsApp business phone is saved in the Settings tab.`
        );
        return { statusCode: 200, body: "OK" };
      }

      // ── 4. Inline ledger update (if ledger record was found via Tier 1) ───
      if (ledgerPk && ledgerSk) {
        await ddb.send(new UpdateItemCommand({
          TableName: TABLE_NAME,
          Key: { pk: { S: ledgerPk }, sk: { S: ledgerSk } },
          UpdateExpression: [
            "SET hasReplied       = :true",
            "    inboundReplyText = :text",
            "    paymentStatus    = :payStatus",
            "    updatedAt        = :now",
          ].join(", "),
          ExpressionAttributeValues: {
            ":true":      { BOOL: true },
            ":text":      { S: messageText.substring(0, 500) },
            ":payStatus": { S: isContrib ? "INTENT_RECEIVED" : "PENDING" },
            ":now":       { S: new Date().toISOString() },
          },
        }));
        console.log(`✅ Ledger updated: ${ledgerSk} | contrib=${isContrib}`);
      }

      // Update member profile persona
      await ddb.send(new UpdateItemCommand({
        TableName: TABLE_NAME,
        Key: { pk: { S: associationId }, sk: { S: `MEM#${senderPhone}` } },
        UpdateExpression: "SET interactionPersona = :persona, updatedAt = :now",
        ExpressionAttributeValues: {
          ":persona": { S: isContrib ? "CONTRIBUTOR" : "ENGAGED" },
          ":now":     { S: new Date().toISOString() },
        },
      }));

      // ── 5. Enqueue to InboundChatQueue ────────────────────────────────────
      await sqs.send(new SendMessageCommand({
        QueueUrl:    INBOUND_CHAT_QUEUE,
        MessageBody: JSON.stringify({
          associationId,
          senderPhone,
          messageText,
          contextWamid:  contextWamid ?? null,
          campIdRaw:     campIdRaw || null,
          isContrib,
        }),
      }));

      console.log(`📩 [${msgType}] "${messageText.substring(0, 60)}" from ${senderPhone} → chatAgent`);
    }

    return { statusCode: 200, body: "OK" };

  } catch (err) {
    console.error("Webhook error:", err);
    return { statusCode: 500, body: "Internal Server Error" };
  }
};
