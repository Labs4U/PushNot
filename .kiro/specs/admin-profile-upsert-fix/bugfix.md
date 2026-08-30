# Bugfix Requirements Document

## Introduction

On every mount of `AppShell`, `verifyOrProvisionProfile()` runs a GET-then-create pattern to ensure the admin's `PROFILE` record exists in DynamoDB. The GET can return `null` not only when the record is genuinely absent, but also when the record exists yet is invisible to the caller — due to an AppSync authorization mismatch (e.g., record written with `apiKey` auth mode but read with `userPool` auth mode) or a race condition on concurrent logins. In both of those invisible-record cases the subsequent `create()` call hits DynamoDB's implicit `attribute_not_exists(pk) AND attribute_not_exists(sk)` condition guard and throws a `ConditionalCheckFailedException` (HTTP 400), causing the dashboard to display a hard "Setup Failed" error instead of loading normally.

## Bug Analysis

### Current Behavior (Defect)

1.1 WHEN the admin's `PROFILE` record exists in DynamoDB but `client.models.PushNotSystem.get()` returns `null` due to an AppSync authorization filter mismatch (record seeded with `apiKey` auth mode, read with `userPool` auth mode) THEN the system attempts `create()`, receives a `ConditionalCheckFailedException` (HTTP 400), and sets `profileStatus` to `'error'`, blocking the dashboard from loading.

1.2 WHEN the admin's `PROFILE` record exists in DynamoDB but `client.models.PushNotSystem.get()` returns `null` due to a race condition (two concurrent `AppShell` mounts on the same account) THEN the system attempts a second `create()`, receives a `ConditionalCheckFailedException` (HTTP 400), and sets `profileStatus` to `'error'`, blocking the dashboard from loading.

1.3 WHEN the `get()` call returns `null` for any reason other than true record absence THEN the system incorrectly treats the absence as a first-login provisioning signal, causing a failed `create()` that surfaces as a terminal error to the user.

### Expected Behavior (Correct)

2.1 WHEN the admin's `PROFILE` record exists in DynamoDB but `get()` returns `null` due to an AppSync authorization filter mismatch THEN the system SHALL attempt `create()` optimistically, catch the `ConditionalCheckFailedException`, treat it as confirmation that the record already exists, and set `profileStatus` to `'ready'`.

2.2 WHEN the admin's `PROFILE` record exists in DynamoDB but `get()` returns `null` due to a race condition THEN the system SHALL attempt `create()` optimistically, catch the `ConditionalCheckFailedException`, treat it as confirmation that the record already exists, and set `profileStatus` to `'ready'`.

2.3 WHEN `create()` succeeds without error (genuine first-login provisioning) THEN the system SHALL set `profileStatus` to `'ready'`.

2.4 WHEN a `ConditionalCheckFailedException` is received (HTTP 400 with error message containing `"conditional"` or `"ConditionalCheckFailed"`) THEN the system SHALL treat it as a success state and set `profileStatus` to `'ready'` rather than `'error'`.

2.5 WHEN an error is received that is NOT a `ConditionalCheckFailedException` (e.g., network failure, auth token expiry, schema mismatch) THEN the system SHALL set `profileStatus` to `'error'` and surface the error message to the user.

### Unchanged Behavior (Regression Prevention)

3.1 WHEN the admin logs in for the first time and no `PROFILE` record exists in DynamoDB THEN the system SHALL CONTINUE TO provision a placeholder `ADMIN_PROFILE` record with all string fields set to `'PENDING_SETUP'` and transition to `profileStatus` `'ready'`.

3.2 WHEN the admin logs in and their `PROFILE` record exists AND is visible to the `userPool` auth mode GET THEN the system SHALL CONTINUE TO confirm the existing profile and set `profileStatus` to `'ready'` without attempting a `create()`.

3.3 WHEN a genuine infrastructure error occurs during provisioning (network timeout, IAM permission denial, schema error) THEN the system SHALL CONTINUE TO set `profileStatus` to `'error'` and display the "Setup Failed" screen with the error message and a "Sign Out & Retry" button.

3.4 WHEN `userId` is empty or falsy on `AppShell` mount THEN the system SHALL CONTINUE TO skip the profile probe entirely via the early-return guard.

3.5 WHEN the `profileStatus` is `'checking'` THEN the system SHALL CONTINUE TO render the loading spinner and "Verifying your account…" text rather than the dashboard.
