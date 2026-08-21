import { DynamoDBClient, QueryCommand } from "@aws-sdk/client-dynamodb";
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

  let lastEvaluatedKey = undefined;
  const targetMembers: any[] = [];

  try {
    // -----------------------------------------------------------------
    // 1. QUERY PushNotSystem FOR ALL RECIPIENTS
    // -----------------------------------------------------------------
    do {
      const queryCmd: QueryCommand = new QueryCommand({
        TableName: TABLE_NAME,
        KeyConditionExpression: "pk = :pk AND begins_with(sk, :sk)",
        ExpressionAttributeValues: {
          ":pk": { S: campaignRunId },
          ":sk": { S: "MEMBER#" },
        },
        ExclusiveStartKey: lastEvaluatedKey,
      });

      const response = await ddb.send(queryCmd);
      if (response.Items && response.Items.length > 0) {
        targetMembers.push(...response.Items);
      }
      lastEvaluatedKey = response.LastEvaluatedKey;
    } while (lastEvaluatedKey);

    console.log(`Discovered ${targetMembers.length} recipients for campaign ${campaignRunId}. Processing SQS buffer...`);

    if (targetMembers.length === 0) {
      return {
        status: "EMPTY",
        queuedCount: 0,
        campaignRunId,
      };
    }

    // -----------------------------------------------------------------
    // 2. CHUNK INTO MAXIMUM SQS BATCHES (10 items max per batch)
    // -----------------------------------------------------------------
    const BATCH_SIZE = 10;
    let totalQueued = 0;

    for (let i = 0; i < targetMembers.length; i += BATCH_SIZE) {
      const chunk = targetMembers.slice(i, i + BATCH_SIZE);

      const entries = chunk.map((member, idx) => {
        const rawSk = member.sk?.S || "";
        const cleanPhone = rawSk.replace(/^MEMBER#/, "");
        const customName = member.name?.S || "";
        const templateName = member.templateName?.S || "hello_world";

        return {
          Id: `msg_${i + idx}_${Date.now().toString().slice(-6)}`,
          MessageBody: JSON.stringify({
            associationId,
            campaignRunId,
            pk: member.pk?.S || campaignRunId,
            sk: rawSk,
            recipientPhone: cleanPhone,
            recipientName: customName,
            templateName,
          }),
        };
      });

      // -----------------------------------------------------------------
      // 3. SEND TO OUTBOUND SQS BUFFER
      // -----------------------------------------------------------------
      await sqs.send(
        new SendMessageBatchCommand({
          QueueUrl: QUEUE_URL,
          Entries: entries,
        })
      );

      totalQueued += entries.length;
    }

    console.log(`Successfully buffered ${totalQueued} messages into SQS.`);

    return {
      status: "SUCCESS",
      queuedCount: totalQueued,
      campaignRunId,
    };
  } catch (error: any) {
    console.error("Failed to execute broadcast dispatch:", error);
    throw new Error(`Dispatch failed: ${error.message}`);
  }
};