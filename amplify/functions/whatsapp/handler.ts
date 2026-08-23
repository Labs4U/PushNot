// import { DynamoDBClient, QueryCommand, UpdateItemCommand } from "@aws-sdk/client-dynamodb";

// const ddb = new DynamoDBClient({});
// const TABLE_NAME = process.env.TABLE_NAME!;
// const META_VERIFY_TOKEN = process.env.META_VERIFY_TOKEN;

// export const handler = async (event: any) => {
//   const httpMethod = event.requestContext?.http?.method || event.httpMethod;

//   // 1. WEBHOOK VERIFICATION (GET)
//   if (httpMethod === "GET") {
//     const queryParams = event.queryStringParameters || {};
//     if (queryParams["hub.mode"] === "subscribe" && queryParams["hub.verify_token"] === META_VERIFY_TOKEN) {
//       return { statusCode: 200, headers: { "Content-Type": "text/plain" }, body: queryParams["hub.challenge"] };
//     }
//     return { statusCode: 403, body: "Forbidden" };
//   }

//   // 2. INBOUND PROCESSING (POST)
//   if (httpMethod === "POST") {
//     try {
//       const body = JSON.parse(event.body || "{}");
//       if (body.object === "whatsapp_business_account" && Array.isArray(body.entry)) {
//         for (const entry of body.entry) {
//           for (const change of entry.changes || []) {
//             const value = change.value;
            
//             if (value?.messages?.length > 0) {
//               for (const message of value.messages) await handleInboundMessage(message);
//             }
//             if (value?.statuses?.length > 0) {
//               for (const status of value.statuses) await handleDeliveryStatus(status);
//             }
//           }
//         }
//       }
//       return { statusCode: 200, body: JSON.stringify({ success: true }) };
//     } catch (error: any) {
//       console.error("Webhook processing error:", error);
//       return { statusCode: 500, body: JSON.stringify({ error: error.message }) };
//     }
//   }
//   return { statusCode: 400, body: "Invalid method" };
// };

// // =====================================================================
// // HELPER: Resolve Record & Update Inbound Reply (Text & Buttons)
// // =====================================================================
// async function handleInboundMessage(message: any) {
//   const targetWamid = message.context?.id; 
//   if (!targetWamid) return; 

//   let inboundText = "";
//   let isInteractiveButton = false;
//   let buttonPayload = "";

//   if (message.type === "interactive" && message.interactive?.type === "button_reply") {
//     isInteractiveButton = true;
//     buttonPayload = message.interactive.button_reply.id; 
//     inboundText = message.interactive.button_reply.title;
//   } else {
//     inboundText = message.text?.body || "NON_TEXT_REPLY";
//   }

//   const queryRes = await ddb.send(new QueryCommand({
//     TableName: TABLE_NAME,
//     IndexName: "ByStatusOrWamid",
//     KeyConditionExpression: "gsi1pk = :wamid",
//     ExpressionAttributeValues: { ":wamid": { S: `MSG#${targetWamid}` } },
//   }));

//   if (!queryRes.Items || queryRes.Items.length === 0) return;

//   const { pk, sk } = queryRes.Items[0];
//   if (!pk?.S || !sk?.S) return;

//   let updateExp = "SET inboundReplyText = :text, deliveryStatus = :status, hasReplied = :hasReplied, updatedAt = :now";
//   let expValues: any = {
//     ":text": { S: String(inboundText) },
//     ":status": { S: "REPLIED" },
//     ":hasReplied": { BOOL: true }, 
//     ":now": { S: new Date().toISOString() },
//   };

//   if (isInteractiveButton && buttonPayload.includes("CONTRIBUTE")) {
//     updateExp += ", paymentStatus = :payStatus";
//     expValues[":payStatus"] = { S: "LINK_SENT" };
//     console.log(`Payment triggered for ${message.from}. Send Payment URL now!`);
//   }

//   await ddb.send(new UpdateItemCommand({
//     TableName: TABLE_NAME,
//     Key: { pk: pk, sk: sk },
//     UpdateExpression: updateExp,
//     ExpressionAttributeValues: expValues,
//   }));
// }

