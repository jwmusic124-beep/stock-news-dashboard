import type { ChartCandle } from "@/lib/twelve-data-chart";

export type TechnicalBias = "bullish" | "bearish" | "neutral";
export type TechnicalSignalType =
  | "fvg"
  | "imbalance"
  | "liquidity_level"
  | "liquidity_sweep"
  | "structure";

export type TechnicalSignal = {
  type: TechnicalSignalType;
  bias: TechnicalBias;
  title: string;
  description: string;
  priceTop: number;
  priceBottom: number;
  strength: number;
  candleLabel: string;
  /** Candle time the pattern is anchored to (ms); used for recency ordering. */
  anchorTs: number;
};

export type TechnicalAnalysisSummary = {
  bias: TechnicalBias;
  confidence: number;
  notes: string[];
  keyLevels: number[];
};

export type TechnicalAnalysisResult = {
  summary: TechnicalAnalysisSummary;
  signals: TechnicalSignal[];
};

function round2(value: number): number {
  return Number(value.toFixed(2));
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function avg(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) return (sorted[mid - 1] + sorted[mid]) / 2;
  return sorted[mid];
}

function normalizeCandles(candles: ChartCandle[]): ChartCandle[] {
  return [...candles].sort((a, b) => a.ts - b.ts);
}

function detectFvgAndImbalance(
  candles: ChartCandle[],
  baseRange: number,
): TechnicalSignal[] {
  const out: TechnicalSignal[] = [];
  if (candles.length < 3) return out;

  for (let i = 2; i < candles.length; i++) {
    const a = candles[i - 2];
    const b = candles[i - 1];
    const c = candles[i];
    const displacement = Math.abs(b.close - b.open);
    const midRange = Math.max(1e-9, b.high - b.low);
    const bodyToRange = displacement / midRange;

    if (c.low > a.high) {
      const gap = c.low - a.high;
      if (gap >= baseRange * 0.12) {
        out.push({
          type: "fvg",
          bias: "bullish",
          title: "Bullish fair value gap",
          description:
            "Three-candle displacement left an upside inefficiency likely to attract a retest.",
          priceTop: round2(c.low),
          priceBottom: round2(a.high),
          strength: clamp((gap / Math.max(baseRange, 1e-9)) * 35, 20, 95),
          candleLabel: c.label,
          anchorTs: c.ts,
        });
      }
    }

    if (c.high < a.low) {
      const gap = a.low - c.high;
      if (gap >= baseRange * 0.12) {
        out.push({
          type: "fvg",
          bias: "bearish",
          title: "Bearish fair value gap",
          description:
            "Three-candle displacement left a downside inefficiency likely to attract a retest.",
          priceTop: round2(a.low),
          priceBottom: round2(c.high),
          strength: clamp((gap / Math.max(baseRange, 1e-9)) * 35, 20, 95),
          candleLabel: c.label,
          anchorTs: c.ts,
        });
      }
    }

    if (bodyToRange >= 0.72 && midRange >= baseRange * 1.25) {
      const bullish = b.close >= b.open;
      out.push({
        type: "imbalance",
        bias: bullish ? "bullish" : "bearish",
        title: bullish ? "Bullish imbalance candle" : "Bearish imbalance candle",
        description:
          "Large displacement candle may signal aggressive order-flow imbalance.",
        priceTop: round2(Math.max(b.open, b.close)),
        priceBottom: round2(Math.min(b.open, b.close)),
        strength: clamp(
          bodyToRange * 60 + (midRange / Math.max(baseRange, 1e-9)) * 14,
          20,
          92,
        ),
        candleLabel: b.label,
        anchorTs: b.ts,
      });
    }
  }

  return out;
}

