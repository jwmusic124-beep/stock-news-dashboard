/**
 * Twelve Data time_series API (https://api.twelvedata.com/time_series).
 * Intervals: 1min … 1month; outputsize up to 5000 per request.
 */

export type ChartIntervalId =
  | "1min"
  | "5min"
  | "15min"
  | "30min"
  | "60min"
  | "daily"
  | "weekly"
  | "monthly";

export type ChartRangeId =
  | "1d"
  | "5d"
  | "1m"
  | "3m"
  | "6m"
  | "1y"
  | "5y"
  | "max";

export type ChartCandle = {
  label: string;
  ts: number;
  open: number;
  high: number;
  low: number;
  close: number;
};

/** Allowed ranges per interval (proportional + Twelve Data-friendly; output capped at 5000 bars). */
const ALLOWED_RANGES: Record<ChartIntervalId, ChartRangeId[]> = {
  "1min": ["1d", "5d"],
  "5min": ["1d", "5d", "1m"],
  "15min": ["1d", "5d", "1m", "3m"],
  "30min": ["1d", "5d", "1m", "3m", "6m"],
  "60min": ["1d", "5d", "1m", "3m", "6m", "1y"],
  daily: ["1m", "3m", "6m", "1y", "5y", "max"],
  weekly: ["6m", "1y", "5y", "max"],
  monthly: ["1y", "5y", "max"],
};

const RANGE_MS: Record<Exclude<ChartRangeId, "max">, number> = {
  "1d": 1 * 86400000,
  "5d": 5 * 86400000,
  "1m": 30 * 86400000,
  "3m": 90 * 86400000,
  "6m": 180 * 86400000,
  "1y": 365 * 86400000,
  "5y": 5 * 365 * 86400000,
};

const RANGE_ALIASES: Record<string, ChartRangeId> = {
  "1d": "1d",
  "1day": "1d",
  "5d": "5d",
  "5days": "5d",
  "1m": "1m",
  "1mo": "1m",
  "1month": "1m",
  "3m": "3m",
  "3mo": "3m",
  "6m": "6m",
  "6mo": "6m",
  "1y": "1y",
  "1yr": "1y",
  "5y": "5y",
  "max": "max",
};

const INTERVAL_ALIASES: Record<string, ChartIntervalId> = {
  "1min": "1min",
  "1m": "1min",
  "5min": "5min",
  "5m": "5min",
  "15min": "15min",
  "15m": "15min",
  "30min": "30min",
  "30m": "30min",
  "60min": "60min",
  "60m": "60min",
  "1hour": "60min",
  "1h": "60min",
  daily: "daily",
  day: "daily",
  "1day": "daily",
  weekly: "weekly",
  week: "weekly",
  monthly: "monthly",
  month: "monthly",
};

export const CHART_INTERVALS: ChartIntervalId[] = [
  "1min",
  "5min",
  "15min",
  "30min",
  "60min",
  "daily",
  "weekly",
  "monthly",
];

export function allowedRangesForInterval(
  interval: ChartIntervalId,
): ChartRangeId[] {
  return ALLOWED_RANGES[interval];
}

function parseInterval(raw: string | null): ChartIntervalId | null {
  if (!raw) return null;
  const k = raw.trim().toLowerCase();
  return INTERVAL_ALIASES[k] ?? null;
}

function parseRange(raw: string | null): ChartRangeId | null {
  if (!raw) return null;
  const k = raw.trim().toLowerCase();
  return RANGE_ALIASES[k] ?? null;
}

function clampRangeForInterval(
  interval: ChartIntervalId,
  range: ChartRangeId,
): ChartRangeId {
  const allowed = ALLOWED_RANGES[interval];
  if (allowed.includes(range)) return range;
  const order: ChartRangeId[] = [
    "1d",
    "5d",
    "1m",
    "3m",
    "6m",
    "1y",
    "5y",
    "max",
  ];
  const want = order.indexOf(range);
  let best: ChartRangeId = allowed[0];
  let bestDist = Infinity;
  for (const r of allowed) {
    const d = Math.abs(order.indexOf(r) - want);
    if (d < bestDist) {
      bestDist = d;
      best = r;
    }
  }
  return best;
}

export function resolveChartSelection(
  intervalInput: string | null,
  rangeInput: string | null,
): {
  interval: ChartIntervalId;
  range: ChartRangeId;
  rangeAdjusted: boolean;
  intervalAdjusted: boolean;
} {
  const interval = parseInterval(intervalInput) ?? "daily";
  let range = parseRange(rangeInput) ?? "1m";

  const intervalAdjusted = parseInterval(intervalInput) === null;
  let rangeAdjusted = parseRange(rangeInput) === null;

  const clampedRange = clampRangeForInterval(interval, range);
  if (clampedRange !== range) {
    range = clampedRange;
    rangeAdjusted = true;
  }

  return { interval, range, rangeAdjusted, intervalAdjusted };
}

function tradingDaysApprox(range: ChartRangeId): number {
  switch (range) {
    case "1d":
      return 1;
    case "5d":
      return 5;
    case "1m":
      return 22;
    case "3m":
      return 66;
    case "6m":
      return 132;
    case "1y":
      return 252;
    case "5y":
      return 1260;
    default:
      return 4000;
  }
}

