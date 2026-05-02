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
import { getRedis } from "@/lib/redis";
import {
  analyzeTechnicalSignals,
  type TechnicalAnalysisResult,
} from "@/lib/technical-analysis";

const COMBINED_AI_SYSTEM_PROMPT =
  "Return ONLY valid JSON (no markdown code fences) with exactly this shape:\n" +
  "{\n" +
  '  "news": {\n' +
  '    "sentiment": "bullish" | "neutral" | "bearish",\n' +
  '    "confidence": number,\n' +
  '    "key_factors": [string, string, string],\n' +
  '    "summary": string\n' +
  "  },\n" +
  '  "technical": {\n' +
  '    "bias": "bullish" | "neutral" | "bearish",\n' +
  '    "confidence": number,\n' +
  '    "key_factors": [string, string, string],\n' +
  '    "summary": string,\n' +
  '    "invalidation": string\n' +
  "  }\n" +
  "}\n" +
  "Task A (news): You are a stock market analyst. Analyze ONLY the provided headlines.\n" +
  "Task B (technical): You are a technical analyst. Use ONLY the TECHNICAL_SCAN JSON (summary, topSignals, recentCandles). Do not invent prices or candles not implied there.";

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

function parseTechnicalAnalysisJson(content: string): {
  bias: "bullish" | "neutral" | "bearish";
  confidence: number;
  key_factors: [string, string, string];
  summary: string;
  invalidation: string;
} {
  const trimmed = content.trim();
  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  const raw = fence ? fence[1].trim() : trimmed;
  const parsed = JSON.parse(raw) as Record<string, unknown>;
  const b = String(parsed.bias ?? "neutral").toLowerCase();
  const bias: "bullish" | "neutral" | "bearish" =
    b === "bullish" || b === "bearish" ? b : "neutral";
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
    bias,
    confidence,
    key_factors,
    summary: String(parsed.summary ?? ""),
    invalidation: String(parsed.invalidation ?? ""),
  };
}

