"use client";

import {
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
} from "react";
import {
  allowedRangesForInterval,
  CHART_INTERVALS,
  type ChartIntervalId,
  type ChartRangeId,
} from "@/lib/twelve-data-chart";
import {
  CartesianGrid,
  ComposedChart,
  Line,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  usePlotArea,
  useXAxisScale,
  useYAxisScale,
  XAxis,
  YAxis,
} from "recharts";

type Analysis = {
  sentiment: "bullish" | "neutral" | "bearish";
  confidence: number;
  key_factors: [string, string, string];
  summary: string;
};

type Article = {
  title: string;
  sourceName: string;
  publishedAt: string;
  url: string;
};

type PriceHistoryPoint = {
  date: string;
  price: number;
};

type TradeSuggestion = {
  action: "buy" | "short" | "wait";
  entry: number;
  takeProfit: number;
  stopLoss: number;
  confidence: number;
  rationale: string;
};

type CandlePoint = {
  label: string;
  ts: number;
  open: number;
  high: number;
  low: number;
  close: number;
};

type StockPayload = {
  ticker: string;
  stockPrice: string | null;
  priceHistory: PriceHistoryPoint[];
  candles: CandlePoint[];
  chartInterval: ChartIntervalId;
  chartRange: ChartRangeId;
  chartWarning: string | null;
  tradeSuggestion: TradeSuggestion;
  articles: Article[];
  analysis: Analysis;
};

const INTERVAL_LABELS: Record<ChartIntervalId, string> = {
  "1min": "1 min (intraday)",
  "5min": "5 min (intraday)",
  "15min": "15 min (intraday)",
  "30min": "30 min (intraday)",
  "60min": "1 hour (intraday, 1h)",
  daily: "Daily",
  weekly: "Weekly",
  monthly: "Monthly",
};

const RANGE_LABELS: Record<ChartRangeId, string> = {
  "1d": "1 day",
  "5d": "5 days",
  "1m": "1 month",
  "3m": "3 months",
  "6m": "6 months",
  "1y": "1 year",
  "5y": "5 years",
  max: "Max (all returned)",
};

function takeProfitForRewardRisk(
  suggestion: TradeSuggestion,
  rewardRisk: number,
): number {
  const rr = Math.max(0.25, Math.min(10, rewardRisk));
  const { action, entry, stopLoss, takeProfit } = suggestion;
  if (!(entry > 0) || !(stopLoss > 0)) return takeProfit;

  if (action === "buy") {
    const risk = entry - stopLoss;
    if (!(risk > 0)) return takeProfit;
    return Number((entry + rr * risk).toFixed(2));
  }
  if (action === "short") {
    const risk = stopLoss - entry;
    if (!(risk > 0)) return takeProfit;
    return Number((entry - rr * risk).toFixed(2));
  }
  const downRisk = entry - stopLoss;
  const upRisk = stopLoss - entry;
  if (downRisk > 0 && downRisk >= upRisk) {
    return Number((entry + rr * downRisk).toFixed(2));
  }
  if (upRisk > 0) {
    return Number((entry - rr * upRisk).toFixed(2));
  }
  return takeProfit;
}

function Candlesticks({ data }: { data: CandlePoint[] }) {
  const xScale = useXAxisScale();
  const yScale = useYAxisScale();
  const plot = usePlotArea();

  if (!xScale || !yScale || !plot || data.length === 0) return null;

  const n = data.length;
  const slot = plot.width / Math.max(n, 1);
  const bodyW = Math.max(2, Math.min(12, slot * 0.55));

  return (
    <g>
      {data.map((c, i) => {
        const cx =
          xScale(c.ts) ??
          plot.x + (i + 0.5) * (plot.width / Math.max(n, 1));
        const yHigh = yScale(c.high);
        const yLow = yScale(c.low);
        const yOpen = yScale(c.open);
        const yClose = yScale(c.close);
        if (
          yHigh === undefined ||
          yLow === undefined ||
          yOpen === undefined ||
          yClose === undefined
        ) {
          return null;
        }
        const top = Math.min(yOpen, yClose);
        const bottom = Math.max(yOpen, yClose);
        const bodyH = Math.max(1, bottom - top);
        const green = c.close >= c.open;
        const fill = green ? "#34d399" : "#f87171";
        const stroke = green ? "#6ee7b7" : "#fca5a5";
        return (
          <g key={`${c.ts}-${i}`}>
            <line
              x1={cx}
              x2={cx}
              y1={yHigh}
              y2={yLow}
              stroke={stroke}
              strokeWidth={1}
            />
            <rect
              x={cx - bodyW / 2}
              y={top}
              width={bodyW}
              height={bodyH}
              fill={fill}
              fillOpacity={0.88}
              stroke={stroke}
              strokeWidth={1}
            />
          </g>
        );
      })}
    </g>
  );
}

