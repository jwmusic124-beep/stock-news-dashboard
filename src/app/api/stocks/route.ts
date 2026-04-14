import { NextResponse } from "next/server";
import Groq from "groq-sdk";
import {
  chartIntervalToTwelveData,
  dailyClosesToPriceHistory,
  estimateOutputSize,
  fetchTwelveDataSeries,
  rangeToDateBounds,
  resolveChartSelection,
  type ChartCandle,
} from "@/lib/twelve-data-chart";
import { env } from "@/lib/env";

const SYSTEM_PROMPT =
  "You are a stock market analyst. Analyze these news headlines and return ONLY a valid JSON object with these exact fields: sentiment (string: bullish, neutral, or bearish), confidence (number 0-100), key_factors (array of exactly 3 strings), summary (string: one paragraph)";

function parseAnalysisJson(content: string): {
  sentiment: "bullish" | "neutral" | "bearish";
  confidence: number;
  key_factors: [string, string, string];
  summary: string;
} {
  const trimmed = content.trim();
  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  const raw = fence ? fence[1].trim() : trimmed;
  const parsed = JSON.parse(raw) as Record<string, unknown>;
  const s = String(parsed.sentiment ?? "neutral").toLowerCase();
  const sentiment: "bullish" | "neutral" | "bearish" =
    s === "bullish" || s === "bearish" ? s : "neutral";
  const confidence = Math.min(
    100,
    Math.max(0, Number(parsed.confidence) || 0),
  );
  const factors = Array.isArray(parsed.key_factors)
    ? parsed.key_factors.map(String)
    : [];
  const key_factors: [string, string, string] = [
    factors[0] ?? "",
    factors[1] ?? "",
    factors[2] ?? "",
  ];
  return {
    sentiment,
    confidence,
    key_factors,
    summary: String(parsed.summary ?? ""),
  };
}

type TradeSuggestion = {
  action: "buy" | "short" | "wait";
  entry: number;
  takeProfit: number;
  stopLoss: number;
  confidence: number;
  rationale: string;
};

type StocksApiResponse = {
  ticker: string;
  stockPrice: string | null;
  priceHistory: Array<{ date: string; price: number }>;
  candles: ChartCandle[];
  chartInterval: ReturnType<typeof resolveChartSelection>["interval"];
  chartRange: ReturnType<typeof resolveChartSelection>["range"];
  chartWarning: string | null;
  tradeSuggestion: TradeSuggestion;
  articles: Array<{
    title: string;
    sourceName: string;
    publishedAt: string;
    url: string;
  }>;
  analysis: ReturnType<typeof parseAnalysisJson>;
};

type CacheEntry = {
  expiresAt: number;
  payload: StocksApiResponse;
};

const CACHE_TTL_MS = 5 * 60 * 1000;
const tickerCache = new Map<string, CacheEntry>();

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

function buildTradeSuggestion(params: {
  entry: number;
  closes: number[];
  sentiment: "bullish" | "neutral" | "bearish";
}): TradeSuggestion {
  const { entry, closes, sentiment } = params;
  const safeCloses = closes.filter((v) => Number.isFinite(v) && v > 0);
  const recent = safeCloses.slice(-20);
  const shortWindow = safeCloses.slice(-5);
  const sma20 = avg(recent);
  const sma5 = avg(shortWindow);
  const momentum = sma20 > 0 ? (entry - sma20) / sma20 : 0;
  const dailyReturns = recent
    .slice(1)
    .map((v, i) => (recent[i] > 0 ? v / recent[i] - 1 : 0));
  const volatility = Math.max(0.008, Math.min(0.04, stdev(dailyReturns)));
  const riskPct = Math.max(0.01, Math.min(0.05, volatility * 1.6));

  let action: TradeSuggestion["action"] = "wait";
  if (entry > sma20 && sma5 >= sma20 && sentiment !== "bearish") action = "buy";
  if (entry < sma20 && sma5 <= sma20 && sentiment !== "bullish") action = "short";

  let confidence = 45 + Math.min(25, Math.abs(momentum) * 250);
  if (action === "wait") confidence -= 10;
  if (
    (action === "buy" && sentiment === "bullish") ||
    (action === "short" && sentiment === "bearish")
  ) {
    confidence += 12;
  }
  if (
    (action === "buy" && sentiment === "bearish") ||
    (action === "short" && sentiment === "bullish")
  ) {
    confidence -= 14;
  }
  confidence = Math.max(15, Math.min(90, Math.round(confidence)));

  if (action === "buy") {
    return {
      action,
      entry: round2(entry),
      takeProfit: round2(entry * (1 + riskPct * 2)),
      stopLoss: round2(entry * (1 - riskPct)),
      confidence,
      rationale:
        "Price is above medium-term trend with supportive momentum; setup uses a 2:1 reward-to-risk target.",
    };
  }
  if (action === "short") {
    return {
      action,
      entry: round2(entry),
      takeProfit: round2(entry * (1 - riskPct * 2)),
      stopLoss: round2(entry * (1 + riskPct)),
      confidence,
      rationale:
        "Price is below medium-term trend with weak momentum; setup uses a 2:1 reward-to-risk target.",
    };
  }
  return {
    action,
    entry: round2(entry),
    takeProfit: round2(entry * (1 + riskPct)),
    stopLoss: round2(entry * (1 - riskPct)),
    confidence,
    rationale:
      "Trend and sentiment are mixed; waiting for clearer direction is the higher-probability setup.",
  };
}

