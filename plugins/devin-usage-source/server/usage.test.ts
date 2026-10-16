import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { hashAccountKey } from "@getpaseo/plugin/server/usage";
import { cliPaths, discover, fetchUsage } from "./usage.js";
import { inputSchema, type UsageInput } from "../shared/input.js";

const QUOTA_URL = "https://app.devin.ai/api/org-test-1/billing/quota/usage";

function mockFetch(handlers: Map<string, () => Response>): typeof fetch {
  return vi.fn(async (url: Parameters<typeof fetch>[0]) => {
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

function writeCliStore(
  home: string,
  files: { credentials?: string; config?: string; dataDir?: string; configDir?: string },
): { credentialsPath: string; configPath: string } {
  const defaults = cliPaths(process.env, home);
  const credentialsPath = files.dataDir
    ? join(files.dataDir, "devin", "credentials.toml")
    : defaults.credentialsPath;
  const configPath = files.configDir
    ? join(files.configDir, "devin", "config.json")
    : defaults.configPath;
  mkdirSync(dirname(credentialsPath), { recursive: true });
  mkdirSync(dirname(configPath), { recursive: true });
  writeFileSync(credentialsPath, files.credentials ?? 'windsurf_api_key = "devin-session-token"\n');
  writeFileSync(configPath, files.config ?? JSON.stringify({ devin: { org_id: "org-test-1" } }));
  return { credentialsPath, configPath };
}

describe("devin usage source", () => {
  let homeDir: string;
  let originalEnv: Record<string, string | undefined>;

  beforeEach(() => {
    homeDir = mkdtempSync(join(tmpdir(), "devin-usage-home-"));
    originalEnv = { ...process.env };
    process.env["HOME"] = homeDir;
    process.env["USERPROFILE"] = homeDir;
    for (const key of [
      "DEVIN_API_KEY",
      "DEVIN_ORG_ID",
      "WINDSURF_API_KEY",
      "XDG_DATA_HOME",
      "XDG_CONFIG_HOME",
      "DEVIN_WEBAPP_HOST",
      "APPDATA",
    ])
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

  it("omits the weekly window when hide_weekly_quota is set", async () => {
    process.env["DEVIN_API_KEY"] = "devin-token";
    process.env["DEVIN_ORG_ID"] = "org-test-1";
    const fetchApi = mockFetch(
      new Map([[QUOTA_URL, () => quotaResponse({ hide_weekly_quota: true })]]),
    );

    const report = await fetchUsage(ENV_INPUT, fetchApi);

    expect(report).toMatchObject({
      status: "available",
      windows: [expect.objectContaining({ id: "daily" })],
    });
  });

  it.each([null, "", "   ", false, [], ["42"]])(
    "does not turn a %s percentage into a fabricated bar",
    async (value) => {
      process.env["DEVIN_API_KEY"] = "devin-token";
      process.env["DEVIN_ORG_ID"] = "org-test-1";
      const fetchApi = mockFetch(
        new Map([[QUOTA_URL, () => quotaResponse({ weekly_percentage: value })]]),
      );

      const report = await fetchUsage(ENV_INPUT, fetchApi);

      expect(report).toMatchObject({
        status: "available",
        windows: [expect.objectContaining({ id: "daily" })],
      });
    },
  );

  it("does not report a null overage balance as $0 spent", async () => {
    process.env["DEVIN_API_KEY"] = "devin-token";
    process.env["DEVIN_ORG_ID"] = "org-test-1";
    const fetchApi = mockFetch(
      new Map([[QUOTA_URL, () => quotaResponse({ overage_balance: null })]]),
    );

    const report = await fetchUsage(ENV_INPUT, fetchApi);

    expect(report).toMatchObject({ status: "available" });
    expect((report as { balances?: unknown[] }).balances ?? []).toEqual([]);
  });

  it("falls back to overage_balance_cents", async () => {
    process.env["DEVIN_API_KEY"] = "devin-token";
    process.env["DEVIN_ORG_ID"] = "org-test-1";
    const fetchApi = mockFetch(
      new Map([
        [
          QUOTA_URL,
          () => quotaResponse({ overage_balance: undefined, overage_balance_cents: 1550 }),
        ],
      ]),
    );

    const report = await fetchUsage(ENV_INPUT, fetchApi);

    expect(report).toMatchObject({
      status: "available",
      balances: [expect.objectContaining({ id: "overage", remaining: 15.5 })],
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

  it("normalizes epoch reset timestamps", async () => {
    process.env["DEVIN_API_KEY"] = "devin-token";
    process.env["DEVIN_ORG_ID"] = "org-test-1";
    const fetchApi = mockFetch(
      new Map([
        [
          QUOTA_URL,
          () =>
            quotaResponse({
              daily_reset_at: 1792100000,
              weekly_reset_at: "1792600000000",
            }),
        ],
      ]),
    );

    const report = await fetchUsage(ENV_INPUT, fetchApi);

    expect(report).toMatchObject({
      status: "available",
      windows: [
        expect.objectContaining({ id: "daily", resetsAt: new Date(1792100000000).toISOString() }),
        expect.objectContaining({ id: "weekly", resetsAt: new Date(1792600000000).toISOString() }),
      ],
    });
  });

  it("omits unparseable reset timestamps", async () => {
    process.env["DEVIN_API_KEY"] = "devin-token";
    process.env["DEVIN_ORG_ID"] = "org-test-1";
    const fetchApi = mockFetch(
      new Map([[QUOTA_URL, () => quotaResponse({ daily_reset_at: "next tuesday" })]]),
    );

    const report = await fetchUsage(ENV_INPUT, fetchApi);

    expect(report).toMatchObject({
      status: "available",
      windows: [
        expect.objectContaining({ id: "daily", resetsAt: null }),
        expect.objectContaining({ id: "weekly" }),
      ],
    });
  });

  it("omits reset timestamps outside Date's range instead of throwing", async () => {
    process.env["DEVIN_API_KEY"] = "devin-token";
    process.env["DEVIN_ORG_ID"] = "org-test-1";
    const fetchApi = mockFetch(
      new Map([[QUOTA_URL, () => quotaResponse({ daily_reset_at: 1e18 })]]),
    );

    const report = await fetchUsage(ENV_INPUT, fetchApi);

    expect(report).toMatchObject({
      status: "available",
      windows: [
        expect.objectContaining({ id: "daily", resetsAt: null }),
        expect.objectContaining({ id: "weekly" }),
      ],
    });
  });

  it.each([
    "file:///etc/passwd",
    "https://user:pass@evil.example.com",
    "https://evil.example.com/path",
    "https://evil.example.com/?x=1",
  ])("rejects a configured web app host that could redirect the token: %s", async (host) => {
    process.env["DEVIN_API_KEY"] = "devin-token";
    process.env["DEVIN_ORG_ID"] = "org-test-1";
    process.env["DEVIN_WEBAPP_HOST"] = host;

    const error = await fetchUsage(ENV_INPUT, vi.fn() as never).then(
      () => {
        throw new Error("expected fetchUsage to reject");
      },
      (caught: unknown) => caught as Error,
    );

    expect(error.message).toBe("Devin web app host is not a usable host");
    expect(error.message).not.toContain("evil");
    expect(error.message).not.toContain("passwd");
  });

  it("uses DEVIN_WEBAPP_HOST for env credentials", async () => {
    process.env["DEVIN_API_KEY"] = "devin-token";
    process.env["DEVIN_ORG_ID"] = "org-test-1";
    process.env["DEVIN_WEBAPP_HOST"] = "devin.acme.example.com";
    const seenUrls: string[] = [];
    const fetchApi = vi.fn(async (url: Parameters<typeof fetch>[0]) => {
      seenUrls.push(url.toString());
      return quotaResponse();
    }) as unknown as typeof fetch;

    await fetchUsage(ENV_INPUT, fetchApi);

    expect(seenUrls).toEqual(["https://devin.acme.example.com/api/org-test-1/billing/quota/usage"]);
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

  it("reports an error rather than no_quota when the response has no usable quota data", async () => {
    process.env["DEVIN_API_KEY"] = "devin-token";
    process.env["DEVIN_ORG_ID"] = "org-test-1";
    const fetchApi = mockFetch(new Map([[QUOTA_URL, () => jsonResponse({})]]));

    const report = await fetchUsage(ENV_INPUT, fetchApi);

    expect(report).toEqual({
      status: "error",
      error: "Devin usage API returned no quota windows",
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
    const { credentialsPath, configPath } = writeCliStore(homeDir, {});

    const report = await fetchUsage(
      { store: "file", credentialsPath, configPath },
      mockFetch(new Map([[QUOTA_URL, () => new Response(null, { status: 401 })]])),
    );

    expect(report).toEqual({
      status: "unavailable",
      problem: { kind: "rejected", status: 401, refreshedBy: "devin auth login" },
    });
  });

  it("includes the status when the request fails", async () => {
    process.env["DEVIN_API_KEY"] = "devin-token";
    process.env["DEVIN_ORG_ID"] = "org-test-1";
    const report = await fetchUsage(
      ENV_INPUT,
      mockFetch(new Map([[QUOTA_URL, () => new Response(null, { status: 500 })]])),
    );

    expect(report).toEqual({ status: "error", error: "Devin usage API returned HTTP 500" });
  });

  it("separates a non-JSON body from a network failure", async () => {
    process.env["DEVIN_API_KEY"] = "devin-token";
    process.env["DEVIN_ORG_ID"] = "org-test-1";

    const nonJson = await fetchUsage(
      ENV_INPUT,
      mockFetch(new Map([[QUOTA_URL, () => new Response("<html>", { status: 200 })]])),
    );
    expect(nonJson).toEqual({
      status: "error",
      error: "Devin usage API returned a non-JSON response",
    });

    const offline = await fetchUsage(
      ENV_INPUT,
      vi.fn(async () => {
        throw new Error("socket hangup");
      }) as never,
    );
    expect(offline).toMatchObject({ status: "error" });
    expect((offline as { error: string }).error).toContain("request failed");
  });

  it("never leaks the token into network failure messages", async () => {
    process.env["DEVIN_API_KEY"] = "devin-token\ninjected";
    process.env["DEVIN_ORG_ID"] = "org-test-1";
    const report = await fetchUsage(
      ENV_INPUT,
      vi.fn(async () => {
        throw new TypeError('Headers.append: "devin-token\ninjected" is an invalid header value');
      }) as never,
    );

    expect(report).toEqual({
      status: "error",
      error: "Devin usage API request failed (TypeError)",
    });
    expect(JSON.stringify(report)).not.toContain("devin-token");
  });

  it("reports an unrecognized response shape", async () => {
    process.env["DEVIN_API_KEY"] = "devin-token";
    process.env["DEVIN_ORG_ID"] = "org-test-1";
    const report = await fetchUsage(
      ENV_INPUT,
      mockFetch(new Map([[QUOTA_URL, () => jsonResponse({ is_quota_plan: "yes" })]])),
    );

    expect(report).toEqual({
      status: "error",
      error: "Devin usage API returned an unrecognized response",
    });
  });

  it("sends the CLI credentials to the org-scoped quota endpoint", async () => {
    const { credentialsPath, configPath } = writeCliStore(homeDir, {
      credentials:
        'windsurf_api_key = "devin-session-token"\napi_server_url = "https://server.codeium.com"\n',
    });

    let seenUrl: string | undefined;
    let seenHeaders: Record<string, string> | undefined;
    const fetchApi = vi.fn(async (url: Parameters<typeof fetch>[0], init?: RequestInit) => {
      seenUrl = url.toString();
      seenHeaders = Object.fromEntries(
        Object.entries((init?.headers ?? {}) as Record<string, string>),
      );
      return quotaResponse();
    }) as unknown as typeof fetch;

    const report = await fetchUsage({ store: "file", credentialsPath, configPath }, fetchApi);

    expect(seenUrl).toBe(QUOTA_URL);
    expect(seenHeaders).toMatchObject({
      Authorization: "Bearer devin-session-token",
      "x-cog-org-id": "org-test-1",
    });
    expect(report).toMatchObject({ status: "available" });
  });

  it("uses devin_webapp_host for the quota endpoint when pinned to another deployment", async () => {
    const { credentialsPath, configPath } = writeCliStore(homeDir, {
      credentials:
        'windsurf_api_key = "devin-session-token"\ndevin_webapp_host = "devin.acme.example.com"\n',
    });

    const seenUrls: string[] = [];
    const fetchApi = vi.fn(async (url: Parameters<typeof fetch>[0]) => {
      seenUrls.push(url.toString());
      return quotaResponse();
    }) as unknown as typeof fetch;

    await fetchUsage({ store: "file", credentialsPath, configPath }, fetchApi);

    expect(seenUrls).toEqual(["https://devin.acme.example.com/api/org-test-1/billing/quota/usage"]);
  });

  it("reads the CLI config with comments", async () => {
    const { credentialsPath, configPath } = writeCliStore(homeDir, {
      config: '{\n  // the org to bill usage to\n  "devin": { "org_id": "org-test-1" }\n}\n',
    });
    const fetchApi = mockFetch(new Map([[QUOTA_URL, () => quotaResponse()]]));

    const report = await fetchUsage({ store: "file", credentialsPath, configPath }, fetchApi);

    expect(report).toMatchObject({ status: "available" });
  });

  it("names the missing env vars when env credentials are incomplete", async () => {
    await expect(fetchUsage(ENV_INPUT, vi.fn() as never)).rejects.toThrow(
      "Devin credentials missing: set DEVIN_API_KEY and DEVIN_ORG_ID",
    );
  });

  it("throws when the credentials file is missing", async () => {
    const credentialsPath = join(homeDir, ".local", "share", "devin", "credentials.toml");
    const configPath = join(homeDir, ".config", "devin", "config.json");

    await expect(
      fetchUsage({ store: "file", credentialsPath, configPath }, vi.fn() as never),
    ).rejects.toThrow("Devin CLI credentials not found");
  });

  it("throws when credentials.toml has no windsurf_api_key", async () => {
    const { credentialsPath, configPath } = writeCliStore(homeDir, {
      credentials: 'api_server_url = "https://server.codeium.com"\n',
    });

    await expect(
      fetchUsage({ store: "file", credentialsPath, configPath }, vi.fn() as never),
    ).rejects.toThrow("credentials.toml does not contain windsurf_api_key");
  });

  it("throws when config.json has no org id", async () => {
    const { credentialsPath, configPath } = writeCliStore(homeDir, {
      config: JSON.stringify({ theme_mode: "dark" }),
    });

    await expect(
      fetchUsage({ store: "file", credentialsPath, configPath }, vi.fn() as never),
    ).rejects.toThrow("config.json has no devin.org_id");
  });

  it("throws when config.json is not valid JSON", async () => {
    const { credentialsPath, configPath } = writeCliStore(homeDir, { config: "{oops" });

    await expect(
      fetchUsage({ store: "file", credentialsPath, configPath }, vi.fn() as never),
    ).rejects.toThrow("config.json is not valid JSON");
  });
});

describe("account discovery", () => {
  let homeDir: string;
  let originalEnv: Record<string, string | undefined>;

  const globalScope = { kind: "global" } as const;

  beforeEach(() => {
    homeDir = mkdtempSync(join(tmpdir(), "devin-discover-home-"));
    originalEnv = { ...process.env };
    process.env["HOME"] = homeDir;
    process.env["USERPROFILE"] = homeDir;
    for (const key of [
      "DEVIN_API_KEY",
      "DEVIN_ORG_ID",
      "WINDSURF_API_KEY",
      "XDG_DATA_HOME",
      "XDG_CONFIG_HOME",
      "DEVIN_WEBAPP_HOST",
      "APPDATA",
    ])
      delete process.env[key];
  });

  afterEach(() => {
    rmSync(homeDir, { recursive: true, force: true });
    for (const key of Object.keys(process.env)) if (!(key in originalEnv)) delete process.env[key];
    for (const key in originalEnv) process.env[key] = originalEnv[key];
  });

  it("returns no accounts without env vars or CLI files", async () => {
    expect(await discover(globalScope)).toEqual([]);
  });

  it("keys the env login by org id", async () => {
    process.env["DEVIN_API_KEY"] = "devin-token";
    process.env["DEVIN_ORG_ID"] = "org-test-1";

    expect(await discover(globalScope)).toEqual([
      {
        key: hashAccountKey("org-test-1"),
        harness: "DEVIN_API_KEY",
        input: { store: "env", tokenEnv: "DEVIN_API_KEY", orgEnv: "DEVIN_ORG_ID" },
      },
    ]);
  });

  it("falls back to WINDSURF_API_KEY for the token", async () => {
    process.env["WINDSURF_API_KEY"] = "devin-token";
    process.env["DEVIN_ORG_ID"] = "org-test-1";

    expect(await discover(globalScope)).toEqual([
      {
        key: hashAccountKey("org-test-1"),
        harness: "WINDSURF_API_KEY",
        input: { store: "env", tokenEnv: "WINDSURF_API_KEY", orgEnv: "DEVIN_ORG_ID" },
      },
    ]);
  });

  it("advertises both env tokens under the same account", async () => {
    process.env["DEVIN_API_KEY"] = "devin-token";
    process.env["WINDSURF_API_KEY"] = "windsurf-token";
    process.env["DEVIN_ORG_ID"] = "org-test-1";

    const accounts = await discover(globalScope);

    expect(accounts.map((account) => account.harness)).toEqual([
      "DEVIN_API_KEY",
      "WINDSURF_API_KEY",
    ]);
    expect(new Set(accounts.map((account) => account.key))).toEqual(
      new Set([hashAccountKey("org-test-1")]),
    );
  });

  it("discovers the Devin CLI login store", async () => {
    const { credentialsPath, configPath } = writeCliStore(homeDir, {});

    expect(await discover(globalScope)).toEqual([
      {
        key: hashAccountKey("org-test-1"),
        harness: "Devin CLI",
        input: { store: "file", credentialsPath, configPath },
      },
    ]);
  });

  it("groups env and CLI logins of the same org under one account key", async () => {
    process.env["DEVIN_API_KEY"] = "devin-token";
    process.env["DEVIN_ORG_ID"] = "org-test-1";
    writeCliStore(homeDir, {});

    const accounts = await discover(globalScope);

    expect(accounts).toHaveLength(2);
    expect(new Set(accounts.map((account) => account.key))).toEqual(
      new Set([hashAccountKey("org-test-1")]),
    );
    expect(accounts.map((account) => account.harness)).toEqual(["DEVIN_API_KEY", "Devin CLI"]);
  });

  it("keeps env and CLI logins of different orgs on separate accounts", async () => {
    process.env["DEVIN_API_KEY"] = "devin-token";
    process.env["DEVIN_ORG_ID"] = "org-env";
    writeCliStore(homeDir, {});

    const accounts = await discover(globalScope);

    expect(accounts.map((account) => account.key)).toEqual([
      hashAccountKey("org-env"),
      hashAccountKey("org-test-1"),
    ]);
  });

  it("does not advertise a CLI store with no usable credentials", async () => {
    writeCliStore(homeDir, { credentials: 'api_server_url = "https://server.codeium.com"\n' });

    expect(await discover(globalScope)).toEqual([]);
  });

  it("does not advertise a CLI store with no org id", async () => {
    writeCliStore(homeDir, { config: JSON.stringify({ theme_mode: "dark" }) });

    expect(await discover(globalScope)).toEqual([]);
  });

  // Windows resolves both stores under APPDATA and never consults XDG.
  it.skipIf(process.platform === "win32")("honors XDG_DATA_HOME and XDG_CONFIG_HOME", async () => {
    process.env["XDG_DATA_HOME"] = join(homeDir, "xdg-data");
    process.env["XDG_CONFIG_HOME"] = join(homeDir, "xdg-config");
    const { credentialsPath, configPath } = writeCliStore(homeDir, {
      dataDir: process.env["XDG_DATA_HOME"],
      configDir: process.env["XDG_CONFIG_HOME"],
    });

    expect(await discover(globalScope)).toEqual([
      {
        key: hashAccountKey("org-test-1"),
        harness: "Devin CLI",
        input: { store: "file", credentialsPath, configPath },
      },
    ]);
  });

  it("discovers the CLI store under a session's HOME and skips env credentials", async () => {
    process.env["DEVIN_API_KEY"] = "devin-token";
    process.env["DEVIN_ORG_ID"] = "org-test-1";
    const sessionHome = mkdtempSync(join(tmpdir(), "devin-session-home-"));
    try {
      const { credentialsPath, configPath } = writeCliStore(sessionHome, {});

      const accounts = await discover({
        kind: "session",
        provider: "devin",
        env: { HOME: sessionHome, DEVIN_API_KEY: "agent-token", DEVIN_ORG_ID: "org-agent" },
      });

      expect(accounts).toEqual([
        {
          key: hashAccountKey("org-test-1"),
          harness: "Devin CLI",
          input: { store: "file", credentialsPath, configPath },
        },
      ]);
    } finally {
      rmSync(sessionHome, { recursive: true, force: true });
    }
  });

  it("ignores other providers' sessions", async () => {
    writeCliStore(homeDir, {});

    expect(
      await discover({
        kind: "session",
        provider: "claude",
        env: { HOME: homeDir },
      }),
    ).toEqual([]);
  });

  it("resolves Windows store paths under APPDATA", () => {
    const paths = cliPaths({ APPDATA: "C:\\Users\\u\\AppData\\Roaming" }, "C:\\Users\\u", "win32");

    expect(paths).toEqual({
      credentialsPath: join("C:\\Users\\u\\AppData\\Roaming", "devin", "credentials.toml"),
      configPath: join("C:\\Users\\u\\AppData\\Roaming", "devin", "config.json"),
    });
  });

  it("treats empty XDG and APPDATA overrides as unset", async () => {
    process.env["XDG_DATA_HOME"] = "";
    process.env["XDG_CONFIG_HOME"] = "";
    process.env["APPDATA"] = "";
    writeCliStore(homeDir, {});

    const accounts = await discover(globalScope);

    expect(
      accounts.map((account) => (account.input as { credentialsPath: string }).credentialsPath),
    ).toEqual([cliPaths(process.env, homeDir).credentialsPath]);
  });

  it("keeps env accounts when the CLI store fails with an I/O error", async () => {
    process.env["DEVIN_API_KEY"] = "devin-token";
    process.env["DEVIN_ORG_ID"] = "org-test-1";
    // A directory where credentials.toml belongs makes readFile fail with EISDIR.
    mkdirSync(cliPaths(process.env, homeDir).credentialsPath, { recursive: true });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    try {
      const accounts = await discover(globalScope);

      expect(accounts).toEqual([
        {
          key: hashAccountKey("org-test-1"),
          harness: "DEVIN_API_KEY",
          input: { store: "env", tokenEnv: "DEVIN_API_KEY", orgEnv: "DEVIN_ORG_ID" },
        },
      ]);
      expect(warn).toHaveBeenCalledOnce();
      expect(warn.mock.calls[0]![0]).toContain("skipping CLI store");
    } finally {
      warn.mockRestore();
    }
  });

  it("does not put credential values into discovered inputs", async () => {
    process.env["DEVIN_API_KEY"] = "devin-secret-token";
    process.env["DEVIN_ORG_ID"] = "org-test-1";
    writeCliStore(homeDir, {});

    const accounts = await discover(globalScope);
    const serialized = JSON.stringify(accounts);

    expect(serialized).not.toContain("devin-secret-token");
    expect(serialized).not.toContain("devin-session-token");
  });

  it("rejects inputs carrying unexpected credential-bearing fields", () => {
    expect(
      inputSchema.safeParse({ store: "env", tokenEnv: "T", orgEnv: "O", token: "leak" }).success,
    ).toBe(false);
    expect(
      inputSchema.safeParse({ store: "file", credentialsPath: "c", configPath: "g", x: 1 }).success,
    ).toBe(false);
  });
});
