import { DynamoDBClient, QueryCommand, UpdateItemCommand } from "@aws-sdk/client-dynamodb";

const ddb = new DynamoDBClient({});
const TABLE_NAME   = process.env.TABLE_NAME!;
// Injected via secret('META_VERIFY_TOKEN') in whatsapp/resource.ts
const VERIFY_TOKEN = process.env.META_VERIFY_TOKEN ?? "your_secure_verify_token";

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

    // ────────────────────────────────────────────────────────────────────────
    // A. Delivery / Read status receipts
    //
    // Meta sends: { statuses: [{ id: <wamid>, status: "delivered"|"read" }] }
    // Strategy:   GSI1 lookup by gsi1pk = MSG#<wamid>
    //             → extract pk/sk from result (never reconstruct sk manually)
    //             → update deliveryStatus + isRead
    // ────────────────────────────────────────────────────────────────────────
    if (value?.statuses) {
      const statusEvent = value.statuses[0];
      const wamid       = statusEvent.id;
      const newStatus   = statusEvent.status; // "sent" | "delivered" | "read"

      if (newStatus === "delivered" || newStatus === "read") {
        const queryRes = await ddb.send(new QueryCommand({
          TableName: TABLE_NAME,
          IndexName: "ByStatusOrWamid",
          KeyConditionExpression: "gsi1pk = :gsi1pk",
          ExpressionAttributeValues: { ":gsi1pk": { S: `MSG#${wamid}` } },
          Limit: 1,
        }));

        if (queryRes.Items?.length) {
          const { pk, sk } = queryRes.Items[0];
          await ddb.send(new UpdateItemCommand({
            TableName: TABLE_NAME,
            Key: { pk: { S: pk.S! }, sk: { S: sk.S! } },
            UpdateExpression: "SET deliveryStatus = :status, isRead = :isRead, updatedAt = :now",
            ExpressionAttributeValues: {
              ":status": { S: newStatus === "read" ? "READ" : "DELIVERED" },
              ":isRead": { BOOL: newStatus === "read" },
              ":now":    { S: new Date().toISOString() },
            },
          }));
          console.log(`✅ Status updated: ${sk.S} → ${newStatus.toUpperCase()}`);
        }
      }
    }

    // ────────────────────────────────────────────────────────────────────────
    // B. Inbound messages — button clicks AND free-text replies
    //
    // Meta sends: { messages: [{ from, type, context: { id: <wamid> }, ... }] }
    //
    // The critical field is inboundMsg.context.id — the WAMID of the ORIGINAL
    // outbound message the member is replying to. This uniquely identifies the
    // exact ledger record (pk + sk) without any sk reconstruction.
    //
    // Strategy:
    //   1. Extract context.id (reply-to WAMID)
    //   2. Query GSI1 (ByStatusOrWamid) with gsi1pk = MSG#<contextWamid>
    //   3. Extract pk + sk from result → update hasReplied, inboundReplyText
    //   4. Extract associationId from pk → update the member's global profile
    //
    // For button clicks: also extract associationId from the button payload
    // as a fallback if context.id is absent (first-tap before delivery receipt).
    // ────────────────────────────────────────────────────────────────────────
    if (value?.messages) {
      const inboundMsg  = value.messages[0];
      const senderPhone = inboundMsg.from;
      const msgType     = inboundMsg.type; // "button" | "text" | "interactive"

      const isButton  = msgType === "button";
      const isText    = msgType === "text";
      const isContrib = isButton && inboundMsg.button?.payload?.startsWith("ACTION_CONTRIBUTE_");
      const replyText = isButton
        ? (isContrib ? "Clicked: I contribute" : (inboundMsg.button?.text ?? "Button clicked"))
        : (inboundMsg.text?.body ?? "Replied");

      // ── Determine the original outbound WAMID ──────────────────────────
      // context.id is present on all replies to a specific message
      const contextWamid: string | undefined = inboundMsg.context?.id;

      // ── Path A: context.id available → GSI1 direct lookup ─────────────
      // This is always preferred — it identifies the exact ledger record.
      if (contextWamid) {
        const gsi1Res = await ddb.send(new QueryCommand({
          TableName: TABLE_NAME,
          IndexName: "ByStatusOrWamid",
          KeyConditionExpression: "gsi1pk = :gsi1pk",
          ExpressionAttributeValues: { ":gsi1pk": { S: `MSG#${contextWamid}` } },
          Limit: 1,
        }));

        if (gsi1Res.Items?.length) {
          const { pk, sk } = gsi1Res.Items[0];
          const associationId = pk.S!;

          // Update the specific ledger record — pk and sk extracted directly,
          // no manual sk reconstruction needed regardless of Option A format.
          await ddb.send(new UpdateItemCommand({
            TableName: TABLE_NAME,
            Key: { pk: { S: associationId }, sk: { S: sk.S! } },
            UpdateExpression: [
              "SET hasReplied       = :true",
              "    inboundReplyText = :text",
              "    paymentStatus    = :payStatus",
              "    updatedAt        = :now",
            ].join(", "),
            ExpressionAttributeValues: {
              ":true":      { BOOL: true },
              ":text":      { S: replyText },
              ":payStatus": { S: isContrib ? "INTENT_RECEIVED" : "PENDING" },
              ":now":       { S: new Date().toISOString() },
            },
          }));
          console.log(`✅ hasReplied set on ledger: ${sk.S}`);

          // Update the member's global profile persona
          await ddb.send(new UpdateItemCommand({
            TableName: TABLE_NAME,
            Key: { pk: { S: associationId }, sk: { S: `MEM#${senderPhone}` } },
            UpdateExpression: "SET interactionPersona = :persona, updatedAt = :now",
            ExpressionAttributeValues: {
              ":persona": { S: isContrib ? "CONTRIBUTOR" : "ENGAGED" },
              ":now":     { S: new Date().toISOString() },
            },
          }));
          console.log(`✅ Member profile updated: ${senderPhone} → ${isContrib ? "CONTRIBUTOR" : "ENGAGED"}`);

        } else {
          console.warn(`⚠️ No ledger found for context WAMID ${contextWamid} — message may be expired`);
        }

      // ── Path B: No context.id (unsolicited text / first-contact) ──────
      // Fall back to GSI2 to find the member's most recent ledger entry.
      // This is less precise — it updates the newest campaign regardless
      // of which one triggered the reply. Acceptable for unsolicited contact.
      } else if (isText) {
        // Extract associationId from button payload if this is a follow-up
        // to a button interaction (some clients omit context.id on text replies)
        let associationId = "";
        if (isContrib && inboundMsg.button?.payload) {
          const raw = inboundMsg.button.payload.replace("ACTION_CONTRIBUTE_", "");
          if (raw.startsWith("ASSOC#")) associationId = raw.split("_CAMP#")[0];
        }

        if (!associationId) {
          console.warn(`⚠️ Unsolicited text from ${senderPhone} — no context.id and no button payload. Cannot resolve tenant.`);
          return { statusCode: 200, body: "OK" };
        }

        const gsi2pk = `${associationId}#MEM#${senderPhone}`;
        const gsi2Res = await ddb.send(new QueryCommand({
          TableName: TABLE_NAME,
          IndexName: "ByMemberHistory",
          KeyConditionExpression: "gsi2pk = :gsi2pk",
          ExpressionAttributeValues: { ":gsi2pk": { S: gsi2pk } },
          ScanIndexForward: false,
          Limit: 1,
        }));

        if (gsi2Res.Items?.length) {
          const { pk, sk } = gsi2Res.Items[0];
          await ddb.send(new UpdateItemCommand({
            TableName: TABLE_NAME,
            Key: { pk: { S: pk.S! }, sk: { S: sk.S! } },
            UpdateExpression: [
              "SET hasReplied       = :true",
              "    inboundReplyText = :text",
              "    updatedAt        = :now",
            ].join(", "),
            ExpressionAttributeValues: {
              ":true": { BOOL: true },
              ":text": { S: replyText },
              ":now":  { S: new Date().toISOString() },
            },
          }));
          console.log(`✅ hasReplied set via GSI2 fallback: ${sk.S}`);
        }
      }
    }

    return { statusCode: 200, body: "OK" };

  } catch (err) {
    console.error("Webhook error:", err);
    return { statusCode: 500, body: "Internal Server Error" };
  }
};
