import { DynamoDBClient, QueryCommand } from "@aws-sdk/client-dynamodb";
import { SQSClient, SendMessageBatchCommand } from "@aws-sdk/client-sqs";

const ddb = new DynamoDBClient({});
const sqs = new SQSClient({});

export const handler = async (event: any) => {
  console.log("Triggered broadcast with event:", JSON.stringify(event.arguments));
  
  // AppSync arguments from the triggerCampaignBroadcast mutation
  const { associationId, campaignRunId } = event.arguments;

  const tableName = process.env.TABLE_NAME!;
  const queueUrl = process.env.OUTBOUND_QUEUE_URL!;

  let lastEvaluatedKey = undefined;
  const targetMembers: any[] = [];

  try {
    // 1. Query PushNotSystem table for all members of this campaign
    // Key pattern: pk = campaignRunId, sk begins with "MEMBER#"
    do {
      const queryCmd: QueryCommand = new QueryCommand({
        TableName: tableName,
        KeyConditionExpression: "pk = :pk AND begins_with(sk, :sk)",
        ExpressionAttributeValues: {
          ":pk": { S: campaignRunId },
          ":sk": { S: "MEMBER#" }
        },
        ExclusiveStartKey: lastEvaluatedKey
      });

      const response = await ddb.send(queryCmd);
      if (response.Items) {
        targetMembers.push(...response.Items);
      }
      lastEvaluatedKey = response.LastEvaluatedKey;
    } while (lastEvaluatedKey);

    console.log(`Found ${targetMembers.length} members for campaign ${campaignRunId}. Queueing...`);

    // 2. Chunk members into batches of 10 (Maximum allowed by SQS SendMessageBatch)
    const batches = [];
    for (let i = 0; i < targetMembers.length; i += 10) {
      batches.push(targetMembers.slice(i, i + 10));
    }

    let messagesQueued = 0;

    // 3. Push to the Outbound SQS Buffer
    for (const batch of batches) {
      const entries = batch.map((member, index) => ({
        // Id must be unique within the batch request
        Id: `msg_${Date.now()}_${index}`,
        MessageBody: JSON.stringify({
          associationId: associationId,
          campaignRunId: campaignRunId,
          memberPhoneSk: member.sk.S
        })
      }));

      await sqs.send(new SendMessageBatchCommand({
        QueueUrl: queueUrl,
        Entries: entries
      }));

      messagesQueued += entries.length;
    }

    // 4. Return success to the React frontend
    return {
      status: "SUCCESS",
      queuedCount: messagesQueued,
      campaignRunId: campaignRunId
    };

  } catch (error: any) {
    console.error("Failed to dispatch broadcast:", error);
    throw new Error(`Dispatch failed: ${error.message}`);
  }
};