async function fetchYahooPriceHistory(
  ticker: string,
): Promise<Array<{ date: string; price: number }>> {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(
    ticker,
  )}?range=1mo&interval=1d`;
  const res = await fetch(url);
  if (!res.ok) return [];

  const payload = (await res.json()) as {
    chart?: {
      result?: Array<{
        timestamp?: number[];
        indicators?: {
          quote?: Array<{
            close?: Array<number | null>;
          }>;
        };
      }>;
    };
  };
  const result = payload.chart?.result?.[0];
  const ts = result?.timestamp;
  const close = result?.indicators?.quote?.[0]?.close;
  if (!ts || !close || ts.length !== close.length) return [];

  const out: Array<{ date: string; price: number }> = [];
  for (let i = 0; i < ts.length; i++) {
    const p = close[i];
    if (p == null || !Number.isFinite(p)) continue;
    out.push({
      date: new Date(ts[i] * 1000).toISOString().slice(0, 10),
      price: p,
    });
  }
  return out;
}

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const tickerRaw = searchParams.get("ticker")?.trim().toUpperCase() ?? "";
  if (!tickerRaw) {
    return NextResponse.json({ error: "Ticker is required" }, { status: 400 });
  }

  const finnhubKey = env.finnhubKey();
  const twelveKey = env.twelveDataKey();
  const groqApiKey = env.groqApiKey();

  if (!finnhubKey) {
    return NextResponse.json(
      { error: "FINNHUB_KEY is not configured" },
      { status: 500 },
    );
  }
  if (!twelveKey) {
    return NextResponse.json(
      { error: "TWELVE_DATA_KEY is not configured" },
      { status: 500 },
    );
  }
  if (!groqApiKey) {
    return NextResponse.json(
      { error: "GROQ_API_KEY is not configured" },
      { status: 500 },
    );
  }

  const chartSelection = resolveChartSelection(
    searchParams.get("chartInterval"),
    searchParams.get("chartRange"),
  );

  const now = Date.now();
  const cached = tickerCache.get(tickerRaw);
  if (cached) {
    if (
      cached.expiresAt > now &&
      cached.payload.chartInterval === chartSelection.interval &&
      cached.payload.chartRange === chartSelection.range
    ) {
      return NextResponse.json(cached.payload);
    }
    if (cached.expiresAt <= now) tickerCache.delete(tickerRaw);
  }

  const tdInterval = chartIntervalToTwelveData(chartSelection.interval);
  const bounds = rangeToDateBounds(chartSelection.range);
  const outputsize = estimateOutputSize(
    chartSelection.interval,
    chartSelection.range,
  );

  const fromDate = new Date();
  fromDate.setDate(fromDate.getDate() - 14);
  const fromStr = fromDate.toISOString().slice(0, 10);
  const toStr = new Date().toISOString().slice(0, 10);

  const newsUrl = `https://finnhub.io/api/v1/company-news?symbol=${encodeURIComponent(
    tickerRaw,
  )}&from=${fromStr}&to=${toStr}&token=${finnhubKey}`;
  const quoteUrl = `https://finnhub.io/api/v1/quote?symbol=${encodeURIComponent(
    tickerRaw,
  )}&token=${finnhubKey}`;

  try {
    const [newsRes, fhQuoteRes, tdDailySeries, tdChartSeries] =
      await Promise.all([
        fetch(newsUrl),
        fetch(quoteUrl),
        fetchTwelveDataSeries({
          symbol: tickerRaw,
          interval: "1day",
          apiKey: twelveKey,
          outputsize: 80,
        }),
        fetchTwelveDataSeries({
          symbol: tickerRaw,
          interval: tdInterval,
          apiKey: twelveKey,
          outputsize,
          start_date: bounds.start_date,
          end_date: bounds.end_date,
        }),
      ]);

    const newsPayload = (await newsRes.json()) as
      | Array<{
          headline?: string;
          source?: string;
          datetime?: number;
          url?: string;
        }>
      | { error?: string };

    if (!newsRes.ok) {
      throw new Error(`Finnhub news request failed (${newsRes.status})`);
    }
    if (!Array.isArray(newsPayload)) {
      throw new Error(
        typeof newsPayload === "object" && newsPayload && "error" in newsPayload
          ? String((newsPayload as { error?: string }).error)
          : "Invalid Finnhub news response",
      );
    }

    const sortedNews = [...newsPayload].sort(
      (a, b) => (b.datetime ?? 0) - (a.datetime ?? 0),
    );
    const topNews = sortedNews.slice(0, 10);

    const fhQuote = (await fhQuoteRes.json()) as {
      c?: number;
      error?: string;
    };

    if (!fhQuoteRes.ok) {
      throw new Error(`Finnhub quote request failed (${fhQuoteRes.status})`);
    }

    const last = fhQuote.c;
    const stockPrice =
      typeof last === "number" && Number.isFinite(last) && last > 0
        ? last.toFixed(2)
        : null;

    let priceHistory = dailyClosesToPriceHistory(tdDailySeries.candles, 30);
    if (priceHistory.length === 0) {
      console.error(
        "Twelve Data daily history unavailable, falling back",
        tdDailySeries.errorMessage,
      );
      priceHistory = await fetchYahooPriceHistory(tickerRaw);
    }

    const candles: ChartCandle[] = tdChartSeries.candles;
    const chartWarning: string | undefined = tdChartSeries.errorMessage;
    if (candles.length === 0 && chartWarning) {
      console.error("Twelve Data chart empty:", chartWarning);
    }

    const articles = topNews.map((a) => ({
      title: a.headline ?? "Untitled",
      sourceName: a.source ?? "Unknown",
      publishedAt:
        a.datetime != null
          ? new Date(a.datetime * 1000).toISOString()
          : "",
      url: a.url ?? "#",
    }));

    const headlines = articles.map((a) => a.title).filter(Boolean);
    const groq = new Groq({ apiKey: groqApiKey });

    const completion = await groq.chat.completions.create({
      model: "llama-3.3-70b-versatile",
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        {
          role: "user",
          content: `Ticker: ${tickerRaw}\n\nHeadlines:\n${headlines.join("\n")}`,
        },
      ],
    });

    const rawContent = completion.choices[0]?.message?.content ?? "";
    let analysis: ReturnType<typeof parseAnalysisJson>;
    try {
      analysis = parseAnalysisJson(rawContent);
    } catch {
      analysis = {
        sentiment: "neutral",
        confidence: 0,
        key_factors: ["—", "—", "—"],
        summary:
          "AI analysis could not be parsed. Try again or check headlines availability.",
      };
    }
    const closes = priceHistory.map((p) => p.price);
    const entryPrice =
      stockPrice != null ? Number(stockPrice) : closes[closes.length - 1];
    const tradeSuggestion =
      Number.isFinite(entryPrice) && entryPrice > 0 && closes.length >= 10
        ? buildTradeSuggestion({
            entry: entryPrice,
            closes,
            sentiment: analysis.sentiment,
          })
        : {
            action: "wait" as const,
            entry:
              entryPrice && Number.isFinite(entryPrice)
                ? round2(entryPrice)
                : 0,
            takeProfit:
              entryPrice && Number.isFinite(entryPrice)
                ? round2(entryPrice)
                : 0,
            stopLoss:
              entryPrice && Number.isFinite(entryPrice)
                ? round2(entryPrice)
                : 0,
            confidence: 20,
            rationale:
              "Insufficient reliable historical data to calculate a higher-confidence setup.",
          };

    const responsePayload: StocksApiResponse = {
      ticker: tickerRaw,
      stockPrice,
      priceHistory,
      candles,
      chartInterval: chartSelection.interval,
      chartRange: chartSelection.range,
      chartWarning: chartWarning ?? null,
      tradeSuggestion,
      articles,
      analysis,
    };

    tickerCache.set(tickerRaw, {
      expiresAt: Date.now() + CACHE_TTL_MS,
      payload: responsePayload,
    });

    return NextResponse.json(responsePayload);
  } catch (err) {
    console.error(err);
    const message = err instanceof Error ? err.message : "Internal server error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
