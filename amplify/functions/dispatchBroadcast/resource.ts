import { defineFunction } from '@aws-amplify/backend';

export const dispatchBroadcast = defineFunction({
  name: 'dispatch-broadcast',
  entry: './handler.ts',
  resourceGroupName: 'data',
  runtime: 20,
  // 300s: supports full pagination over 60k members (Query loop) +
  // SQS SendMessageBatch loop + PutItem for the run summary record.
  // SQS visibility timeout (120s) constraint only applies to the consumer
  // Lambda (processOutboundQueue), not to this dispatcher.
  timeoutSeconds: 300,
  memoryMB: 512,
});
