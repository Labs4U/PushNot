import { DynamoDBClient, UpdateItemCommand } from "@aws-sdk/client-dynamodb";

const ddb = new DynamoDBClient({});

const TABLE_NAME            = process.env.TABLE_NAME!;
const WHATSAPP_ACCESS_TOKEN = process.env.WHATSAPP_ACCESS_TOKEN!;
const WHATSAPP_PHONE_ID     = process.env.WHATSAPP_PHONE_ID!;

export const handler = async (event: any) => {
  // ── Entry log ─────────────────────────────────────────────────────────────
  console.log(`🚨 processOutboundQueue invoked | records: ${event.Records?.length ?? 0}`);

  // ── Env-var check — catch misconfigured deployments immediately ───────────
  if (!TABLE_NAME || !WHATSAPP_ACCESS_TOKEN || !WHATSAPP_PHONE_ID) {
    console.error(
      `❌ FATAL: missing env vars — ` +
      `TABLE_NAME="${TABLE_NAME ? "set" : "MISSING"}" ` +
      `WHATSAPP_ACCESS_TOKEN="${WHATSAPP_ACCESS_TOKEN ? "set" : "MISSING"}" ` +
      `WHATSAPP_PHONE_ID="${WHATSAPP_PHONE_ID ? "set" : "MISSING"}"`
    );
    // Return all records as failures so SQS retries after the next deployment
    return {
      batchItemFailures: event.Records.map((r: any) => ({ itemIdentifier: r.messageId })),
    };
  }

  const batchItemFailures: { itemIdentifier: string }[] = [];

  for (const record of event.Records) {
    const messageId = record.messageId;
    console.log(`📦 Processing SQS record ${messageId}`);

    try {
      // ── Parse payload ──────────────────────────────────────────────────
      let payload: any;
      try {
        payload = JSON.parse(record.body);
      } catch (parseErr: any) {
        console.error(`❌ [${messageId}] JSON parse failed: ${parseErr.message} | body: ${record.body}`);
        batchItemFailures.push({ itemIdentifier: messageId });
        continue;
      }

      const {
        associationId,
        ledgerSk,
        gsi2pk,
        gsi2sk,
        campId,
        recipientPhone,
        recipientName,
        templateName,
        campaignMessage,
        associationName,
      } = payload;

      // ── Payload validation — every field used in a DynamoDB key must be defined ──
      const missing = [
        !associationId  && "associationId",
        !ledgerSk       && "ledgerSk",
        !gsi2pk         && "gsi2pk",
        !gsi2sk         && "gsi2sk",
        !campId         && "campId",
        !recipientPhone && "recipientPhone",
        !templateName   && "templateName",
      ].filter(Boolean);

      if (missing.length > 0) {
        console.error(
          `❌ [${messageId}] Missing payload fields: ${missing.join(", ")}. ` +
          `Full payload: ${JSON.stringify(payload)}`
        );
        // Bad payload — don't retry, it will never recover
        continue;
      }

      // Normalise associationId — guarantee ASSOC# prefix
      const safeAssocId = associationId.startsWith("ASSOC#")
        ? associationId
        : `ASSOC#${associationId}`;

      console.log(
        `📤 [${messageId}] Sending to +${recipientPhone} | ` +
        `tenant: ${safeAssocId} | campaign: ${campId} | template: ${templateName}`
      );

      // ── Language derivation from template name ──────────────────────────
      const cleanTemplateName = (templateName || "campaign_msg").trim();
      const TEMPLATE_LANGUAGE_MAP: Record<string, string> = {
        campaign_msg:    "en",
        campaign_msg_ar: "ar",
      };
      const cleanLanguageCode =
        TEMPLATE_LANGUAGE_MAP[cleanTemplateName]
        ?? (cleanTemplateName.endsWith("_ar") ? "ar" : "en");

      console.log(`🌐 [${messageId}] Template: "${cleanTemplateName}" → lang: "${cleanLanguageCode}"`);

      // ── Send WhatsApp template message ─────────────────────────────────
      const metaResponse = await fetch(
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
            to:                recipientPhone,
            type:              "template",
            template: {
              name:     cleanTemplateName,
              language: { code: cleanLanguageCode },
              components: [
                {
                  type:       "header",
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
                  type:     "button",
                  sub_type: "quick_reply",
                  index:    "0",
                  parameters: [
                    // Format: ACTION_CONTRIBUTE_<safeAssocId>_CAMP#<id>
                    // Embeds tenant ID so the webhook can resolve it on reply
                    { type: "payload", payload: `ACTION_CONTRIBUTE_${safeAssocId}_${campId}` },
                  ],
                },
              ],
            },
          }),
        }
      );

      const metaData: any = await metaResponse.json();

      if (!metaResponse.ok) {
        const errMsg = metaData.error?.message ?? JSON.stringify(metaData);
        console.error(
          `❌ [${messageId}] Meta API ${metaResponse.status} for +${recipientPhone}: ${errMsg}`
        );
        // 401 = token expired/invalid — push to failures so SQS retries after token rotation
        // 400 = bad template config — skip (retrying won't help)
        if (metaResponse.status === 401 || metaResponse.status === 429) {
          batchItemFailures.push({ itemIdentifier: messageId });
        }
        continue; // don't write a ledger record for a failed send
      }

      const wamid = metaData.messages?.[0]?.id;
      if (!wamid) {
        console.error(`❌ [${messageId}] Meta returned no wamid. Response: ${JSON.stringify(metaData)}`);
        batchItemFailures.push({ itemIdentifier: messageId });
        continue;
      }

      console.log(`✅ [${messageId}] WhatsApp sent → wamid: ${wamid}`);

      // ── Write CAMPRUN ledger record ─────────────────────────────────────
      await ddb.send(new UpdateItemCommand({
        TableName: TABLE_NAME,
        Key: {
          pk: { S: safeAssocId },
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
          // if_not_exists preserves original createdAt on status-update retries
          "    createdAt         = if_not_exists(createdAt, :now)",
        ].join(", "),
        ExpressionAttributeNames: { "#tn": "__typename" },
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

      console.log(`💾 [${messageId}] Ledger written: ${ledgerSk}`);

      // ── Increment member's campaign counter ─────────────────────────────
      await ddb.send(new UpdateItemCommand({
        TableName: TABLE_NAME,
        Key: {
          pk: { S: safeAssocId },
          sk: { S: `MEM#${recipientPhone}` },
        },
        UpdateExpression: "ADD totalCampaignsReceived :inc",
        ExpressionAttributeValues: { ":inc": { N: "1" } },
      }));

      console.log(`📊 [${messageId}] Counter incremented for +${recipientPhone}`);

    } catch (err: any) {
      console.error(`❌ [${messageId}] Unexpected error: ${err.message}`, err.stack ?? "");
      batchItemFailures.push({ itemIdentifier: messageId });
    }
  }

  console.log(
    `🏁 processOutboundQueue done | ` +
    `total: ${event.Records?.length ?? 0} | failures: ${batchItemFailures.length}`
  );

  return { batchItemFailures };
};
