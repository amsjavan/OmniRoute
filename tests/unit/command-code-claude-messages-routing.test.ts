// @ts-nocheck
// Command Code serves every claude-* model ONLY on the Anthropic Messages
// endpoint (live catalog: supported_endpoints ["/messages"]); sending one to
// /provider/v1/chat/completions returns 400 "must be called via
// /provider/v1/messages (Anthropic Messages shape)". The fix reuses the
// registry targetFormat:"claude" + messagesUrl mechanism (same as GitHub
// Copilot): chatCore translates OpenAI <-> Anthropic Messages (request,
// JSON response, SSE stream, tool calls, usage) and CommandCodeExecutor only
// picks the endpoint + anthropic-version header. Non-claude models keep
// /provider/v1/chat/completions (with the existing /alpha/generate fallback
// for non-claude plans), and upstream errors are returned unchanged for the
// claude path so a 403 MODEL_NOT_IN_PLAN reaches the client verbatim.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-cc-claude-messages-"));
process.env.DATA_DIR = TEST_DATA_DIR;

const core = await import("../../src/lib/db/core.ts");
const { clearCache } = await import("../../src/lib/semanticCache.ts");
const { clearIdempotency } = await import("../../src/lib/idempotencyLayer.ts");
const { clearInflight } = await import("../../open-sse/services/requestDedup.ts");
const { resetAll: resetAccountSemaphores } =
  await import("../../open-sse/services/accountSemaphore.ts");
const { handleChatCore, clearUpstreamProxyConfigCache } =
  await import("../../open-sse/handlers/chatCore.ts");
const { resetPayloadRulesConfigForTests } = await import("../../open-sse/services/payloadRules.ts");
const { getModelTargetFormat } = await import("../../open-sse/config/providerModels.ts");
const { CommandCodeExecutor, usesCommandCodeMessagesEndpoint } =
  await import("../../open-sse/executors/commandCode.ts");

const originalFetch = globalThis.fetch;

const CHAT_URL = "https://api.commandcode.ai/provider/v1/chat/completions";
const MESSAGES_URL = "https://api.commandcode.ai/provider/v1/messages";

function noopLog() {
  return { debug() {}, info() {}, warn() {}, error() {} };
}

function toPlainHeaders(headers) {
  if (!headers) return {};
  if (headers instanceof Headers) return Object.fromEntries(headers.entries());
  return Object.fromEntries(
    Object.entries(headers).map(([key, value]) => [key, value == null ? "" : String(value)])
  );
}

function anthropicSse(events: Array<Record<string, unknown>>): string {
  return events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join("");
}

async function invokeChatCore({ body, model, responseFactory }) {
  const calls: Array<{ url: string; headers: Record<string, string>; body: Record<string, unknown> | null }> = [];
  globalThis.fetch = async (url, init = {}) => {
    calls.push({
      url: String(url),
      headers: toPlainHeaders(init.headers),
      body: init.body ? JSON.parse(String(init.body)) : null,
    });
    return responseFactory(String(url));
  };
  try {
    const result = await handleChatCore({
      body: structuredClone(body),
      modelInfo: { provider: "command-code", model, extendedContext: false },
      credentials: { apiKey: "cc_test_key", providerSpecificData: {} },
      log: noopLog(),
      clientRawRequest: {
        endpoint: "/v1/chat/completions",
        body: structuredClone(body),
        headers: new Headers({ accept: body.stream ? "text/event-stream" : "application/json" }),
      },
      connectionId: null,
      apiKeyInfo: null,
      userAgent: "unit-test",
      isCombo: false,
      comboStrategy: null,
      onCredentialsRefreshed: null,
      onRequestSuccess: null,
    });
    return { result, calls };
  } finally {
    globalThis.fetch = originalFetch;
  }
}

async function resetStorage() {
  clearUpstreamProxyConfigCache();
  resetPayloadRulesConfigForTests();
  clearCache();
  clearIdempotency();
  clearInflight();
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
}

test.afterEach(async () => {
  globalThis.fetch = originalFetch;
  resetAccountSemaphores();
  await resetStorage();
});

