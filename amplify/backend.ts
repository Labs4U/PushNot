import { PolicyStatement, Effect } from 'aws-cdk-lib/aws-iam';
import { defineBackend } from '@aws-amplify/backend';
import { FunctionUrlAuthType } from 'aws-cdk-lib/aws-lambda';
import { Queue } from 'aws-cdk-lib/aws-sqs';
import { Duration } from 'aws-cdk-lib';
import { SqsEventSource } from 'aws-cdk-lib/aws-lambda-event-sources';

import { auth }                 from './auth/resource';
import { data }                 from './data/resource';
import { whatsappWebhook }      from './functions/whatsapp/resource';
import { dispatchBroadcast }    from './functions/dispatchBroadcast/resource';
import { processOutboundQueue } from './functions/processOutboundQueue/resource';
import { chatAgent }            from './functions/chatAgent/resource';

const backend = defineBackend({
  auth,
  data,
  whatsappWebhook,
  dispatchBroadcast,
  processOutboundQueue,
  chatAgent,
});

// ── CDK construct handles ─────────────────────────────────────────────────────
const webhookLambda         = backend.whatsappWebhook.resources.lambda;
const dispatchLambda        = backend.dispatchBroadcast.resources.lambda;
const processOutboundLambda = backend.processOutboundQueue.resources.lambda;
const chatAgentLambda       = backend.chatAgent.resources.lambda;

// Single, consistent table reference
const pushNotTable = backend.data.resources.tables["PushNotSystem"];

// ── Messaging + AI infrastructure stack ──────────────────────────────────────
const customStack = backend.createStack('MessagingInfrastructure');

// ── SQS: Outbound broadcast buffer ───────────────────────────────────────────
// Visibility timeout (120s) > processOutboundQueue Lambda timeout (60s)
const outboundMainQueue = new Queue(customStack, 'OutboundBroadcastQueue', {
  queueName: 'outbound-broadcast-queue',
  visibilityTimeout: Duration.seconds(120),
});

// ── SQS: Inbound chat queue (text replies → chatAgent) ────────────────────────
// Visibility timeout (90s) > chatAgent Lambda timeout (60s)
const inboundChatQueue = new Queue(customStack, 'InboundChatQueue', {
  queueName: 'inbound-chat-queue',
  visibilityTimeout: Duration.seconds(90),
});

// ── S3: Reference the existing push-notifications-bh bucket ─────────────────
// This is a pre-existing external bucket — NOT created by CDK.
const RAG_BUCKET_NAME = "push-notifications-bh";

// ── SQS event sources ────────────────────────────────────────────────────────
processOutboundLambda.addEventSource(
  new SqsEventSource(outboundMainQueue, {
    batchSize: 10,
    reportBatchItemFailures: true,
  })
);

chatAgentLambda.addEventSource(
  new SqsEventSource(inboundChatQueue, {
    batchSize: 1,          // process one message at a time — Bedrock calls are slow
    reportBatchItemFailures: true,
  })
);

// ── Public Function URL for Meta inbound webhook ──────────────────────────────
const webhookUrl = webhookLambda.addFunctionUrl({
  authType: FunctionUrlAuthType.NONE,
});

// ── Shared GSI query policy ───────────────────────────────────────────────────
const gsiQueryPolicy = new PolicyStatement({
  actions:   ['dynamodb:Query'],
  resources: [`${pushNotTable.tableArn}/index/*`],
});

// ── Bedrock invocation policy for chatAgent ───────────────────────────────────
const bedrockPolicy = new PolicyStatement({
  effect:  Effect.ALLOW,
  // bedrock:Converse is required by the cross-region inference profile API
  actions: ['bedrock:InvokeModel', 'bedrock:Converse'],
  resources: [
    // All foundation models
    'arn:aws:bedrock:*::foundation-model/*',
    // Cross-region inference profiles (e.g. us.amazon.nova-lite-v1:0)
    'arn:aws:bedrock:*:*:inference-profile/*',
  ],
});

// ── A. Inbound Webhook Lambda ─────────────────────────────────────────────────
pushNotTable.grantReadWriteData(webhookLambda);
webhookLambda.addToRolePolicy(gsiQueryPolicy);
inboundChatQueue.grantSendMessages(webhookLambda);
backend.whatsappWebhook.addEnvironment('TABLE_NAME',             pushNotTable.tableName);
backend.whatsappWebhook.addEnvironment('INBOUND_CHAT_QUEUE_URL', inboundChatQueue.queueUrl);

// ── B. Dispatch Broadcast Lambda ──────────────────────────────────────────────
pushNotTable.grantReadWriteData(dispatchLambda);
dispatchLambda.addToRolePolicy(gsiQueryPolicy);
outboundMainQueue.grantSendMessages(dispatchLambda);
backend.dispatchBroadcast.addEnvironment('TABLE_NAME',         pushNotTable.tableName);
backend.dispatchBroadcast.addEnvironment('OUTBOUND_QUEUE_URL', outboundMainQueue.queueUrl);

// ── C. Process Outbound Queue Lambda ─────────────────────────────────────────
pushNotTable.grantReadWriteData(processOutboundLambda);
processOutboundLambda.addToRolePolicy(gsiQueryPolicy);
outboundMainQueue.grantConsumeMessages(processOutboundLambda);
backend.processOutboundQueue.addEnvironment('TABLE_NAME', pushNotTable.tableName);

// ── D. Chat Agent Lambda ──────────────────────────────────────────────────────
pushNotTable.grantReadWriteData(chatAgentLambda);
chatAgentLambda.addToRolePolicy(gsiQueryPolicy);
inboundChatQueue.grantConsumeMessages(chatAgentLambda);

chatAgentLambda.addToRolePolicy(new PolicyStatement({
  effect:    Effect.ALLOW,
  actions:   ['s3:GetObject'],
  resources: [`arn:aws:s3:::${RAG_BUCKET_NAME}/*`],
}));
chatAgentLambda.addToRolePolicy(bedrockPolicy);
backend.chatAgent.addEnvironment('TABLE_NAME',          pushNotTable.tableName);
backend.chatAgent.addEnvironment('RAG_BUCKET_NAME',     RAG_BUCKET_NAME);
backend.chatAgent.addEnvironment('WHATSAPP_PHONE_ID',   process.env.WHATSAPP_PHONE_ID ?? '');

// ── E. Frontend Authenticated Role & Groups (S3 Uploads) ──────────────────────
const s3UploadPolicy = new PolicyStatement({
  effect: Effect.ALLOW,
  actions: ['s3:PutObject'],
  resources: [`arn:aws:s3:::${RAG_BUCKET_NAME}/ASSOC#*/mission.txt`],
});

// 1. Attach to the default authenticated role
backend.auth.resources.authenticatedUserIamRole.addToPrincipalPolicy(s3UploadPolicy);

// 2. Attach to all Cognito User Pool Group roles (Critical for Admin groups)
if (backend.auth.resources.groups) {
  Object.values(backend.auth.resources.groups).forEach((group) => {
    group.role.addToPrincipalPolicy(s3UploadPolicy);
  });
}

// ── Stack outputs ─────────────────────────────────────────────────────────────
backend.addOutput({
  custom: {
    MetaWebhookEndpoint: webhookUrl.url,
    OutboundQueueUrl:    outboundMainQueue.queueUrl,
    InboundChatQueueUrl: inboundChatQueue.queueUrl,
    RagBucketName:       RAG_BUCKET_NAME,
  },
});