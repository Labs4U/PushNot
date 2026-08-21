# Push Notification System - Project Steering Rules

## 1. Tech Stack & Architecture
* **Frontend:** React, TypeScript, Vite.
* **Backend:** AWS Amplify Gen 2 (Code-first architecture).
* **API Layer:** Always use **AWS AppSync** (GraphQL) via the Amplify `generateClient` data client for all data fetching and mutations unless strictly infeasible. Do not default to raw REST calls for database operations.

## 2. Database & Data Access (Strict)
* **Single Table Design:** All data is modeled in a DynamoDB Single Table pattern.
* **Zero Scans:** Absolutely no DynamoDB table scans are permitted.
* **Targeting Indexes:** All AppSync queries must strictly target predefined Global Secondary Indexes (GSIs).
* **Index Filtering:** Use the GSI hash key for strict equality and the sort key exclusively for flexible filtering operations like `beginsWith`, `eq`, `between`, or `gt`.
* **Key Formatting:** Composite keys must always use the `#` separator to separate attributes (e.g., `ASSOC#<id>`, `CAMPRUN#<camp_id>#<timestamp>`, `MEMBER#<phone>`).

## 3. Multi-Tenancy & Subscriptions
* **Tenant Isolation:** Association data must be strictly isolated. Enforce this at the schema level using Cognito `groupsDefinedIn('associationId')` authorization rules.
* **Real-Time Data:** Implement real-time dashboard updates (e.g., payment status, member replies) exclusively using AppSync `observeQuery` subscriptions to avoid manual polling.

## 4. UI/UX & Styling
* **Styling constraints:** Use standard vanilla CSS in an external `.css` file. Do not install, configure, or migrate the project to Tailwind, MUI, Bootstrap, or any other external styling framework.
* **Componentization:** Build modular, multi-tab interfaces using standard React state. Use dummy HTML/CSS visual placeholders for complex elements like charts before suggesting external charting libraries.

## 5. Integrations & Background Processing
* **Event Buffering:** High-throughput operations (like dispatching 60k messages) must utilize an Amazon SQS Buffer bound to a Dead Letter Queue (DLQ). 
* **Messaging APIs:** Meta WhatsApp Cloud API v24.0 outbound integrations must be orchestrated through AWS Lambda workers.
* **AI Agents:** Use native AWS agentic components deployed via custom AppSync mutations.