import { PolicyStatement } from 'aws-cdk-lib/aws-iam';
import { defineBackend } from '@aws-amplify/backend';
import { FunctionUrlAuthType } from 'aws-cdk-lib/aws-lambda';
import { Queue } from 'aws-cdk-lib/aws-sqs';
import { Duration } from 'aws-cdk-lib';
import { SqsEventSource } from 'aws-cdk-lib/aws-lambda-event-sources'; // Required for the trigger

import { auth } from './auth/resource';
import { data } from './data/resource';
import { whatsappWebhook } from './functions/whatsapp/resource';
import { dispatchBroadcast } from './functions/dispatchBroadcast/resource';
// 1. Import the new consumer Lambda resource
import { processOutboundQueue } from './functions/processOutboundQueue/resource'; 

const backend = defineBackend({
  auth,
  data,
  whatsappWebhook,
  dispatchBroadcast,
  processOutboundQueue, // 2. Register it with the Amplify backend
});

// Get the underlying CDK constructs
const webhookLambda = backend.whatsappWebhook.resources.lambda;
const dispatchLambda = backend.dispatchBroadcast.resources.lambda;
const processOutboundLambda = backend.processOutboundQueue.resources.lambda; // Reference the worker

// Access the DynamoDB table from the data backend
const dataTables = backend.data.resources.tables;
const pushNotTable = Object.values(dataTables)[0]; 

// Create a custom stack for the messaging infrastructure (SQS Queues)
const customStack = backend.createStack('MessagingInfrastructure');

// Attach a public Function URL for the Meta Inbound Webhook
const webhookUrl = webhookLambda.addFunctionUrl({
  authType: FunctionUrlAuthType.NONE,
});

// Configure the Outbound SQS Buffer Queue
const outboundMainQueue = new Queue(customStack, 'OutboundBroadcastQueue', {
  queueName: 'outbound-broadcast-queue',
  visibilityTimeout: Duration.seconds(30),
});

// 3. Attach the SQS Event Source to the Consumer Lambda
processOutboundLambda.addEventSource(
  new SqsEventSource(outboundMainQueue, {
    batchSize: 10,
    reportBatchItemFailures: true, // Prevents deleting the whole batch if one message fails
  })
);

// --- Grant Permissions & Inject Environment Variables ---

// A. Inbound Webhook Lambda Permissions
pushNotTable.grantReadWriteData(webhookLambda);
backend.whatsappWebhook.addEnvironment('TABLE_NAME', pushNotTable.tableName);
webhookLambda.addToRolePolicy(
  new PolicyStatement({
    actions: ['dynamodb:Query'],
    resources: [`${pushNotTable.tableArn}/index/*`],
  })
);

// B. Dispatch Broadcast Lambda Permissions
pushNotTable.grantReadData(dispatchLambda);
outboundMainQueue.grantSendMessages(dispatchLambda);
backend.dispatchBroadcast.addEnvironment('TABLE_NAME', pushNotTable.tableName);
backend.dispatchBroadcast.addEnvironment('OUTBOUND_QUEUE_URL', outboundMainQueue.queueUrl);

// C. Process Outbound Queue Lambda Permissions (NEW)
pushNotTable.grantReadWriteData(processOutboundLambda);
backend.processOutboundQueue.addEnvironment('TABLE_NAME', pushNotTable.tableName);

// Output endpoints and identifiers to the terminal after deployment
backend.addOutput({
  custom: {
    MetaWebhookEndpoint: webhookUrl.url,
    OutboundQueueUrl: outboundMainQueue.queueUrl,
  },
});
backend.data.resources.tables["PushNotSystem"].grantReadWriteData(
  backend.dispatchBroadcast.resources.lambda
);