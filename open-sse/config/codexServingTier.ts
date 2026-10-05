/**
 * codexServingTier.ts — per-account Codex serving-speed tier.
 *
 * The ChatGPT Codex backend serves accounts at very different speeds. Measured
 * 2026-10-04 with identical requests sent straight to chatgpt.com (no proxy):
 *   - `pro` accounts:                                   ~57 tok/s, first token 2-5s
 *   - `prolite` accounts:                               ~19 tok/s, first token 6-32s
 *   - accounts answering with
 *     `x-base-model-inference-limit-name: gpt-reserve`: ~19 tok/s even on `pro`
 *
 * Load-balancing evenly across both groups made every other request ~3x slower
 * than a direct Codex connection. Every Codex response carries
 * `x-codex-plan-type` (and the reserve marker when it applies), so the tier is
 * learned from live traffic and account selection prefers fast accounts,
 * keeping slow ones as fallback only.
 *
 * Accounts never observed count as fast, so they keep receiving traffic until
 * their first response classifies them. Observations expire so a slow account
 * is periodically re-admitted and re-classified (reserve status in particular
 * comes and goes with quota usage).
 *
 * Operator overrides: `providerSpecificData.codexSpeedTier = "fast" | "slow"`
 * pins an account regardless of headers. `OMNIROUTE_CODEX_PREFER_FAST_TIER=0`
 * disables the preference; `OMNIROUTE_CODEX_SLOW_PLAN_TYPES` (comma list,
 * default `prolite`) sets which plan types count as slow.
 */

const PLAN_TYPE_HEADER = "x-codex-plan-type";
const INFERENCE_LIMIT_HEADER = "x-base-model-inference-limit-name";

/** Plan type is stable; re-check a few times a day in case of upgrades. */
const PLAN_OBSERVATION_TTL_MS = 6 * 60 * 60 * 1000;
/** Reserve status tracks quota usage; re-admit the account sooner to re-check. */
const RESERVE_OBSERVATION_TTL_MS = 20 * 60 * 1000;

export type CodexServingTier = {
  slow: boolean;
  planType: string | null;
  inferenceLimitName: string | null;
  observedAt: number;
  expiresAt: number;
};

// Shared through globalThis so every bundled copy of this module (Next route
// bundles) and the standalone Responses WS proxy (scripts/dev/responses-ws-proxy.mjs,
// loaded outside the Next bundle) read and write the same observations.
const OBSERVATIONS_KEY = Symbol.for("omniroute.codexServingTier.observations");
const NOTE_HOOK_KEY = Symbol.for("omniroute.codexServingTier.note");
const globalRegistry = globalThis as typeof globalThis & {
  [OBSERVATIONS_KEY]?: Map<string, CodexServingTier>;
  [NOTE_HOOK_KEY]?: typeof noteCodexServingTier;
};
const observations = (globalRegistry[OBSERVATIONS_KEY] ??= new Map<string, CodexServingTier>());

type HeaderSource = Headers | Record<string, unknown> | null | undefined;

function readHeader(headers: HeaderSource, name: string): string | null {
  if (!headers) return null;
  let value: unknown;
  if (typeof (headers as Headers).get === "function") {
    value = (headers as Headers).get(name);
  } else {
    const record = headers as Record<string, unknown>;
    value = record[name] ?? record[name.toLowerCase()];
  }
  if (typeof value !== "string") return null;
  const trimmed = value.trim().toLowerCase();
  return trimmed.length > 0 ? trimmed : null;
}

function slowPlanTypes(): Set<string> {
  const raw = process.env.OMNIROUTE_CODEX_SLOW_PLAN_TYPES ?? "prolite";
  return new Set(
    raw
      .split(",")
      .map((entry) => entry.trim().toLowerCase())
      .filter(Boolean)
  );
}

export function isCodexFastTierPreferenceEnabled(): boolean {
  return process.env.OMNIROUTE_CODEX_PREFER_FAST_TIER !== "0";
}

/** Classify one upstream response; null when it carries no tier headers. */
export function classifyCodexServingTier(
  headers: HeaderSource,
  now = Date.now()
): CodexServingTier | null {
  const planType = readHeader(headers, PLAN_TYPE_HEADER);
  const inferenceLimitName = readHeader(headers, INFERENCE_LIMIT_HEADER);
  if (!planType && !inferenceLimitName) return null;

  const reserve = inferenceLimitName !== null && inferenceLimitName.includes("reserve");
  const slowPlan = planType !== null && slowPlanTypes().has(planType);
  const ttl = reserve && !slowPlan ? RESERVE_OBSERVATION_TTL_MS : PLAN_OBSERVATION_TTL_MS;
  return {
    slow: reserve || slowPlan,
    planType,
    inferenceLimitName,
    observedAt: now,
    expiresAt: now + ttl,
  };
}

/** Record the tier advertised by an upstream Codex response for this account. */
export function noteCodexServingTier(
  connectionId: string | null | undefined,
  headers: HeaderSource,
  now = Date.now()
): CodexServingTier | null {
  if (!connectionId) return null;
  const tier = classifyCodexServingTier(headers, now);
  if (tier) observations.set(connectionId, tier);
  return tier;
}

// The WS proxy has no import path into the bundle; it calls this hook with the
// `codex.response.metadata` event's headers.
globalRegistry[NOTE_HOOK_KEY] = noteCodexServingTier;

export function getCodexServingTier(
  connectionId: string,
  now = Date.now()
): CodexServingTier | null {
  const tier = observations.get(connectionId);
  if (!tier) return null;
  if (tier.expiresAt <= now) {
    observations.delete(connectionId);
    return null;
  }
  return tier;
}

type TieredConnection = { id: string; providerSpecificData?: unknown };

export function isCodexConnectionSlowTier(connection: TieredConnection, now = Date.now()): boolean {
  const psd =
    connection.providerSpecificData && typeof connection.providerSpecificData === "object"
      ? (connection.providerSpecificData as Record<string, unknown>)
      : {};
  if (psd.codexSpeedTier === "fast") return false;
  if (psd.codexSpeedTier === "slow") return true;
  return getCodexServingTier(connection.id, now)?.slow === true;
}

/**
 * Narrow a candidate pool to fast-tier accounts when at least one is available;
 * otherwise return the pool unchanged so slow accounts still serve as fallback.
 */
export function preferCodexFastTier<T extends TieredConnection>(
  connections: T[],
  now = Date.now()
): T[] {
  if (!isCodexFastTierPreferenceEnabled() || connections.length < 2) return connections;
  const fast = connections.filter((connection) => !isCodexConnectionSlowTier(connection, now));
  return fast.length > 0 ? fast : connections;
}

export function __resetCodexServingTiersForTesting(): void {
  observations.clear();
}
