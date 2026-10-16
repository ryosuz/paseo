import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { discover, fetchUsage } from "./usage.js";
import type { UsageInput } from "../shared/input.js";

const QUOTA_URL = "https://app.devin.ai/api/org-test-1/billing/quota/usage";

function mockFetch(handlers: Map<string, () => Response>): typeof fetch {
  return vi.fn(async (url: RequestInfo | URL) => {
    const handler = handlers.get(url.toString());
    if (!handler) throw new Error(`Unmocked fetch: ${url.toString()}`);
    return handler();
  }) as unknown as typeof fetch;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const ENV_INPUT: UsageInput = {
  store: "env",
  tokenEnv: "DEVIN_API_KEY",
  orgEnv: "DEVIN_ORG_ID",
};

function quotaResponse(overrides: Record<string, unknown> = {}) {
  return jsonResponse({
    is_quota_plan: true,
    has_quota_allocation: true,
    daily_percentage: 0,
    weekly_percentage: 16,
    daily_reset_at: "2026-10-16T00:00:00-08:00",
    weekly_reset_at: "2026-10-18T00:00:00-08:00",
    overage_balance: 10,
    hide_daily_quota: false,
    ...overrides,
  });
}

describe("devin usage source", () => {
  let homeDir: string;
  let originalEnv: Record<string, string | undefined>;

  beforeEach(() => {
    homeDir = mkdtempSync(join(tmpdir(), "devin-usage-home-"));
    originalEnv = { ...process.env };
    process.env["HOME"] = homeDir;
    process.env["USERPROFILE"] = homeDir;
    for (const key of ["DEVIN_API_KEY", "DEVIN_ORG_ID", "WINDSURF_API_KEY"])
      delete process.env[key];
  });

  afterEach(() => {
    rmSync(homeDir, { recursive: true, force: true });
    for (const key of Object.keys(process.env)) if (!(key in originalEnv)) delete process.env[key];
    for (const key in originalEnv) process.env[key] = originalEnv[key];
  });

  it("maps daily and weekly quota percentages plus the overage balance", async () => {
    process.env["DEVIN_API_KEY"] = "devin-token";
    process.env["DEVIN_ORG_ID"] = "org-test-1";
    const fetchApi = mockFetch(new Map([[QUOTA_URL, () => quotaResponse()]]));

    const report = await fetchUsage(ENV_INPUT, fetchApi);

    expect(report).toEqual({
      status: "available",
      windows: [
        expect.objectContaining({
          id: "daily",
          label: "Daily",
          shortLabel: "1d",
          summary: true,
          usedPct: 0,
          remainingPct: 100,
          resetsAt: "2026-10-16T00:00:00-08:00",
          tone: "ok",
        }),
        expect.objectContaining({
          id: "weekly",
          label: "Weekly",
          shortLabel: "wk",
          summary: true,
          usedPct: 16,
          resetsAt: "2026-10-18T00:00:00-08:00",
        }),
      ],
      balances: [
        {
          id: "overage",
          label: "On-demand credits",
          remaining: 10,
          unit: "usd",
          tone: "ok",
        },
      ],
    });
  });

  it("omits the daily window when hide_daily_quota is set", async () => {
    process.env["DEVIN_API_KEY"] = "devin-token";
    process.env["DEVIN_ORG_ID"] = "org-test-1";
    const fetchApi = mockFetch(
      new Map([[QUOTA_URL, () => quotaResponse({ hide_daily_quota: true })]]),
    );

    const report = await fetchUsage(ENV_INPUT, fetchApi);

    expect(report).toMatchObject({
      status: "available",
      windows: [expect.objectContaining({ id: "weekly" })],
    });
  });

  it("flags an empty overage balance as spent", async () => {
    process.env["DEVIN_API_KEY"] = "devin-token";
    process.env["DEVIN_ORG_ID"] = "org-test-1";
    const fetchApi = mockFetch(new Map([[QUOTA_URL, () => quotaResponse({ overage_balance: 0 })]]));

    const report = await fetchUsage(ENV_INPUT, fetchApi);

    expect(report).toMatchObject({
      status: "available",
      balances: [expect.objectContaining({ id: "overage", remaining: 0, tone: "danger" })],
    });
  });

  it("reports no quota when the account is not on a quota plan", async () => {
    process.env["DEVIN_API_KEY"] = "devin-token";
    process.env["DEVIN_ORG_ID"] = "org-test-1";
    const fetchApi = mockFetch(
      new Map([
        [QUOTA_URL, () => quotaResponse({ is_quota_plan: false, has_quota_allocation: false })],
      ]),
    );

    const report = await fetchUsage(ENV_INPUT, fetchApi);

    expect(report).toEqual({
      status: "unavailable",
      problem: { kind: "no_quota", detail: "No Devin quota plan" },
    });
  });

  it.each([401, 403])("reports a rejected env login with HTTP %i", async (status) => {
    process.env["DEVIN_API_KEY"] = "devin-token";
    process.env["DEVIN_ORG_ID"] = "org-test-1";
    const report = await fetchUsage(
      ENV_INPUT,
      mockFetch(new Map([[QUOTA_URL, () => new Response(null, { status })]])),
    );

    expect(report).toEqual({ status: "unavailable", problem: { kind: "rejected", status } });
  });

  it("points a rejected CLI login at devin auth login", async () => {
    const credentialsPath = join(homeDir, ".local", "share", "devin", "credentials.toml");
    const configPath = join(homeDir, ".config", "devin", "config.json");
    mkdirSync(dirname(credentialsPath), { recursive: true });
    mkdirSync(dirname(configPath), { recursive: true });
    writeFileSync(credentialsPath, 'windsurf_api_key = "devin-session-token"\n');
    writeFileSync(configPath, JSON.stringify({ devin: { org_id: "org-test-1" } }));

    const report = await fetchUsage(
      { store: "file", credentialsPath, configPath },
      mockFetch(new Map([[QUOTA_URL, () => new Response(null, { status: 401 })]])),
    );

    expect(report).toEqual({
      status: "unavailable",
      problem: { kind: "rejected", status: 401, refreshedBy: "devin auth login" },
    });
  });

  it("reports an error when the request fails", async () => {
    process.env["DEVIN_API_KEY"] = "devin-token";
    process.env["DEVIN_ORG_ID"] = "org-test-1";
    const report = await fetchUsage(
      ENV_INPUT,
      mockFetch(new Map([[QUOTA_URL, () => new Response(null, { status: 500 })]])),
    );

    expect(report).toEqual({ status: "error", error: "Devin usage API request failed" });
  });

  it("sends the CLI credentials to the org-scoped quota endpoint", async () => {
    const credentialsPath = join(homeDir, ".local", "share", "devin", "credentials.toml");
    const configPath = join(homeDir, ".config", "devin", "config.json");
    mkdirSync(dirname(credentialsPath), { recursive: true });
    mkdirSync(dirname(configPath), { recursive: true });
    writeFileSync(
      credentialsPath,
      'windsurf_api_key = "devin-session-token"\napi_server_url = "https://server.codeium.com"\n',
    );
    writeFileSync(configPath, JSON.stringify({ devin: { org_id: "org-test-1" } }));

    let seenHeaders: Record<string, string> | undefined;
    const fetchApi = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      seenHeaders = Object.fromEntries(
        Object.entries((init?.headers ?? {}) as Record<string, string>),
      );
      return quotaResponse();
    }) as unknown as typeof fetch;

    const report = await fetchUsage({ store: "file", credentialsPath, configPath }, fetchApi);

    expect(seenHeaders).toMatchObject({
      Authorization: "Bearer devin-session-token",
      "x-cog-org-id": "org-test-1",
    });
    expect(report).toMatchObject({ status: "available" });
  });

  it("throws when the file login store has no credentials", async () => {
    const credentialsPath = join(homeDir, ".local", "share", "devin", "credentials.toml");
    const configPath = join(homeDir, ".config", "devin", "config.json");

    await expect(
      fetchUsage({ store: "file", credentialsPath, configPath }, vi.fn() as never),
    ).rejects.toThrow("Devin login store no longer exists");
  });
});

