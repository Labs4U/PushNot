import { defineFunction } from '@aws-amplify/backend';

export const dispatchBroadcast = defineFunction({
  name: 'dispatch-broadcast',
  entry: './handler.ts',
  resourceGroupName: 'data',
  runtime:20,
  timeoutSeconds: 60, // Give it time to paginate through 60k members
  memoryMB: 512,      // Slight memory bump for array processing
});
