import { z } from "zod";
import { handleSearch } from "@omniroute/open-sse/handlers/search.ts";
import { errorResponse } from "@omniroute/open-sse/utils/error.ts";
import { resolveSearchExecution } from "@/app/api/v1/_shared/searchExecution";
import { enforceApiKeyPolicy } from "@/shared/utils/apiKeyPolicy";
import {
  formatValidationMessage,
  isValidationFailure,
  validateBody,
} from "@/shared/validation/helpers";
import { extractApiKey, isValidApiKey } from "@/sse/services/auth";
import * as log from "@/sse/utils/logger";

const CORS_HEADERS = {
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "*",
};

const alphaSearchSchema = z.object({
  id: z.string(),
  model: z.string(),
  commands: z
    .object({
      search_query: z
        .array(
          z.object({
            q: z.string().trim().min(1).max(500),
            recency: z.number().nonnegative().optional(),
            domains: z.array(z.string().max(253)).max(20).optional(),
          })
        )
        .min(1, "commands.search_query must contain at least one query")
        .default([]),
    })
    .default({ search_query: [] }),
});

type TextResult = {
  type: "text_result";
  ref_id: string;
  url: string;
  title: string;
  snippet: string;
};

export async function OPTIONS() {
  return new Response(null, { headers: CORS_HEADERS });
}

export async function POST(request: Request) {
  let rawBody: unknown;
  try {
    rawBody = await request.json();
  } catch {
    return errorResponse(400, "Invalid JSON body");
  }

  const validation = validateBody(alphaSearchSchema, rawBody);
  if (isValidationFailure(validation)) {
    return errorResponse(400, formatValidationMessage(validation.error));
  }
  const queries = validation.data.commands.search_query;
  if (!queries.length) {
    return errorResponse(400, "commands.search_query must contain at least one query");
  }

  try {
    const apiKey = extractApiKey(request);
    if (!apiKey || !(await isValidApiKey(apiKey))) {
      return errorResponse(401, "A valid API key is required");
    }
    const policy = await enforceApiKeyPolicy(request, "search");
    if (policy.rejection) return policy.rejection;

    const execution = await resolveSearchExecution({ search_type: "web", max_results: 5 });
    if (execution instanceof Response) return execution;

    const results: TextResult[] = [];
    const output: string[] = [];
    for (const query of queries) {
      // Only map exact standard windows; other recency values are ignored.
      const timeRange = { 1: "day", 7: "week", 30: "month", 365: "year" }[query.recency ?? -1];
      const result = await handleSearch({
        ...execution,
        query: query.q,
        searchType: "web",
        timeRange,
        domainFilter: query.domains,
        log,
        connectionId:
          typeof execution.credentials.connectionId === "string"
            ? execution.credentials.connectionId
            : undefined,
        apiKeyId: policy.apiKeyInfo?.id || undefined,
      });
      if (!result.success || !result.data) {
        return errorResponse(result.status || 502, result.error || "Search failed");
      }
      if (!result.data.results.length) {
        output.push(`No results found for ${query.q}`);
      }
      for (const item of result.data.results) {
        results.push({
          type: "text_result",
          ref_id: `turn0search${results.length}`,
          url: item.url,
          title: item.title,
          snippet: item.snippet,
        });
        output.push(`${results.length}. ${item.title} — ${item.url}\n${item.snippet}`);
      }
    }
    return Response.json(
      { encrypted_output: null, output: output.join("\n\n"), results },
      { headers: CORS_HEADERS }
    );
  } catch (error) {
    return errorResponse(500, error instanceof Error ? error.message : "Internal search error");
  }
}
