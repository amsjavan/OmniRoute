// @vitest-environment jsdom
//
// Phase 1d regression tests for Issue #3501.
// ConnectionRow, ModelCompatPopover, and SiliconFlowEndpointModal were extracted
// from the god-component. This proves each mounts in isolation with its clean
// Props interface (Hard Rule #8, Rule #18 TDD gate).
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ConnectionRow from "../ConnectionRow";
import ModelCompatPopover from "../ModelCompatPopover";
import SiliconFlowEndpointModal from "../SiliconFlowEndpointModal";

vi.mock("next/navigation", () => ({
  useParams: () => ({ id: "openai" }),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
}));
vi.mock("next-intl", () => ({
  useTranslations: () => (k: string) => k,
  useLocale: () => "en",
}));

// Minimal store stubs
vi.mock("@/store/emailPrivacyStore", () => ({
  default: () => true,
}));
vi.mock("@/store/notificationStore", () => ({
  useNotificationStore: () => ({ add: vi.fn() }),
}));

const cleanups: Array<() => void> = [];

function renderComponent(node: React.ReactElement) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => root.render(node));
  cleanups.push(() => {
    act(() => root.unmount());
    container.remove();
  });
  return container;
}

describe("phase-1d extractions (#3501)", () => {
  beforeEach(() => {
    (
      globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve({ ok: true, json: async () => ({}), text: async () => "" } as Response)
      )
    );
    vi.stubGlobal("localStorage", {
      getItem: () => null,
      setItem: () => undefined,
      removeItem: () => undefined,
      clear: () => undefined,
    });
  });

  afterEach(() => {
    while (cleanups.length) cleanups.pop()?.();
    document.body.innerHTML = "";
    vi.unstubAllGlobals();
  });

  // ── ConnectionRow ──────────────────────────────────────────────────────────

  function codexPoolFixture(): any {
    const win = (used: number | null) => ({
      usage: null,
      limit: null,
      resetAt: null,
      usedPercentage: used,
    });
    return {
      parentConnectionId: "conn-codex",
      aggregate: { status: "available", limitedChildCount: 0 },
      children: [
        {
          key: { parentConnectionId: "conn-codex", scope: "codex" },
          unavailable: false,
          cooldown: { active: false, rateLimitedUntil: null },
          quota: {
            exhaustedWindow: null,
            observedAt: null,
            windows: { "5h": win(94), "7d": null },
          },
        },
        {
          key: { parentConnectionId: "conn-codex", scope: "spark" },
          unavailable: false,
          cooldown: { active: false, rateLimitedUntil: null },
          quota: { exhaustedWindow: null, observedAt: null, windows: { "5h": null, "7d": null } },
        },
      ],
    };
  }

  it("ConnectionRow mounts with minimal required props (API-key connection)", () => {
    const conn = {
      id: "conn-1",
      name: "My Key",
      isActive: true,
      priority: 1,
    };
    const c = renderComponent(
      <ConnectionRow
        connection={conn}
        isOAuth={false}
        isFirst={true}
        isLast={false}
        onMoveUp={vi.fn()}
        onMoveDown={vi.fn()}
        onToggleActive={vi.fn()}
        onToggleRateLimit={vi.fn()}
        onRetest={vi.fn()}
        onEdit={vi.fn()}
        onDelete={vi.fn()}
      />
    );
    expect(c).toBeDefined();
  });

  it("ConnectionRow mounts as OAuth connection (isClaude=true)", () => {
    const conn = {
      id: "conn-2",
      email: "user@example.com",
      isActive: true,
      priority: 2,
    };
    const c = renderComponent(
      <ConnectionRow
        connection={conn}
        isOAuth={true}
        isClaude={true}
        isFirst={false}
        isLast={true}
        onMoveUp={vi.fn()}
        onMoveDown={vi.fn()}
        onToggleActive={vi.fn()}
        onToggleRateLimit={vi.fn()}
        onRetest={vi.fn()}
        onEdit={vi.fn()}
        onDelete={vi.fn()}
      />
    );
    expect(c).toBeDefined();
  });

  it("ConnectionRow toggles Provider Quota visibility", () => {
    const onToggleQuotaVisibility = vi.fn();
    const c = renderComponent(
      <ConnectionRow
        connection={{ id: "conn-quota", name: "Hidden quota", quotaVisible: false }}
        isOAuth={false}
        isFirst={true}
        isLast={true}
        onMoveUp={vi.fn()}
        onMoveDown={vi.fn()}
        onToggleActive={vi.fn()}
        onToggleRateLimit={vi.fn()}
        onToggleQuotaVisibility={onToggleQuotaVisibility}
        onRetest={vi.fn()}
        onEdit={vi.fn()}
        onDelete={vi.fn()}
      />
    );

    const button = c.querySelector('button[aria-pressed="false"]') as HTMLButtonElement;
    expect(button).not.toBeNull();
    act(() => button.click());
    expect(onToggleQuotaVisibility).toHaveBeenCalledWith(true);
  });

  it("ConnectionRow renders codex quota pools panel BELOW the action row (no flex-row overlap)", () => {
    const c = renderComponent(
      <ConnectionRow
        connection={{
          id: "conn-codex",
          name: "Codex acct",
          isActive: true,
          priority: 1,
          codexAccountPool: codexPoolFixture(),
        }}
        isOAuth={true}
        isCodex={true}
        isFirst={true}
        isLast={true}
        onMoveUp={vi.fn()}
        onMoveDown={vi.fn()}
        onToggleActive={vi.fn()}
        onToggleRateLimit={vi.fn()}
        onRetest={vi.fn()}
        onEdit={vi.fn()}
        onDelete={vi.fn()}
      />
    );

    // The quota-pools panel must be a block-level sibling AFTER the row,
    // never a flex item inside the horizontal action row (that caused the
    // overlap in the providers page screenshot).
    const panel = Array.from(c.querySelectorAll("div")).find((d) =>
      d.textContent?.includes("5h:")
    ) as HTMLElement | undefined;
    expect(panel).toBeDefined();
    const panelStyle = panel!.parentElement;
    // wrapper is a plain block div, not a flex row
    expect(panelStyle?.className ?? "").not.toMatch(/(^|\s)flex(\s|$)/);
    // the top-level row container itself must not be a flex row anymore
    const root = c.firstElementChild as HTMLElement | null;
    expect(root?.className ?? "").not.toMatch(/(^|\s)flex(\s|$)/);
  });

  it("ConnectionRow renders cooldown badge when rateLimitedUntil is in the future", () => {
    const conn = {
      id: "conn-3",
      name: "Rate-limited Key",
      isActive: true,
      priority: 1,
      rateLimitedUntil: new Date(Date.now() + 60000).toISOString(),
      testStatus: "unavailable",
    };
    const c = renderComponent(
      <ConnectionRow
        connection={conn}
        isOAuth={false}
        isFirst={true}
        isLast={true}
        onMoveUp={vi.fn()}
        onMoveDown={vi.fn()}
        onToggleActive={vi.fn()}
        onToggleRateLimit={vi.fn()}
        onRetest={vi.fn()}
        onEdit={vi.fn()}
        onDelete={vi.fn()}
      />
    );
    expect(c).toBeDefined();
  });

  // ── ModelCompatPopover ─────────────────────────────────────────────────────

  it("ModelCompatPopover mounts in closed state without throwing", () => {
    const c = renderComponent(
      <ModelCompatPopover
        t={(k: string) => k}
        providerId="openai"
        modelId="gpt-test"
        effectiveModelNormalize={() => false}
        effectiveModelPreserveDeveloper={() => true}
        getUpstreamHeadersRecord={() => ({})}
        onCompatPatch={vi.fn()}
      />
    );
    expect(c).toBeDefined();
  });

  it("ModelCompatPopover mounts with compact=true and disabled=true", () => {
    const c = renderComponent(
      <ModelCompatPopover
        t={(k: string) => k}
        providerId="openai"
        modelId="gpt-test"
        effectiveModelNormalize={() => true}
        effectiveModelPreserveDeveloper={() => false}
        getUpstreamHeadersRecord={() => ({ "X-Custom": "value" })}
        onCompatPatch={vi.fn()}
        compact={true}
        disabled={true}
      />
    );
    expect(c).toBeDefined();
  });

  // ── SiliconFlowEndpointModal ───────────────────────────────────────────────

  it("SiliconFlowEndpointModal mounts when isOpen=false (renders nothing visible)", () => {
    const c = renderComponent(
      <SiliconFlowEndpointModal isOpen={false} onSelect={vi.fn()} onClose={vi.fn()} />
    );
    expect(c).toBeDefined();
  });

  it("SiliconFlowEndpointModal mounts when isOpen=true without throwing", () => {
    const c = renderComponent(
      <SiliconFlowEndpointModal isOpen={true} onSelect={vi.fn()} onClose={vi.fn()} />
    );
    expect(c).toBeDefined();
  });
});