describe("account discovery", () => {
  let homeDir: string;
  let originalEnv: Record<string, string | undefined>;

  beforeEach(() => {
    homeDir = mkdtempSync(join(tmpdir(), "devin-discover-home-"));
    originalEnv = { ...process.env };
    process.env["HOME"] = homeDir;
    process.env["USERPROFILE"] = homeDir;
    for (const key of ["DEVIN_API_KEY", "DEVIN_ORG_ID", "WINDSURF_API_KEY"])
      delete process.env[key];
  });

  afterEach(() => {
    rmSync(homeDir, { recursive: true, force: true });
    for (const key of Object.keys(process.env)) if (!(key in originalEnv)) delete process.env[key];
    for (const key in originalEnv) process.env[key] = originalEnv[key];
  });

  it("returns no accounts without env vars or CLI files", async () => {
    expect(await discover()).toEqual([]);
  });

  it("prefers env credentials when both are set", async () => {
    process.env["DEVIN_API_KEY"] = "devin-token";
    process.env["DEVIN_ORG_ID"] = "org-test-1";

    expect(await discover()).toEqual([
      {
        key: "env",
        input: { store: "env", tokenEnv: "DEVIN_API_KEY", orgEnv: "DEVIN_ORG_ID" },
      },
    ]);
  });

  it("falls back to WINDSURF_API_KEY for the token", async () => {
    process.env["WINDSURF_API_KEY"] = "devin-token";
    process.env["DEVIN_ORG_ID"] = "org-test-1";

    expect(await discover()).toEqual([
      {
        key: "env",
        input: { store: "env", tokenEnv: "WINDSURF_API_KEY", orgEnv: "DEVIN_ORG_ID" },
      },
    ]);
  });

  it("discovers the Devin CLI login store", async () => {
    const credentialsPath = join(homeDir, ".local", "share", "devin", "credentials.toml");
    const configPath = join(homeDir, ".config", "devin", "config.json");
    mkdirSync(dirname(credentialsPath), { recursive: true });
    mkdirSync(dirname(configPath), { recursive: true });
    writeFileSync(credentialsPath, 'windsurf_api_key = "devin-session-token"\n');
    writeFileSync(configPath, JSON.stringify({ devin: { org_id: "org-test-1" } }));

    expect(await discover()).toEqual([
      { key: "cli", input: { store: "file", credentialsPath, configPath } },
    ]);
  });
});
