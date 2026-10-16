import type { UsageInput } from "../shared/input.js";
import { z } from "zod";
import {
  unavailable,
  toneFromUsedPct,
  usedPctOf,
  windowFromUsedPct,
  type UsageAccount,
  type UsageReport,
  type UsageWindow,
} from "@getpaseo/plugin/server/usage";

const ApiNumberSchema = z.coerce.number().finite();
const ApiOptionalStringSchema = z.preprocess(
  (value) => (value == null ? undefined : value),
  z.coerce.string().optional(),
);

// The Z.AI dashboard's own quota endpoint. Undocumented; community implementations
// (cc-switch, tokn, quota-bar) agree it takes the raw key with no Bearer prefix.
const QUOTA_URL = "https://api.z.ai/api/monitor/usage/quota/limit";

// Quota `limits` rows. CREDIT_LIMIT/TOKENS_LIMIT rows name their window with a
// (unit, number) pair — (3, 5) is the five-hour credit window, (6, 1) is weekly.
// Older payloads carry TOKENS_LIMIT rows without the pair; TIME_LIMIT rows are the
// monthly MCP tool budget. `usage` is the quota total, `currentValue` the used
// amount, `remaining` what's left, `percentage` the used percent.
const ZaiQuotaLimitSchema = z.object({
  type: ApiOptionalStringSchema,
  unit: ApiNumberSchema.optional(),
  number: ApiNumberSchema.optional(),
  usage: ApiNumberSchema.optional(),
  currentValue: ApiNumberSchema.optional(),
  remaining: ApiNumberSchema.optional(),
  percentage: ApiNumberSchema.optional(),
  nextResetTime: ApiNumberSchema.optional(),
});

const ZaiQuotaResponseSchema = z.object({
  data: z
    .object({
      // Rows are parsed one by one so a single drifting row cannot void the rest.
      limits: z.array(z.unknown()).optional(),
      level: ApiOptionalStringSchema,
      // Legacy flat fields seen before the `limits` array existed.
      fiveHourPercent: ApiNumberSchema.optional(),
      weeklyPercent: ApiNumberSchema.optional(),
      monthlyMCPUsage: ApiNumberSchema.optional(),
    })
    .nullish(),
});

type ZaiQuotaLimit = z.infer<typeof ZaiQuotaLimitSchema>;
type ZaiQuotaData = NonNullable<z.infer<typeof ZaiQuotaResponseSchema>["data"]>;

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

function epochMsToIso(value: number | null | undefined): string | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return null;
  return new Date(value).toISOString();
}

function limitUsedPct(limit: ZaiQuotaLimit): number | null {
  if (typeof limit.percentage === "number") return clampPct(limit.percentage);
  const fromUsed = usedPctOf(limit.currentValue, limit.usage);
  if (fromUsed !== null) return clampPct(fromUsed);
  if (typeof limit.usage === "number" && limit.usage > 0 && typeof limit.remaining === "number") {
    return clampPct(((limit.usage - limit.remaining) / limit.usage) * 100);
  }
  return null;
}

const WINDOW_SLOTS = [
  { unit: 3, number: 5, id: "five_hour", label: "Session", shortLabel: "5h" },
  { unit: 6, number: 1, id: "weekly", label: "Weekly", shortLabel: "wk" },
] as const;

type WindowSlot = (typeof WINDOW_SLOTS)[number];

function parseLimitRows(data: ZaiQuotaData): {
  rows: ZaiQuotaLimit[];
  mcpLimit?: ZaiQuotaLimit;
} {
  const rows: ZaiQuotaLimit[] = [];
  let mcpLimit: ZaiQuotaLimit | undefined;
  for (const raw of data.limits ?? []) {
    const parsed = ZaiQuotaLimitSchema.safeParse(raw);
    if (!parsed.success) continue;
    if (parsed.data.type === "TIME_LIMIT") mcpLimit ??= parsed.data;
    else if (parsed.data.type === "CREDIT_LIMIT" || parsed.data.type === "TOKENS_LIMIT")
      rows.push(parsed.data);
  }
  return { rows, mcpLimit };
}

