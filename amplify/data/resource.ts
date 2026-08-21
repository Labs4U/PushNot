import { type ClientSchema, a, defineData } from '@aws-amplify/backend';
import { dispatchBroadcast } from '../functions/dispatchBroadcast/resource';

const schema = a.schema({
  // =====================================================================
  // UNIFIED SINGLE TABLE DESIGN: PushNotSystem
  // =====================================================================
  // All campaign and member data flows through a single table with:
  // - Composite PK/SK for entity isolation
  // - GSI1 for webhook-based queries (by WhatsApp message ID)
  // - GSI2 for flexible secondary filtering
  // - EntityType discriminator for entity classification
  //
  // Key Formats:
  // Campaign:     pk="ASSOC#<id>", sk="CAMPRUN#<id>#METADATA"
  // Member:       pk="CAMPRUN#<id>", sk="MEMBER#<phone>"
  // =====================================================================
  PushNotSystem: a
    .model({
      // ===== Primary Key (Composite) =====
      pk: a.string().required(),           // Partition Key (e.g., "ASSOC#101" or "CAMPRUN#123")
      sk: a.string().required(),           // Sort Key (e.g., "CAMPRUN#123#METADATA" or "MEMBER#+1234567890")

      // ===== Entity Type Discriminator =====
      entityType: a.string().required(),   // "CAMPAIGN", "MEMBER", etc.

      // ===== Global Secondary Index Keys =====
      gsi1pk: a.string(),                  // GSI1 Partition (e.g., WhatsApp Message ID)
      gsi1sk: a.string(),                  // GSI1 Sort (optional, for compound queries)
      gsi2pk: a.string(),                  // GSI2 Partition (flexible, e.g., "ASSOC#101" for listing all campaigns)
      gsi2sk: a.string(),                  // GSI2 Sort (optional, e.g., createdAt for sorted results)

      // ===== Campaign Master Attributes =====
      title: a.string(),
      type: a.string(),                    // e.g., "ANNOUNCEMENT", "PROMOTION"
      templateName: a.string(),            // e.g., "standard_alert", "payment_reminder"
      status: a.string(),                  // e.g., "DRAFT", "QUEUED", "SENT", "COMPLETED"

      // ===== Member/Delivery State Attributes =====
      deliveryStatus: a.string(),          // e.g., "SENT", "DELIVERED", "READ", "FAILED"
      statusWeight: a.integer(),           // Numeric weight for analytics aggregation

      // ===== WhatsApp Webhook Integration =====
      whatsappMessageId: a.string(),       // Unique WAMID from Meta (for GSI1 queries)
      inboundReplyText: a.string(),        // User's inbound message reply

      // ===== Payment State =====
      paymentStatusSort: a.string(),       // Composite: "STATUS#PAID#<timestamp>" or "STATUS#PENDING#<timestamp>"
      paymentAmount: a.float(),

      // ===== Timestamps =====
      createdAt: a.datetime(),
      updatedAt: a.datetime(),
    })
    // Define composite primary key
    .identifier(['pk', 'sk'])

    // Define Global Secondary Indexes (GSIs) for zero-scan queries
    .secondaryIndexes((index) => [
      // GSI 1: Webhook Resolver – Query by WhatsApp Message ID (e.g., incoming webhook from Meta)
      index('gsi1pk').sortKeys(['gsi1sk']).queryField('getByWhatsAppMessageId'),

      // GSI 2: Flexible Secondary Queries – Query by gsi2pk (e.g., all campaigns for an association)
      index('gsi2pk').sortKeys(['gsi2sk']).queryField('listByGsi2pk'),

      // GSI 3: Alternative PK Queries – Query by primary pk with sort key filtering
      index('pk').sortKeys(['sk']).queryField('listByPk'),
    ])

    // Authorization: Standard authenticated users and public API key access
    // No groupsDefinedIn() to avoid implicit field conflicts
    .authorization((allow) => [
      allow.authenticated().to(['create', 'read', 'update', 'delete']),
      allow.publicApiKey().to(['create', 'read', 'update', 'delete']),
    ]),

  // =====================================================================
  // ORCHESTRATION MUTATIONS
  // =====================================================================

  // Mutation 1: Trigger Campaign Broadcast
  // Routes to dispatchBroadcast Lambda to queue 60k+ messages via SQS
  triggerCampaignBroadcast: a
    .mutation()
    .arguments({
      associationId: a.string().required(),
      campaignRunId: a.string().required(),
    })
    .returns(a.json())
    .authorization((allow) => [allow.authenticated()])
    .handler(a.handler.function(dispatchBroadcast)),

  // Mutation 2: Chat with Campaign Agent
  // Routes to Strands SDK AgentCore Lambda for AI-powered message drafting
  // PLACEHOLDER: Uncomment and add handler once chatAgent Lambda resource is defined
  // chatWithCampaignAgent: a
  //   .mutation()
  //   .arguments({
  //     associationId: a.string().required(),
  //     memberPhone: a.string().required(),
  //     messageText: a.string().required(),
  //   })
  //   .returns(a.string())
  //   .authorization((allow) => [allow.authenticated()])
  //   .handler(a.handler.function(chatAgent)),
});

export type Schema = ClientSchema<typeof schema>;

export const data = defineData({
  schema,
  authorizationModes: {
    defaultAuthorizationMode: 'userPool',
    apiKeyAuthorizationMode: {
      expiresInDays: 365,
    },
  },
});
