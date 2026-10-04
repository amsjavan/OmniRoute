import test from "node:test";
import assert from "node:assert/strict";
import { resolveRequestedModel } from "../../open-sse/utils/cursorAgentProtobuf";

// Issue #7289: pinned Claude/GPT models carrying an effort/reasoning suffix
// (e.g. "claude-opus-4-8-high") return an empty turn from cursor's server.
//
// Ground truth captured from the real cursor-agent 2026.07.09 (Node) client
// via an http2/fetch preload hook: the wire request for a pinned model with
// an effort suffix carries the BASE model id (suffix stripped) plus a
// separate ModelParameter — "effort" for Claude models, "reasoning" for GPT
// models — not the full suffixed id crammed into model_id.
// Superseded for Claude and the flattened GPT/Grok families: Cursor now
// publishes flattened effort ids and answers the base id + parameter split
// with AI Model Not Found (verified live 2026-10-04), so those pass through.
for (const id of [
  "claude-opus-4-8-high",
  "claude-sonnet-5-high",
  "claude-opus-5-high",
  "claude-opus-5-thinking-high-fast",
  "claude-4.6-opus-max",
  "claude-4.6-sonnet-medium-thinking",
  "gpt-5.5-high",
]) {
  test(`resolveRequestedModel sends flattened Cursor id ${id} verbatim`, () => {
    assert.deepEqual(resolveRequestedModel(id), { modelId: id, parameters: [] });
  });
}

test("resolveRequestedModel still splits the reasoning suffix off unflattened GPT ids (#7289)", () => {
  assert.deepEqual(resolveRequestedModel("gpt-5-high"), {
    modelId: "gpt-5",
    parameters: [{ id: "reasoning", value: "high" }],
  });
});

test("resolveRequestedModel does not touch the composer -fast toggle (#7289 regression guard)", () => {
  assert.deepEqual(resolveRequestedModel("composer-2-fast"), {
    modelId: "composer-2",
    parameters: [{ id: "fast", value: "true" }],
  });
});

test("resolveRequestedModel does not rewrite ids with no recognized effort suffix (#7289 regression guard)", () => {
  assert.deepEqual(resolveRequestedModel("claude-2.5"), {
    modelId: "claude-2.5",
    parameters: [],
  });
  assert.deepEqual(resolveRequestedModel("gpt-4o"), {
    modelId: "gpt-4o",
    parameters: [],
  });
});

test("resolveRequestedModel sends flattened cursor-grok ids verbatim", () => {
  for (const id of ["cursor-grok-4.5-high", "cursor-grok-4.5-medium"]) {
    assert.deepEqual(resolveRequestedModel(id), { modelId: id, parameters: [] });
  }
});

test("resolveRequestedModel splits effort off legacy grok- ids", () => {
  // "grok-4.5-*" combos are pre-aliased to "cursor-grok-4.5-*" by
  // CURSOR_MODEL_ALIASES (already shipped on the release tip), so this uses
  // an unaliased grok version to actually exercise the bare "grok-" fallback
  // in resolveGrokRequestedModel rather than the alias table's rewrite.
  assert.deepEqual(resolveRequestedModel("grok-3-high"), {
    modelId: "grok-3",
    parameters: [{ id: "effort", value: "high" }],
  });
});

test("resolveRequestedModel sends flattened cursor-grok effort + fast ids verbatim", () => {
  assert.deepEqual(resolveRequestedModel("cursor-grok-4.5-high-fast"), {
    modelId: "cursor-grok-4.5-high-fast",
    parameters: [],
  });
});

test("resolveRequestedModel maps Claude 1M catalog ids to the flattened slug + context=1m", () => {
  assert.deepEqual(resolveRequestedModel("claude-opus-5-thinking-max-fast-1m"), {
    modelId: "claude-opus-5-thinking-max-fast",
    parameters: [{ id: "context", value: "1m" }],
  });
  assert.deepEqual(resolveRequestedModel("claude-4.6-sonnet-high-thinking-1m"), {
    modelId: "claude-4.6-sonnet-high-thinking",
    parameters: [{ id: "context", value: "1m" }],
  });
});

test("resolveRequestedModel maps GPT-5.6 1M ids to the flattened slug + context=1m", () => {
  const id = "gpt-5.6-sol-xhigh-1m";
  assert.deepEqual(resolveRequestedModel(id, { liveCatalogIds: new Set([id]) }), {
    modelId: "gpt-5.6-sol-xhigh",
    parameters: [{ id: "context", value: "1m" }],
  });
});