function barsPerTradingDay(interval: ChartIntervalId): number {
  switch (interval) {
    case "1min":
      return 390;
    case "5min":
      return 78;
    case "15min":
      return 26;
    case "30min":
      return 13;
    case "60min":
      return 7;
    default:
      return 1;
  }
}

export const MAX_OUTPUTSIZE = 5000;

/** Estimated bars needed; capped later at MAX_OUTPUTSIZE. */
export function estimateOutputSize(
  interval: ChartIntervalId,
  range: ChartRangeId,
): number {
  if (range === "max") return MAX_OUTPUTSIZE;

  if (interval === "weekly") {
    const ms = RANGE_MS[range as Exclude<ChartRangeId, "max">];
    const weeks = Math.ceil(ms / (7 * 86400000));
    return Math.max(8, weeks + 4);
  }
  if (interval === "monthly") {
    const ms = RANGE_MS[range as Exclude<ChartRangeId, "max">];
    const months = Math.ceil(ms / (30 * 86400000));
    return Math.max(12, months + 2);
  }
  if (interval === "daily") {
    return Math.max(30, tradingDaysApprox(range) + 10);
  }

  const days =
    range === "1d"
      ? 1
      : range === "5d"
        ? 5
        : tradingDaysApprox(range);
  return Math.max(32, days * barsPerTradingDay(interval));
}

export function chartIntervalToTwelveData(interval: ChartIntervalId): string {
  switch (interval) {
    case "60min":
      return "1h";
    case "daily":
      return "1day";
    case "weekly":
      return "1week";
    case "monthly":
      return "1month";
    default:
      return interval;
  }
}

function formatYMD(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export function rangeToDateBounds(
  range: ChartRangeId,
): { start_date?: string; end_date?: string } {
  if (range === "max") return {};
  const end = new Date();
  const end_date = formatYMD(end);
  const ms = RANGE_MS[range];
  const start = new Date(end.getTime() - ms);
  const start_date = formatYMD(start);
  return { start_date, end_date };
}

function parseTwelveDateTime(s: string): number {
  const t = Date.parse(s.replace(" ", "T"));
  return Number.isFinite(t) ? t : 0;
}

export async function fetchTwelveDataSeries(params: {
  symbol: string;
  interval: string;
  apiKey: string;
  outputsize: number;
  start_date?: string;
  end_date?: string;
}): Promise<{ candles: ChartCandle[]; errorMessage?: string }> {
  const {
    symbol,
    interval,
    apiKey,
    outputsize,
    start_date,
    end_date,
  } = params;
  const url = new URL("https://api.twelvedata.com/time_series");
  url.searchParams.set("symbol", symbol);
  url.searchParams.set("interval", interval);
  url.searchParams.set("apikey", apiKey);
  url.searchParams.set(
    "outputsize",
    String(Math.min(Math.max(1, outputsize), MAX_OUTPUTSIZE)),
  );
  if (start_date) url.searchParams.set("start_date", start_date);
  if (end_date) url.searchParams.set("end_date", end_date);

  let res: Response;
  try {
    res = await fetch(url.toString());
  } catch {
    return { candles: [], errorMessage: "Twelve Data request failed" };
  }

  if (!res.ok) {
    return {
      candles: [],
      errorMessage: `Twelve Data HTTP ${res.status}`,
    };
  }

  const json = (await res.json()) as {
    status?: string;
    code?: number;
    message?: string;
    values?: Array<{
      datetime?: string;
      open?: string;
      high?: string;
      low?: string;
      close?: string;
    }>;
  };

  if (json.status === "error") {
    const msg =
      typeof json.message === "string"
        ? json.message
        : "Twelve Data returned an error";
    return { candles: [], errorMessage: msg };
  }

  if (json.code != null && json.code !== 200) {
    const msg =
      typeof json.message === "string"
        ? json.message
        : `Twelve Data error (${json.code})`;
    return { candles: [], errorMessage: msg };
  }

  if (!Array.isArray(json.values)) {
    return { candles: [], errorMessage: "Twelve Data: no values array" };
  }

  const candles: ChartCandle[] = [];
  for (const row of json.values) {
    const dt = row.datetime ?? "";
    const open = Number(row.open);
    const high = Number(row.high);
    const low = Number(row.low);
    const close = Number(row.close);
    const ts = parseTwelveDateTime(dt);
    if (
      !dt ||
      !Number.isFinite(open) ||
      !Number.isFinite(high) ||
      !Number.isFinite(low) ||
      !Number.isFinite(close) ||
      !Number.isFinite(ts)
    ) {
      continue;
    }
    candles.push({
      label: dt,
      ts,
      open,
      high,
      low,
      close,
    });
  }

  candles.sort((a, b) => a.ts - b.ts);

  return { candles };
}

/** Last `count` daily closes for trade logic. */
export function dailyClosesToPriceHistory(
  candles: ChartCandle[],
  count: number,
): Array<{ date: string; price: number }> {
  if (candles.length === 0) return [];
  const sorted = [...candles].sort((a, b) => a.ts - b.ts);
  const slice = sorted.slice(-Math.max(1, count));
  return slice.map((c) => ({
    date: c.label.slice(0, 10),
    price: c.close,
  }));
}
