import type { UsageInput } from "../shared/input.js";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { z } from "zod";
import {
  unavailable,
  hashAccountKey,
  toneFromUsedPct,
  balanceToneFromRemaining,
  windowFromUsedPct,
  type UsageAccount,
  type UsageBalance,
  type UsageReport,
  type UsageScope,
  type UsageWindow,
} from "@getpaseo/plugin/server/usage";

const ApiNumberSchema = z.preprocess(
  (value) => (value == null || value === "" || typeof value === "boolean" ? undefined : value),
  z.coerce.number().finite().optional(),
);
const ApiOptionalStringSchema = z.preprocess(
  (value) => (value == null ? undefined : value),
  z.coerce.string().optional(),
);
// Reset timestamps arrive as ISO strings or epoch seconds/millis; normalize so
// the app can always parse them.
const ApiResetSchema = z.preprocess((value) => normalizeReset(value), z.string().optional());

const DEFAULT_WEBAPP_HOST = "app.devin.ai";

// The Devin web dashboard's own quota endpoint. Undocumented. The Devin CLI
// session token authenticates as Bearer here — verified against a live login —
// with the org id on x-cog-org-id. Enterprise deployments report their own
// devin_webapp_host, which is where that login's token is valid.
const quotaUrl = (webappHost: string, orgId: string) =>
  `https://${webappHost}/api/${encodeURIComponent(orgId)}/billing/quota/usage`;

const DevinQuotaResponseSchema = z.object({
  is_quota_plan: z.boolean().optional(),
  has_quota_allocation: z.boolean().optional(),
  daily_percentage: ApiNumberSchema,
  weekly_percentage: ApiNumberSchema,
  daily_reset_at: ApiResetSchema,
  weekly_reset_at: ApiResetSchema,
  overage_balance: ApiNumberSchema,
  overage_balance_cents: ApiNumberSchema,
  hide_daily_quota: z.boolean().optional(),
  hide_weekly_quota: z.boolean().optional(),
});

const DevinCliConfigSchema = z.object({
  devin: z.object({ org_id: ApiOptionalStringSchema }).optional(),
});

// Devin CLI credentials written by `devin auth login`. The session token lives
// in the data dir; the org id lives in the config file.
const WINDSURF_API_KEY_RE = /^\s*windsurf_api_key\s*=\s*["']([^"']+)["']/m;
const WEBAPP_HOST_RE = /^\s*devin_webapp_host\s*=\s*["']([^"']+)["']/m;

// Store states meaning "no usable login" — skipped in discovery, detailed at fetch.
// I/O problems (permissions, I/O errors) stay ordinary errors so they surface.
class UnusableStoreError extends Error {}

// Devin config files are JSON with comments.
function stripJsonComments(source: string): string {
  let out = "";
  let inString = false;
  let escaped = false;
  for (let i = 0; i < source.length; i++) {
    const ch = source[i]!;
    const next = source[i + 1];
    if (inString) {
      out += ch;
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ch;
    } else if (ch === "/" && next === "/") {
      while (i < source.length && source[i] !== "\n") i++;
      out += "\n";
    } else if (ch === "/" && next === "*") {
      i += 2;
      while (i < source.length && !(source[i] === "*" && source[i + 1] === "/")) i++;
      i++;
    } else out += ch;
  }
  return out;
}

export function cliPaths(
  env: NodeJS.ProcessEnv,
  home: string,
  platform: NodeJS.Platform = process.platform,
): {
  credentialsPath: string;
  configPath: string;
} {
  const dataDir =
    platform === "win32"
      ? (env.APPDATA ?? join(home, "AppData", "Roaming"))
      : (env.XDG_DATA_HOME ?? join(home, ".local", "share"));
  const configDir =
    platform === "win32"
      ? (env.APPDATA ?? join(home, "AppData", "Roaming"))
      : (env.XDG_CONFIG_HOME ?? join(home, ".config"));
  return {
    credentialsPath: join(dataDir, "devin", "credentials.toml"),
    configPath: join(configDir, "devin", "config.json"),
  };
}

function sanitizeWebappHost(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  try {
    const { host } = new URL(raw.includes("://") ? raw : `https://${raw}`);
    return host === DEFAULT_WEBAPP_HOST ? undefined : host;
  } catch {
    return undefined;
  }
}

