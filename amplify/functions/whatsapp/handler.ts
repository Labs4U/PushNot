import { DynamoDBClient, QueryCommand, UpdateItemCommand } from "@aws-sdk/client-dynamodb";

const ddb = new DynamoDBClient({});

// =====================================================================
// META WEBHOOK VERIFICATION & INBOUND MESSAGE HANDLER
// =====================================================================
// This Lambda handles:
// 1. Webhook verification (GET requests from Meta)
// 2. Inbound message updates (POST from Meta)
// 3. Query PushNotSystem via GSI1 (wamid) to find member record
// 4. Update delivery/payment status in real-time
// =====================================================================

export const handler = async (event: any) => {
  console.log("Received webhook event:", JSON.stringify(event));
  
  const tableName = process.env.TABLE_NAME!;
  const verifyToken = process.env.META_VERIFY_TOKEN;

  // ===== 1. WEBHOOK VERIFICATION (GET) =====
  if (event.requestContext?.http?.method === 'GET') {
    const mode = event.queryStringParameters?.['hub.mode'];
    const token = event.queryStringParameters?.['hub.verify_token'];
    const challenge = event.queryStringParameters?.['hub.challenge'];

    if (mode === 'subscribe' && token === verifyToken) {
      console.log('Webhook verified successfully');
      return {
        statusCode: 200,
        body: challenge,
      };
    } else {
      console.warn('Webhook verification failed');
      return { statusCode: 403, body: 'Forbidden' };
    }
  }

  // ===== 2. INBOUND MESSAGE HANDLING (POST) =====
  if (event.requestContext?.http?.method === 'POST') {
    try {
      const body = JSON.parse(event.body || '{}');
      const entry = body.entry?.[0];
      const change = entry?.changes?.[0];
      const value = change?.value;

      // 2a. Handle inbound messages
      if (value?.messages?.[0]) {
        const message = value.messages[0];
        const wamid = message.id; // WhatsApp Message ID (unique identifier)
        const senderPhone = message.from; // Sender's phone number
        const inboundText = message.text?.body || '';

        console.log(`Inbound message from ${senderPhone}: ${inboundText}`);

        // 2b. Query GSI1 to find the member record by WAMID
        const queryCmd = new QueryCommand({
          TableName: tableName,
          IndexName: 'gsi1pk-gsi1sk-index', // GSI1 index (wamid-based)
          KeyConditionExpression: 'gsi1pk = :wamid',
          ExpressionAttributeValues: {
            ':wamid': { S: wamid },
          },
        });

        const queryResult = await ddb.send(queryCmd);

        if (queryResult.Items && queryResult.Items.length > 0) {
          const memberRecord = queryResult.Items[0];
          const pk = memberRecord.pk.S; // Campaign Run ID
          const sk = memberRecord.sk.S; // Member record SK

          // 2c. Update the member record with inbound reply text
          const updateCmd = new UpdateItemCommand({
            TableName: tableName,
            Key: {
              pk: { S: pk },
              sk: { S: sk },
            },
            UpdateExpression: 'SET inboundReplyText = :text, deliveryStatus = :status, updatedAt = :now',
            ExpressionAttributeValues: {
              ':text': { S: inboundText },
              ':status': { S: 'READ' },
              ':now': { S: new Date().toISOString() },
            },
          } as any);

          await ddb.send(updateCmd);
          console.log(`Updated member record: pk=${pk}, sk=${sk}`);
        } else {
          console.warn(`No member record found for WAMID: ${wamid}`);
        }
      }

      // 2d. Handle status updates (delivery, read receipts)
      if (value?.statuses?.[0]) {
        const status = value.statuses[0];
        const wamid = status.id; // WhatsApp Message ID
        const deliveryStatus = status.status; // 'sent', 'delivered', 'read', 'failed'

        console.log(`Status update for WAMID ${wamid}: ${deliveryStatus}`);

        // Query GSI1 to find the member record
        const queryCmd = new QueryCommand({
          TableName: tableName,
          IndexName: 'gsi1pk-gsi1sk-index',
          KeyConditionExpression: 'gsi1pk = :wamid',
          ExpressionAttributeValues: {
            ':wamid': { S: wamid },
          },
        });

        const queryResult = await ddb.send(queryCmd);

        if (queryResult.Items && queryResult.Items.length > 0) {
          const memberRecord = queryResult.Items[0];
          const pk = memberRecord.pk.S;
          const sk = memberRecord.sk.S;

          // Map Meta status to delivery status
          const deliveryStatusMap: { [key: string]: string } = {
            'sent': 'SENT',
            'delivered': 'DELIVERED',
            'read': 'READ',
            'failed': 'FAILED',
          };

          const mappedStatus = deliveryStatusMap[deliveryStatus] || 'UNKNOWN';

          // Update the member record
          const updateCmd = new UpdateItemCommand({
            TableName: tableName,
            Key: {
              pk: { S: pk },
              sk: { S: sk },
            },
            UpdateExpression: 'SET deliveryStatus = :status, updatedAt = :now',
            ExpressionAttributeValues: {
              ':status': { S: mappedStatus },
              ':now': { S: new Date().toISOString() },
            },
          } as any);

          await ddb.send(updateCmd);
          console.log(`Updated delivery status: pk=${pk}, sk=${sk}, status=${mappedStatus}`);
        }
      }

      // 2e. Handle payment confirmations (example: webhook from payment provider)
      if (value?.payment_status) {
        // Placeholder for payment status updates
        console.log('Payment status received:', value.payment_status);
      }

      return {
        statusCode: 200,
        body: JSON.stringify({ success: true }),
      };
    } catch (error: any) {
      console.error('Error processing webhook:', error);
      return {
        statusCode: 500,
        body: JSON.stringify({ error: error.message }),
      };
    }
  }

  return {
    statusCode: 400,
    body: 'Invalid request',
  };
};
