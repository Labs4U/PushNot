import { defineBackend } from '@aws-amplify/backend';
import { FunctionUrlAuthType } from 'aws-cdk-lib/aws-lambda';
import { Queue } from 'aws-cdk-lib/aws-sqs';
import { Duration } from 'aws-cdk-lib';
import { auth } from './auth/resource';
import { data } from './data/resource';
import { whatsappWebhook } from './functions/whatsapp/resource';
import { dispatchBroadcast } from './functions/dispatchBroadcast/resource';

const backend = defineBackend({
  auth,
  data,
  whatsappWebhook,
  dispatchBroadcast,
});

// 1. Get the underlying CDK constructs
const webhookLambda = backend.whatsappWebhook.resources.lambda;
const dispatchLambda = backend.dispatchBroadcast.resources.lambda;

// Access the DynamoDB table from the data backend
// In Amplify Gen 2, the table is created within the data backend stack
const dataTables = backend.data.resources.tables;
const pushNotTable = Object.values(dataTables)[0]; // Get the unified PushNotSystem table

// Create a custom stack for the messaging infrastructure (SQS Queues)
const customStack = backend.createStack('MessagingInfrastructure');

// 2. Attach a public Function URL for the Meta Inbound Webhook
const webhookUrl = webhookLambda.addFunctionUrl({
  authType: FunctionUrlAuthType.NONE,
});

// 3. Configure the Outbound SQS Buffer Queue for 60k broadcasts
const outboundMainQueue = new Queue(customStack, 'OutboundBroadcastQueue', {
  queueName: 'outbound-broadcast-queue',
  visibilityTimeout: Duration.seconds(30),
});

// 4. Grant Permissions & Inject Environment Variables

// A. Inbound Webhook Lambda Permissions
pushNotTable.grantReadWriteData(webhookLambda);
backend.whatsappWebhook.addEnvironment('TABLE_NAME', pushNotTable.tableName);

// B. Dispatch Broadcast Lambda Permissions
pushNotTable.grantReadData(dispatchLambda);
outboundMainQueue.grantSendMessages(dispatchLambda);
backend.dispatchBroadcast.addEnvironment('TABLE_NAME', pushNotTable.tableName);
backend.dispatchBroadcast.addEnvironment('OUTBOUND_QUEUE_URL', outboundMainQueue.queueUrl);

// 5. Output endpoints and identifiers to the terminal after deployment
backend.addOutput({
  custom: {
    MetaWebhookEndpoint: webhookUrl.url,
    OutboundQueueUrl: outboundMainQueue.queueUrl,
  },
});