test.after(() => {
  globalThis.fetch = originalFetch;
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

// ── Routing decision ─────────────────────────────────────────────────────────

test("registry: claude-* command-code models resolve targetFormat 'claude', others do not", () => {
  for (const model of [
    "claude-opus-5-5",
    "claude-haiku-4-5-20251001",
    "cmd/claude-sonnet-5",
    // live-discovered id not in the static catalog
    "claude-future-9",
  ]) {
    assert.equal(getModelTargetFormat("command-code", model), "claude", model);
    assert.equal(getModelTargetFormat("cmd", model), "claude", model);
  }
  assert.equal(getModelTargetFormat("command-code", "command-code/claude-opus-5-5"), "claude");
  for (const model of ["gpt-5.5", "deepseek/deepseek-v4-flash", "zai-org/GLM-5.1"]) {
    assert.equal(getModelTargetFormat("command-code", model), null, model);
  }
  // Scoped to command-code: another provider's claude-* id keeps its own semantics.
  assert.equal(getModelTargetFormat("openrouter", "claude-future-9"), null);
});

test("executor: buildUrl routes claude-* to /provider/v1/messages and everything else to /chat/completions", () => {
  const executor = new CommandCodeExecutor();
  assert.equal(executor.buildUrl("claude-opus-5-5", true), MESSAGES_URL);
  assert.equal(executor.buildUrl("command-code/claude-haiku-4-5-20251001", false), MESSAGES_URL);
  assert.equal(executor.buildUrl("gpt-5.5", true), CHAT_URL);
  assert.equal(executor.buildUrl("deepseek/deepseek-v4-flash", false), CHAT_URL);
  // No-arg call (used by provider validation probing) keeps the chat endpoint.
  assert.equal(executor.buildUrl(), CHAT_URL);
});

test("executor: chatCore's threaded targetFormat wins over the model-name lookup", () => {
  // A custom-model override that keeps a claude id on the OpenAI shape must not
  // be posted to /messages (body and endpoint would disagree).
  assert.equal(
    usesCommandCodeMessagesEndpoint("claude-opus-5-5", {
      providerSpecificData: { targetFormat: "openai" },
    }),
    false
  );
  assert.equal(
    usesCommandCodeMessagesEndpoint("claude-opus-5-5", {
      providerSpecificData: { targetFormat: "claude" },
    }),
    true
  );
});

// ── End-to-end through chatCore ──────────────────────────────────────────────

test("chatCore: claude non-stream request is translated to Anthropic Messages and posted to /provider/v1/messages", async () => {
  const { result, calls } = await invokeChatCore({
    model: "claude-opus-5-5",
    body: {
      model: "claude-opus-5-5",
      stream: false,
      max_tokens: 64,
      messages: [
        { role: "system", content: "You are concise." },
        { role: "user", content: "Say hi" },
      ],
    },
    responseFactory: () =>
      new Response(
        JSON.stringify({
          id: "msg_1",
          type: "message",
          role: "assistant",
          model: "claude-opus-5-5",
          content: [{ type: "text", text: "Hi there" }],
          stop_reason: "end_turn",
          stop_sequence: null,
          usage: { input_tokens: 11, output_tokens: 3 },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      ),
  });

  assert.equal(calls.length, 1);
  const call = calls[0];
  assert.equal(call.url, MESSAGES_URL);
  assert.equal(call.headers.Authorization, "Bearer cc_test_key");
  assert.equal(call.headers["anthropic-version"], "2023-06-01");
  // Anthropic Messages shape: system hoisted out of messages, no OpenAI-only fields.
  assert.equal(call.body.model, "claude-opus-5-5");
  assert.equal(call.body.stream, false);
  assert.equal(call.body.max_tokens, 64);
  assert.ok(call.body.system, "system prompt must be hoisted to the top-level system field");
  assert.ok(
    call.body.messages.every((m) => m.role !== "system"),
    "no role:system entries in Anthropic messages"
  );
  assert.equal(call.body.messages.at(-1).role, "user");

  assert.equal(result.success, true);
  const payload = await result.response.json();
  assert.equal(payload.object, "chat.completion");
  assert.equal(payload.choices[0].message.content, "Hi there");
  assert.equal(payload.choices[0].finish_reason, "stop");
  assert.equal(payload.usage.prompt_tokens, 11);
  assert.equal(payload.usage.completion_tokens, 3);
});

test("chatCore: claude streaming request posts to /provider/v1/messages and the Anthropic SSE (text + tool_use + usage) comes back as OpenAI chunks", async () => {
  const upstream = anthropicSse([
    {
      type: "message_start",
      message: {
        id: "msg_s",
        type: "message",
        role: "assistant",
        model: "claude-opus-5-5",
        content: [],
        stop_reason: null,
        usage: { input_tokens: 20, output_tokens: 1 },
      },
    },
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Looking" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: " it up" } },
    { type: "content_block_stop", index: 0 },
    {
      type: "content_block_start",
      index: 1,
      content_block: { type: "tool_use", id: "toolu_1", name: "lookup", input: {} },
    },
    {
      type: "content_block_delta",
      index: 1,
      delta: { type: "input_json_delta", partial_json: '{"q":"omni"}' },
    },
    { type: "content_block_stop", index: 1 },
    {
      type: "message_delta",
      delta: { stop_reason: "tool_use", stop_sequence: null },
      usage: { output_tokens: 9 },
    },
    { type: "message_stop" },
  ]);

  const { result, calls } = await invokeChatCore({
    model: "claude-opus-5-5",
    body: {
      model: "claude-opus-5-5",
      stream: true,
      stream_options: { include_usage: true },
      messages: [{ role: "user", content: "find omni" }],
      tools: [
        {
          type: "function",
          function: {
            name: "lookup",
            description: "search",
            parameters: { type: "object", properties: { q: { type: "string" } } },
          },
        },
      ],
    },
    responseFactory: () =>
      new Response(upstream, { status: 200, headers: { "Content-Type": "text/event-stream" } }),
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, MESSAGES_URL);
  assert.equal(calls[0].headers["anthropic-version"], "2023-06-01");
  assert.equal(calls[0].body.stream, true);
  // Tools are translated to the Anthropic shape (name + input_schema).
  const tool = calls[0].body.tools.find((t) => String(t.name).endsWith("lookup"));
  assert.ok(tool, "lookup tool forwarded");
  assert.ok(tool.input_schema, "tool translated to Anthropic input_schema");

  assert.equal(result.success, true);
  const text = await result.response.text();
  const chunks = text
    .split("\n")
    .filter((line) => line.startsWith("data: ") && !line.includes("[DONE]"))
    .map((line) => JSON.parse(line.slice(6)));
  const content = chunks.map((c) => c.choices?.[0]?.delta?.content || "").join("");
  assert.equal(content, "Looking it up");
  const toolCalls = chunks.flatMap((c) => c.choices?.[0]?.delta?.tool_calls || []);
  assert.equal(toolCalls[0].function.name, "lookup");
  assert.equal(toolCalls.map((t) => t.function?.arguments || "").join(""), '{"q":"omni"}');
  const finish = chunks.map((c) => c.choices?.[0]?.finish_reason).filter(Boolean);
  assert.equal(finish.at(-1), "tool_calls");
  const usage = chunks.find((c) => c.usage)?.usage;
  assert.ok(usage, "usage chunk emitted");
  assert.equal(usage.completion_tokens, 9);
  assert.ok(text.includes("data: [DONE]"));
});

for (const model of ["gpt-5.5", "deepseek/deepseek-v4-flash"]) {
  test(`chatCore: non-claude ${model} stays on /provider/v1/chat/completions (OpenAI body, no anthropic-version)`, async () => {
    const { result, calls } = await invokeChatCore({
      model,
      body: { model, stream: false, messages: [{ role: "user", content: "hi" }] },
      responseFactory: () =>
        new Response(
          JSON.stringify({
            id: "chatcmpl-1",
            object: "chat.completion",
            model,
            choices: [
              { index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" },
            ],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        ),
    });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, CHAT_URL);
    assert.equal(calls[0].headers["anthropic-version"], undefined);
    assert.equal(calls[0].body.model, model);
    assert.equal(calls[0].body.messages[0].role, "user");
    assert.equal(result.success, true);
    assert.equal((await result.response.json()).choices[0].message.content, "ok");
  });
}

// ── Upstream errors surfaced as-is on the claude path ────────────────────────

const NOT_IN_PLAN_CASES = [
  {
    model: "gpt-5.5",
    url: CHAT_URL,
    body: {
      error: {
        message:
          "MODEL_NOT_IN_PLAN: GPT-5.5 available in Pro and above plans or extra on demand usage",
        type: "permission_error",
        code: "FORBIDDEN",
      },
    },
  },
  {
    model: "claude-haiku-4-5-20251001",
    url: MESSAGES_URL,
    body: {
      type: "error",
      error: {
        type: "permission_error",
        message:
          "MODEL_NOT_IN_PLAN: Claude Haiku 4.5 available in Pro and above plans or extra on demand usage",
      },
    },
  },
];

for (const { model, url, body } of NOT_IN_PLAN_CASES) {
  for (const stream of [false, true]) {
    test(`chatCore: 403 MODEL_NOT_IN_PLAN for ${model} (stream=${stream}) is surfaced as-is`, async () => {
      const isClaude = url === MESSAGES_URL;
      const { result, calls } = await invokeChatCore({
        model,
        body: { model, stream, messages: [{ role: "user", content: "hi" }] },
        // Non-claude models keep the legacy 403 -> /alpha/generate fallback
        // (Go-plan behavior); answer 403 there too so the error surfaces.
        responseFactory: () =>
          new Response(JSON.stringify(body), {
            status: 403,
            headers: { "Content-Type": "application/json" },
          }),
      });
      assert.equal(calls[0].url, url);
      if (isClaude) {
        assert.equal(calls.length, 1, "claude path: exactly one upstream call");
        assert.ok(
          calls.every((c) => !c.url.includes("/alpha/")),
          "claude path must never touch the CLI-only /alpha/generate endpoint"
        );
      }
      assert.equal(result.success, false);
      assert.equal(result.status, 403);
      assert.match(String(result.error), /MODEL_NOT_IN_PLAN/);
    });
  }
}