function assignWindowSlots(rows: ZaiQuotaLimit[]): Map<WindowSlot, ZaiQuotaLimit> {
  const rowsBySlot = new Map<WindowSlot, ZaiQuotaLimit>();
  const unclassified: ZaiQuotaLimit[] = [];
  for (const row of rows) {
    const slot = WINDOW_SLOTS.find(
      (candidate) =>
        candidate.unit === row.unit &&
        candidate.number === row.number &&
        !rowsBySlot.has(candidate),
    );
    if (slot) rowsBySlot.set(slot, row);
    else unclassified.push(row);
  }
  // Rows without a (unit, number) pair fill whichever windows are still empty,
  // earliest reset first — the five-hour window always resets sooner.
  unclassified.sort((a, b) => (a.nextResetTime ?? Infinity) - (b.nextResetTime ?? Infinity));
  for (const slot of WINDOW_SLOTS) {
    if (rowsBySlot.has(slot)) continue;
    const row = unclassified.shift();
    if (row) rowsBySlot.set(slot, row);
  }
  return rowsBySlot;
}

function quotaWindow(input: {
  id: string;
  label: string;
  shortLabel: string;
  summary?: boolean;
  row: ZaiQuotaLimit;
}): UsageWindow | null {
  const usedPct = limitUsedPct(input.row);
  if (usedPct === null) return null;
  return windowFromUsedPct({
    id: input.id,
    label: input.label,
    shortLabel: input.shortLabel,
    summary: input.summary,
    utilizationPct: usedPct,
    resetsAt: epochMsToIso(input.row.nextResetTime),
    tone: toneFromUsedPct(usedPct),
  });
}

function buildLimitWindows(data: ZaiQuotaData | undefined): UsageWindow[] {
  if (!data) return [];
  const { rows, mcpLimit } = parseLimitRows(data);
  const rowsBySlot = assignWindowSlots(rows);
  const windows = WINDOW_SLOTS.flatMap((slot) => {
    const row = rowsBySlot.get(slot);
    const window = row ? quotaWindow({ ...slot, summary: true, row }) : null;
    return window ? [window] : [];
  });
  const mcpWindow = mcpLimit
    ? quotaWindow({
        id: "mcp_monthly",
        label: "MCP Tools · Monthly",
        shortLabel: "mcp",
        row: mcpLimit,
      })
    : null;
  if (mcpWindow) windows.push(mcpWindow);
  return windows;
}

function buildLegacyWindows(data: ZaiQuotaData): UsageWindow[] {
  const windows: UsageWindow[] = [];
  const entries = [
    { pct: data.fiveHourPercent, id: "five_hour", label: "Session", shortLabel: "5h" },
    { pct: data.weeklyPercent, id: "weekly", label: "Weekly", shortLabel: "wk" },
    {
      pct: data.monthlyMCPUsage,
      id: "mcp_monthly",
      label: "MCP Tools · Monthly",
      shortLabel: "mcp",
    },
  ];
  for (const entry of entries) {
    if (typeof entry.pct !== "number") continue;
    const usedPct = clampPct(entry.pct);
    windows.push(
      windowFromUsedPct({
        id: entry.id,
        label: entry.label,
        shortLabel: entry.shortLabel,
        summary: true,
        utilizationPct: usedPct,
        tone: toneFromUsedPct(usedPct),
      }),
    );
  }
  return windows;
}

function planLabelFromLevel(level: string | undefined): string | undefined {
  if (!level) return undefined;
  return `GLM Coding ${level.charAt(0).toUpperCase()}${level.slice(1)}`;
}

export async function fetchUsage(
  input: UsageInput,
  fetchApi: typeof fetch = fetch,
): Promise<UsageReport> {
  const token = process.env[input.locator];
  if (!token) throw new Error("Z.ai login store no longer exists");

  const quota = await fetchJson(
    QUOTA_URL,
    { Authorization: token },
    ZaiQuotaResponseSchema,
    fetchApi,
  );
  if (quota.kind === "rejected") return unavailable({ kind: "rejected", status: quota.status });
  if (quota.kind === "failed") return { status: "error", error: "Z.ai usage API request failed" };

  const quotaData = quota.value.data ?? undefined;
  const windows = buildLimitWindows(quotaData);
  if (windows.length === 0 && quotaData) windows.push(...buildLegacyWindows(quotaData));

  if (windows.length === 0 && !quotaData?.level)
    return unavailable({ kind: "no_quota", detail: "No active coding plan" });

  return {
    status: "available",
    planLabel: planLabelFromLevel(quotaData?.level),
    windows,
    balances: [],
  };
}

export async function discover(): Promise<UsageAccount[]> {
  for (const locator of ["ZAI_API_KEY", "GLM_API_KEY"]) {
    if (process.env[locator]) return [{ key: "default", input: { store: "env", locator } }];
  }
  return [];
}