function detectLiquiditySignals(
  candles: ChartCandle[],
  tolerancePct: number,
): TechnicalSignal[] {
  const out: TechnicalSignal[] = [];
  if (candles.length < 8) return out;

  const last = candles[candles.length - 1];

  const swingHighs: Array<{ idx: number; price: number; label: string }> = [];
  const swingLows: Array<{ idx: number; price: number; label: string }> = [];
  for (let i = 1; i < candles.length - 1; i++) {
    const prev = candles[i - 1];
    const cur = candles[i];
    const next = candles[i + 1];
    if (cur.high > prev.high && cur.high >= next.high) {
      swingHighs.push({ idx: i, price: cur.high, label: cur.label });
    }
    if (cur.low < prev.low && cur.low <= next.low) {
      swingLows.push({ idx: i, price: cur.low, label: cur.label });
    }
  }

  const makeLevels = (
    points: Array<{ idx: number; price: number; label: string }>,
    side: "high" | "low",
  ): Array<{ price: number; touches: number; lastIdx: number; label: string }> => {
    const levels: Array<{
      price: number;
      touches: number;
      lastIdx: number;
      label: string;
    }> = [];

    for (const p of points) {
      const tol = p.price * tolerancePct;
      const existing = levels.find((x) => Math.abs(x.price - p.price) <= tol);
      if (existing) {
        existing.price = (existing.price * existing.touches + p.price) / (existing.touches + 1);
        existing.touches += 1;
        if (p.idx > existing.lastIdx) {
          existing.lastIdx = p.idx;
          existing.label = p.label;
        }
      } else {
        levels.push({ price: p.price, touches: 1, lastIdx: p.idx, label: p.label });
      }
    }

    return levels
      .filter((x) => x.touches >= 2)
      .sort((a, b) => b.lastIdx - a.lastIdx)
      .slice(0, 3)
      .map((x) => ({
        price: x.price,
        touches: x.touches,
        lastIdx: x.lastIdx,
        label: x.label,
        side,
      }));
  };

  const highLevels = makeLevels(swingHighs, "high");
  const lowLevels = makeLevels(swingLows, "low");

  for (const level of highLevels) {
    const anchorTs = candles[level.lastIdx]?.ts ?? last.ts;
    out.push({
      type: "liquidity_level",
      bias: "bearish",
      title: "Buy-side liquidity level",
      description: `Multiple similar highs suggest clustered stops above ${round2(level.price)}.`,
      priceTop: round2(level.price),
      priceBottom: round2(level.price),
      strength: clamp(level.touches * 24, 20, 85),
      candleLabel: level.label,
      anchorTs,
    });
  }

  for (const level of lowLevels) {
    const anchorTs = candles[level.lastIdx]?.ts ?? last.ts;
    out.push({
      type: "liquidity_level",
      bias: "bullish",
      title: "Sell-side liquidity level",
      description: `Multiple similar lows suggest clustered stops below ${round2(level.price)}.`,
      priceTop: round2(level.price),
      priceBottom: round2(level.price),
      strength: clamp(level.touches * 24, 20, 85),
      candleLabel: level.label,
      anchorTs,
    });
  }

  for (const level of highLevels) {
    const tol = level.price * tolerancePct;
    if (last.high > level.price + tol && last.close < level.price) {
      out.push({
        type: "liquidity_sweep",
        bias: "bearish",
        title: "Buy-side liquidity sweep",
        description:
          "Price ran above prior highs and closed back below, a potential bearish sweep.",
        priceTop: round2(last.high),
        priceBottom: round2(level.price),
        strength: 72,
        candleLabel: last.label,
        anchorTs: last.ts,
      });
    }
  }
  for (const level of lowLevels) {
    const tol = level.price * tolerancePct;
    if (last.low < level.price - tol && last.close > level.price) {
      out.push({
        type: "liquidity_sweep",
        bias: "bullish",
        title: "Sell-side liquidity sweep",
        description:
          "Price dipped below prior lows and reclaimed the level, a potential bullish sweep.",
        priceTop: round2(level.price),
        priceBottom: round2(last.low),
        strength: 72,
        candleLabel: last.label,
        anchorTs: last.ts,
      });
    }
  }

  return out;
}