function parseCombinedAiJson(content: string): {
  analysis: ReturnType<typeof parseAnalysisJson>;
  technicalAi: ReturnType<typeof parseTechnicalAnalysisJson>;
} {
  const trimmed = content.trim();
  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  const raw = fence ? fence[1].trim() : trimmed;
  const parsed = JSON.parse(raw) as Record<string, unknown>;
  const news = parsed.news;
  const technical = parsed.technical;
  if (!news || typeof news !== "object" || !technical || typeof technical !== "object") {
    throw new Error("Combined AI JSON missing news or technical object");
  }
  return {
    analysis: parseAnalysisJson(JSON.stringify(news)),
    technicalAi: parseTechnicalAnalysisJson(JSON.stringify(technical)),
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
  technicalAnalysis: TechnicalAnalysisResult & {
    ai: ReturnType<typeof parseTechnicalAnalysisJson>;
  };
};

type CacheEntry = {
  expiresAt: number;
  payload: StocksApiResponse;
};

/** In-process cache TTL aligns with Redis hot cache when env is set (default 15m). */
function memoryCacheTtlMs(): number {
  return env.stocksCacheTtlSeconds() * 1000;
}

const tickerCache = new Map<string, CacheEntry>();

function memoryCacheKey(
  ticker: string,
  interval: string,
  range: string,
): string {
  return `${ticker}:${interval}:${range}`;
}

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

  const redis = getRedis();
  const redisStockKey = `sd:stocks:v1:${tickerRaw}:${chartSelection.interval}:${chartSelection.range}`;
  const redisStaleKey = `${redisStockKey}:stale`;

  if (redis) {
    const cachedBody = await redis.get(redisStockKey);
    if (typeof cachedBody === "string" && cachedBody.length > 0) {
      try {
        return NextResponse.json(JSON.parse(cachedBody) as StocksApiResponse, {
          headers: { "x-signaldesk-cache": "redis" },
        });
      } catch {
        /* fall through */
      }
    }
  }

  const memKey = memoryCacheKey(
    tickerRaw,
    chartSelection.interval,
    chartSelection.range,
  );
  const now = Date.now();
  const cached = tickerCache.get(memKey);
  if (cached) {
    if (
      cached.expiresAt > now &&
      cached.payload.chartInterval === chartSelection.interval &&
      cached.payload.chartRange === chartSelection.range
    ) {
      return NextResponse.json(cached.payload, {
        headers: { "x-signaldesk-cache": "memory" },
      });
    }
    if (cached.expiresAt <= now) tickerCache.delete(memKey);
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
    const tdChartErr = (chartWarning ?? "").toLowerCase();
    if (
      candles.length === 0 &&
      /limit|credit|quota|rate|maximum|exceed/i.test(tdChartErr)
    ) {
      throw new Error(chartWarning ?? "Twelve Data chart unavailable");
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
    const deterministicTechnical = analyzeTechnicalSignals(candles);
    const recentCandles = candles.slice(-20).map((c) => ({
      t: c.label,
      o: round2(c.open),
      h: round2(c.high),
      l: round2(c.low),
      c: round2(c.close),
    }));

    const combinedUser = [
      `Ticker: ${tickerRaw}`,
      "",
      "HEADLINES:",
      headlines.join("\n"),
      "",
      "TECHNICAL_SCAN:",
      JSON.stringify({
        chartInterval: chartSelection.interval,
        chartRange: chartSelection.range,
        technicalSummary: deterministicTechnical.summary,
        topSignals: deterministicTechnical.signals.slice(0, 8),
        recentCandles,
      }),
    ].join("\n");

    const completion = await groq.chat.completions.create({
      model: "llama-3.3-70b-versatile",
      messages: [
        { role: "system", content: COMBINED_AI_SYSTEM_PROMPT },
        { role: "user", content: combinedUser },
      ],
    });

    const rawContent = completion.choices[0]?.message?.content ?? "";
    let analysis: ReturnType<typeof parseAnalysisJson>;
    let technicalAi: ReturnType<typeof parseTechnicalAnalysisJson>;
    try {
      const parsed = parseCombinedAiJson(rawContent);
      analysis = parsed.analysis;
      technicalAi = parsed.technicalAi;
    } catch {
      analysis = {
        sentiment: "neutral",
        confidence: 0,
        key_factors: ["—", "—", "—"],
        summary:
          "AI analysis could not be parsed. Try again or check headlines availability.",
      };
      technicalAi = {
        bias: deterministicTechnical.summary.bias,
        confidence: deterministicTechnical.summary.confidence,
        key_factors: [
          deterministicTechnical.summary.notes[0] ?? "Signal cluster is mixed.",
          deterministicTechnical.summary.notes[1] ??
            "Primary technical context is weak.",
          deterministicTechnical.summary.notes[2] ?? "Use strict risk controls.",
        ],
        summary:
          "Technical AI commentary could not be parsed. Showing deterministic technical scan instead.",
        invalidation:
          deterministicTechnical.summary.bias === "bullish"
            ? "Invalid if price closes below nearest key support/liquidity level."
            : deterministicTechnical.summary.bias === "bearish"
              ? "Invalid if price closes above nearest key resistance/liquidity level."
              : "Invalid if price decisively breaks the nearest key level cluster.",
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
      technicalAnalysis: {
        ...deterministicTechnical,
        ai: technicalAi,
      },
    };

    tickerCache.set(memKey, {
      expiresAt: Date.now() + memoryCacheTtlMs(),
      payload: responsePayload,
    });

    if (redis) {
      const body = JSON.stringify(responsePayload);
      const hotTtl = env.stocksCacheTtlSeconds();
      const staleTtl = env.stocksStaleTtlSeconds();
      await Promise.all([
        redis.set(redisStockKey, body, { ex: hotTtl }),
        redis.set(redisStaleKey, body, { ex: staleTtl }),
      ]);
    }

    return NextResponse.json(responsePayload, {
      headers: { "x-signaldesk-cache": "miss" },
    });
  } catch (err) {
    console.error(err);
    const message = err instanceof Error ? err.message : "Internal server error";

    if (redis) {
      try {
        const staleBody = await redis.get(redisStaleKey);
        if (typeof staleBody === "string" && staleBody.length > 0) {
          const payload = JSON.parse(staleBody) as StocksApiResponse;
          const note =
            "Live data providers are rate-limited or unavailable; showing last successful snapshot.";
          return NextResponse.json(
            {
              ...payload,
              chartWarning: payload.chartWarning
                ? `${payload.chartWarning} ${note}`
                : note,
            },
            { headers: { "x-signaldesk-cache": "stale" } },
          );
        }
      } catch {
        /* ignore */
      }
    }

    return NextResponse.json({ error: message }, { status: 500 });
  }
}