// // =====================================================================
// // HELPER: Resolve Record & Update Status Receipts (Sent, Delivered, Read)
// // =====================================================================
// async function handleDeliveryStatus(statusObj: any) {
//   const mappedStatus = (statusObj.status || "sent").toUpperCase();

//   // 🚨 TRAP FOR FAILED MESSAGES
//   if (mappedStatus === "FAILED") {
//     console.log("🚨 META DELIVERY FAILED. Error Details:", JSON.stringify(statusObj.errors || statusObj, null, 2));
//   }

//   const queryRes = await ddb.send(new QueryCommand({
//     TableName: TABLE_NAME,
//     IndexName: "ByStatusOrWamid",
//     KeyConditionExpression: "gsi1pk = :wamid",
//     ExpressionAttributeValues: { ":wamid": { S: `MSG#${statusObj.id}` } },
//   }));

//   if (!queryRes.Items || queryRes.Items.length === 0) return;

//   const { pk, sk } = queryRes.Items[0];

//   let updateExp = "SET deliveryStatus = :status, updatedAt = :now";
//   let expValues: any = {
//     ":status": { S: mappedStatus },
//     ":now": { S: new Date().toISOString() },
//   };

//   // Only update isRead if the status is actually read, preventing it from flipping back to false
//   if (mappedStatus === "READ") {
//     updateExp += ", isRead = :isRead";
//     expValues[":isRead"] = { BOOL: true };
//   }

//   await ddb.send(new UpdateItemCommand({
//     TableName: TABLE_NAME,
//     Key: { pk: pk, sk: sk },
//     UpdateExpression: updateExp,
//     ExpressionAttributeValues: expValues,
//   }));
// }
import { DynamoDBClient, QueryCommand, UpdateItemCommand } from "@aws-sdk/client-dynamodb";

const ddb = new DynamoDBClient({});
const TABLE_NAME = process.env.TABLE_NAME!;
const META_VERIFY_TOKEN = process.env.META_VERIFY_TOKEN;

export const handler = async (event: any) => {
  const httpMethod = event.requestContext?.http?.method || event.httpMethod;

  if (httpMethod === "GET") {
    const queryParams = event.queryStringParameters || {};
    if (queryParams["hub.mode"] === "subscribe" && queryParams["hub.verify_token"] === META_VERIFY_TOKEN) {
      return { statusCode: 200, headers: { "Content-Type": "text/plain" }, body: queryParams["hub.challenge"] };
    }
    return { statusCode: 403, body: "Forbidden" };
  }

  if (httpMethod === "POST") {
    try {
      const body = JSON.parse(event.body || "{}");
      
      // 🟢 TRACER 1: Let's see the exact raw JSON Meta is sending us
      console.log("📥 RAW META PAYLOAD:", JSON.stringify(body, null, 2));

      if (body.object === "whatsapp_business_account" && Array.isArray(body.entry)) {
        for (const entry of body.entry) {
          for (const change of entry.changes || []) {
            const value = change.value;
            
            if (value?.messages?.length > 0) {
              console.log("💬 INBOUND MESSAGE DETECTED");
              for (const message of value.messages) await handleInboundMessage(message);
            }
            if (value?.statuses?.length > 0) {
              console.log("📊 STATUS UPDATE DETECTED");
              for (const status of value.statuses) await handleDeliveryStatus(status);
            }
          }
        }
      }
      return { statusCode: 200, body: JSON.stringify({ success: true }) };
    } catch (error: any) {
      console.error("❌ FATAL WEBHOOK ERROR:", error.message);
      return { statusCode: 500, body: JSON.stringify({ error: error.message }) };
    }
  }
  return { statusCode: 400, body: "Invalid method" };
};