function CandlestickChart({
  candles,
  currentPrice,
}: {
  candles: CandlePoint[];
  currentPrice?: number | null;
}) {
  const chartData = useMemo(() => candles ?? [], [candles]);

  const xDomain = useMemo((): [number, number] | undefined => {
    if (chartData.length === 0) return undefined;
    const first = chartData[0].ts;
    const last = chartData[chartData.length - 1].ts;
    if (!Number.isFinite(first) || !Number.isFinite(last)) return undefined;
    const span = Math.max(last - first, 1);
    const pad = span * 0.02;
    return [first - pad, last + pad];
  }, [chartData]);

  const yDomain = useMemo((): [number, number] => {
    if (chartData.length === 0) return [0, 1];
    let lo = Infinity;
    let hi = -Infinity;
    for (const c of chartData) {
      lo = Math.min(lo, c.low);
      hi = Math.max(hi, c.high);
    }
    if (
      currentPrice != null &&
      Number.isFinite(currentPrice) &&
      currentPrice > 0
    ) {
      lo = Math.min(lo, currentPrice);
      hi = Math.max(hi, currentPrice);
    }
    if (!Number.isFinite(lo) || !Number.isFinite(hi)) return [0, 1];
    const pad = (hi - lo) * 0.04 || Math.abs(hi) * 0.02 || 1;
    return [lo - pad, hi + pad];
  }, [chartData, currentPrice]);

  if (chartData.length === 0) {
    return (
      <p className="mt-4 text-sm text-zinc-500">
        No OHLC data available for this chart selection.
      </p>
    );
  }

  return (
    <div className="mt-4 h-[320px] w-full min-w-0">
      <ResponsiveContainer width="100%" height="100%" minHeight={320}>
        <ComposedChart
          data={chartData}
          margin={{ top: 8, right: 12, left: 0, bottom: 4 }}
        >
          <CartesianGrid
            strokeDasharray="3 3"
            stroke="#27272a"
            vertical={false}
          />
          <XAxis
            dataKey="ts"
            type="number"
            domain={xDomain ?? ["dataMin", "dataMax"]}
            tickFormatter={(ts) =>
              new Date(ts as number).toLocaleDateString("en-US", {
                month: "short",
                day: "numeric",
              })
            }
            stroke="#52525b"
            tick={{ fill: "#a1a1aa", fontSize: 10 }}
            axisLine={{ stroke: "#3f3f46" }}
            tickLine={{ stroke: "#3f3f46" }}
            minTickGap={28}
            allowDataOverflow
          />
          <YAxis
            domain={yDomain}
            tickFormatter={(v) =>
              `$${typeof v === "number" ? v.toFixed(0) : v}`
            }
            stroke="#52525b"
            tick={{ fill: "#a1a1aa", fontSize: 11 }}
            axisLine={{ stroke: "#3f3f46" }}
            tickLine={{ stroke: "#3f3f46" }}
            width={56}
            allowDataOverflow
          />
          <Line
            type="monotone"
            dataKey="high"
            stroke="transparent"
            strokeWidth={0}
            dot={false}
            activeDot={false}
            isAnimationActive={false}
            legendType="none"
          />
          <Line
            type="monotone"
            dataKey="low"
            stroke="transparent"
            strokeWidth={0}
            dot={false}
            activeDot={false}
            isAnimationActive={false}
            legendType="none"
          />
          <Line
            type="monotone"
            dataKey="close"
            stroke="transparent"
            strokeWidth={0}
            dot={false}
            activeDot={false}
            isAnimationActive={false}
            legendType="none"
          />
          <Tooltip
            content={({ active, payload }) => {
              if (!active || !payload?.[0]) return null;
              const d = payload[0].payload as CandlePoint;
              return (
                <div className="rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-xs text-zinc-100 shadow-lg">
                  <p className="mb-1 font-medium text-zinc-400">{d.label}</p>
                  <p className="tabular-nums">
                    O {d.open.toFixed(2)} · H {d.high.toFixed(2)} · L{" "}
                    {d.low.toFixed(2)} · C {d.close.toFixed(2)}
                  </p>
                </div>
              );
            }}
          />
          <Candlesticks data={chartData} />
          {currentPrice != null &&
            Number.isFinite(currentPrice) &&
            currentPrice > 0 && (
              <ReferenceLine
                y={currentPrice}
                stroke="#38bdf8"
                strokeDasharray="4 4"
                strokeWidth={1}
                ifOverflow="extendDomain"
              />
            )}
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}

type SearchQuery = {
  ticker: string;
  chartInterval: ChartIntervalId;
  chartRange: ChartRangeId;
};

const INTRO_STORAGE_KEY = "stock-news-dashboard-welcome-v1";
const INTRO_UPDATED_EVENT = "snd-intro-updated";

function subscribeIntroDismissed(onChange: () => void) {
  if (typeof window === "undefined") return () => {};
  const run = () => onChange();
  window.addEventListener("storage", run);
  window.addEventListener(INTRO_UPDATED_EVENT, run);
  return () => {
    window.removeEventListener("storage", run);
    window.removeEventListener(INTRO_UPDATED_EVENT, run);
  };
}

function getIntroDismissedSnapshot(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return window.localStorage.getItem(INTRO_STORAGE_KEY) === "1";
  } catch {
    return true;
  }
}

