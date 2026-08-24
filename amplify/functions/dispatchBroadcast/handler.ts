import { DynamoDBClient, QueryCommand, GetItemCommand, PutItemCommand } from "@aws-sdk/client-dynamodb";
import { SQSClient, SendMessageBatchCommand } from "@aws-sdk/client-sqs";

const ddb = new DynamoDBClient({});
const sqs = new SQSClient({});

const TABLE_NAME = process.env.TABLE_NAME!;
const QUEUE_URL = process.env.OUTBOUND_QUEUE_URL!;

export const handler = async (event: any) => {
  console.log("Triggered broadcast event arguments:", JSON.stringify(event.arguments));
  
  const { 
    associationId, 
    campaignRunId, 
    minEngagementRate,
    minConversionRate,
    targetRegion,
    targetGenders
  } = event.arguments; 

  if (!associationId || !campaignRunId) {
    throw new Error("Missing required arguments: associationId or campaignRunId");
  }

  try {
    // 1. Fetch the Campaign Template Record
    const campRecord = await ddb.send(new GetItemCommand({
      TableName: TABLE_NAME,
      Key: { pk: { S: associationId }, sk: { S: campaignRunId } }
    }));
    const campaignMessage = campRecord.Item?.description?.S || "Please support our latest cause.";
    const templateName = campRecord.Item?.templateName?.S || "campaign_msg"; 
    const templateLanguage = campRecord.Item?.templateLanguage?.S || "en"; 
    const campaignTitle = campRecord.Item?.title?.S || "Untitled Campaign";
    const campaignType = campRecord.Item?.type?.S || "FUNDRAISER";

    // 2. Fetch the Association Name
    const assocRecord = await ddb.send(new GetItemCommand({
      TableName: TABLE_NAME,
      Key: { pk: { S: associationId }, sk: { S: "META" } }
    }));
    const associationName = assocRecord.Item?.name?.S || "Community Association";

    // 3. Generate the Unique RUN ID for this specific broadcast
    const timestampIso = new Date().toISOString();
    const timestampMs = Date.now();
    
    // Ensure clean ID generation (e.g., RUN#1724490000000#CAMP#433345)
    const cleanCampId = campaignRunId.startsWith('CAMP#') ? campaignRunId : `CAMP#${campaignRunId}`;
    const runSk = `RUN#${timestampMs}#${cleanCampId}`;

    let lastEvaluatedKey = undefined;
    const allMembers: any[] = [];

    // 4. QUERY PushNotSystem FOR ALL RECIPIENTS
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
        allMembers.push(...response.Items);
      }
      lastEvaluatedKey = response.LastEvaluatedKey;
    } while (lastEvaluatedKey);

    if (allMembers.length === 0) {
      return { status: "EMPTY", queuedCount: 0, campaignRunId: runSk };
    }

    // 5. THE TARGETING ENGINE
    const targetedMembers = allMembers.filter(member => {
      if (minEngagementRate !== undefined && minEngagementRate !== null) {
        const engagement = parseFloat(member.engagementRatePercent?.N || member.engagementRatePercent?.S || "0");
        if (engagement < minEngagementRate) return false;
      }
      if (minConversionRate !== undefined && minConversionRate !== null) {
        const conversion = parseFloat(member.conversionRatePercent?.N || member.conversionRatePercent?.S || "0");
        if (conversion < minConversionRate) return false;
      }
      if (targetRegion && targetRegion !== "All Regions") {
        const region = member.address?.S || "";
        if (region !== targetRegion) return false;
      }
      if (targetGenders && Array.isArray(targetGenders) && targetGenders.length > 0) {
        const gender = (member.gender?.S || "").toUpperCase();
        if (!targetGenders.includes(gender)) return false;
      }
      return true; 
    });

    console.log(`🎯 Targeting Engine: Reduced ${allMembers.length} members to ${targetedMembers.length}.`);

    if (targetedMembers.length === 0) {
      return { status: "SUCCESS_NO_MATCH", queuedCount: 0, campaignRunId: runSk };
    }

    // 6. CHUNK TARGETED MEMBERS INTO SQS BATCHES
    const BATCH_SIZE = 10;
    let totalQueued = 0;

    for (let i = 0; i < targetedMembers.length; i += BATCH_SIZE) {
      const chunk = targetedMembers.slice(i, i + BATCH_SIZE);

      const entries = chunk.map((member, idx) => {
        const rawSk = member.sk?.S || "";
        const cleanPhone = rawSk.replace(/^MEM#/, ""); 
        const customName = member.name?.S || "";

        return {
          Id: `msg_${i + idx}_${timestampMs.toString().slice(-6)}`,
          MessageBody: JSON.stringify({
            associationId,
            campaignRunSk: runSk,          // Unambiguous: RUN#12345#CAMP#433345
            baseCampaignSk: cleanCampId,   // Unambiguous: CAMP#433345
            recipientPhone: cleanPhone,
            recipientName: customName,
            templateName,        
            templateLanguage,    
            campaignMessage,     
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
    
    console.log(`✅ Queued ${totalQueued} messages. RUN ID: ${runSk}`);

    // 7. CREATE THE IMMUTABLE CAMPAIGN RUN SUMMARY RECORD
    await ddb.send(new PutItemCommand({
      TableName: TABLE_NAME,
      Item: {
        pk: { S: associationId },
        sk: { S: runSk },
        entityType: { S: "CAMPAIGN_RUN" },
        __typename: { S: "PushNotSystem" }, 
        parentCampaignSk: { S: cleanCampId },
        title: { S: campaignTitle },
        type: { S: campaignType },
        templateName: { S: templateName },
        status: { S: "RUNNING" },
        recipientCount: { N: totalQueued.toString() },
        createdAt: { S: timestampIso },
        updatedAt: { S: timestampIso }
      }
    }));

    return { status: "SUCCESS", queuedCount: totalQueued, campaignRunId: runSk };

  } catch (error: any) {
    console.error("Failed to execute broadcast:", error);
    throw new Error(`Dispatch failed: ${error.message}`);
  }
};