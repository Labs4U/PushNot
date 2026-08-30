import { defineFunction, secret } from '@aws-amplify/backend';

export const whatsappWebhook = defineFunction({
  name: 'whatsapp-webhook',
  entry: './handler.ts',
  resourceGroupName: 'data',
  timeoutSeconds: 29,   // Function URL default limit is 29s; webhook must respond quickly
  runtime: 20,
  environment: {
    // Pulled securely from AWS Secrets Manager at runtime
    META_VERIFY_TOKEN:    secret('META_VERIFY_TOKEN'),
    META_APP_SECRET:      secret('META_APP_SECRET'),
    WHATSAPP_ACCESS_TOKEN: secret('WHATSAPP_ACCESS_TOKEN'),
  },
});
