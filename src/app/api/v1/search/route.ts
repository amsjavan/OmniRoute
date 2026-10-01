import { handleSearch } from "@omniroute/open-sse/handlers/search.ts";
import {
  getAllSearchProviders,
  getSearchProvider,
} from "@omniroute/open-sse/config/searchRegistry.ts";
import { errorResponse } from "@omniroute/open-sse/utils/error.ts";
import { HTTP_STATUS } from "@omniroute/open-sse/config/constants.ts";
import * as log from "@/sse/utils/logger";
import { toJsonErrorPayload } from "@/shared/utils/upstreamError";
import { enforceApiKeyPolicy } from "@/shared/utils/apiKeyPolicy";
import { v1SearchSchema } from "@/shared/validation/schemas";
import {
  formatValidationMessage,
  isValidationFailure,
  validateBody,
} from "@/shared/validation/helpers";
import { recordCost } from "@/domain/costRules";
import {
  computeCacheKey,
  getOrCoalesce,
  SEARCH_CACHE_DEFAULT_TTL_MS,
} from "@omniroute/open-sse/services/searchCache.ts";
import { resolveSearchExecution } from "@/app/api/v1/_shared/searchExecution";
import { getSettings } from "@/lib/db/settings";
import { withInjectionGuard } from "@/middleware/promptInjectionGuard";

const CORS_HEADERS = {
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "*",
};

/**
 * Handle CORS preflight
 */
export async function OPTIONS() {
  return new Response(null, { headers: CORS_HEADERS });
}

/**
 * GET /v1/search — list available search providers
 */
export async function GET() {
  const settings = await getSettings().catch(() => ({}) as any);
  const blockedProviders = settings?.blockedProviders || [];
  const providers = getAllSearchProviders(blockedProviders);
  const timestamp = Math.floor(Date.now() / 1000);

  const data = providers.map((p) => ({
    id: p.id,
    object: "search_provider",
    created: timestamp,
    name: p.name,
    search_types: p.searchTypes,
  }));

  return new Response(JSON.stringify({ object: "list", data }), {
    headers: { "Content-Type": "application/json", ...CORS_HEADERS },
  });
}

// Helper: build domain filter array from filters object
function buildDomainFilter(filters?: {
  include_domains?: string[];
  exclude_domains?: string[];
}): string[] | undefined {
  if (!filters) return undefined;
  const parts: string[] = [];
  if (filters.include_domains?.length) parts.push(...filters.include_domains);
  if (filters.exclude_domains?.length) parts.push(...filters.exclude_domains.map((d) => `-${d}`));
  return parts.length > 0 ? parts : undefined;
}

/**
 * POST /v1/search — execute a web search
 */
async function postHandler(request: Request, context: unknown) {
  let rawBody: unknown;
  try {
    rawBody = await request.json();
  } catch {
    log.warn("SEARCH", "Invalid JSON body");
    return errorResponse(HTTP_STATUS.BAD_REQUEST, "Invalid JSON body");
  }

  const validation = validateBody(v1SearchSchema, rawBody);
  if (isValidationFailure(validation)) {
    return errorResponse(HTTP_STATUS.BAD_REQUEST, formatValidationMessage(validation.error));
  }
  const body = validation.data;
  if (body.provider === "x_search") body.provider = "x-search";
  if (body.provider === "x-search") body.search_type = "x";

  // Enforce API key policies — use "search" as model identifier for consistent policy config
  const policy = await enforceApiKeyPolicy(request, "search");
  if (policy.rejection) return policy.rejection;

  const execution = await resolveSearchExecution(body);
  if (execution instanceof Response) return execution;
  const { provider: providerId, maxResults: clampedMaxResults, credentials } = execution;
  const providerConfig = getSearchProvider(providerId)!;

  // Cache key — includes all fields that affect results
  const cacheKey = computeCacheKey(
    body.query,
    providerConfig.id,
    body.search_type,
    clampedMaxResults,
    body.country,
    body.language,
    {
      filters: body.filters,
      offset: body.offset,
      time_range: body.time_range,
      content: body.content,
      provider_options: body.provider_options,
    }
  );

  const ttl = providerConfig.cacheTTLMs ?? SEARCH_CACHE_DEFAULT_TTL_MS;

  try {
    const { data: searchResult, cached } = await getOrCoalesce(cacheKey, ttl, async () => {
      const result = await handleSearch({
        query: body.query,
        provider: providerConfig.id,
        maxResults: clampedMaxResults,
        searchType: body.search_type,
        country: body.country,
        language: body.language,
        timeRange: body.time_range,
        offset: body.offset,
        domainFilter: buildDomainFilter(body.filters),
        contentOptions: body.content,
        strictFilters: body.strict_filters,
        providerOptions: body.provider_options,
        credentials,
        alternateProvider: execution.alternateProvider,
        alternateCredentials: execution.alternateCredentials,
        log,
        connectionId:
          typeof credentials.connectionId === "string" ? credentials.connectionId : undefined,
        apiKeyId: policy.apiKeyInfo?.id || undefined,
      });

      if (!result.success) {
        throw new SearchError(result.error || "Search failed", result.status || 502);
      }

      return result.data!;
    });

    // Record cost for budget tracking (skip cache hits — no provider cost)
    if (!cached && policy.apiKeyInfo?.id && searchResult.usage?.search_cost_usd > 0) {
      try {
        recordCost(policy.apiKeyInfo.id, searchResult.usage.search_cost_usd);
      } catch (e: any) {
        log.warn("SEARCH", `Cost recording failed: ${e?.message}`);
      }
    }

    const response = {
      id: `search-${crypto.randomUUID()}`,
      ...searchResult,
      cached,
      usage: cached ? { queries_used: 0, search_cost_usd: 0 } : searchResult.usage,
    };

    return new Response(JSON.stringify(response), {
      status: 200,
      headers: { "Content-Type": "application/json", ...CORS_HEADERS },
    });
  } catch (err: any) {
    if (err instanceof SearchError) {
      const errorPayload = toJsonErrorPayload(err.message, "Search provider error");
      return new Response(JSON.stringify(errorPayload), {
        status: err.statusCode,
        headers: { "Content-Type": "application/json", ...CORS_HEADERS },
      });
    }

    log.error("SEARCH", `Unexpected error: ${err.message}`);
    const errorPayload = toJsonErrorPayload(err.message, "Internal search error");
    return new Response(JSON.stringify(errorPayload), {
      status: 500,
      headers: { "Content-Type": "application/json", ...CORS_HEADERS },
    });
  }
}

class SearchError extends Error {
  statusCode: number;
  constructor(message: string, statusCode: number) {
    super(message);
    this.statusCode = statusCode;
  }
}

export const POST = withInjectionGuard(postHandler);