interface CliStore {
  token: string;
  orgId: string;
  webappHost?: string;
}

async function readCliStore(credentialsPath: string, configPath: string): Promise<CliStore> {
  let credentials: string;
  try {
    credentials = await readFile(credentialsPath, "utf8");
  } catch (error) {
    if (isNotFound(error))
      throw new UnusableStoreError("Devin CLI credentials not found — run devin auth login", {
        cause: error,
      });
    throw new Error(`Cannot read ${basename(credentialsPath)}: ${errorMessage(error)}`, {
      cause: error,
    });
  }
  const token = WINDSURF_API_KEY_RE.exec(credentials)?.[1];
  if (!token)
    throw new UnusableStoreError(`${basename(credentialsPath)} does not contain windsurf_api_key`);

  let configText: string;
  try {
    configText = await readFile(configPath, "utf8");
  } catch (error) {
    if (isNotFound(error))
      throw new UnusableStoreError("Devin CLI config not found — run devin auth login", {
        cause: error,
      });
    throw new Error(`Cannot read ${basename(configPath)}: ${errorMessage(error)}`, {
      cause: error,
    });
  }
  let config: unknown;
  try {
    config = JSON.parse(stripJsonComments(configText));
  } catch (error) {
    throw new UnusableStoreError(`${basename(configPath)} is not valid JSON`, { cause: error });
  }
  const orgId = DevinCliConfigSchema.safeParse(config).data?.devin?.org_id;
  if (!orgId) throw new UnusableStoreError(`${basename(configPath)} has no devin.org_id`);

  return { token, orgId, webappHost: sanitizeWebappHost(WEBAPP_HOST_RE.exec(credentials)?.[1]) };
}

function isNotFound(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}

function errorMessage(error: unknown): string {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code ?? (error instanceof Error ? error.message : String(error));
}

interface DevinCredentials {
  token: string;
  orgId: string;
  webappHost?: string;
}

async function resolveCredentials(input: UsageInput): Promise<DevinCredentials> {
  if (input.store === "env") {
    const missing = [input.tokenEnv, input.orgEnv].filter((name) => !process.env[name]);
    if (missing.length) throw new Error(`Devin credentials missing: set ${missing.join(" and ")}`);
    return {
      token: process.env[input.tokenEnv]!,
      orgId: process.env[input.orgEnv]!,
      webappHost: sanitizeWebappHost(process.env.DEVIN_WEBAPP_HOST),
    };
  }
  return readCliStore(input.credentialsPath, input.configPath);
}

type FetchOutcome<T> =
  | { kind: "ok"; value: T }
  | { kind: "rejected"; status: number }
  | { kind: "failed"; reason: string };

async function fetchJson<Schema extends z.ZodType>(
  url: string,
  headers: Record<string, string>,
  schema: Schema,
  fetchApi: typeof fetch,
): Promise<FetchOutcome<z.infer<Schema>>> {
  let res: Response;
  try {
    res = await fetchApi(url, {
      signal: AbortSignal.timeout(15_000),
      headers: { ...headers, Accept: "application/json" },
    });
  } catch (error) {
    return { kind: "failed", reason: `request failed: ${errorMessage(error)}` };
  }
  if (res.status === 401 || res.status === 403) return { kind: "rejected", status: res.status };
  if (!res.ok) return { kind: "failed", reason: `returned HTTP ${res.status}` };
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    return { kind: "failed", reason: "returned a non-JSON response" };
  }
  const parsed = schema.safeParse(body);
  if (!parsed.success) return { kind: "failed", reason: "returned an unrecognized response" };
  return { kind: "ok", value: parsed.data };
}

function normalizeReset(value: unknown): string | undefined {
  let epoch: number | undefined;
  if (typeof value === "number" && Number.isFinite(value)) epoch = value;
  else if (typeof value === "string" && /^\d{10,13}$/.test(value)) epoch = Number(value);
  if (epoch !== undefined) {
    const ms = epoch < 1e11 ? epoch * 1000 : epoch;
    // toISOString throws outside Date's representable range — drop instead.
    if (Math.abs(ms) > 8.64e15) return undefined;
    return new Date(ms).toISOString();
  }
  if (typeof value === "string" && value && !Number.isNaN(Date.parse(value))) return value;
  return undefined;
}

function clampPct(value: number): number {
  return Math.max(0, Math.min(100, value));
}

