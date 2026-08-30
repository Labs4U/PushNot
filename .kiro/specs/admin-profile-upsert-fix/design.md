# Admin Profile Upsert Fix — Bugfix Design

## Overview

`verifyOrProvisionProfile()` in `src/App.tsx` uses a GET-then-create pattern to ensure every admin tenant has a `PROFILE` record in DynamoDB. The GET can return `null` even when the record genuinely exists — due to an AppSync auth-mode mismatch (record written with `apiKey`, read with `userPool`) or a concurrent login race condition. When `get()` returns `null` for either of these non-absence reasons, the subsequent `create()` call hits DynamoDB's implicit conditional check guard and throws a `ConditionalCheckFailedException`, which the current catch block incorrectly treats as a terminal error, blocking the dashboard.

The fix removes the GET entirely and replaces the pattern with an **optimistic-write upsert**: attempt `create()` directly, and if DynamoDB rejects it with `ConditionalCheckFailedException`, interpret that rejection as proof the record already exists and transition to `ready`. This eliminates both the extra round-trip and all race/auth-mode failure modes simultaneously.

---

## Glossary

- **Bug_Condition (C)**: The condition that triggers the bug — `get()` returns `null` for a record that already exists (due to auth-mode mismatch or race condition), causing `create()` to throw a `ConditionalCheckFailedException` that is incorrectly escalated to `profileStatus = 'error'`.
- **Property (P)**: The desired behavior when the bug condition holds — `ConditionalCheckFailedException` SHALL be treated as confirmation of existence and resolve to `profileStatus = 'ready'`.
- **Preservation**: All behaviors that must remain unchanged — genuine first-login provisioning, true infrastructure error surfacing, early-return guard, and loading spinner — must continue to work exactly as before.
- **`verifyOrProvisionProfile()`**: The async function inside the `useEffect` in `AppShell` (`src/App.tsx`, lines ~58–109) responsible for ensuring the admin's `PROFILE` record exists before rendering the dashboard.
- **`associationId`**: The DynamoDB partition key for the tenant, derived as `` `ASSOC#${userId}` ``.
- **`profileStatus`**: React state (`'checking' | 'ready' | 'error'`) that gates dashboard rendering.
- **`PENDING_SETUP`**: String sentinel value `'PENDING_SETUP'` written to all string fields of a freshly-provisioned placeholder profile.
- **`ConditionalCheckFailedException`**: DynamoDB error (HTTP 400) thrown when a `put`/`create` request violates the implicit `attribute_not_exists(pk) AND attribute_not_exists(sk)` condition, i.e., the item already exists.
- **`isConditionalCheckFailure(message)`**: Helper function that detects whether an error message string originates from a `ConditionalCheckFailedException`, regardless of how Amplify surfaces it.

---

## Bug Details

### Bug Condition

The bug manifests when `client.models.PushNotSystem.get()` returns `null` for a `PROFILE` record that physically exists in DynamoDB — either because the record was written with a different AppSync auth mode than the one used to read it, or because two concurrent `AppShell` mounts race each other. The fallthrough `create()` call then receives a `ConditionalCheckFailedException`, which the current catch block cannot distinguish from a genuine infrastructure failure, so it sets `profileStatus = 'error'` and blocks the dashboard.

**Formal Specification:**

```
FUNCTION isBugCondition(input)
  INPUT: input = { userId: string, existingRecordInDB: boolean, getReturnsNull: boolean }
  OUTPUT: boolean

  RETURN input.existingRecordInDB = true
         AND input.getReturnsNull = true
         AND profileStatus = 'error'   -- system incorrectly escalated to error
END FUNCTION
```

### Examples

- **Auth-mode mismatch**: Record created during seeding with `apiKey` auth mode. On first `userPool` login, `get()` returns `null`. `create()` fires, DynamoDB rejects with `ConditionalCheckFailedException`. Dashboard shows "Setup Failed" — **should** show the main dashboard.
- **Concurrent logins**: User opens two browser tabs simultaneously. Both mounts call `get()` → both see `null` → both call `create()`. Second `create()` receives `ConditionalCheckFailedException`. Second tab shows "Setup Failed" — **should** show the main dashboard.
- **Genuine first login**: No record exists. `get()` returns `null`. `create()` succeeds. `profileStatus` becomes `'ready'` — this path works correctly today and must continue to work after the fix.
- **Real infrastructure error**: Network timeout during `create()`. Error message does not contain `"conditional"` or `"conditioncheck"`. `profileStatus` becomes `'error'` and error message is surfaced — this path works correctly today and must be preserved.

---

## Expected Behavior

### Preservation Requirements

**Unchanged Behaviors:**

