import type { UsageInput } from "../shared/input.js";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import {
  unavailable,
  toneFromUsedPct,
  balanceToneFromRemaining,
  windowFromUsedPct,
  type UsageAccount,
  type UsageBalance,
  type UsageReport,
  type UsageWindow,
} from "@getpaseo/plugin/server/usage";

const ApiNumberSchema = z.coerce.number().finite();
const ApiOptionalStringSchema = z.preprocess(
  (value) => (value == null ? undefined : value),
  z.coerce.string().optional(),
);

// The Devin web dashboard's own quota endpoint. Undocumented; CodexBar and
// usage-monitor-cli read it with the CLI session token as a Bearer credential
// plus the org id on x-cog-org-id.
const quotaUrl = (orgId: string) =>
  `https://app.devin.ai/api/${encodeURIComponent(orgId)}/billing/quota/usage`;

const DevinQuotaResponseSchema = z.object({
  is_quota_plan: z.boolean().optional(),
  has_quota_allocation: z.boolean().optional(),
  daily_percentage: ApiNumberSchema.optional(),
  weekly_percentage: ApiNumberSchema.optional(),
  daily_reset_at: ApiOptionalStringSchema,
  weekly_reset_at: ApiOptionalStringSchema,
  overage_balance: ApiNumberSchema.optional(),
  hide_daily_quota: z.boolean().optional(),
});

const DevinCliConfigSchema = z.object({
  devin: z.object({ org_id: ApiOptionalStringSchema }).optional(),
});

// Devin CLI credentials written by `devin auth login`. The session token lives
// in the data dir; the org id lives in the config file.
const WINDSURF_API_KEY_RE = /^\s*windsurf_api_key\s*=\s*["']([^"']+)["']/m;

function cliPaths(home: string): { credentialsPath: string; configPath: string } {
  return {
    credentialsPath: join(home, ".local", "share", "devin", "credentials.toml"),
    configPath: join(home, ".config", "devin", "config.json"),
  };
}

async function readCliToken(path: string): Promise<string | undefined> {
  try {
    return WINDSURF_API_KEY_RE.exec(await readFile(path, "utf8"))?.[1];
  } catch {
    return undefined;
  }
}

async function readCliOrgId(path: string): Promise<string | undefined> {
  try {
    return DevinCliConfigSchema.parse(JSON.parse(await readFile(path, "utf8"))).devin?.org_id;
  } catch {
    return undefined;
  }
}

interface DevinCredentials {
  token: string;
  orgId: string;
}

async function resolveCredentials(input: UsageInput): Promise<DevinCredentials> {
  let token: string | undefined;
  let orgId: string | undefined;
  if (input.store === "env") {
    token = process.env[input.tokenEnv];
    orgId = process.env[input.orgEnv];
  } else {
    [token, orgId] = await Promise.all([
      readCliToken(input.credentialsPath),
      readCliOrgId(input.configPath),
    ]);
  }
  if (!token || !orgId) throw new Error("Devin login store no longer exists");
  return { token, orgId };
}

type FetchOutcome<T> =
  | { kind: "ok"; value: T }
  | { kind: "rejected"; status: number }
  | { kind: "failed" };

async function fetchJson<Schema extends z.ZodType>(
  url: string,
  headers: Record<string, string>,
  schema: Schema,
  fetchApi: typeof fetch,
): Promise<FetchOutcome<z.infer<Schema>>> {
  try {
    const res = await fetchApi(url, {
      signal: AbortSignal.timeout(15_000),
      headers: { ...headers, Accept: "application/json" },
    });
    if (res.status === 401 || res.status === 403) return { kind: "rejected", status: res.status };
    if (!res.ok) return { kind: "failed" };
    return { kind: "ok", value: schema.parse(await res.json()) };
  } catch {
    return { kind: "failed" };
  }
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
  const { token, orgId } = await resolveCredentials(input);

  const outcome = await fetchJson(
    quotaUrl(orgId),
    { Authorization: `Bearer ${token}`, "x-cog-org-id": orgId },
    DevinQuotaResponseSchema,
    fetchApi,
  );
  if (outcome.kind === "rejected") return unavailable({ kind: "rejected", status: outcome.status });
  if (outcome.kind === "failed")
    return { status: "error", error: "Devin usage API request failed" };

  const data = outcome.value;
  if (data.is_quota_plan === false || data.has_quota_allocation === false)
    return unavailable({ kind: "no_quota", detail: "No Devin quota plan" });

  const windows: UsageWindow[] = [];
  if (!data.hide_daily_quota && typeof data.daily_percentage === "number") {
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
  if (typeof data.weekly_percentage === "number") {
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
  if (typeof data.overage_balance === "number") {
    balances.push({
      id: "overage",
      label: "On-demand credits",
      remaining: data.overage_balance,
      unit: "usd",
      tone: balanceToneFromRemaining(data.overage_balance),
    });
  }

  if (windows.length === 0 && balances.length === 0)
    return unavailable({ kind: "no_quota", detail: "No Devin quota plan" });

  return { status: "available", windows, balances };
}

export async function discover(): Promise<UsageAccount[]> {
  if (process.env.DEVIN_ORG_ID) {
    for (const tokenEnv of ["DEVIN_API_KEY", "WINDSURF_API_KEY"]) {
      if (process.env[tokenEnv])
        return [
          {
            key: "env",
            input: { store: "env", tokenEnv, orgEnv: "DEVIN_ORG_ID" },
          },
        ];
    }
  }
  const { credentialsPath, configPath } = cliPaths(homedir());
  if (existsSync(credentialsPath) && existsSync(configPath))
    return [{ key: "cli", input: { store: "file", credentialsPath, configPath } }];
  return [];
}
