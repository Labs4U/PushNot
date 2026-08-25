import { DynamoDBClient, QueryCommand, UpdateItemCommand } from "@aws-sdk/client-dynamodb";

const ddb = new DynamoDBClient({});
const TABLE_NAME = process.env.TABLE_NAME!;
const VERIFY_TOKEN = "your_secure_verify_token"; // Ensure this matches your Meta portal

export const handler = async (event: any) => {
  console.log("🔥 WEBHOOK HIT! Incoming Event:", event.body || event.queryStringParameters);

  // 1. Meta Webhook Verification
  if (event.requestContext?.http?.method === "GET") {
    const queryParams = event.queryStringParameters || {};
    if (queryParams['hub.mode'] === 'subscribe' && queryParams['hub.verify_token'] === VERIFY_TOKEN) {
      return { statusCode: 200, body: queryParams['hub.challenge'] };
    }
    return { statusCode: 403, body: "Forbidden" };
  }

  try {
    const body = JSON.parse(event.body);
    const value = body.entry?.[0]?.changes?.[0]?.value;
    const associationId = "ASSOC#101"; // Standardized tenant ID

    // --- A. Handle READ / DELIVERED Receipts ---
    if (value?.statuses) {
      const statusEvent = value.statuses[0];
      const wamid = statusEvent.id;
      const statusString = statusEvent.status; 

      if (statusString === "read") {
        const queryRes = await ddb.send(new QueryCommand({
          TableName: TABLE_NAME,
          IndexName: "ByStatusOrWamid", // 🟢 Updated to match your schema!
          KeyConditionExpression: "gsi1pk = :wamid",
          ExpressionAttributeValues: { ":wamid": { S: `MSG#${wamid}` } }
        }));

        if (queryRes.Items && queryRes.Items.length > 0) {
          const ledger = queryRes.Items[0];
          
          await ddb.send(new UpdateItemCommand({
            TableName: TABLE_NAME,
            Key: { pk: { S: associationId }, sk: { S: ledger.sk.S! } },
            UpdateExpression: "SET isRead = :true, deliveryStatus = :status",
            ExpressionAttributeValues: { ":true": { BOOL: true }, ":status": { S: "READ" } }
          }));
        }
      }
    }

    // --- B. Handle INBOUND REPLIES & BUTTON CLICKS ---
    if (value?.messages) {
      const inboundMsg = value.messages[0];
      const senderPhone = inboundMsg.from; // e.g., "97333787388"
      
      const isButton = inboundMsg.type === "button";
      const isText = inboundMsg.type === "text";
      const isContributionClick = isButton && inboundMsg.button?.payload?.startsWith("ACTION_CONTRIBUTE_");

      // 1. Update the Member's Global Profile
      await ddb.send(new UpdateItemCommand({
        TableName: TABLE_NAME,
        Key: { pk: { S: associationId }, sk: { S: `MEM#${senderPhone}` } },
        UpdateExpression: "SET interactionPersona = :persona, updatedAt = :now",
        ExpressionAttributeValues: {
          ":persona": { S: isContributionClick ? "CONTRIBUTOR" : "ENGAGED" },
          ":now": { S: new Date().toISOString() }
        }
      }));

      // 2. Find and update their latest Campaign Ledger
      const queryRes = await ddb.send(new QueryCommand({
        TableName: TABLE_NAME,
        IndexName: "ByMemberHistory", // 🟢 Updated to match your schema!
        KeyConditionExpression: "gsi2pk = :gsi2pk",
        ExpressionAttributeValues: { ":gsi2pk": { S: `${associationId}#MEM#${senderPhone}` } },
        ScanIndexForward: false, // Pulls the most recent ledger record first
        Limit: 1
      }));

      if (queryRes.Items && queryRes.Items.length > 0) {
        const latestLedgerSk = queryRes.Items[0].sk.S!;

        await ddb.send(new UpdateItemCommand({
          TableName: TABLE_NAME,
          Key: { pk: { S: associationId }, sk: { S: latestLedgerSk } },
          UpdateExpression: "SET hasReplied = :true, paymentStatus = :payStatus, inboundReplyText = :text",
          ExpressionAttributeValues: {
            ":true": { BOOL: true },
            ":payStatus": { S: isContributionClick ? "INTENT_RECEIVED" : "PENDING" },
            ":text": { S: isContributionClick ? "Clicked: I contribute" : (inboundMsg.text?.body || "Replied") }
          }
        }));
      }
    }

    return { statusCode: 200, body: "OK" };
  } catch (error) {
    console.error("Webhook Error:", error);
    return { statusCode: 500, body: "Internal Server Error" };
  }
};