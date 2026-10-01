import { getProviderCredentialsWithQuotaPreflight } from "@/sse/services/auth";
import {
  getSearchProvider,
  resolveSearchProvider,
  selectProvider,
  supportsSearchType,
  isUnconfiguredLoopbackSearchProvider,
  SEARCH_PROVIDERS,
  getSearchCredentialFallbacks,
} from "@omniroute/open-sse/config/searchRegistry.ts";
import { errorResponse } from "@omniroute/open-sse/utils/error.ts";
import { HTTP_STATUS } from "@omniroute/open-sse/config/constants.ts";
import {
  isAllRateLimitedCredentials,
  rateLimitedProviderResponse,
  type RateLimitedCredentials,
} from "@/app/api/v1/_shared/rateLimit";
import { getSettings } from "@/lib/db/settings";
import { isProviderBlockedByIdOrAlias } from "@/shared/utils/noAuthProviders";

type SearchCredentials = Record<string, unknown>;
type SearchCredentialLookup = SearchCredentials | RateLimitedCredentials | null;

async function resolveSearchCredentials(providerId: string): Promise<SearchCredentialLookup> {
  const credentials = await getProviderCredentialsWithQuotaPreflight(providerId).catch(() => null);
  if (credentials && !isAllRateLimitedCredentials(credentials)) return credentials;

  for (const fallbackId of getSearchCredentialFallbacks(providerId)) {
    const fallbackCredentials = await getProviderCredentialsWithQuotaPreflight(fallbackId).catch(
      () => null
    );
    if (fallbackCredentials && !isAllRateLimitedCredentials(fallbackCredentials)) {
      return fallbackCredentials;
    }
    if (fallbackCredentials) return fallbackCredentials;
  }

  return credentials;
}

async function resolveSearchExecutionCredentials(providerConfig: {
  id: string;
  authType: string;
}): Promise<SearchCredentialLookup> {
  const credentials = await resolveSearchCredentials(providerConfig.id);
  if (credentials) return credentials;
  return providerConfig.authType === "none" ? {} : null;
}