function DynamicBackground() {
  return (
    <div
      className="pointer-events-none fixed inset-0 -z-10 overflow-hidden"
      aria-hidden
    >
      <div className="absolute inset-0 bg-zinc-950" />
      <div
        className="dynamic-bg-grid absolute inset-0 opacity-[0.4]"
        style={{
          backgroundImage: `linear-gradient(rgba(255,255,255,0.04) 1px, transparent 1px),
            linear-gradient(90deg, rgba(255,255,255,0.04) 1px, transparent 1px)`,
          backgroundSize: "48px 48px",
          animation: "grid-pan 100s linear infinite",
        }}
      />
      <div
        className="dynamic-bg-blob absolute -left-[18%] -top-[22%] h-[88vmin] w-[88vmin] rounded-full bg-emerald-500/30 blur-[128px]"
        style={{ animation: "aurora-drift 26s ease-in-out infinite" }}
      />
      <div
        className="dynamic-bg-blob absolute -right-[12%] top-[28%] h-[72vmin] w-[72vmin] rounded-full bg-sky-500/22 blur-[108px]"
        style={{ animation: "aurora-drift-reverse 20s ease-in-out infinite" }}
      />
      <div
        className="dynamic-bg-blob absolute bottom-[-8%] left-[20%] h-[58vmin] w-[58vmin] rounded-full bg-violet-600/20 blur-[96px]"
        style={{ animation: "aurora-drift 32s ease-in-out infinite reverse" }}
      />
      <div className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-emerald-400/35 to-transparent" />
      <div className="absolute inset-x-0 bottom-0 h-px bg-gradient-to-r from-transparent via-sky-500/20 to-transparent opacity-60" />
    </div>
  );
}

function IntroSplash({ onDismiss }: { onDismiss: () => void }) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 sm:p-6"
      role="dialog"
      aria-modal="true"
      aria-labelledby="intro-title"
    >
      <button
        type="button"
        className="absolute inset-0 cursor-default border-0 p-0 [animation:intro-backdrop_0.4s_ease-out_forwards] bg-zinc-950/75 backdrop-blur-md"
        aria-label="Dismiss welcome screen"
        onClick={onDismiss}
      />
      <div className="relative z-10 w-full max-w-md rounded-2xl border border-white/10 bg-zinc-900/85 p-7 shadow-2xl shadow-emerald-950/50 backdrop-blur-2xl ring-1 ring-white/[0.06] sm:p-9 [animation:intro-card_0.55s_cubic-bezier(0.22,1,0.36,1)_0.06s_both]">
        <p className="text-xs font-medium uppercase tracking-[0.2em] text-emerald-400/90">
          Welcome to
        </p>
        <h2
          id="intro-title"
          className="mt-2 bg-gradient-to-br from-white via-zinc-100 to-zinc-500 bg-clip-text text-2xl font-semibold tracking-tight text-transparent sm:text-3xl"
        >
          SignalDesk
        </h2>
        <p className="mt-3 text-sm leading-relaxed text-zinc-400">
          Live quotes, candlestick charts, headlines, and AI sentiment—plus
          trade ideas and sizing in one workspace.
        </p>
        <ul className="mt-5 space-y-2.5 text-sm text-zinc-300">
          <li className="flex gap-2">
            <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-emerald-400 shadow-[0_0_8px_rgba(52,211,153,0.6)]" />
            <span>Search any ticker to load price, news, and analysis.</span>
          </li>
          <li className="flex gap-2">
            <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-sky-400 shadow-[0_0_8px_rgba(56,189,248,0.5)]" />
            <span>Switch chart intervals and timeframes on the fly.</span>
          </li>
          <li className="flex gap-2">
            <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-violet-400 shadow-[0_0_8px_rgba(167,139,250,0.5)]" />
            <span>Tune reward-to-risk and position size to match your plan.</span>
          </li>
        </ul>
        <div className="mt-8 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <button
            type="button"
            onClick={onDismiss}
            className="w-full rounded-xl bg-gradient-to-r from-emerald-500 to-emerald-600 px-5 py-3 text-sm font-semibold text-white shadow-lg shadow-emerald-900/40 transition hover:from-emerald-400 hover:to-emerald-500 focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400 focus-visible:ring-offset-2 focus-visible:ring-offset-zinc-900 sm:w-auto"
          >
            Get started
          </button>
          <p className="text-center text-xs text-zinc-500 sm:text-right">
            Or click outside to close
          </p>
        </div>
      </div>
    </div>
  );
}

