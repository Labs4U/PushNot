import { PolicyStatement } from 'aws-cdk-lib/aws-iam';
import { defineBackend } from '@aws-amplify/backend';
import { FunctionUrlAuthType } from 'aws-cdk-lib/aws-lambda';
import { Queue } from 'aws-cdk-lib/aws-sqs';
import { Duration } from 'aws-cdk-lib';
import { SqsEventSource } from 'aws-cdk-lib/aws-lambda-event-sources';

import { auth }                from './auth/resource';
import { data }                from './data/resource';
import { whatsappWebhook }     from './functions/whatsapp/resource';
import { dispatchBroadcast }   from './functions/dispatchBroadcast/resource';
import { processOutboundQueue } from './functions/processOutboundQueue/resource';

const backend = defineBackend({
  auth,
  data,
  whatsappWebhook,
  dispatchBroadcast,
  processOutboundQueue,
});

// ── CDK construct handles ─────────────────────────────────────────────────────
const webhookLambda        = backend.whatsappWebhook.resources.lambda;
const dispatchLambda       = backend.dispatchBroadcast.resources.lambda;
const processOutboundLambda = backend.processOutboundQueue.resources.lambda;

// Single, consistent table reference — explicit name, never array index
const pushNotTable = backend.data.resources.tables["PushNotSystem"];

// ── SQS messaging infrastructure (own stack to isolate from data stack) ───────
const customStack = backend.createStack('MessagingInfrastructure');

// Outbound broadcast buffer queue.
// Visibility timeout (120s) > processOutboundQueue Lambda timeout (60s) — AWS requirement.
const outboundMainQueue = new Queue(customStack, 'OutboundBroadcastQueue', {
  queueName: 'outbound-broadcast-queue',
  visibilityTimeout: Duration.seconds(120),
});

// SQS event source: worker Lambda triggered by queue messages
processOutboundLambda.addEventSource(
  new SqsEventSource(outboundMainQueue, {
    batchSize: 10,
    reportBatchItemFailures: true, // partial batch retry — failed messages stay in queue
  })
);

// Public Function URL for the Meta inbound webhook (no auth — Meta calls this)
const webhookUrl = webhookLambda.addFunctionUrl({
  authType: FunctionUrlAuthType.NONE,
});

// ── Shared GSI query policy ───────────────────────────────────────────────────
// All three Lambdas need to query secondary indexes (GSI1: ByStatusOrWamid,
// GSI2: ByMemberHistory). grantReadWriteData() covers base table actions but
// NOT index queries — those require an explicit index ARN policy.
const gsiQueryPolicy = new PolicyStatement({
  actions: ['dynamodb:Query'],
  resources: [`${pushNotTable.tableArn}/index/*`],
});

// ── A. Inbound Webhook Lambda ─────────────────────────────────────────────────
// Reads delivery status updates via GSI1 (ByStatusOrWamid: MSG#<wamid>).
// Reads member history via GSI2 (ByMemberHistory) to update ledger on reply.
pushNotTable.grantReadWriteData(webhookLambda);
webhookLambda.addToRolePolicy(gsiQueryPolicy);
backend.whatsappWebhook.addEnvironment('TABLE_NAME', pushNotTable.tableName);

// ── B. Dispatch Broadcast Lambda ──────────────────────────────────────────────
// Reads all MEM# records via base table Query (pk + sk beginsWith MEM#).
// Writes the CAMPRUN# summary record via PutItem.
// Sends messages to SQS — needs SendMessage on the queue.
pushNotTable.grantReadWriteData(dispatchLambda);
dispatchLambda.addToRolePolicy(gsiQueryPolicy); // for future GSI1 campaign status lookups
outboundMainQueue.grantSendMessages(dispatchLambda);
backend.dispatchBroadcast.addEnvironment('TABLE_NAME',        pushNotTable.tableName);
backend.dispatchBroadcast.addEnvironment('OUTBOUND_QUEUE_URL', outboundMainQueue.queueUrl);

// ── C. Process Outbound Queue Lambda ─────────────────────────────────────────
// Writes CAMPRUN#<id>#MEM#<phone>#<ts> ledger records.
// Increments totalCampaignsReceived on MEM# profile records.
// Needs both base table write AND index query permission (gsi1pk lookup on DLQ retry).
pushNotTable.grantReadWriteData(processOutboundLambda);
processOutboundLambda.addToRolePolicy(gsiQueryPolicy);
outboundMainQueue.grantConsumeMessages(processOutboundLambda);
backend.processOutboundQueue.addEnvironment('TABLE_NAME', pushNotTable.tableName);

// ── Stack outputs ─────────────────────────────────────────────────────────────
backend.addOutput({
  custom: {
    MetaWebhookEndpoint: webhookUrl.url,
    OutboundQueueUrl:    outboundMainQueue.queueUrl,
  },
});
