import { DynamoDBClient, QueryCommand, GetItemCommand, PutItemCommand } from "@aws-sdk/client-dynamodb";
import { SQSClient, SendMessageBatchCommand } from "@aws-sdk/client-sqs";

const ddb = new DynamoDBClient({});
const sqs = new SQSClient({});

const TABLE_NAME = process.env.TABLE_NAME!;
const QUEUE_URL  = process.env.OUTBOUND_QUEUE_URL!;

export const handler = async (event: any) => {
  console.log("Triggered broadcast event arguments:", JSON.stringify(event.arguments));

  const {
    associationId,
    campaignRunId,      // Caller passes the campaign sk, e.g. "CAMP#433345"
    minEngagementRate,
    minConversionRate,
    targetRegion,
    targetGenders,
  } = event.arguments;

  if (!associationId || !campaignRunId) {
    throw new Error("Missing required arguments: associationId or campaignRunId");
  }

  try {
    // ── 1. Fetch the Campaign Template Record ────────────────────────────────
    const campRecord = await ddb.send(new GetItemCommand({
      TableName: TABLE_NAME,
      Key: { pk: { S: associationId }, sk: { S: campaignRunId } },
    }));
    const campaignMessage  = campRecord.Item?.description?.S  || "Please support our latest cause.";
    const templateName     = campRecord.Item?.templateName?.S || "campaign_msg";
    const templateLanguage = campRecord.Item?.templateLanguage?.S || "en";
    const campaignTitle    = campRecord.Item?.title?.S        || "Untitled Campaign";
    const campaignType     = campRecord.Item?.type?.S         || "FUNDRAISER";

    // ── 2. Fetch the Association Name ────────────────────────────────────────
    const assocRecord = await ddb.send(new GetItemCommand({
      TableName: TABLE_NAME,
      Key: { pk: { S: associationId }, sk: { S: "PROFILE" } },
    }));
    const associationName = assocRecord.Item?.name?.S || "Community Association";

    // ── 3. Build the canonical Campaign ID ──────────────────────────────────
    // Normalise: accept "433345" or "CAMP#433345" from the caller
    const campId    = campaignRunId.startsWith("CAMP#") ? campaignRunId : `CAMP#${campaignRunId}`;
    // Strip the "CAMP#" prefix to get the raw numeric/slug part
    const campIdRaw = campId.replace(/^CAMP#/, "");

    const timestampMs  = Date.now();
    const timestampIso = new Date(timestampMs).toISOString();

    // ── 4. Query all members for this tenant ─────────────────────────────────
    let lastEvaluatedKey: any = undefined;
    const allMembers: any[] = [];

    do {
      const response = await ddb.send(new QueryCommand({
        TableName: TABLE_NAME,
        KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)",
        ExpressionAttributeValues: {
          ":pk":     { S: associationId },
          ":prefix": { S: "MEM#" },
        },
        ExclusiveStartKey: lastEvaluatedKey,
      }));
      if (response.Items?.length) allMembers.push(...response.Items);
      lastEvaluatedKey = response.LastEvaluatedKey;
    } while (lastEvaluatedKey);

    if (allMembers.length === 0) {
      return { status: "EMPTY", queuedCount: 0, campaignRunId: campId };
    }

    // ── 5. Targeting engine ──────────────────────────────────────────────────
    const targeted = allMembers.filter((m) => {
      if (minEngagementRate != null) {
        const v = parseFloat(m.engagementRatePercent?.N ?? m.engagementRatePercent?.S ?? "0");
        if (v < minEngagementRate) return false;
      }
      if (minConversionRate != null) {
        const v = parseFloat(m.conversionRatePercent?.N ?? m.conversionRatePercent?.S ?? "0");
        if (v < minConversionRate) return false;
      }
      if (targetRegion && targetRegion !== "All Regions") {
        if ((m.address?.S ?? "") !== targetRegion) return false;
      }
      if (Array.isArray(targetGenders) && targetGenders.length > 0) {
        if (!targetGenders.includes((m.gender?.S ?? "").toUpperCase())) return false;
      }
      return true;
    });

    console.log(`🎯 Targeting: ${allMembers.length} → ${targeted.length} members`);

    if (targeted.length === 0) {
      return { status: "SUCCESS_NO_MATCH", queuedCount: 0, campaignRunId: campId };
    }

    // ── 6. Enqueue SQS batches ───────────────────────────────────────────────
    const BATCH_SIZE = 10;
    let totalQueued = 0;

    for (let i = 0; i < targeted.length; i += BATCH_SIZE) {
      const chunk = targeted.slice(i, i + BATCH_SIZE);

      const entries = chunk.map((member, idx) => {
        const phone = (member.sk?.S ?? "").replace(/^MEM#/, "");

        // ── KEY FORMAT (per spec) ────────────────────────────────────────────
        // sk      = CAMPRUN#<campIdRaw>#MEM#<phone>#<timestamp>
        // gsi2pk  = ASSOC#<tenantId>#MEM#<phone>   (tenantId = associationId without "ASSOC#")
        // gsi2sk  = CAMP#<campIdRaw>
        //
        // We pass these pre-computed values to the worker so it writes them
        // verbatim — no re-derivation needed in processOutboundQueue.
        const ledgerSk = `CAMPRUN#${campIdRaw}#MEM#${phone}#${timestampMs}`;
        const tenantId = associationId.replace(/^ASSOC#/, "");
        const gsi2pk   = `ASSOC#${tenantId}#MEM#${phone}`;   // same as: `${associationId}#MEM#${phone}`
        const gsi2sk   = campId;                               // CAMP#<campIdRaw>

        return {
          Id: `msg_${i + idx}_${timestampMs.toString().slice(-6)}`,
          MessageBody: JSON.stringify({
            associationId,
            ledgerSk,          // pre-computed final sk for the ledger record
            gsi2pk,            // pre-computed GSI2 hash key
            gsi2sk,            // pre-computed GSI2 sort key  = CAMP#<id>
            campId,            // CAMP#<id> — for the button payload & run summary
            recipientPhone: phone,
            recipientName:  member.name?.S ?? "",
            templateName,
            templateLanguage,
            campaignMessage,
            associationName,
          }),
        };
      });

      await sqs.send(new SendMessageBatchCommand({ QueueUrl: QUEUE_URL, Entries: entries }));
      totalQueued += entries.length;
    }

    console.log(`✅ Queued ${totalQueued} messages for campaign ${campId}`);

    // ── 7. Write the immutable Campaign Run summary record ───────────────────
    // sk = CAMPRUN#<campIdRaw>  (one summary per broadcast run)
    const runSummarySk = `CAMPRUN#${campIdRaw}`;
    await ddb.send(new PutItemCommand({
      TableName: TABLE_NAME,
      Item: {
        pk:               { S: associationId },
        sk:               { S: runSummarySk },
        entityType:       { S: "CAMPAIGN_RUN" },
        __typename:       { S: "PushNotSystem" },
        parentCampaignSk: { S: campId },
        title:            { S: campaignTitle },
        type:             { S: campaignType },
        templateName:     { S: templateName },
        status:           { S: "RUNNING" },
        recipientCount:   { N: totalQueued.toString() },
        createdAt:        { S: timestampIso },
        updatedAt:        { S: timestampIso },
      },
      // Upsert-safe: overwrite if a run for this campaign already exists
      // (i.e. when the same campaign is relaunched)
    }));

    return { status: "SUCCESS", queuedCount: totalQueued, campaignRunId: campId };

  } catch (err: any) {
    console.error("Broadcast dispatch failed:", err);
    throw new Error(`Dispatch failed: ${err.message}`);
  }
};
