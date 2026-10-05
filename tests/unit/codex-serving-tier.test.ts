/**
 * Tests for Codex serving-tier detection and fast-tier account preference.
 */
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";

import {
  classifyCodexServingTier,
  noteCodexServingTier,
  isCodexConnectionSlowTier,
  preferCodexFastTier,
  __resetCodexServingTiersForTesting,
} from "../../open-sse/config/codexServingTier.ts";

const pro = new Headers({ "x-codex-plan-type": "pro" });
const prolite = new Headers({ "x-codex-plan-type": "prolite" });
const proReserve = new Headers({
  "x-codex-plan-type": "pro",
  "x-base-model-inference-limit-name": "gpt-reserve",
});

describe("codexServingTier", () => {
  beforeEach(() => {
    __resetCodexServingTiersForTesting();
    delete process.env.OMNIROUTE_CODEX_PREFER_FAST_TIER;
    delete process.env.OMNIROUTE_CODEX_SLOW_PLAN_TYPES;
  });

  it("classifies pro as fast, prolite and reserve capacity as slow", () => {
    assert.equal(classifyCodexServingTier(pro)?.slow, false);
    assert.equal(classifyCodexServingTier(prolite)?.slow, true);
    assert.equal(classifyCodexServingTier(proReserve)?.slow, true);
    assert.equal(classifyCodexServingTier(new Headers({ "content-type": "x" })), null);
  });

  it("reads plain header records", () => {
    assert.equal(classifyCodexServingTier({ "x-codex-plan-type": "ProLite" })?.slow, true);
  });

  it("honours OMNIROUTE_CODEX_SLOW_PLAN_TYPES", () => {
    process.env.OMNIROUTE_CODEX_SLOW_PLAN_TYPES = "plus";
    assert.equal(classifyCodexServingTier(prolite)?.slow, false);
    assert.equal(
      classifyCodexServingTier(new Headers({ "x-codex-plan-type": "plus" }))?.slow,
      true
    );
  });

  it("treats unobserved accounts as fast and expires observations", () => {
    const now = 1_000_000;
    assert.equal(isCodexConnectionSlowTier({ id: "a" }, now), false);
    noteCodexServingTier("a", proReserve, now);
    assert.equal(isCodexConnectionSlowTier({ id: "a" }, now), true);
    // Reserve observations expire after 20 minutes so the account is re-checked.
    assert.equal(isCodexConnectionSlowTier({ id: "a" }, now + 21 * 60 * 1000), false);
  });

  it("manual codexSpeedTier override wins over observed headers", () => {
    noteCodexServingTier("a", prolite);
    assert.equal(
      isCodexConnectionSlowTier({ id: "a", providerSpecificData: { codexSpeedTier: "fast" } }),
      false
    );
    assert.equal(
      isCodexConnectionSlowTier({ id: "b", providerSpecificData: { codexSpeedTier: "slow" } }),
      true
    );
  });

  it("prefers fast accounts and falls back to slow ones when no fast account is left", () => {
    noteCodexServingTier("slow1", prolite);
    noteCodexServingTier("slow2", proReserve);
    noteCodexServingTier("fast1", pro);
    const pool = [{ id: "slow1" }, { id: "fast1" }, { id: "slow2" }, { id: "unknown" }];
    assert.deepEqual(
      preferCodexFastTier(pool).map((c) => c.id),
      ["fast1", "unknown"]
    );
    const slowOnly = [{ id: "slow1" }, { id: "slow2" }];
    assert.deepEqual(preferCodexFastTier(slowOnly), slowOnly);
  });

  it("can be disabled with OMNIROUTE_CODEX_PREFER_FAST_TIER=0", () => {
    noteCodexServingTier("slow1", prolite);
    process.env.OMNIROUTE_CODEX_PREFER_FAST_TIER = "0";
    const pool = [{ id: "slow1" }, { id: "fast1" }];
    assert.deepEqual(preferCodexFastTier(pool), pool);
  });
});

describe("codexServingTier global registry", () => {
  it("exposes the note hook used by the standalone Responses WS proxy", () => {
    __resetCodexServingTiersForTesting();
    const hook = (globalThis as Record<symbol, unknown>)[
      Symbol.for("omniroute.codexServingTier.note")
    ] as (id: string, headers: Record<string, string>) => unknown;
    assert.equal(typeof hook, "function");
    hook("ws-conn", { "x-codex-plan-type": "prolite" });
    assert.equal(isCodexConnectionSlowTier({ id: "ws-conn" }), true);
  });
});
