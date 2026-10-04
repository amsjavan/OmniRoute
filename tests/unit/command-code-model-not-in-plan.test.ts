// Command Code answers a plan-restricted model with 403
// `MODEL_NOT_IN_PLAN: <model> available in Pro and above plans ...`. Only that
// model is outside the plan — the same key keeps serving DeepSeek/Kimi/GLM/...
// Before the fix the generic apikey-403 path classified it as auth_error and
// cooled the WHOLE connection with exponential backoff, and the chat-shape body
// (`code: "FORBIDDEN"`) counted as a key credential failure (2 in a row → key
// marked invalid). It must be a model-only lockout that never touches the key.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-cc-not-in-plan-"));
process.env.DATA_DIR = TEST_DATA_DIR;

const core = await import("../../src/lib/db/core.ts");
const providersDb = await import("../../src/lib/db/providers.ts");
const auth = await import("../../src/sse/services/auth.ts");
const accountFallback = await import("../../open-sse/services/accountFallback.ts");
const { isModelNotInPlanError } = await import("../../open-sse/config/providerErrorRules.ts");
const { recordKeyHealthStatus } = await import("../../open-sse/handlers/chatCore/keyHealth.ts");
const apiKeyRotator = await import("../../open-sse/services/apiKeyRotator.ts");

const CHAT_403 = JSON.stringify({
  error: {
    message: "MODEL_NOT_IN_PLAN: GPT-5.5 available in Pro and above plans or extra on demand usage",
    type: "permission_error",
    code: "FORBIDDEN",
  },
});
const MESSAGES_403 = JSON.stringify({
  type: "error",
  error: {
    type: "permission_error",
    message:
      "MODEL_NOT_IN_PLAN: Claude Haiku 4.5 available in Pro and above plans or extra on demand usage",
  },
});

async function resetStorage() {
  accountFallback.clearAllModelLockouts();
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
}

async function createCommandCodeConnection() {
  return (await providersDb.createProviderConnection({
    provider: "command-code",
    authType: "apikey",
    name: "main",
    apiKey: "cc_test_key",
    isActive: true,
    testStatus: "active",
  })) as { id: string };
}

test.after(() => {
  accountFallback.clearAllModelLockouts();
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

test("isModelNotInPlanError matches both Command Code 403 shapes and nothing else", () => {
  assert.equal(isModelNotInPlanError(403, CHAT_403), true);
  assert.equal(isModelNotInPlanError(403, MESSAGES_403), true);
  assert.equal(isModelNotInPlanError(403, JSON.parse(CHAT_403)), true);
  assert.equal(isModelNotInPlanError(400, CHAT_403), false, "403 only");
  assert.equal(isModelNotInPlanError(403, '{"error":{"message":"Invalid API key"}}'), false);
  assert.equal(isModelNotInPlanError(403, "forbidden"), false);
});

for (const [label, body, model] of [
  ["chat/completions", CHAT_403, "gpt-5.5"],
  ["messages", MESSAGES_403, "claude-haiku-4-5-20251001"],
] as const) {
  test(`markAccountUnavailable: command-code 403 MODEL_NOT_IN_PLAN (${label}) locks only the model`, async () => {
    await resetStorage();
    const conn = await createCommandCodeConnection();

    const result = await auth.markAccountUnavailable(conn.id, 403, body, "command-code", model);
    const after = await providersDb.getProviderConnectionById(conn.id);
    const lockout = accountFallback.getModelLockoutInfo("command-code", conn.id, model);

    assert.equal(result.shouldFallback, true);
    assert.ok(result.cooldownMs > 0);
    // Connection untouched: no cooldown, no backoff, not terminal.
    assert.equal(after.testStatus, "active");
    assert.ok(!after.rateLimitedUntil, "connection must not be cooled down");
    assert.ok(!after.backoffLevel, "connection backoff must not grow");
    assert.equal(after.lastErrorType, "forbidden");
    assert.match(String(after.lastError), /MODEL_NOT_IN_PLAN/);
    // Model-scoped lock only.
    assert.equal(lockout?.reason, "forbidden");
    assert.equal(
      accountFallback.getModelLockoutInfo("command-code", conn.id, "deepseek/deepseek-v4-flash"),
      null,
      "sibling models stay unlocked"
    );

    // The same connection is still selectable for an in-plan model.
    const creds = await auth.getProviderCredentials(
      "command-code",
      null,
      null,
      "deepseek/deepseek-v4-flash"
    );
    assert.equal(creds?.connectionId, conn.id);
  });
}

test("markAccountUnavailable: a generic command-code 403 keeps the existing connection-level handling", async () => {
  await resetStorage();
  const conn = await createCommandCodeConnection();

  await auth.markAccountUnavailable(
    conn.id,
    403,
    '{"error":{"message":"Invalid API key","code":"FORBIDDEN"}}',
    "command-code",
    "gpt-5.5"
  );
  const after = await providersDb.getProviderConnectionById(conn.id);
  assert.equal(accountFallback.getModelLockoutInfo("command-code", conn.id, "gpt-5.5"), null);
  assert.ok(after.rateLimitedUntil, "non-plan 403 still cools the connection as before");
});

function primaryHealth(connectionId: string) {
  const all = apiKeyRotator.getAllKeyHealth();
  const key = Object.keys(all).find((k) => k.includes(connectionId) && k.includes("primary"));
  return key ? all[key] : undefined;
}

test("recordKeyHealthStatus: MODEL_NOT_IN_PLAN is not a credential failure (key never invalidated)", () => {
  const connectionId = "cc-keyhealth-conn";
  const creds = { connectionId, apiKey: "cc_test_key", providerSpecificData: {} };
  for (let i = 0; i < 3; i++) {
    recordKeyHealthStatus(403, creds, null, undefined, CHAT_403);
    recordKeyHealthStatus(403, creds, null, undefined, MESSAGES_403);
  }
  const health = primaryHealth(connectionId);
  assert.ok(
    !health || health.status === "active",
    `key health must stay healthy, got ${health?.status}`
  );

  // Control: a real credential 403 still counts.
  recordKeyHealthStatus(403, creds, null, undefined, '{"error":{"message":"Invalid API key"}}');
  recordKeyHealthStatus(403, creds, null, undefined, '{"error":{"message":"Invalid API key"}}');
  assert.equal(primaryHealth(connectionId)?.status, "invalid");
});
