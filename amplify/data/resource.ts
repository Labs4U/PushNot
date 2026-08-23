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
  PushNotSystem: a.model({
    // --- 1. Base Table Keys (Tenant Isolation) ---
    pk: a.string().required(), // e.g., ASSOC#101
    sk: a.string().required(), // e.g., META, MEM#973..., CAMP#01, CAMP#01#973...
    
    // --- 2. GSI 1: Webhook Routing & Status Index ---
    gsi1pk: a.string(),        // e.g., MSG#wamid.12345 (for webhooks) OR ASSOC#101
    gsi1sk: a.string(),        // e.g., STATUS#RUNNING (for filtering campaigns)
    
    // --- 3. GSI 2: Member History Index ---
    gsi2pk: a.string(),        // e.g., ASSOC#101#MEM#97333787388
    gsi2sk: a.string(),        // e.g., CAMP#01
    
    // --- 4. Entity Type Classifier ---
    entityType: a.string().required(), // 'ASSOCIATION' | 'MEMBER' | 'CAMPAIGN' | 'CAMPAIGN_RUN'

    // --- 5. Shared / Profile Attributes ---
    name: a.string(),          // Member or Association name
    phone: a.string(),         // Member phone number
    address: a.string(),
    optIn: a.boolean(),        // Global opt-in for the member

    // --- 6. Campaign Attributes ---
    title: a.string(),
    description: a.string(),
    templateName: a.string(),
    status: a.string(),        // 'DRAFT', 'RUNNING', 'COMPLETED'
    type: a.string(),          // 'ANNOUNCEMENT', 'FUNDRAISER'
    targetAmount: a.float(),   // Overall campaign goal

    // --- 7. Campaign Run (Target/Ledger) Attributes ---
    deliveryStatus: a.string(),// 'QUEUED', 'SENT', 'DELIVERED', 'READ'
    whatsappMessageId: a.string(), 
    paymentStatus: a.string(), // 'PENDING', 'LINK_SENT', 'PAID'
    paymentAmount: a.float(),  // Amount actually paid by this member
    inboundReplyText: a.string(), // If they reply with text instead of a button
    paymentLinkSentAt: a.datetime(), // Idempotency check to prevent duplicate links
    isRead: a.boolean(),
    hasPaid: a.boolean(),
    hasReplied: a.boolean(),
    
  })
  .identifier(['pk', 'sk'])
  .secondaryIndexes((index) => [
    // Index 1: Find Active Campaigns OR Find Message by WAMID
    index('gsi1pk').sortKeys(['gsi1sk']).name('ByStatusOrWamid'),
    
    // Index 2: Find all Campaign participation for a single Member
    index('gsi2pk').sortKeys(['gsi2sk']).name('ByMemberHistory')
  ])
  .authorization((allow) => [
    allow.publicApiKey().to(['create', 'read', 'update', 'delete']),
    allow.authenticated()
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
    .authorization((allow) => [
      allow.authenticated(),
      allow.publicApiKey(), 
    ])
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
