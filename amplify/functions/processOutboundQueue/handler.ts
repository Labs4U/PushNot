import { DynamoDBClient, UpdateItemCommand } from "@aws-sdk/client-dynamodb";

const ddb = new DynamoDBClient({});
const TABLE_NAME = process.env.TABLE_NAME!;
const WHATSAPP_ACCESS_TOKEN = process.env.WHATSAPP_ACCESS_TOKEN!;
const WHATSAPP_PHONE_ID = process.env.WHATSAPP_PHONE_ID!; 

export const handler = async (event: any) => {
  const batchItemFailures: { itemIdentifier: string }[] = [];

  for (const record of event.Records) {
    const messageId = record.messageId;
    
    try {
      const payload = JSON.parse(record.body);
      const { associationId, campaignRunId, recipientPhone, recipientName, templateName, campaignMessage, associationName, templateLanguage } = payload;      
      const cleanTemplateName = (templateName || "campaign_msg").trim();
      const cleanLanguageCode = (templateLanguage || "en").trim(); // Default to "en" if missing

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
              parameters: [
                { type: "text", text: associationName || "Association" } 
              ]
            },
            {
              type: "body",
              parameters: [
                { type: "text", text: recipientName || "Member" }, 
                { type: "text", text: campaignMessage || "Please support our cause." }            
              ]
            },
            {
              type: "button",
              sub_type: "quick_reply",
              index: "0", 
              parameters: [
                { type: "payload", payload: `ACTION_CONTRIBUTE_${campaignRunId}` } 
              ]
            }
          ]
        }
      };

      const metaUrl = `https://graph.facebook.com/v20.0/${WHATSAPP_PHONE_ID}/messages`;
      
      const metaResponse = await fetch(metaUrl, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${WHATSAPP_ACCESS_TOKEN}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(metaPayload),
      });

      const metaData = await metaResponse.json();

      if (!metaResponse.ok) {
        throw new Error(`Meta API rejected request: ${metaData.error?.message}`);
      }

      const wamid = metaData.messages?.[0]?.id;

      // --- THE ARCHITECTURE UPDATES ---
      // 1. Isolate the Ledger Record with "RUN#"
      const runSk = `RUN#${campaignRunId}#${recipientPhone}`; 
      // 2. Set up the Member History Pivot Index
      const gsi2pk = `${associationId}#MEM#${recipientPhone}`; 

      await ddb.send(
        new UpdateItemCommand({
          TableName: TABLE_NAME,
          Key: {
            pk: { S: associationId },
            sk: { S: runSk },
          },
          // 🟢 FIX 1: Added gsi1sk = :gsi1sk to the UpdateExpression
          UpdateExpression: "SET entityType = :type, whatsappMessageId = :wamid, gsi1pk = :gsi1pk, gsi1sk = :gsi1sk, gsi2pk = :gsi2pk, gsi2sk = :gsi2sk, deliveryStatus = :status, isRead = :isRead, hasPaid = :hasPaid, hasReplied = :hasReplied, paymentStatus = :payStatus, updatedAt = :now",
          ExpressionAttributeValues: {
            ":type": { S: "CAMPAIGN_RUN" },
            ":wamid": { S: wamid },
            ":gsi1pk": { S: `MSG#${wamid}` }, 
            
            // 🟢 FIX 2: Added a dummy value for the Sort Key so DynamoDB indexes it!
            ":gsi1sk": { S: "WEBHOOK" }, 
            
            ":gsi2pk": { S: gsi2pk },
            ":gsi2sk": { S: campaignRunId },
            ":status": { S: "SENT" },
            ":isRead": { BOOL: false },
            ":hasPaid": { BOOL: false },
            ":hasReplied": { BOOL: false },
            ":payStatus": { S: "PENDING" },
            ":now": { S: new Date().toISOString() },
          },
        })
      );
      
    } catch (error: any) {
      console.error(`Failed to process SQS record ${messageId}:`, error.message);
      batchItemFailures.push({ itemIdentifier: messageId });
    }
  }

  return { batchItemFailures };
};