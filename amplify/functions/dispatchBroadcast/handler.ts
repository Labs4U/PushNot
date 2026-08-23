import { DynamoDBClient, QueryCommand, GetItemCommand } from "@aws-sdk/client-dynamodb";
import { SQSClient, SendMessageBatchCommand } from "@aws-sdk/client-sqs";

const ddb = new DynamoDBClient({});
const sqs = new SQSClient({});

const TABLE_NAME = process.env.TABLE_NAME!;
const QUEUE_URL = process.env.OUTBOUND_QUEUE_URL!;

export const handler = async (event: any) => {
  console.log("Triggered broadcast event arguments:", JSON.stringify(event.arguments));
  
  const { associationId, campaignRunId } = event.arguments; 

  if (!associationId || !campaignRunId) {
    throw new Error("Missing required arguments: associationId or campaignRunId");
  }

  try {
    // 1. Fetch the Campaign Record (to get the Message AND the Template Name!)
    const campRecord = await ddb.send(new GetItemCommand({
      TableName: TABLE_NAME,
      Key: { pk: { S: associationId }, sk: { S: campaignRunId } }
    }));
    const campaignMessage = campRecord.Item?.description?.S || "Please support our latest cause.";
    
    // 🟢 NEW: Pull the template name directly from the Campaign!
    const templateName = campRecord.Item?.templateName?.S || "campaign_msg"; 
    const templateLanguage = campRecord.Item?.templateLanguage?.S || "en"; 

    // 2. Fetch the Association Name
    const assocRecord = await ddb.send(new GetItemCommand({
      TableName: TABLE_NAME,
      Key: { pk: { S: associationId }, sk: { S: "META" } }
    }));
    const associationName = assocRecord.Item?.name?.S || "Community Association";

    let lastEvaluatedKey = undefined;
    const targetMembers: any[] = [];

    // 3. QUERY PushNotSystem FOR ALL RECIPIENTS
    do {
      const queryCmd: QueryCommand = new QueryCommand({
        TableName: TABLE_NAME,
        KeyConditionExpression: "pk = :pk AND begins_with(sk, :sk)",
        ExpressionAttributeValues: {
          ":pk": { S: associationId },
          ":sk": { S: "MEM#" },
        },
        ExclusiveStartKey: lastEvaluatedKey,
      });

      const response = await ddb.send(queryCmd);
      if (response.Items && response.Items.length > 0) {
        targetMembers.push(...response.Items);
      }
      lastEvaluatedKey = response.LastEvaluatedKey;
    } while (lastEvaluatedKey);

    if (targetMembers.length === 0) {
      return { status: "EMPTY", queuedCount: 0, campaignRunId };
    }

    // 4. CHUNK INTO MAXIMUM SQS BATCHES
    const BATCH_SIZE = 10;
    let totalQueued = 0;

    // for (let i = 0; i < targetMembers.length; i += BATCH_SIZE) {
    //   const chunk = targetMembers.slice(i, i + BATCH_SIZE);

    //   const entries = chunk.map((member, idx) => {
    //     const rawSk = member.sk?.S || "";
    //     const cleanPhone = rawSk.replace(/^MEM#/, ""); 
    //     const customName = member.name?.S || "";
    //     // 🔴 REMOVED: templateName is no longer pulled from the member record here.

    //     return {
    //       Id: `msg_${i + idx}_${Date.now().toString().slice(-6)}`,
    //       MessageBody: JSON.stringify({
    //         associationId,
    //         campaignRunId,
    //         recipientPhone: cleanPhone,
    //         recipientName: customName,
    //         templateName,    // 🟢 Passed down globally from the Campaign record
    //         templateLanguage,
    //         campaignMessage,
    //         associationName
    //       }),
    //     };
    //   });

    //   // 5. SEND TO OUTBOUND SQS BUFFER
    //   await sqs.send(
    //     new SendMessageBatchCommand({
    //       QueueUrl: QUEUE_URL,
    //       Entries: entries,
    //     })
    //   );
    //   totalQueued += entries.length;
    // }
    // Inside dispatchBroadcast/handler.ts (Step 4: Chunk into SQS Batches)
    for (let i = 0; i < targetMembers.length; i += BATCH_SIZE) {
      const chunk = targetMembers.slice(i, i + BATCH_SIZE);

      const entries = chunk.map((member, idx) => {
        const rawSk = member.sk?.S || "";
        const cleanPhone = rawSk.replace(/^MEM#/, ""); 
        const customName = member.name?.S || "";
        
        // 🟢 Pull template configuration directly from the Campaign record
        const templateName = campRecord.Item?.templateName?.S || "campaign_msg";
        const templateLanguage = campRecord.Item?.templateLanguage?.S || "en";

        return {
          Id: `msg_${i + idx}_${Date.now().toString().slice(-6)}`,
          MessageBody: JSON.stringify({
            associationId,
            campaignRunId,
            recipientPhone: cleanPhone,
            recipientName: customName,
            templateName,        // Passed dynamically (e.g., campaign_msg_ar)
            templateLanguage,    // Passed dynamically (e.g., ar or en)
            campaignMessage,     // Injected into Meta variable {{2}}
            associationName
          }),
        };
      });

      await sqs.send(
        new SendMessageBatchCommand({
          QueueUrl: QUEUE_URL,
          Entries: entries,
        })
      );
      totalQueued += entries.length;
    }
    console.log(`Successfully queued ${totalQueued} messages to SQS!`);

    return { status: "SUCCESS", queuedCount: totalQueued, campaignRunId };
  } catch (error: any) {
    console.error("Failed to execute broadcast dispatch:", error);
    throw new Error(`Dispatch failed: ${error.message}`);
  }
};