export default function Home() {
  const [input, setInput] = useState("");
  const [query, setQuery] = useState<SearchQuery | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [data, setData] = useState<StockPayload | null>(null);
  const [accountSize, setAccountSize] = useState("10000");
  const [riskPercent, setRiskPercent] = useState("1");
  const [rewardRiskRatio, setRewardRiskRatio] = useState("2");
  const [chartInterval, setChartInterval] =
    useState<ChartIntervalId>("daily");
  const [chartRange, setChartRange] = useState<ChartRangeId>("1m");
  const introDismissed = useSyncExternalStore(
    subscribeIntroDismissed,
    getIntroDismissedSnapshot,
    () => true,
  );
  const showIntro = !introDismissed;

  const dismissIntro = () => {
    try {
      window.localStorage.setItem(INTRO_STORAGE_KEY, "1");
    } catch {
      /* ignore */
    }
    window.dispatchEvent(new Event(INTRO_UPDATED_EVENT));
  };

  const handleSearch = (e: React.FormEvent) => {
    e.preventDefault();
    const t = input.trim().toUpperCase();
    if (!t) {
      setError("Enter a ticker symbol.");
      return;
    }
    setError(null);
    setLoading(true);
    setQuery({
      ticker: t,
      chartInterval,
      chartRange,
    });
  };

  const updateChartInterval = (next: ChartIntervalId) => {
    const allowed = allowedRangesForInterval(next);
    const nextRange = allowed.includes(chartRange)
      ? chartRange
      : allowed[0];
    setChartInterval(next);
    setChartRange(nextRange);
    if (query) setLoading(true);
    setQuery((q) =>
      q ? { ...q, chartInterval: next, chartRange: nextRange } : q,
    );
  };

  const updateChartRange = (next: ChartRangeId) => {
    setChartRange(next);
    if (query) setLoading(true);
    setQuery((q) => (q ? { ...q, chartRange: next } : q));
  };

  useEffect(() => {
    if (!query) return;

    const controller = new AbortController();
    const { ticker, chartInterval: ci, chartRange: cr } = query;

    const params = new URLSearchParams({
      ticker,
      chartInterval: ci,
      chartRange: cr,
    });

    fetch(`/api/stocks?${params.toString()}`, {
      signal: controller.signal,
    })
      .then(async (res) => {
        const body = (await res.json()) as StockPayload & { error?: string };
        if (!res.ok) {
          throw new Error(body.error ?? res.statusText);
        }
        if (!body.tradeSuggestion) {
          body.tradeSuggestion = {
            action: "wait",
            entry: 0,
            takeProfit: 0,
            stopLoss: 0,
            confidence: 0,
            rationale: "No trade setup available.",
          };
        }
        body.candles = body.candles ?? [];
        body.chartInterval = body.chartInterval ?? ci;
        body.chartRange = body.chartRange ?? cr;
        body.chartWarning =
          body.chartWarning === undefined ? null : body.chartWarning;
        setData(body);
        setChartInterval(body.chartInterval);
        setChartRange(body.chartRange);
      })
      .catch((err: unknown) => {
        if (err instanceof Error && err.name === "AbortError") return;
        setError(err instanceof Error ? err.message : "Something went wrong.");
        setData(null);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });

    return () => controller.abort();
  }, [query]);

  const sentimentStyles: Record<
    Analysis["sentiment"],
    { label: string; className: string }
  > = {
    bullish: {
      label: "Bullish",
      className:
        "bg-emerald-500/20 text-emerald-300 ring-1 ring-emerald-500/40",
    },
    bearish: {
      label: "Bearish",
      className: "bg-red-500/20 text-red-300 ring-1 ring-red-500/40",
    },
    neutral: {
      label: "Neutral",
      className: "bg-zinc-600/40 text-zinc-200 ring-1 ring-zinc-500/50",
    },
  };

  const suggestionStyles: Record<
    TradeSuggestion["action"],
    { label: string; className: string }
  > = {
    buy: {
      label: "Buy setup",
      className:
        "bg-emerald-500/20 text-emerald-300 ring-1 ring-emerald-500/40",
    },
    short: {
      label: "Short setup",
      className: "bg-red-500/20 text-red-300 ring-1 ring-red-500/40",
    },
    wait: {
      label: "Wait / no-trade",
      className: "bg-zinc-600/40 text-zinc-200 ring-1 ring-zinc-500/50",
    },
  };

  const adjustedTakeProfit = useMemo(() => {
    if (!data) return null;
    const rr = Number(rewardRiskRatio);
    if (!Number.isFinite(rr) || rr <= 0) return null;
    return takeProfitForRewardRisk(data.tradeSuggestion, rr);
  }, [data, rewardRiskRatio]);

  const positionSizing = useMemo(() => {
    if (!data) return null;
    const entry = data.tradeSuggestion.entry;
    const stop = data.tradeSuggestion.stopLoss;
    if (!(entry > 0) || !(stop > 0)) return null;

    const account = Number(accountSize);
    const riskPct = Number(riskPercent);
    if (!Number.isFinite(account) || !Number.isFinite(riskPct)) return null;
    if (account <= 0 || riskPct <= 0) return null;

    const riskAmount = account * (riskPct / 100);
    const riskPerShare = Math.abs(entry - stop);
    if (!(riskPerShare > 0)) return null;

    const maxSharesByRisk = riskAmount / riskPerShare;
    const maxSharesByCash = account / entry;
    const rawShares = Math.min(maxSharesByRisk, maxSharesByCash);
    const shares = Math.max(0, Math.floor(rawShares * 100) / 100);
    const positionValue = shares * entry;
    const estLossAtStop = shares * riskPerShare;

    return {
      shares,
      riskAmount,
      riskPerShare,
      positionValue,
      estLossAtStop,
    };
  }, [accountSize, riskPercent, data]);

  return (
    <div className="relative min-h-screen overflow-x-hidden text-zinc-100">
      <DynamicBackground />
      {showIntro ? <IntroSplash onDismiss={dismissIntro} /> : null}
      <div className="relative z-10 mx-auto max-w-4xl px-4 py-10 sm:px-6">
        <header className="mb-10">
          <h1 className="bg-gradient-to-br from-white via-zinc-100 to-zinc-500 bg-clip-text text-3xl font-semibold tracking-tight text-transparent sm:text-4xl">
            SignalDesk
          </h1>
          <p className="mt-2 max-w-xl text-sm leading-relaxed text-zinc-400">
            Search a ticker for live price, OHLC charts, AI sentiment, and
            headlines—plus an experimental trade snapshot.
          </p>
        </header>

        <form
          onSubmit={handleSearch}
          className="flex flex-col gap-3 sm:flex-row sm:items-center"
        >
          <label className="sr-only" htmlFor="ticker">
            Ticker symbol
          </label>
          <input
            id="ticker"
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value.toUpperCase())}
            placeholder="e.g. AAPL"
            className="w-full rounded-xl border border-white/[0.1] bg-zinc-900/60 px-4 py-2.5 text-zinc-100 shadow-inner shadow-black/20 backdrop-blur-sm placeholder:text-zinc-500 focus:border-emerald-500/60 focus:outline-none focus:ring-2 focus:ring-emerald-500/25 sm:max-w-xs"
            autoComplete="off"
          />
          <button
            type="submit"
            disabled={loading}
            className="rounded-xl bg-gradient-to-r from-emerald-600 to-emerald-500 px-5 py-2.5 font-medium text-white shadow-lg shadow-emerald-900/30 transition hover:from-emerald-500 hover:to-emerald-400 disabled:cursor-not-allowed disabled:opacity-60"
          >
            Search
          </button>
        </form>

        {loading && (
          <div className="mt-10 flex items-center gap-3 text-zinc-400">
            <span
              className="inline-block h-6 w-6 animate-spin rounded-full border-2 border-zinc-600 border-t-emerald-400"
              aria-hidden
            />
            <span>Loading…</span>
          </div>
        )}

        {error && !loading && (
          <div
            className="mt-8 rounded-xl border border-red-500/35 bg-red-950/45 px-4 py-3 text-sm text-red-200 shadow-lg shadow-red-950/20 backdrop-blur-sm"
            role="alert"
          >
            {error}
          </div>
        )}

        {data && !loading && (
          <div className="mt-10 space-y-10">
            <section className="rounded-2xl border border-white/[0.08] bg-zinc-900/40 p-6 shadow-xl shadow-black/30 backdrop-blur-md ring-1 ring-white/[0.04]">
              <h2 className="text-sm font-medium uppercase tracking-wide text-zinc-500">
                Current price
              </h2>
              <p className="mt-2 text-4xl font-semibold tabular-nums text-white sm:text-5xl">
                {data.stockPrice != null ? `$${data.stockPrice}` : "—"}
              </p>
              <p className="mt-1 text-sm text-zinc-500">{data.ticker}</p>
            </section>

            <section className="rounded-2xl border border-white/[0.08] bg-zinc-900/45 p-6 shadow-xl shadow-black/35 backdrop-blur-md ring-1 ring-white/[0.04]">
              <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-end sm:justify-between">
                <h2 className="text-sm font-medium uppercase tracking-wide text-zinc-500">
                  Price chart (OHLC)
                </h2>
                <div className="flex flex-wrap gap-3">
                  <label className="flex flex-col text-xs text-zinc-400">
                    Interval
                    <select
                      value={chartInterval}
                      onChange={(e) =>
                        updateChartInterval(e.target.value as ChartIntervalId)
                      }
                      className="mt-1 min-w-[10rem] rounded-md border border-zinc-700 bg-zinc-950 px-2 py-1.5 text-sm text-zinc-100 focus:border-emerald-500/80 focus:outline-none focus:ring-2 focus:ring-emerald-500/30"
                    >
                      {CHART_INTERVALS.map((id) => (
                        <option key={id} value={id}>
                          {INTERVAL_LABELS[id]}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="flex flex-col text-xs text-zinc-400">
                    Timeframe
                    <select
                      value={chartRange}
                      onChange={(e) =>
                        updateChartRange(e.target.value as ChartRangeId)
                      }
                      className="mt-1 min-w-[10rem] rounded-md border border-zinc-700 bg-zinc-950 px-2 py-1.5 text-sm text-zinc-100 focus:border-emerald-500/80 focus:outline-none focus:ring-2 focus:ring-emerald-500/30"
                    >
                      {allowedRangesForInterval(chartInterval).map((id) => (
                        <option key={id} value={id}>
                          {RANGE_LABELS[id]}
                        </option>
                      ))}
                    </select>
                  </label>
                </div>
              </div>
              <p className="mt-2 text-xs text-zinc-500">
                OHLC from Twelve Data (intraday down to 1 minute; hourly bars
                use the 1h interval). Timeframes are limited per interval so
                ranges stay proportional; up to 5000 bars per request. Sky
                dashed line matches the live quote above.
              </p>
              {data.chartWarning && (
                <p className="mt-2 rounded-md border border-amber-500/30 bg-amber-950/30 px-3 py-2 text-xs text-amber-200">
                  {data.chartWarning}
                </p>
              )}
              <CandlestickChart
                candles={data.candles}
                currentPrice={
                  data.stockPrice != null
                    ? Number.parseFloat(data.stockPrice)
                    : null
                }
              />
            </section>

            <section className="rounded-2xl border border-white/[0.08] bg-zinc-900/45 p-6 shadow-xl shadow-black/35 backdrop-blur-md ring-1 ring-white/[0.04]">
              <div className="flex flex-wrap items-center gap-3">
                <h2 className="text-lg font-semibold text-white">
                  AI analysis
                </h2>
                <span
                  className={`inline-flex rounded-full px-3 py-1 text-xs font-medium ${sentimentStyles[data.analysis.sentiment].className}`}
                >
                  {sentimentStyles[data.analysis.sentiment].label}
                </span>
                <span className="text-sm text-zinc-400">
                  Confidence:{" "}
                  <span className="font-medium text-zinc-200">
                    {Math.round(data.analysis.confidence)}%
                  </span>
                </span>
              </div>
              <ul className="mt-4 list-inside list-disc space-y-1 text-sm text-zinc-300">
                {data.analysis.key_factors.map((factor, i) => (
                  <li key={i}>{factor}</li>
                ))}
              </ul>
              <p className="mt-4 text-sm leading-relaxed text-zinc-400">
                {data.analysis.summary}
              </p>
            </section>

            <section className="rounded-2xl border border-white/[0.08] bg-zinc-900/45 p-6 shadow-xl shadow-black/35 backdrop-blur-md ring-1 ring-white/[0.04]">
              <div className="flex flex-wrap items-center gap-3">
                <h2 className="text-lg font-semibold text-white">
                  Trade setup (experimental)
                </h2>
                <span
                  className={`inline-flex rounded-full px-3 py-1 text-xs font-medium ${suggestionStyles[data.tradeSuggestion.action].className}`}
                >
                  {suggestionStyles[data.tradeSuggestion.action].label}
                </span>
                <span className="text-sm text-zinc-400">
                  Confidence:{" "}
                  <span className="font-medium text-zinc-200">
                    {data.tradeSuggestion.confidence}%
                  </span>
                </span>
              </div>
              <div className="mt-4 grid gap-3 text-sm sm:grid-cols-3">
                <div className="rounded-lg border border-white/[0.08] bg-zinc-950/55 backdrop-blur-sm px-3 py-2">
                  <p className="text-zinc-500">Entry</p>
                  <p className="font-medium text-zinc-100">
                    ${data.tradeSuggestion.entry.toFixed(2)}
                  </p>
                </div>
                <div className="rounded-lg border border-white/[0.08] bg-zinc-950/55 backdrop-blur-sm px-3 py-2">
                  <p className="text-zinc-500">Take profit</p>
                  <p className="font-medium text-emerald-300">
                    $
                    {(adjustedTakeProfit ?? data.tradeSuggestion.takeProfit).toFixed(
                      2,
                    )}
                  </p>
                </div>
                <div className="rounded-lg border border-white/[0.08] bg-zinc-950/55 backdrop-blur-sm px-3 py-2">
                  <p className="text-zinc-500">Stop loss</p>
                  <p className="font-medium text-red-300">
                    ${data.tradeSuggestion.stopLoss.toFixed(2)}
                  </p>
                </div>
              </div>
              <label className="mt-3 flex max-w-xs flex-col text-xs text-zinc-400">
                <abbr
                  className="cursor-help no-underline decoration-dotted underline-offset-2 transition hover:text-zinc-200 hover:[text-shadow:0_0_8px_rgba(244,244,245,0.45)]"
                  title="Reward-to-risk: Target profit per unit of risk (entry-to-stop distance). Take profit updates; entry and stop stay as suggested."
                >
                  Reward : risk target
                </abbr>
                <input
                  type="number"
                  min="0.25"
                  max="10"
                  step="0.25"
                  value={rewardRiskRatio}
                  onChange={(e) => setRewardRiskRatio(e.target.value)}
                  className="mt-1 w-full rounded-md border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm text-zinc-100 focus:border-emerald-500/80 focus:outline-none focus:ring-2 focus:ring-emerald-500/30"
                />
              </label>
              <p className="mt-4 text-sm text-zinc-400">
                {data.tradeSuggestion.rationale}
              </p>
              <div className="mt-5 border-t border-white/[0.08] pt-5">
                <h3 className="text-sm font-medium text-zinc-300">
                  Position sizing
                </h3>
                <div className="mt-3 grid gap-3 sm:grid-cols-2">
                  <label className="text-xs text-zinc-400">
                    <abbr
                      className="cursor-help no-underline decoration-dotted underline-offset-2 transition hover:text-zinc-200 hover:[text-shadow:0_0_8px_rgba(244,244,245,0.45)]"
                      title="Account size: Total capital available in your account for sizing this trade."
                    >
                      Account size ($)
                    </abbr>
                    <input
                      type="number"
                      min="0"
                      step="100"
                      value={accountSize}
                      onChange={(e) => setAccountSize(e.target.value)}
                      className="mt-1 w-full rounded-md border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm text-zinc-100 focus:border-emerald-500/80 focus:outline-none focus:ring-2 focus:ring-emerald-500/30"
                    />
                  </label>
                  <label className="text-xs text-zinc-400">
                    <abbr
                      className="cursor-help no-underline decoration-dotted underline-offset-2 transition hover:text-zinc-200 hover:[text-shadow:0_0_8px_rgba(244,244,245,0.45)]"
                      title="Risk per trade (%): The percent of your account you are willing to lose if the stop loss is hit on one trade."
                    >
                      Risk per trade (%)
                    </abbr>
                    <input
                      type="number"
                      min="0.1"
                      max="10"
                      step="0.1"
                      value={riskPercent}
                      onChange={(e) => setRiskPercent(e.target.value)}
                      className="mt-1 w-full rounded-md border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm text-zinc-100 focus:border-emerald-500/80 focus:outline-none focus:ring-2 focus:ring-emerald-500/30"
                    />
                  </label>
                </div>
                {positionSizing ? (
                  <div className="mt-3 grid gap-3 text-sm sm:grid-cols-2 lg:grid-cols-4">
                    <div className="rounded-lg border border-white/[0.08] bg-zinc-950/55 backdrop-blur-sm px-3 py-2">
                      <p className="text-zinc-500">
                        <abbr
                          className="cursor-help no-underline decoration-dotted underline-offset-2 transition hover:text-zinc-200 hover:[text-shadow:0_0_8px_rgba(244,244,245,0.45)]"
                          title="Suggested shares: Position size based on your risk amount and stop loss distance, capped so total position value does not exceed account size."
                        >
                          Suggested shares
                        </abbr>
                      </p>
                      <p className="font-medium text-zinc-100">
                        {positionSizing.shares.toFixed(2)}
                      </p>
                    </div>
                    <div className="rounded-lg border border-white/[0.08] bg-zinc-950/55 backdrop-blur-sm px-3 py-2">
                      <p className="text-zinc-500">
                        <abbr
                          className="cursor-help no-underline decoration-dotted underline-offset-2 transition hover:text-zinc-200 hover:[text-shadow:0_0_8px_rgba(244,244,245,0.45)]"
                          title="Risk amount: The dollar amount you can lose on this trade (account size × risk per trade %)."
                        >
                          Risk amount
                        </abbr>
                      </p>
                      <p className="font-medium text-zinc-100">
                        ${positionSizing.riskAmount.toFixed(2)}
                      </p>
                    </div>
                    <div className="rounded-lg border border-white/[0.08] bg-zinc-950/55 backdrop-blur-sm px-3 py-2">
                      <p className="text-zinc-500">
                        <abbr
                          className="cursor-help no-underline decoration-dotted underline-offset-2 transition hover:text-zinc-200 hover:[text-shadow:0_0_8px_rgba(244,244,245,0.45)]"
                          title="Risk / share: How much you lose per share if price moves from entry to stop loss."
                        >
                          Risk / share
                        </abbr>
                      </p>
                      <p className="font-medium text-zinc-100">
                        ${positionSizing.riskPerShare.toFixed(2)}
                      </p>
                    </div>
                    <div className="rounded-lg border border-white/[0.08] bg-zinc-950/55 backdrop-blur-sm px-3 py-2">
                      <p className="text-zinc-500">
                        <abbr
                          className="cursor-help no-underline decoration-dotted underline-offset-2 transition hover:text-zinc-200 hover:[text-shadow:0_0_8px_rgba(244,244,245,0.45)]"
                          title="Position value: Total dollar size of the trade (suggested shares × entry price)."
                        >
                          Position value
                        </abbr>
                      </p>
                      <p className="font-medium text-zinc-100">
                        ${positionSizing.positionValue.toFixed(2)}
                      </p>
                    </div>
                  </div>
                ) : (
                  <p className="mt-3 text-xs text-zinc-500">
                    Enter valid sizing inputs to calculate share quantity.
                  </p>
                )}
                {positionSizing && (
                  <p className="mt-2 text-xs text-zinc-500">
                    Estimated loss at stop: $
                    {positionSizing.estLossAtStop.toFixed(2)}
                  </p>
                )}
              </div>
              <p className="mt-2 text-xs text-zinc-500">
                Educational use only. Markets are uncertain and losses are possible.
              </p>
            </section>

            <section>
              <h2 className="text-lg font-semibold text-white">News feed</h2>
              <ul className="mt-4 space-y-4">
                {data.articles.map((article, idx) => (
                  <li
                    key={`${article.url}-${idx}`}
                    className="rounded-xl border border-white/[0.06] bg-zinc-900/35 p-4 backdrop-blur-sm transition hover:border-emerald-500/25 hover:bg-zinc-900/50"
                  >
                    <a
                      href={article.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-base font-medium text-emerald-400 hover:text-emerald-300 hover:underline"
                    >
                      {article.title}
                    </a>
                    <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-xs text-zinc-500">
                      <span>{article.sourceName}</span>
                      <span>
                        {article.publishedAt
                          ? new Date(article.publishedAt).toLocaleString()
                          : ""}
                      </span>
                    </div>
                  </li>
                ))}
              </ul>
            </section>
          </div>
        )}
      </div>
    </div>
  );
}
