/**
 * Session-affinity hardening:
 * 1. The Responses-API `input[]` hash fallback keys on the first `role:"user"` item,
 *    so unrelated sessions sharing an identical leading developer/env-context item
 *    no longer collapse onto one pin.
 * 2. Content-derived (`input:`) keys are scoped per API key; explicit session ids
 *    (prompt_cache_key, headers, metadata) pass through unchanged.
 * 3. Cursor participates in session affinity like any other provider (no exclusion).
 * 4. The "no available affinity target" log only fires when affinity is enabled.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-affinity-hardening-"));
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.API_KEY_SECRET = process.env.API_KEY_SECRET || "affinity-hardening-test-secret";

const core = await import("../../src/lib/db/core.ts");
const providersDb = await import("../../src/lib/db/providers.ts");
const settingsDb = await import("../../src/lib/db/settings.ts");
const apiKeysDb = await import("../../src/lib/db/apiKeys.ts");
const affinityDb = await import("../../src/lib/db/sessionAccountAffinity.ts");
const auth = await import("../../src/sse/services/auth.ts");
const { extractSessionAffinityKey, scopeSessionAffinityKey } =
  await import("../../src/sse/services/sessionAffinityPin.ts");

async function resetStorage() {
  core.resetDbInstance();
  apiKeysDb.resetApiKeyState();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
}

async function seedConnection(provider: string, name: string) {
  return providersDb.createProviderConnection({
    provider,
    authType: "api_key",
    name,
    accessToken: `at-${Math.random().toString(16).slice(2, 10)}`,
    isActive: true,
    testStatus: "active",
    providerSpecificData: {},
  });
}

test.beforeEach(async () => {
  await resetStorage();
});

test.after(async () => {
  core.resetDbInstance();
  apiKeysDb.resetApiKeyState();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

// ── 1. input[] hash prefers the first user item ─────────────────────────────

const sharedDeveloperItem = {
  role: "developer",
  content: [{ type: "input_text", text: "<environment_context>cwd=/repo</environment_context>" }],
};

test("input[] hash ignores a shared leading developer item and keys on the user turn", () => {
  const keyA = extractSessionAffinityKey({
    input: [sharedDeveloperItem, { role: "user", content: "fix the login bug" }],
  });
  const keyB = extractSessionAffinityKey({
    input: [sharedDeveloperItem, { role: "user", content: "write release notes" }],
  });
  assert.ok(keyA?.startsWith("input:sha256:"));
  assert.ok(keyB?.startsWith("input:sha256:"));
  assert.notEqual(keyA, keyB, "different user turns must not share a pin");
});

test("input[] hash is stable for the same user turn regardless of leading context", () => {
  const keyA = extractSessionAffinityKey({
    input: [sharedDeveloperItem, { role: "user", content: "same prompt" }],
  });
  const keyB = extractSessionAffinityKey({
    input: [{ role: "user", content: "same prompt" }],
  });
  assert.equal(keyA, keyB);
});

test("input[] without any user item still falls back to the first text item", () => {
  const key = extractSessionAffinityKey({ input: [sharedDeveloperItem] });
  assert.ok(key?.startsWith("input:sha256:"));
});

test("prompt_cache_key still wins over the input hash", () => {
  const key = extractSessionAffinityKey({
    prompt_cache_key: "conv-123",
    input: [{ role: "user", content: "hello" }],
  });
  assert.equal(key, "prompt-cache:conv-123");
});

// ── 2. API-key scoping of content-derived keys ──────────────────────────────

test("scopeSessionAffinityKey prefixes only input: keys with the API key id", () => {
  assert.equal(scopeSessionAffinityKey("input:sha256:abc", "key-1"), "key:key-1:input:sha256:abc");
  assert.equal(scopeSessionAffinityKey("prompt-cache:conv-123", "key-1"), "prompt-cache:conv-123");
  assert.equal(scopeSessionAffinityKey("header:sess-9", "key-1"), "header:sess-9");
  assert.equal(scopeSessionAffinityKey("input:sha256:abc", null), "input:sha256:abc");
  assert.equal(scopeSessionAffinityKey(null, "key-1"), null);
});

test("identical first-turn text under different API keys yields different keys", () => {
  const raw = extractSessionAffinityKey({ input: [{ role: "user", content: "smoke test" }] });
  assert.notEqual(scopeSessionAffinityKey(raw, "key-a"), scopeSessionAffinityKey(raw, "key-b"));
});

// ── 3. cursor participates in session affinity ──────────────────────────────

test("cursor: a request with a session key pins and reuses the same connection", async () => {
  await settingsDb.updateSettings({ sessionAffinityTtlMs: 60_000 });
  const connections = [];
  for (let i = 0; i < 3; i++) connections.push(await seedConnection("cursor", `cursor-${i}`));

  const first = await auth.getProviderCredentials("cursor", null, null, "claude-4.5-sonnet", {
    sessionKey: "prompt-cache:cursor-session",
  });
  assert.ok(first?.connectionId, "first request must resolve a cursor connection");
  assert.equal(
    affinityDb.getSessionAccountAffinity("prompt-cache:cursor-session", "cursor", 60_000)
      ?.connectionId,
    first.connectionId,
    "a pin must be persisted for cursor"
  );

  for (let i = 0; i < 3; i++) {
    const next = await auth.getProviderCredentials("cursor", null, null, "claude-4.5-sonnet", {
      sessionKey: "prompt-cache:cursor-session",
    });
    assert.equal(next?.connectionId, first.connectionId, "same session reuses pinned connection");
  }

  // A combo re-score forcing another connection must not break the pin.
  const other = connections.find((c) => c.id !== first.connectionId)!;
  const forced = await auth.getProviderCredentials("cursor", null, null, "claude-4.5-sonnet", {
    sessionKey: "prompt-cache:cursor-session",
    forcedConnectionId: other.id,
  });
  assert.equal(forced?.connectionId, first.connectionId);
});

// ── 4. log gating ───────────────────────────────────────────────────────────

test("'no available affinity target' log is gated on an enabled TTL", () => {
  const source = fs.readFileSync(path.join(process.cwd(), "src/sse/services/auth.ts"), "utf8");
  assert.match(
    source,
    /else if \(options\.sessionKey && sessionAffinityTtlMs > 0\) \{\s*log\.info\(\s*"AUTH",\s*`[^`]*has no available affinity target`/
  );
  assert.match(source, /affinity disabled \(ttl=0\)/);
});