function quotaWindow(input: {
  id: string;
  label: string;
  shortLabel: string;
  usedPct: number;
  resetsAt?: string;
}): UsageWindow {
  const usedPct = clampPct(input.usedPct);
  return windowFromUsedPct({
    id: input.id,
    label: input.label,
    shortLabel: input.shortLabel,
    summary: true,
    utilizationPct: usedPct,
    resetsAt: input.resetsAt ?? null,
    tone: toneFromUsedPct(usedPct),
  });
}

export async function fetchUsage(
  input: UsageInput,
  fetchApi: typeof fetch = fetch,
): Promise<UsageReport> {
  const { token, orgId, webappHost } = await resolveCredentials(input);

  const outcome = await fetchJson(
    quotaUrl(webappHost ?? DEFAULT_WEBAPP_HOST, orgId),
    { Authorization: `Bearer ${token}`, "x-cog-org-id": orgId },
    DevinQuotaResponseSchema,
    fetchApi,
  );
  if (outcome.kind === "rejected")
    return unavailable({
      kind: "rejected",
      status: outcome.status,
      // File-store tokens refresh through the CLI; env vars have no command to point at.
      ...(input.store === "file" ? { refreshedBy: "devin auth login" } : {}),
    });
  if (outcome.kind === "failed")
    return { status: "error", error: `Devin usage API ${outcome.reason}` };

  const data = outcome.value;
  if (data.is_quota_plan === false || data.has_quota_allocation === false)
    return unavailable({ kind: "no_quota", detail: "No Devin quota plan" });

  const windows: UsageWindow[] = [];
  if (!data.hide_daily_quota && data.daily_percentage !== undefined) {
    windows.push(
      quotaWindow({
        id: "daily",
        label: "Daily",
        shortLabel: "1d",
        usedPct: data.daily_percentage,
        resetsAt: data.daily_reset_at,
      }),
    );
  }
  if (!data.hide_weekly_quota && data.weekly_percentage !== undefined) {
    windows.push(
      quotaWindow({
        id: "weekly",
        label: "Weekly",
        shortLabel: "wk",
        usedPct: data.weekly_percentage,
        resetsAt: data.weekly_reset_at,
      }),
    );
  }

  const balances: UsageBalance[] = [];
  const overage =
    data.overage_balance ??
    (data.overage_balance_cents !== undefined ? data.overage_balance_cents / 100 : undefined);
  if (overage !== undefined) {
    balances.push({
      id: "overage",
      label: "On-demand credits",
      remaining: overage,
      unit: "usd",
      tone: balanceToneFromRemaining(overage),
    });
  }

  if (windows.length === 0 && balances.length === 0)
    return { status: "error", error: "Devin usage API returned no quota windows" };

  return { status: "available", windows, balances };
}

function accountKey(orgId: string): string {
  return hashAccountKey(orgId);
}

export async function discover(scope: UsageScope): Promise<UsageAccount[]> {
  // Session discovery only applies to Devin's own agent sessions — every other
  // provider's session would otherwise surface this machine's Devin login.
  if (scope.kind === "session" && scope.provider !== "devin") return [];
  const env = scope.kind === "session" ? scope.env : process.env;
  const home = env.HOME || env.USERPROFILE || homedir();
  const accounts: UsageAccount[] = [];

  // Env credentials resolve against the daemon's environment at fetch time, so
  // they only exist in global scope — a session's env is not visible to fetch.
  if (scope.kind === "global") {
    const tokenEnv = ["DEVIN_API_KEY", "WINDSURF_API_KEY"].find((name) => env[name]);
    if (env.DEVIN_ORG_ID && tokenEnv)
      accounts.push({
        key: accountKey(env.DEVIN_ORG_ID),
        harness: "environment",
        input: { store: "env", tokenEnv, orgEnv: "DEVIN_ORG_ID" },
      });
  }

  const { credentialsPath, configPath } = cliPaths(env, home);
  try {
    const store = await readCliStore(credentialsPath, configPath);
    accounts.push({
      key: accountKey(store.orgId),
      harness: "Devin CLI",
      input: { store: "file", credentialsPath, configPath },
    });
  } catch (error) {
    // Unusable store contents mean "no login"; I/O failures stay visible.
    if (!(error instanceof UnusableStoreError)) throw error;
  }

  return accounts;
}