- Genuine first-login provisioning (Requirements 3.1): `create()` succeeds without error → `profileStatus = 'ready'` with a placeholder `ADMIN_PROFILE` record written.
- Existing profile fast-path (Requirement 3.2): In the new implementation the GET is removed, so this path merges into the `ConditionalCheckFailedException` success path — the observable outcome (`profileStatus = 'ready'`) remains identical.
- True infrastructure error surfacing (Requirement 3.3): Any error that is NOT a `ConditionalCheckFailedException` must still set `profileStatus = 'error'` and populate `profileError` with the message.
- Early-return guard (Requirement 3.4): `if (!userId) return;` guard remains untouched.
- Loading spinner (Requirement 3.5): `profileStatus = 'checking'` is set at the top of the function before any async work; the spinner renders as before.

**Scope:**

All code paths that do NOT involve the `ConditionalCheckFailedException` error case are unaffected. This includes:

- All four view components (`MessagesView`, campaigns, analytics, bills)
- `amplify/data/resource.ts` — schema unchanged
- `App.css` — styling unchanged
- All other mutations and queries throughout `App.tsx`

---

## Hypothesized Root Cause

1. **GET returns `null` for non-absence reasons**: AppSync's authorization filter on `get()` operates at the resolver level. A record written with `apiKey` auth mode may not be visible to a `userPool`-scoped read, causing `get()` to return `null` even though DynamoDB holds the item. The code treats every `null` return as "record does not exist."

2. **`ConditionalCheckFailedException` not distinguished in catch block**: The current `catch (err: any)` handler has no logic to inspect the error type. It routes every error to `setProfileStatus('error')`, making a "record already exists" signal indistinguishable from a "network is down" signal.

3. **Race condition on concurrent mounts**: When two `AppShell` instances initialize simultaneously (e.g., two tabs), both execute `get()` before either `create()` completes. Both see `null`, both attempt `create()`, and the second one fails with `ConditionalCheckFailedException` for the same reason as above.

4. **Amplify can surface the error two ways**: Depending on network conditions and Amplify's internal retry logic, the `ConditionalCheckFailedException` may arrive either as a populated `errors[]` array (non-throwing path) or as a thrown exception (catch block path). The fix must handle both.

---

## Correctness Properties

Property 1: Bug Condition — ConditionalCheckFailedException Resolves to Ready

_For any_ call to `verifyOrProvisionProfile()` where `create()` returns or throws a `ConditionalCheckFailedException` (error message contains `"conditional"` or `"conditioncheck"`, case-insensitive), the fixed function SHALL set `profileStatus` to `'ready'` and SHALL NOT set `profileStatus` to `'error'`, regardless of whether the error is surfaced via the `errors[]` array or as a thrown exception.

**Validates: Requirements 2.1, 2.2, 2.4**

Property 2: Preservation — Non-Conditional Errors Still Escalate

_For any_ call to `verifyOrProvisionProfile()` where `create()` returns or throws an error whose message does NOT contain `"conditional"` or `"conditioncheck"`, the fixed function SHALL set `profileStatus` to `'error'` and SHALL populate `profileError` with the error message, preserving the existing infrastructure-failure surfacing behavior.

**Validates: Requirements 2.5, 3.3**

---

## Fix Implementation

### Changes Required

**File**: `src/App.tsx`

**Function**: `verifyOrProvisionProfile()` inside `useEffect` in `AppShell`

**Specific Changes**:

1. **Remove the GET call**: Delete the `client.models.PushNotSystem.get()` call and its associated `getErrors` guard and `existingProfile` branch (lines ~62–80). The two-step pattern becomes a single step.

2. **Attempt `create()` directly**: Call `client.models.PushNotSystem.create()` with the same payload as today — `pk`, `sk`, `entityType`, and the four `PENDING_SETUP` fields — as the first and only async operation.

3. **Check `errors[]` for conditional failure**: After `create()`, if `createErrors` is non-empty, call `isConditionalCheckFailure(errorMessage)`. If it returns `true`, log success and call `setProfileStatus('ready')`. If `false`, throw the error to escalate.

4. **Mirror the check in the catch block**: In `catch (err: any)`, call `isConditionalCheckFailure(err.message ?? '')` before routing to `setProfileStatus('error')`. If the check passes, log success and call `setProfileStatus('ready')` instead.

5. **Add `isConditionalCheckFailure` helper**: Define the helper function outside `AppShell` (module-level) so it is pure and easily testable:

   ```typescript
   function isConditionalCheckFailure(message: string): boolean {
     const lower = message.toLowerCase();
     return lower.includes('conditional') || lower.includes('conditioncheck');
   }
   ```

6. **No other files change**: `amplify/data/resource.ts`, all view components, and `App.css` are untouched.

---

## Testing Strategy

### Validation Approach