function detectStructureSignal(candles: ChartCandle[]): TechnicalSignal[] {
  if (candles.length < 8) return [];
  const out: TechnicalSignal[] = [];
  const recent = candles.slice(-25);
  const highs = recent.map((c) => c.high);
  const lows = recent.map((c) => c.low);
  const prevHigh = Math.max(...highs.slice(0, -1));
  const prevLow = Math.min(...lows.slice(0, -1));
  const last = recent[recent.length - 1];

  if (last.close > prevHigh) {
    out.push({
      type: "structure",
      bias: "bullish",
      title: "Bullish structure break",
      description:
        "Latest close broke above recent swing highs, signaling possible continuation.",
      priceTop: round2(last.close),
      priceBottom: round2(prevHigh),
      strength: 78,
      candleLabel: last.label,
      anchorTs: last.ts,
    });
  } else if (last.close < prevLow) {
    out.push({
      type: "structure",
      bias: "bearish",
      title: "Bearish structure break",
      description:
        "Latest close broke below recent swing lows, signaling possible continuation.",
      priceTop: round2(prevLow),
      priceBottom: round2(last.close),
      strength: 78,
      candleLabel: last.label,
      anchorTs: last.ts,
    });
  }

  return out;
}

function buildSummary(signals: TechnicalSignal[], lastPrice: number): TechnicalAnalysisSummary {
  let score = 0;
  const levels = new Set<number>();
  for (const s of signals) {
    if (s.bias === "bullish") score += s.strength;
    if (s.bias === "bearish") score -= s.strength;
    levels.add(round2(s.priceTop));
    levels.add(round2(s.priceBottom));
  }

  const abs = Math.abs(score);
  const bias: TechnicalBias =
    abs < 35 ? "neutral" : score > 0 ? "bullish" : "bearish";
  const confidence = clamp(Math.round(35 + abs / Math.max(signals.length, 1)), 25, 93);
  const notes: string[] = [];
  if (signals.some((s) => s.type === "fvg")) {
    notes.push("Fair value gaps suggest potential mean-reversion retest zones.");
  }
  if (signals.some((s) => s.type === "liquidity_sweep")) {
    notes.push("Recent liquidity sweep detected; watch for continuation or failure.");
  }
  if (signals.some((s) => s.type === "structure")) {
    notes.push("Structure break is active on the current timeframe.");
  }
  if (notes.length === 0) {
    notes.push("No strong smart-money-style pattern cluster found in the current sample.");
  }
  if (Number.isFinite(lastPrice) && lastPrice > 0) {
    notes.push(`Current reference price: ${round2(lastPrice)}.`);
  }

  return {
    bias,
    confidence,
    notes: notes.slice(0, 3),
    keyLevels: [...levels]
      .filter((v) => Number.isFinite(v) && v > 0)
      .sort((a, b) => Math.abs(a - lastPrice) - Math.abs(b - lastPrice))
      .slice(0, 6),
  };
}

export function analyzeTechnicalSignals(candlesRaw: ChartCandle[]): TechnicalAnalysisResult {
  const candles = normalizeCandles(candlesRaw).filter(
    (c) =>
      Number.isFinite(c.open) &&
      Number.isFinite(c.high) &&
      Number.isFinite(c.low) &&
      Number.isFinite(c.close) &&
      c.high >= c.low,
  );
  if (candles.length < 12) {
    return {
      summary: {
        bias: "neutral",
        confidence: 20,
        notes: ["Not enough candle data for robust technical pattern detection."],
        keyLevels: [],
      },
      signals: [],
    };
  }

  const ranges = candles.slice(-120).map((c) => Math.max(0, c.high - c.low));
  const baseRange = Math.max(1e-6, median(ranges) || avg(ranges) || 1e-6);
  const tolerancePct = 0.0018;
  const lastPrice = candles[candles.length - 1].close;

  const collected = [
    ...detectFvgAndImbalance(candles, baseRange),
    ...detectLiquiditySignals(candles, tolerancePct),
    ...detectStructureSignal(candles),
  ];
  const isFvgOrImbalance = (s: TechnicalSignal) =>
    s.type === "fvg" || s.type === "imbalance";
  const fvgImb = collected
    .filter(isFvgOrImbalance)
    .sort((a, b) => {
      const byTime = b.anchorTs - a.anchorTs;
      if (byTime !== 0) return byTime;
      return b.strength - a.strength;
    });
  const rest = collected
    .filter((s) => !isFvgOrImbalance(s))
    .sort((a, b) => b.strength - a.strength);
  const signals = [...fvgImb, ...rest].slice(0, 12);

  return {
    summary: buildSummary(signals, lastPrice),
    signals,
  };
}