// Shared provider selection and credential resolution for search protocol adapters.
export async function resolveSearchExecution(body: {
  provider?: string;
  search_type: "web" | "news" | "x";
  max_results: number;
}) {
  const settings = await getSettings().catch(() => ({ blockedProviders: [] as string[] }));
  const blockedProviders = settings?.blockedProviders || [];

  // Resolve provider and credentials
  if (body.provider) {
    if (isProviderBlockedByIdOrAlias(body.provider, blockedProviders)) {
      return errorResponse(
        HTTP_STATUS.FORBIDDEN,
        `Search provider ${body.provider} is blocked by security policy`
      );
    }
    const explicitProvider = resolveSearchProvider(body.provider);
    if (!explicitProvider) {
      return errorResponse(HTTP_STATUS.BAD_REQUEST, `Unknown search provider: ${body.provider}`);
    }
    if (!supportsSearchType(explicitProvider, body.search_type)) {
      return errorResponse(
        HTTP_STATUS.BAD_REQUEST,
        `Search provider ${body.provider} does not support search_type: ${body.search_type}`
      );
    }
  }

  let providerConfig = selectProvider(body.provider, body.search_type);
  if (
    providerConfig &&
    !body.provider &&
    isProviderBlockedByIdOrAlias(providerConfig.id, blockedProviders)
  ) {
    const unblockedCandidate = Object.values(SEARCH_PROVIDERS)
      .filter(
        (p) =>
          !p.fallbackOnly &&
          supportsSearchType(p, body.search_type) &&
          !isProviderBlockedByIdOrAlias(p.id, blockedProviders)
      )
      .sort((a, b) => a.costPerQuery - b.costPerQuery)[0];
    providerConfig = unblockedCandidate || null;
  }
  if (!providerConfig) {
    return errorResponse(
      HTTP_STATUS.BAD_REQUEST,
      body.provider ? `Unknown search provider: ${body.provider}` : "No search providers available"
    );
  }

  let credentials: Record<string, unknown> | null = null;
  let alternateProviderId: string | undefined;
  let alternateCredentials: Record<string, unknown> | null = null;
  let firstRateLimitedCredentials: {
    providerId: string;
    credentials: RateLimitedCredentials;
  } | null = null;

  if (body.provider) {
    // Explicit provider — single credential lookup (with fallback)
    const explicitCredentials = await resolveSearchExecutionCredentials(providerConfig);
    if (isAllRateLimitedCredentials(explicitCredentials)) {
      return rateLimitedProviderResponse(providerConfig.id, explicitCredentials);
    }
    credentials = explicitCredentials;
    if (!credentials) {
      return errorResponse(
        HTTP_STATUS.BAD_REQUEST,
        `No credentials configured for search provider: ${providerConfig.id}. Add an API key for "${providerConfig.id}" in the dashboard.`
      );
    }
  } else {
    // Auto-select — try the resolved provider first, then iterate others by cost
    const selectedCredentials = await resolveSearchExecutionCredentials(providerConfig);
    if (isAllRateLimitedCredentials(selectedCredentials)) {
      firstRateLimitedCredentials = {
        providerId: providerConfig.id,
        credentials: selectedCredentials,
      };
    } else {
      credentials = selectedCredentials;
    }

    if (!credentials) {
      // Sort by cost to find cheapest with credentials (fallback-only providers
      // are reached via the last-resort step below, never the primary pick).
      const sortedIds = Object.values(SEARCH_PROVIDERS)
        .filter(
          (provider) =>
            !provider.fallbackOnly &&
            supportsSearchType(provider, body.search_type) &&
            !isProviderBlockedByIdOrAlias(provider.id, blockedProviders)
        )
        .sort((a, b) => a.costPerQuery - b.costPerQuery)
        .map((p) => p.id);

      for (const pid of sortedIds) {
        if (pid === providerConfig.id) continue;
        const altConfig = getSearchProvider(pid);
        const altCreds = altConfig ? await resolveSearchExecutionCredentials(altConfig) : null;
        if (isAllRateLimitedCredentials(altCreds)) {
          firstRateLimitedCredentials ??= { providerId: pid, credentials: altCreds };
          continue;
        }
        if (altConfig && altCreds) {
          providerConfig = altConfig;
          credentials = altCreds;
          break;
        }
      }
    }

    // Last resort before failing: promote a fallback-only free provider (e.g.
    // duckduckgo-free) to the primary pick so out-of-the-box search works when
    // no credentialed provider is configured at all.
    if (!credentials) {
      const fallbackProviders = Object.values(SEARCH_PROVIDERS)
        .filter(
          (provider) =>
            provider.fallbackOnly &&
            supportsSearchType(provider, body.search_type) &&
            !isProviderBlockedByIdOrAlias(provider.id, blockedProviders)
        )
        .sort((a, b) => a.costPerQuery - b.costPerQuery);

      for (const fallbackProvider of fallbackProviders) {
        providerConfig = fallbackProvider;
        if (fallbackProvider.id === "duckduckgo-free") {
          credentials = {};
          break;
        }
        const fallbackCreds = await resolveSearchCredentials(fallbackProvider.id);
        if (isAllRateLimitedCredentials(fallbackCreds)) continue;
        if (fallbackCreds) {
          credentials = fallbackCreds;
          break;
        }
      }
    }

    if (!credentials) {
      if (firstRateLimitedCredentials) {
        return rateLimitedProviderResponse(
          firstRateLimitedCredentials.providerId,
          firstRateLimitedCredentials.credentials
        );
      }
      return errorResponse(
        HTTP_STATUS.BAD_REQUEST,
        `No credentials configured for any search provider. Add an API key for a search provider (${Object.keys(SEARCH_PROVIDERS).join(", ")}) in the dashboard.`
      );
    }

    // Find alternate for failover — must bind credentials to the matched provider.
    // Exclude fallback-only providers; they are only used by the last-resort step.
    const otherIds = Object.values(SEARCH_PROVIDERS)
      .filter(
        (provider) => !provider.fallbackOnly && supportsSearchType(provider, body.search_type)
      )
      .sort((a, b) => a.costPerQuery - b.costPerQuery)
      .map((p) => p.id)
      .filter((id) => id !== providerConfig.id);

    for (const pid of otherIds) {
      const altConfig = getSearchProvider(pid);
      const creds = altConfig ? await resolveSearchExecutionCredentials(altConfig) : null;
      if (isAllRateLimitedCredentials(creds)) continue;
      if (creds) {
        alternateProviderId = pid;
        alternateCredentials = creds;
        break;
      }
    }

    // Last-resort: guarantee a free no-key fallback (e.g. duckduckgo-free) as the
    // failover so out-of-the-box search still works when no credentialed provider
    // is configured. Only used when no real alternate was found above.
    if (!alternateProviderId) {
      for (const provider of Object.values(SEARCH_PROVIDERS)) {
        if (!provider.fallbackOnly || provider.id === providerConfig.id) continue;
        if (isUnconfiguredLoopbackSearchProvider(provider)) continue;
        if (!supportsSearchType(provider, body.search_type)) continue;
        const fallbackCreds = await resolveSearchExecutionCredentials(provider);
        if (fallbackCreds && !isAllRateLimitedCredentials(fallbackCreds)) {
          alternateProviderId = provider.id;
          alternateCredentials = fallbackCreds;
          break;
        }
      }
    }
  }

  // Clamp max_results to provider limit
  const clampedMaxResults = Math.min(body.max_results, providerConfig.maxMaxResults);

  return {
    provider: providerConfig.id,
    maxResults: clampedMaxResults,
    credentials,
    alternateProvider: alternateProviderId,
    alternateCredentials,
  };
}