Testing follows a two-phase approach: first, surface counterexamples on the **unfixed** code to confirm the root cause; then verify the fix and preservation on the **fixed** code.

---

### Exploratory Bug Condition Checking

**Goal**: Surface counterexamples that demonstrate the bug BEFORE applying the fix. Confirm or refute the hypothesized root cause. If refuted, re-hypothesize before implementing.

**Test Plan**: Mock `client.models.PushNotSystem.create()` to return a `ConditionalCheckFailedException` in both the `errors[]` path and the thrown-exception path. Assert that on unfixed code, `profileStatus` ends up as `'error'`. This confirms the bug.

**Test Cases**:

1. **`errors[]` path on unfixed code**: Mock `create()` to return `{ errors: [{ message: 'ConditionalCheckFailedException: ...' }] }`. Assert `profileStatus === 'error'` (will fail/show bug on unfixed code, should become `'ready'` after fix).
2. **Thrown-exception path on unfixed code**: Mock `create()` to `throw new Error('conditional check failed')`. Assert `profileStatus === 'error'` (will fail/show bug on unfixed code, should become `'ready'` after fix).
3. **Concurrent race simulation**: Invoke `verifyOrProvisionProfile()` twice concurrently; mock the second `create()` to return `ConditionalCheckFailedException`. Assert both calls resolve to `'ready'` after fix.

**Expected Counterexamples**:
- `profileStatus` is set to `'error'` when `ConditionalCheckFailedException` is received.
- Possible causes: no error-type discrimination in the catch block, `errors[]` not inspected before throwing.

---

### Fix Checking

**Goal**: Verify that for all inputs where the bug condition holds, the fixed function produces `profileStatus = 'ready'`.

**Pseudocode:**

```
FOR ALL input WHERE isBugCondition(input) DO
  result := verifyOrProvisionProfile_fixed(input)
  ASSERT result.profileStatus = 'ready'
  ASSERT result.profileError = ''   -- no error surfaced
END FOR
```

---

### Preservation Checking

**Goal**: Verify that for all inputs where the bug condition does NOT hold, the fixed function produces the same result as the original.

**Pseudocode:**

```
FOR ALL input WHERE NOT isBugCondition(input) DO
  ASSERT verifyOrProvisionProfile_original(input) = verifyOrProvisionProfile_fixed(input)
END FOR
```

**Testing Approach**: Property-based testing is recommended for preservation checking because:
- It generates many test cases automatically across the error-message input space.
- It guards against future error-message format changes from Amplify accidentally matching the conditional-check detection strings.
- It provides strong guarantees that no non-conditional error is silently swallowed.

**Test Cases**:

1. **Genuine first login (create succeeds)**: Mock `create()` to return `{ errors: [] }`. Verify `profileStatus === 'ready'` after fix — same as before.
2. **Network timeout**: Mock `create()` to throw `Error('Network request failed')`. Verify `profileStatus === 'error'` and `profileError` contains the message — same as before.
3. **Auth token expiry**: Mock `create()` to return `{ errors: [{ message: 'UnauthorizedException: ...' }] }`. Verify `profileStatus === 'error'` — same as before.
4. **`userId` guard**: Call with `userId = ''`. Verify `verifyOrProvisionProfile` exits early without calling `create()` — same as before.

---

### Unit Tests

- Test `isConditionalCheckFailure()` with `"ConditionalCheckFailedException"`, `"conditional check failed"`, `"conditioncheck"`, empty string, and a generic error message.
- Test `verifyOrProvisionProfile()` with `create()` mocked to return conditional-check error via `errors[]` → expect `'ready'`.
- Test `verifyOrProvisionProfile()` with `create()` mocked to throw conditional-check error → expect `'ready'`.
- Test `verifyOrProvisionProfile()` with `create()` mocked to succeed → expect `'ready'`.
- Test `verifyOrProvisionProfile()` with `create()` mocked to return a non-conditional error → expect `'error'` with correct message.

### Property-Based Tests

- Generate random error messages that do NOT contain `"conditional"` or `"conditioncheck"` and assert `isConditionalCheckFailure` returns `false` for all of them (preservation: no false positives).
- Generate random error messages that DO contain `"conditional"` (any casing) and assert `isConditionalCheckFailure` returns `true` (fix checking: all true positives caught).
- Generate random non-empty `userId` values and verify `create()` is always called exactly once (no GET call ever made after the fix).

### Integration Tests

- Full `AppShell` render with mocked Amplify client: simulate auth-mode-mismatch scenario and verify dashboard loads without "Setup Failed" screen.
- Full `AppShell` render with mocked Amplify client: simulate genuine first login and verify placeholder profile is created and dashboard loads.
- Full `AppShell` render with mocked Amplify client: simulate network error and verify "Setup Failed" screen appears with correct error message.