// =====================================================================
// HELPER: Resolve Record & Update Inbound Reply (Text & Buttons)
// =====================================================================
async function handleInboundMessage(message: any) {
  const targetWamid = message.context?.id; 
  if (!targetWamid) {
    console.log("⚠️ No context.id found. This is not a reply to a campaign.");
    return;
  }

  console.log(`🔍 Seeking Original WAMID for Reply: MSG#${targetWamid}`);

  let inboundText = "";
  let isInteractiveButton = false;
  let buttonPayload = "";

  if (message.type === "interactive" && message.interactive?.type === "button_reply") {
    isInteractiveButton = true;
    buttonPayload = message.interactive.button_reply.id; 
    inboundText = message.interactive.button_reply.title;
    console.log(`🔘 Button Clicked: ${inboundText} (Payload: ${buttonPayload})`);
  }

  const queryRes = await ddb.send(new QueryCommand({
    TableName: TABLE_NAME,
    IndexName: "ByStatusOrWamid",
    KeyConditionExpression: "gsi1pk = :wamid",
    ExpressionAttributeValues: { ":wamid": { S: `MSG#${targetWamid}` } },
  }));

  if (!queryRes.Items || queryRes.Items.length === 0) {
    console.log(`❌ GSI QUERY FAILED: Could not find ledger record for MSG#${targetWamid}`);
    return;
  }

  const { pk, sk } = queryRes.Items[0];
  console.log(`✅ Found Record for Reply - PK: ${pk.S} | SK: ${sk.S}`);

  let updateExp = "SET inboundReplyText = :text, deliveryStatus = :status, hasReplied = :hasReplied, updatedAt = :now";
  let expValues: any = {
    ":text": { S: String(inboundText) },
    ":status": { S: "REPLIED" },
    ":hasReplied": { BOOL: true }, 
    ":now": { S: new Date().toISOString() },
  };

  if (isInteractiveButton && buttonPayload.includes("CONTRIBUTE")) {
    updateExp += ", paymentStatus = :payStatus";
    expValues[":payStatus"] = { S: "LINK_SENT" };
    console.log(`💸 Contribution Triggered! Updating paymentStatus to LINK_SENT`);
  }

  try {
    await ddb.send(new UpdateItemCommand({
      TableName: TABLE_NAME,
      Key: { pk: pk, sk: sk },
      UpdateExpression: updateExp,
      ExpressionAttributeValues: expValues,
    }));
    console.log("💾 DB Reply Update Successful!");
  } catch (err: any) {
    console.error("❌ DB Reply Update Failed:", err.message);
  }
}

// =====================================================================
// HELPER: Resolve Record & Update Status Receipts (Sent, Delivered, Read)
// =====================================================================
async function handleDeliveryStatus(statusObj: any) {
  const mappedStatus = (statusObj.status || "sent").toUpperCase();
  console.log(`📡 Processing Status: ${mappedStatus} for WAMID: ${statusObj.id}`);

  const queryRes = await ddb.send(new QueryCommand({
    TableName: TABLE_NAME,
    IndexName: "ByStatusOrWamid",
    KeyConditionExpression: "gsi1pk = :wamid",
    ExpressionAttributeValues: { ":wamid": { S: `MSG#${statusObj.id}` } },
  }));

  if (!queryRes.Items || queryRes.Items.length === 0) {
    console.log(`❌ GSI QUERY FAILED: Could not find ledger record for MSG#${statusObj.id}`);
    return;
  }

  const { pk, sk } = queryRes.Items[0];
  console.log(`✅ Found Record for Status Update - PK: ${pk.S} | SK: ${sk.S}`);

  let updateExp = "SET deliveryStatus = :status, updatedAt = :now";
  let expValues: any = {
    ":status": { S: mappedStatus },
    ":now": { S: new Date().toISOString() },
  };

  if (mappedStatus === "READ") {
    updateExp += ", isRead = :isRead";
    expValues[":isRead"] = { BOOL: true };
    console.log("👀 Status is READ, appending isRead = true");
  }

  try {
    await ddb.send(new UpdateItemCommand({
      TableName: TABLE_NAME,
      Key: { pk: pk, sk: sk },
      UpdateExpression: updateExp,
      ExpressionAttributeValues: expValues,
    }));
    console.log(`💾 DB Status Update (${mappedStatus}) Successful!`);
  } catch (err: any) {
    console.error(`❌ DB Status Update Failed:`, err.message);
  }
}
