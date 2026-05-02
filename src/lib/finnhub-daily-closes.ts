/**
 * Finnhub stock candle API (daily resolution) for top bullish/bearish ranking.
 * https://finnhub.io/docs/api/stock-candles
 */

export async function fetchFinnhubDailyCloses(
  symbol: string,
  token: string,
  options?: { daysBack?: number },
): Promise<number[] | null> {
  const daysBack = options?.daysBack ?? 150;
  const now = Math.floor(Date.now() / 1000);
  const from = now - daysBack * 86400;
  const url = `https://finnhub.io/api/v1/stock/candle?symbol=${encodeURIComponent(
    symbol,
  )}&resolution=D&from=${from}&to=${now}&token=${encodeURIComponent(token)}`;

  let res: Response;
  try {
    res = await fetch(url);
  } catch {
    return null;
  }
  if (!res.ok) return null;

  const json = (await res.json()) as {
    s?: string;
    c?: number[];
    t?: number[];
  };

  if (json.s !== "ok" || !Array.isArray(json.c) || !Array.isArray(json.t)) {
    return null;
  }

  const pairs: { t: number; c: number }[] = [];
  for (let i = 0; i < json.t.length; i++) {
    const c = json.c[i];
    const t = json.t[i];
    if (
      typeof c === "number" &&
      Number.isFinite(c) &&
      c > 0 &&
      typeof t === "number"
    ) {
      pairs.push({ t, c });
    }
  }
  pairs.sort((a, b) => a.t - b.t);
  const closes = pairs.map((p) => p.c);
  return closes.length >= 35 ? closes : null;
}
