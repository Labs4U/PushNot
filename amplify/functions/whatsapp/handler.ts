import { DynamoDBClient, QueryCommand, UpdateItemCommand } from "@aws-sdk/client-dynamodb";

const ddb = new DynamoDBClient({});
const TABLE_NAME = process.env.TABLE_NAME!;
const META_VERIFY_TOKEN = process.env.META_VERIFY_TOKEN;

// Status progression weights to prevent race conditions from out-of-order webhooks
const STATUS_WEIGHTS: Record<string, number> = {
  sent: 1,
  delivered: 2,
  read: 3,
  replied: 4,
  failed: 0,
};

export const handler = async (event: any) => {
  console.log("Received webhook event:", JSON.stringify(event));

  const httpMethod = event.requestContext?.http?.method || event.httpMethod;

  // =====================================================================
  // 1. META WEBHOOK VERIFICATION (GET)
  // =====================================================================
  if (httpMethod === "GET") {
    const queryParams = event.queryStringParameters || {};
    const mode = queryParams["hub.mode"];
    const token = queryParams["hub.verify_token"];
    const challenge = queryParams["hub.challenge"];

    if (mode === "subscribe" && token === META_VERIFY_TOKEN) {
      console.log("Webhook verified successfully");
      return {
        statusCode: 200,
        headers: { "Content-Type": "text/plain" },
        body: challenge,
      };
    } else {
      console.warn("Webhook verification failed: Token mismatch");
      return { statusCode: 403, body: "Forbidden" };
    }
  }

  // =====================================================================
  // 2. INBOUND WEBHOOK PROCESSING (POST)
  // =====================================================================
  if (httpMethod === "POST") {
    try {
      const body = JSON.parse(event.body || "{}");

      if (body.object === "whatsapp_business_account" && Array.isArray(body.entry)) {
        for (const entry of body.entry) {
          for (const change of entry.changes || []) {
            const value = change.value;

            // 2a. Process Inbound Messages / Customer Replies
            if (value?.messages && value.messages.length > 0) {
              for (const message of value.messages) {
                await handleInboundMessage(message);
              }
            }

            // 2b. Process Delivery & Read Status Receipts
            if (value?.statuses && value.statuses.length > 0) {
              for (const status of value.statuses) {
                await handleDeliveryStatus(status);
              }
            }
          }
        }
      }

      return {
        statusCode: 200,
        body: JSON.stringify({ success: true }),
      };
    } catch (error: any) {
      console.error("Error processing webhook:", error);
      return {
        statusCode: 500,
        body: JSON.stringify({ error: error.message }),
      };
    }
  }

  return {
    statusCode: 400,
    body: "Invalid request method",
  };
};

// =====================================================================
// HELPER: Resolve Record & Update Inbound Reply
// =====================================================================
async function handleInboundMessage(message: any) {
  // If the user is replying to a template message, context.id holds the original wamid
  const targetWamid = message.context?.id || message.id;
  const inboundText = message.text?.body || message.button?.text || "INTERACTIVE_REPLY";
  const now = new Date().toISOString();

  console.log(`Processing inbound reply for target WAMID: ${targetWamid}`);

  const queryRes = await ddb.send(new QueryCommand({
    TableName: TABLE_NAME,
    IndexName: "getByWhatsAppMessageId",
    KeyConditionExpression: "gsi1pk = :wamid",
    ExpressionAttributeValues: {
      ":wamid": { S: `MSG#${targetWamid}` },
    },
  }));

  if (!queryRes.Items || queryRes.Items.length === 0) {
    console.warn(`No record found matching GSI1: MSG#${targetWamid}`);
    return;
  }

  const item = queryRes.Items[0];
  const pk = item.pk?.S;
  const sk = item.sk?.S;

  if (!pk || !sk) {
    console.warn("Record found but missing primary keys.");
    return;
  }

  await ddb.send(new UpdateItemCommand({
    TableName: TABLE_NAME,
    Key: {
      pk: { S: pk },
      sk: { S: sk },
    },
    UpdateExpression: "SET inboundReplyText = :text, deliveryStatus = :status, statusWeight = :weight, updatedAt = :now",
    ExpressionAttributeValues: {
      ":text": { S: String(inboundText) },
      ":status": { S: "REPLIED" },
      ":weight": { N: String(STATUS_WEIGHTS["replied"]) },
      ":now": { S: now },
    },
  }));

  console.log(`Updated inbound reply for pk=${pk}, sk=${sk}`);
}

// =====================================================================
// HELPER: Resolve Record & Update Status Receipts
// =====================================================================
async function handleDeliveryStatus(statusObj: any) {
  const wamid = statusObj.id;
  const rawStatus = statusObj.status?.toLowerCase() || "sent";
  const mappedStatus = rawStatus.toUpperCase();
  const weight = STATUS_WEIGHTS[rawStatus] ?? 0;
  const now = new Date().toISOString();

  console.log(`Processing status receipt: ${mappedStatus} for WAMID: ${wamid}`);

  const queryRes = await ddb.send(new QueryCommand({
    TableName: TABLE_NAME,
    IndexName: "getByWhatsAppMessageId",
    KeyConditionExpression: "gsi1pk = :wamid",
    ExpressionAttributeValues: {
      ":wamid": { S: `MSG#${wamid}` },
    },
  }));

  if (!queryRes.Items || queryRes.Items.length === 0) {
    console.warn(`No record found matching GSI1: MSG#${wamid}`);
    return;
  }

  const item = queryRes.Items[0];
  const pk = item.pk?.S;
  const sk = item.sk?.S;

  if (!pk || !sk) return;

  try {
    // ConditionExpression prevents a delayed 'DELIVERED' webhook from overriding 'READ' or 'REPLIED'
    await ddb.send(new UpdateItemCommand({
      TableName: TABLE_NAME,
      Key: {
        pk: { S: pk },
        sk: { S: sk },
      },
      UpdateExpression: "SET deliveryStatus = :status, statusWeight = :weight, updatedAt = :now",
      ConditionExpression: "attribute_not_exists(statusWeight) OR statusWeight < :weight",
      ExpressionAttributeValues: {
        ":status": { S: mappedStatus },
        ":weight": { N: String(weight) },
        ":now": { S: now },
      },
    }));

    console.log(`Updated status to ${mappedStatus} for pk=${pk}, sk=${sk}`);
  } catch (err: any) {
    if (err.name === "ConditionalCheckFailedException") {
      console.log(`Ignored out-of-order status (${mappedStatus}) for pk=${pk}, sk=${sk}`);
      return;
    }
    throw err;
  }
}