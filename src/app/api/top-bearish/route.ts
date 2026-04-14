import { NextResponse } from "next/server";
import { env } from "@/lib/env";
import { fetchTwelveDataSeries } from "@/lib/twelve-data-chart";

type RankedIdea = {
  ticker: string;
  confidence: number;
  projectedDecreasePct: number;
  currentPrice: number;
  score: number;
};

const WATCHLIST = [
  "AAPL",
  "MSFT",
  "NVDA",
  "AMZN",
  "META",
  "GOOGL",
  "TSLA",
  "AMD",
  "AVGO",
  "NFLX",
  "PLTR",
  "CRWD",
  "SMCI",
  "SNOW",
  "SHOP",
  "JPM",
  "BAC",
  "WFC",
  "GS",
  "V",
  "MA",
  "UNH",
  "LLY",
  "MRK",
  "PFE",
  "XOM",
  "CVX",
  "COP",
  "CAT",
  "GE",
  "DE",
  "BA",
  "ORCL",
  "ADBE",
  "CRM",
  "INTC",
  "QCOM",
  "TXN",
  "MU",
  "AMAT",
  "PANW",
  "UBER",
  "ABNB",
  "COST",
  "WMT",
  "HD",
  "MCD",
  "NKE",
];
const TOP_IDEA_COUNT = 4;

function avg(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

function stdev(values: number[]): number {
  if (values.length < 2) return 0;
  const mean = avg(values);
  const variance =
    values.reduce((sum, v) => sum + (v - mean) ** 2, 0) / values.length;
  return Math.sqrt(variance);
}

function round2(value: number): number {
  return Number(value.toFixed(2));
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function zScore(values: number[]): number {
  const mean = avg(values);
  const sigma = stdev(values);
  if (!(sigma > 0)) return 0;
  const last = values[values.length - 1];
  return (last - mean) / sigma;
}

async function analyzeTicker(
  ticker: string,
  twelveKey: string,
): Promise<RankedIdea | null> {
  try {
    const series = await fetchTwelveDataSeries({
      symbol: ticker,
      interval: "1day",
      apiKey: twelveKey,
      outputsize: 120,
    });

    if (series.candles.length < 35) return null;
    const closes = series.candles.map((c) => c.close).filter((v) => v > 0);
    if (closes.length < 35) return null;

    const price = closes[closes.length - 1];
    if (!(price > 0)) return null;

    const sma20 = avg(closes.slice(-20));
    const sma50 = avg(closes.slice(-50));
    const sma5 = avg(closes.slice(-5));
    if (!(sma20 > 0) || !(sma50 > 0)) return null;

    const momentum20 = (price - sma20) / sma20;
    const momentum50 = (price - sma50) / sma50;
    const accel = (sma5 - sma20) / sma20;
    const extensionDown = (sma20 - price) / sma20;

    const recentForVol = closes.slice(-21);
    const dailyReturns: number[] = [];
    for (let i = 1; i < recentForVol.length; i++) {
      const prev = recentForVol[i - 1];
      const cur = recentForVol[i];
      if (prev > 0 && cur > 0) dailyReturns.push(cur / prev - 1);
    }
    const rawVolatility = stdev(dailyReturns);
    const dailyVol = clamp(
      Number.isFinite(rawVolatility) && rawVolatility > 0 ? rawVolatility : 0.005,
      0.003,
      0.08,
    );
    const monthVol = dailyVol * Math.sqrt(20);

    const bearishSignal = clamp(
      -(0.45 * momentum20 + 0.35 * momentum50 + 0.2 * accel),
      -0.2,
      0.25,
    );
    const oversoldPenalty = clamp(Math.max(0, extensionDown - 0.12) * 1.2, 0, 0.12);
    const expectedDownDrift = clamp(bearishSignal - oversoldPenalty, -0.2, 0.25);

    const projectedDecreasePct = round2(
      clamp((expectedDownDrift + monthVol * 0.6) * 100, 0.25, 30),
    );

    const trendAligned = price < sma20 && sma20 < sma50 ? 1 : 0;
    const momentumZ = clamp(zScore(closes.slice(-30)), -3, 3);
    const confidenceRaw =
      52 +
      trendAligned * 14 +
      clamp(-momentum20 * 180, -20, 24) +
      clamp(-momentum50 * 120, -16, 18) +
      clamp(-accel * 140, -12, 14) +
      clamp(-momentumZ * 3, -8, 8) -
      clamp(oversoldPenalty * 140, 0, 18);
    const confidence = Math.round(clamp(confidenceRaw, 20, 92));
    const score = round2(confidence * 0.75 + projectedDecreasePct * 2.2);

    return {
      ticker,
      confidence,
      projectedDecreasePct,
      currentPrice: round2(price),
      score,
    };
  } catch {
    return null;
  }
}

export async function GET() {
  const twelveKey = env.twelveDataKey();
  if (!twelveKey) {
    return NextResponse.json(
      { error: "TWELVE_DATA_KEY is required." },
      { status: 500 },
    );
  }

  try {
    const ideas = (
      await Promise.all(
        WATCHLIST.map((ticker) => analyzeTicker(ticker, twelveKey)),
      )
    ).filter((v): v is RankedIdea => v !== null);

    ideas.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      if (b.confidence !== a.confidence) return b.confidence - a.confidence;
      return b.projectedDecreasePct - a.projectedDecreasePct;
    });

    return NextResponse.json({
      generatedAt: new Date().toISOString(),
      ideas: ideas.slice(0, TOP_IDEA_COUNT),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
