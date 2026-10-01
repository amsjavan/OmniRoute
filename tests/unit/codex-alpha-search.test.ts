import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";

// Replace only external boundaries; exercise the real route, validation,
// error sanitizer and shared provider selection without opening any database.
const calls: Array<Record<string, unknown>> = [];
const policyCalls: string[] = [];
let failure: { status: number; error: string } | null = null;
let policyRejection: Response | null = null;
const mocks: Record<string, string> = {
  "@/sse/services/auth": `
    export function extractApiKey(request) {
      return request.headers.get("authorization")?.replace(/^Bearer /, "") || null;
    }
    export async function isValidApiKey(key) { return key === "test-key"; }
    export async function getProviderCredentialsWithQuotaPreflight(provider) {
      return provider === "brave-search" ? { apiKey: "upstream-key", connectionId: "test-connection" } : null;
    }
  `,
  "@/lib/db/settings": `
    export async function getSettings() { return { blockedProviders: [] }; }
  `,
  "@/shared/utils/noAuthProviders": `
    export function isProviderBlockedByIdOrAlias(id, blocked) { return blocked.includes(id); }
  `,
  "@/sse/utils/logger": `
    export function info() {}
    export function warn() {}
    export function error() {}
  `,
};

// Bridge closures to the synthetic modules without global state or eval.
const boundaryUrl = new URL("./codex-alpha-search-boundaries.js", import.meta.url).href;
const boundaries = {
  async handleSearch(options: Record<string, unknown>) {
    calls.push(options);
    if (failure) return { success: false, ...failure };
    return {
      success: true,
      data: {
        results:
          options.query === "empty query"
            ? []
            : [
                {
                  title: "Example title",
                  url: "https://example.com/result",
                  snippet: "Example snippet",
                },
              ],
      },
    };
  },
  async enforceApiKeyPolicy(_request: Request, model: string) {
    policyCalls.push(model);
    return { rejection: policyRejection, apiKeyInfo: { id: "test-key-id" } };
  },
};
// Node's synchronous loader can supply modules directly from source. Functions
// are exported from this test module for the synthetic boundary module to reuse.
export const handleSearch = boundaries.handleSearch;
export const enforceApiKeyPolicy = boundaries.enforceApiKeyPolicy;

const hook = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (
      specifier === "@omniroute/open-sse/handlers/search.ts" ||
      specifier === "@/shared/utils/apiKeyPolicy"
    ) {
      return { url: boundaryUrl, shortCircuit: true };
    }
    if (specifier in mocks) {
      return { url: "mock:alpha-search/" + specifier, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url === boundaryUrl) {
      return {
        format: "module",
        source: `export { handleSearch, enforceApiKeyPolicy } from ${JSON.stringify(import.meta.url)};`,
        shortCircuit: true,
      };
    }
    if (url.startsWith("mock:alpha-search/")) {
      return {
        format: "module",
        source: mocks[url.slice("mock:alpha-search/".length)],
        shortCircuit: true,
      };
    }
    return nextLoad(url, context);
  },
});

let alphaSearch: typeof import("../../src/app/api/v1/alpha/search/route.ts");
test.before(async () => {
  alphaSearch = await import("../../src/app/api/v1/alpha/search/route.ts");
});

function request(commands?: unknown, key: string | null = "test-key") {
  return new Request("http://localhost/v1/alpha/search", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(key ? { Authorization: `Bearer ${key}` } : {}),
      originator: "codex_cli_rs",
      "x-codex-turn-metadata": "{}",
    },
    body: JSON.stringify({
      id: "turn-1",
      model: "unused-model",
      commands,
      reasoning: {},
      settings: {},
      input: [],
      max_output_tokens: 1000,
    }),
  });
}

test.beforeEach(() => {
  calls.length = 0;
  policyCalls.length = 0;
  failure = null;
  policyRejection = null;
});
test.after(() => hook.deregister());

test("missing or empty search_query returns a clear 400", async () => {
  for (const commands of [undefined, {}, { search_query: [] }, { open: [{ ref: "example" }] }]) {
    const response = await alphaSearch.POST(request(commands));
    assert.equal(response.status, 400);
    const body = await response.json();
    assert.match(body.error.message, /commands.search_query/);
  }
  assert.equal(calls.length, 0);
});

test("merges queries into the exact Codex envelope with unique references", async () => {
  const response = await alphaSearch.POST(
    request({
      search_query: [
        { q: "first query", recency: 7, domains: ["example.com"] },
        { q: "second query" },
        { q: "empty query" },
      ],
    })
  );
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.deepEqual(Object.keys(body).sort(), ["encrypted_output", "output", "results"]);
  assert.equal(body.encrypted_output, null);
  assert.equal(typeof body.output, "string");
  assert.deepEqual(
    body.results,
    [0, 1].map((index) => ({
      type: "text_result",
      ref_id: `turn0search${index}`,
      url: "https://example.com/result",
      title: "Example title",
      snippet: "Example snippet",
    }))
  );
  assert.equal(
    body.output,
    "1. Example title — https://example.com/result\nExample snippet\n\n" +
      "2. Example title — https://example.com/result\nExample snippet\n\n" +
      "No results found for empty query"
  );
  assert.deepEqual(
    calls.map((call) => call.query),
    ["first query", "second query", "empty query"]
  );
  assert.equal(calls[0].provider, "brave-search");
  assert.equal(calls[0].connectionId, "test-connection");
  assert.equal(calls[0].apiKeyId, "test-key-id");
  assert.equal(calls[0].timeRange, "week");
  assert.deepEqual(calls[0].domainFilter, ["example.com"]);
  assert.deepEqual(policyCalls, ["search"]);
});

test("rejects missing and invalid keys without running searches", async () => {
  for (const key of [null, "invalid-key"]) {
    const response = await alphaSearch.POST(request({ search_query: [{ q: "auth test" }] }, key));
    assert.equal(response.status, 401);
  }
  assert.equal(calls.length, 0);
});

test("honors policy rejection", async () => {
  policyRejection = new Response(null, { status: 403 });
  const response = await alphaSearch.POST(request({ search_query: [{ q: "policy test" }] }));
  assert.equal(response.status, 403);
  assert.equal(calls.length, 0);
});

test("empty results still supply model-facing output", async () => {
  const response = await alphaSearch.POST(request({ search_query: [{ q: "empty query" }] }));
  assert.deepEqual(await response.json(), {
    encrypted_output: null,
    output: "No results found for empty query",
    results: [],
  });
});

test("provider errors preserve status and do not leak stack traces", async () => {
  failure = { status: 503, error: "Search unavailable\n    at /srv/private/search.ts:10:2" };
  const response = await alphaSearch.POST(request({ search_query: [{ q: "failure" }] }));
  assert.equal(response.status, 503);
  const body = await response.json();
  assert.ok(!body.error.message.includes("at /"));
  assert.ok(!body.error.message.includes("/srv/private"));
});

test("validates query values and JSON", async () => {
  for (const q of ["", 42, null]) {
    assert.equal((await alphaSearch.POST(request({ search_query: [{ q }] }))).status, 400);
  }
  const malformed = new Request("http://localhost/v1/alpha/search", { method: "POST", body: "{" });
  assert.equal((await alphaSearch.POST(malformed)).status, 400);
  assert.equal(calls.length, 0);
});

test("CORS preflight allows POST and extra client headers", async () => {
  const response = await alphaSearch.OPTIONS();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("Access-Control-Allow-Methods") || "", /POST/);
  assert.equal(response.headers.get("Access-Control-Allow-Headers"), "*");
});
