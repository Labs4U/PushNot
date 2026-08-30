import { DynamoDBClient, UpdateItemCommand } from "@aws-sdk/client-dynamodb";

const ddb = new DynamoDBClient({});
const TABLE_NAME          = process.env.TABLE_NAME!;
const WHATSAPP_ACCESS_TOKEN = process.env.WHATSAPP_ACCESS_TOKEN!;
const WHATSAPP_PHONE_ID     = process.env.WHATSAPP_PHONE_ID!;

export const handler = async (event: any) => {
  const batchItemFailures: { itemIdentifier: string }[] = [];

  for (const record of event.Records) {
    const messageId = record.messageId;

    try {
      const payload = JSON.parse(record.body);

      // All key values are pre-computed by dispatchBroadcast — no re-derivation needed.
      const {
        associationId,
        ledgerSk,        // CAMPRUN#<campIdRaw>#MEM#<phone>#<timestamp>
        gsi2pk,          // ASSOC#<tenantId>#MEM#<phone>
        gsi2sk,          // CAMP#<campIdRaw>
        campId,          // CAMP#<campIdRaw>
        recipientPhone,
        recipientName,
        templateName,
        campaignMessage,
        associationName,
        // templateLanguage intentionally omitted — language is derived from templateName
      } = payload;

      const cleanTemplateName = (templateName || "campaign_msg").trim();

      // Derive the language code from the template name so the payload is always
      // consistent — even if the caller omits templateLanguage or passes a stale value.
      //
      // Convention used in the Meta Business dashboard:
      //   campaign_msg      → registered under "en"  (English)
      //   campaign_msg_ar   → registered under "ar"  (Arabic)
      //
      // Rule: if the template name ends with "_ar", use "ar"; otherwise use "en".
      // Extend this map as new language variants are added to the Meta dashboard.
      const TEMPLATE_LANGUAGE_MAP: Record<string, string> = {
        campaign_msg:    "en",
        campaign_msg_ar: "ar",
      };
      const cleanLanguageCode: string =
        TEMPLATE_LANGUAGE_MAP[cleanTemplateName]          // exact match wins
        ?? (cleanTemplateName.endsWith("_ar") ? "ar" : "en"); // suffix fallback

      // ── Send WhatsApp message via Meta Cloud API ──────────────────────────
      const metaPayload = {
        messaging_product: "whatsapp",
        recipient_type: "individual",
        to: recipientPhone,
        type: "template",
        template: {
          name: cleanTemplateName,
          language: { code: cleanLanguageCode },
          components: [
            {
              type: "header",
              parameters: [{ type: "text", text: associationName || "Association" }],
            },
            {
              type: "body",
              parameters: [
                { type: "text", text: recipientName   || "Member" },
                { type: "text", text: campaignMessage || "Please support our cause." },
              ],
            },
            {
              type: "button",
              sub_type: "quick_reply",
              index: "0",
              parameters: [
                // Button payload carries the base campaign ID for webhook routing
                // Payload carries associationId so the webhook can resolve the tenant
                // Format: ACTION_CONTRIBUTE_<associationId>_CAMP#<id>
                { type: "payload", payload: `ACTION_CONTRIBUTE_${associationId}_${campId}` },
              ],
            },
          ],
        },
      };

      const metaResponse = await fetch(
        `https://graph.facebook.com/v20.0/${WHATSAPP_PHONE_ID}/messages`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${WHATSAPP_ACCESS_TOKEN}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(metaPayload),
        }
      );

      const metaData: any = await metaResponse.json();
      if (!metaResponse.ok) {
        throw new Error(`Meta API error: ${metaData.error?.message}`);
      }

      const wamid = metaData.messages?.[0]?.id;

      // ── Write the per-member ledger record ────────────────────────────────
      // Key format (per spec):
      //   pk     = associationId                              (ASSOC#<sub>)
      //   sk     = ledgerSk = CAMPRUN#<campIdRaw>#MEM#<phone>#<timestamp>
      //   gsi1pk = MSG#<wamid>       → webhook lookup by message ID
      //   gsi1sk = "WEBHOOK"
      //   gsi2pk = ASSOC#<tenantId>#MEM#<phone>  → member history lookup
      //   gsi2sk = CAMP#<campIdRaw>              → campaign participation
      await ddb.send(new UpdateItemCommand({
        TableName: TABLE_NAME,
        Key: {
          pk: { S: associationId },
          sk: { S: ledgerSk },
        },
        UpdateExpression: [
          "SET entityType        = :type",
          "    #tn               = :typename",
          "    whatsappMessageId = :wamid",
          "    gsi1pk            = :gsi1pk",
          "    gsi1sk            = :gsi1sk",
          "    gsi2pk            = :gsi2pk",
          "    gsi2sk            = :gsi2sk",
          "    deliveryStatus    = :status",
          "    isRead            = :false",
          "    hasPaid           = :false",
          "    hasReplied        = :false",
          "    paymentStatus     = :payStatus",
          "    updatedAt         = :now",
          // Amplify Gen 2 declares createdAt as non-nullable in AppSync schema.
          // UpdateItem never auto-sets it — use if_not_exists so the first write
          // sets it and subsequent status updates (delivered/read) preserve it.
          "    createdAt         = if_not_exists(createdAt, :now)",
        ].join(", "),
        ExpressionAttributeNames: {
          "#tn": "__typename",
        },
        ExpressionAttributeValues: {
          ":type":     { S: "CAMPAIGN_LEDGER" },
          ":typename": { S: "PushNotSystem" },
          ":wamid":    { S: wamid },
          ":gsi1pk":   { S: `MSG#${wamid}` },
          ":gsi1sk":   { S: "WEBHOOK" },
          ":gsi2pk":   { S: gsi2pk },
          ":gsi2sk":   { S: gsi2sk },
          ":status":   { S: "SENT" },
          ":false":    { BOOL: false },
          ":payStatus":{ S: "PENDING" },
          ":now":      { S: new Date().toISOString() },
        },
      }));

      // ── Increment the member's campaign counter ───────────────────────────
      await ddb.send(new UpdateItemCommand({
        TableName: TABLE_NAME,
        Key: {
          pk: { S: associationId },
          sk: { S: `MEM#${recipientPhone}` },
        },
        UpdateExpression: "ADD totalCampaignsReceived :inc",
        ExpressionAttributeValues: { ":inc": { N: "1" } },
      }));

    } catch (err: any) {
      console.error(`Failed to process SQS record ${messageId}:`, err.message);
      batchItemFailures.push({ itemIdentifier: messageId });
    }
  }

  return { batchItemFailures };
};
