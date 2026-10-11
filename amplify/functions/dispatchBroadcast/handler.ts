import { DynamoDBClient, QueryCommand, GetItemCommand, PutItemCommand } from "@aws-sdk/client-dynamodb";
import { SQSClient, SendMessageBatchCommand } from "@aws-sdk/client-sqs";

const ddb = new DynamoDBClient({});
const sqs = new SQSClient({});

const TABLE_NAME = process.env.TABLE_NAME!;
const QUEUE_URL  = process.env.OUTBOUND_QUEUE_URL!;

export const handler = async (event: any) => {
  // ── Entry log — shows the full mutation arguments for CloudWatch tracing ──
  console.log("🚀 dispatchBroadcast triggered:", JSON.stringify(event.arguments));

  const {
    associationId,
    campaignRunId,
    minEngagementRate,
    minConversionRate,
    targetRegion,
    targetGenders,
  } = event.arguments;

  // ── Argument validation ───────────────────────────────────────────────────
  if (!associationId || !campaignRunId) {
    throw new Error(`Missing required arguments: associationId="${associationId}", campaignRunId="${campaignRunId}"`);
  }
  if (!TABLE_NAME) throw new Error("TABLE_NAME environment variable is not set");
  if (!QUEUE_URL)  throw new Error("OUTBOUND_QUEUE_URL environment variable is not set");

  // Normalise associationId — guarantee ASSOC# prefix
  const safeAssocId = associationId.startsWith("ASSOC#")
    ? associationId
    : `ASSOC#${associationId}`;

  // Normalise campId — accept "433345" or "CAMP#433345"
  const campId    = campaignRunId.startsWith("CAMP#") ? campaignRunId : `CAMP#${campaignRunId}`;
  const campIdRaw = campId.replace(/^CAMP#/, "");

  console.log(`🏷️  safeAssocId: ${safeAssocId} | campId: ${campId} | campIdRaw: ${campIdRaw}`);

  try {
    // ── 1. Fetch the Campaign Template Record ─────────────────────────────
    console.log(`📋 Fetching campaign record: pk="${safeAssocId}" sk="${campaignRunId}"`);
    const campRecord = await ddb.send(new GetItemCommand({
      TableName: TABLE_NAME,
      Key: { pk: { S: safeAssocId }, sk: { S: campaignRunId } },
    }));

    if (!campRecord.Item) {
      console.warn(`⚠️ Campaign record not found for pk="${safeAssocId}" sk="${campaignRunId}" — using defaults`);
    }

    const campaignMessage  = campRecord.Item?.description?.S  || "Please support our latest cause.";
    const templateName     = campRecord.Item?.templateName?.S || "campaign_msg";
    const templateLanguage = campRecord.Item?.templateLanguage?.S || "en";
    const campaignTitle    = campRecord.Item?.title?.S        || "Untitled Campaign";
    const campaignType     = campRecord.Item?.type?.S         || "FUNDRAISER";

    console.log(`📋 Campaign: "${campaignTitle}" | template: ${templateName} | lang: ${templateLanguage}`);

    // ── 2. Fetch the Association Name ─────────────────────────────────────
    const assocRecord = await ddb.send(new GetItemCommand({
      TableName: TABLE_NAME,
      Key: { pk: { S: safeAssocId }, sk: { S: "PROFILE" } },
    }));
    const associationName = assocRecord.Item?.name?.S || "Community Association";
    console.log(`🏢 Association: "${associationName}"`);

    const timestampMs  = Date.now();
    const timestampIso = new Date(timestampMs).toISOString();

    // ── 3. Query all members for this tenant ─────────────────────────────
    console.log(`🔍 Fetching members for tenant "${safeAssocId}" with filters: ` +
      `region="${targetRegion ?? "all"}" | genders=${JSON.stringify(targetGenders)} | ` +
      `minEngagement=${minEngagementRate ?? 0} | minConversion=${minConversionRate ?? 0}`);

    let lastEvaluatedKey: any = undefined;
    const allMembers: any[] = [];
    let pageCount = 0;

    do {
      const response = await ddb.send(new QueryCommand({
        TableName: TABLE_NAME,
        KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)",
        ExpressionAttributeValues: {
          ":pk":     { S: safeAssocId },
          ":prefix": { S: "MEM#" },
        },
        ExclusiveStartKey: lastEvaluatedKey,
      }));

      const pageItems = response.Items ?? [];
      allMembers.push(...pageItems);
      lastEvaluatedKey = response.LastEvaluatedKey;
      pageCount++;
      console.log(`  📄 Page ${pageCount}: ${pageItems.length} members fetched (running total: ${allMembers.length})`);

    } while (lastEvaluatedKey);

    console.log(`👥 Total members in DB for tenant: ${allMembers.length}`);

    if (allMembers.length === 0) {
      console.warn(`⚠️ No MEM# records found for pk="${safeAssocId}". ` +
        `Ensure members were seeded with the correct associationId.`);
      return { status: "EMPTY", queuedCount: 0, campaignRunId: campId };
    }

    // ── 4. Targeting filter ───────────────────────────────────────────────
    const targeted = allMembers.filter((m) => {
      const phone = (m.sk?.S ?? "").replace(/^MEM#/, "");

      // Skip members with no usable phone number — would produce empty DynamoDB keys
      if (!phone) {
        console.warn(`⚠️ Skipping member with missing sk/phone: ${JSON.stringify(m)}`);
        return false;
      }

      if (minEngagementRate != null) {
        const v = parseFloat(m.engagementRatePercent?.N ?? m.engagementRatePercent?.S ?? "0");
        if (isNaN(v) || v < minEngagementRate) return false;
      }
      if (minConversionRate != null) {
        const v = parseFloat(m.conversionRatePercent?.N ?? m.conversionRatePercent?.S ?? "0");
        if (isNaN(v) || v < minConversionRate) return false;
      }
      if (targetRegion && targetRegion !== "All Regions") {
        const memberRegion = (m.address?.S ?? "").trim();
        if (memberRegion !== targetRegion.trim()) return false;
      }
      if (Array.isArray(targetGenders) && targetGenders.length > 0) {
        const memberGender = (m.gender?.S ?? "").toUpperCase();
        if (!memberGender || !targetGenders.includes(memberGender)) return false;
      }
      return true;
    });

    console.log(`🎯 Targeting result: ${allMembers.length} total → ${targeted.length} matched`);

    // Log a breakdown to show why members were excluded
    if (targeted.length === 0) {
      const regionCounts: Record<string, number> = {};
      const genderCounts: Record<string, number> = {};
      allMembers.forEach(m => {
        const r = m.address?.S ?? "unknown";
        const g = (m.gender?.S ?? "unknown").toUpperCase();
        regionCounts[r] = (regionCounts[r] || 0) + 1;
        genderCounts[g] = (genderCounts[g] || 0) + 1;
      });
      console.warn(`⚠️ No members matched. DB regions: ${JSON.stringify(regionCounts)} | genders: ${JSON.stringify(genderCounts)}`);
      console.warn(`   Filters applied: region="${targetRegion}" | genders=${JSON.stringify(targetGenders)}`);
      return { status: "SUCCESS_NO_MATCH", queuedCount: 0, campaignRunId: campId };
    }

    // ── 5. Enqueue SQS batches ────────────────────────────────────────────
    const BATCH_SIZE = 10;
    let totalQueued  = 0;
    let batchErrors  = 0;

    for (let i = 0; i < targeted.length; i += BATCH_SIZE) {
      const chunk = targeted.slice(i, i + BATCH_SIZE);

      const entries = chunk.flatMap((member, idx) => {
        const phone = (member.sk?.S ?? "").replace(/^MEM#/, "");

        // Hard validation — never pass empty strings to DynamoDB keys
        if (!phone) {
          console.error(`❌ Member at index ${i + idx} has no phone — sk="${member.sk?.S}". Skipping.`);
          return []; // flatMap: return empty array to skip this member
        }
        if (!safeAssocId || !campIdRaw) {
          console.error(`❌ CRITICAL: safeAssocId="${safeAssocId}" or campIdRaw="${campIdRaw}" is empty. Cannot build ledger key.`);
          return [];
        }

        // ── Key construction (all fields explicitly validated above) ─────
        const ledgerSk = `CAMPRUN#${campIdRaw}#MEM#${phone}#${timestampMs}`;
        const tenantId = safeAssocId.replace(/^ASSOC#/, "");
        const gsi2pk   = `ASSOC#${tenantId}#MEM#${phone}`;
        const gsi2sk   = campId;

        console.log(`  📦 Queuing: phone=${phone} | ledgerSk=${ledgerSk}`);

        return [{
          Id: `msg_${i + idx}_${timestampMs.toString().slice(-6)}`,
          MessageBody: JSON.stringify({
            associationId: safeAssocId,
            ledgerSk,
            gsi2pk,
            gsi2sk,
            campId,
            recipientPhone: phone,
            recipientName:  member.name?.S ?? "",
            templateName,
            templateLanguage,
            campaignMessage,
            associationName,
          }),
        }];
      });

      if (entries.length === 0) {
        console.warn(`⚠️ Batch ${Math.floor(i / BATCH_SIZE) + 1} produced no valid entries — skipping`);
        continue;
      }

      try {
        const sqsResult = await sqs.send(new SendMessageBatchCommand({
          QueueUrl: QUEUE_URL,
          Entries:  entries,
        }));

        if (sqsResult.Failed?.length) {
          console.error(
            `❌ SQS batch partial failure: ${sqsResult.Failed.length} messages failed:`,
            JSON.stringify(sqsResult.Failed)
          );
          batchErrors += sqsResult.Failed.length;
        }

        totalQueued += entries.length - (sqsResult.Failed?.length ?? 0);
        console.log(`  ✅ Batch ${Math.floor(i / BATCH_SIZE) + 1}: ${entries.length} sent, ${sqsResult.Failed?.length ?? 0} failed`);

      } catch (sqsErr: any) {
        console.error(`❌ CRITICAL: SQS SendMessageBatch failed for batch ${Math.floor(i / BATCH_SIZE) + 1}:`, sqsErr.message);
        batchErrors += entries.length;
      }
    }

    console.log(`✅ SQS dispatch complete: ${totalQueued} queued, ${batchErrors} errors`);

    // ── 6. Write Campaign Run summary record ─────────────────────────────
    const runSummarySk = `CAMPRUN#${campIdRaw}`;
    console.log(`💾 Writing run summary: pk="${safeAssocId}" sk="${runSummarySk}" recipientCount=${totalQueued}`);

    try {
      await ddb.send(new PutItemCommand({
        TableName: TABLE_NAME,
        Item: {
          pk:               { S: safeAssocId },
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
      }));
      console.log(`✅ Run summary written: ${runSummarySk}`);
    } catch (putErr: any) {
      // Non-fatal — messages are already queued; log and continue
      console.error(`❌ Failed to write run summary record:`, putErr.message);
    }

    const finalStatus = batchErrors > 0 ? "PARTIAL_SUCCESS" : "SUCCESS";
    console.log(`🏁 dispatchBroadcast complete: status=${finalStatus} | queued=${totalQueued} | errors=${batchErrors}`);

    return { status: finalStatus, queuedCount: totalQueued, campaignRunId: campId };

  } catch (err: any) {
    console.error("❌ CRITICAL: dispatchBroadcast failed:", err.message);
    console.error("   Stack:", err.stack);
    throw new Error(`Dispatch failed: ${err.message}`);
  }
};
