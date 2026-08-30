import { defineFunction, secret } from '@aws-amplify/backend';

export const whatsappWebhook = defineFunction({
  name: 'whatsapp-webhook',
  entry: './handler.ts',
  resourceGroupName: 'data',
  timeoutSeconds: 60,
  runtime:20,
  environment: {
    // These pull securely from AWS Secrets Manager
    META_VERIFY_TOKEN: secret('META_VERIFY_TOKEN'),
    META_APP_SECRET: secret('META_APP_SECRET'),
    WHATSAPP_ACCESS_TOKEN: secret('WHATSAPP_ACCESS_TOKEN'),
  },
});
