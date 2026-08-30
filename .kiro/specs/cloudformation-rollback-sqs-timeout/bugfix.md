# Bugfix Requirements Document

## Introduction

CloudFormation deployment fails during the CREATE_FAILED phase of SQS Event Source mapping. The root cause is a critical mismatch between SQS visibility timeout configuration and Lambda timeout specifications, combined with missing IAM permissions and inconsistent DynamoDB table references. The SQS queue has a 30-second visibility timeout while the Lambda consumer has a 60-second timeout, violating AWS constraints that require visibility timeout to exceed Lambda timeout plus a safety buffer. Additionally, the processOutboundQueue Lambda lacks permission to consume messages from the queue, and there are redundant/conflicting table references in the backend infrastructure code.

## Bug Analysis

### Current Behavior (Defect)

1.1 WHEN `OutboundBroadcastQueue` has `visibilityTimeout: Duration.seconds(30)` AND the `processOutboundQueue` Lambda has `timeoutSeconds: 60` THEN CloudFormation fails to create the SqsEventSource mapping with a validation error

1.2 WHEN deploying infrastructure to AWS THEN the SqsEventSource mapping is rejected because visibility timeout (30s) is not greater than Lambda timeout (60s)

1.3 WHEN `processOutboundQueue` Lambda attempts to read messages from the SQS queue THEN the Lambda is denied permission because it lacks the `sqs:ReceiveMessage` and `sqs:DeleteMessage` permissions (no `grantConsumeMessages()` call)

1.4 WHEN backend.ts references the PushNotSystem table THEN the code uses both `Object.values(dataTables)[0]` (line 31) and `backend.data.resources.tables["PushNotSystem"]` (line 74), creating inconsistent reference patterns and redundant permission grants

1.5 WHEN CloudFormation processes the backend stack THEN redundant `grantReadWriteData()` call on line 74 duplicates permissions already granted on line 65, creating confusion about the actual permission state

### Expected Behavior (Correct)

2.1 WHEN `OutboundBroadcastQueue` is created AND `processOutboundQueue` Lambda is attached as an SqsEventSource THEN the SQS visibility timeout MUST be greater than the Lambda timeout (with safety buffer), allowing CloudFormation to successfully create the mapping

2.2 WHEN deploying infrastructure to AWS THEN CloudFormation successfully provisions the SqsEventSource mapping without validation errors

2.3 WHEN `processOutboundQueue` Lambda attempts to read messages from the SQS queue THEN the Lambda has explicit permission to receive and delete messages via `grantConsumeMessages()`

2.4 WHEN backend.ts references the PushNotSystem table THEN the code uses a single, consistent reference pattern (explicit table name `backend.data.resources.tables["PushNotSystem"]`) throughout

2.5 WHEN CloudFormation processes the backend stack THEN each permission grant is applied exactly once with no redundancy or duplication

### Unchanged Behavior (Regression Prevention)

3.1 WHEN `webhookLambda` (whatsapp inbound handler) needs to read/write to the PushNotSystem table THEN the system SHALL CONTINUE TO grant read/write permissions via `grantReadWriteData()`

3.2 WHEN `dispatchLambda` (broadcast dispatcher) needs to send messages to OutboundBroadcastQueue THEN the system SHALL CONTINUE TO grant send permissions via `grantSendMessages()`

3.3 WHEN `processOutboundQueue` Lambda needs to read/write to the PushNotSystem table THEN the system SHALL CONTINUE TO grant read/write permissions via `grantReadWriteData()`

3.4 WHEN environment variables are injected into Lambda functions THEN the system SHALL CONTINUE TO provide correct table names and queue URLs via `addEnvironment()`

3.5 WHEN CloudFormation backend stack initializes THEN all Lambda functions AND their required resources (tables, queues) SHALL CONTINUE TO be properly registered and available
