import { defineFunction, secret } from '@aws-amplify/backend';

export const processOutboundQueue = defineFunction({
  name: 'processOutboundQueue',
  entry: './handler.ts',
  timeoutSeconds: 60,
  runtime:20, 
  environment: {
    // Inject secrets securely into the runtime
    WHATSAPP_ACCESS_TOKEN: secret('WHATSAPP_ACCESS_TOKEN'),
    WHATSAPP_PHONE_ID: secret('WHATSAPP_PHONE_ID'), // Create this secret next
  },
});