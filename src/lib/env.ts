function envFlagEnabled(raw: string | undefined, fallback = true): boolean {
  if (!raw) return fallback;
  const normalized = raw.trim().toLowerCase();
  return (
    normalized !== "0" &&
    normalized !== "false" &&
    normalized !== "off" &&
    normalized !== "no"
  );
}

export const env = {
  finnhubKey(): string {
    return (
      process.env.FINNHUB_KEY?.trim() ||
      process.env.FINNHUB_API_KEY?.trim() ||
      ""
    );
  },
  twelveDataKey(): string {
    return (
      process.env.TWELVE_DATA_KEY?.trim() ||
      process.env.TWELVEDATA_KEY?.trim() ||
      ""
    );
  },
  groqApiKey(): string {
    return process.env.GROQ_API_KEY?.trim() ?? "";
  },
  topOpportunitiesEnabled(): boolean {
    return envFlagEnabled(
      process.env.TOP_OPPORTUNITIES_ENABLED?.trim() ||
        process.env.NEXT_PUBLIC_TOP_OPPORTUNITIES_ENABLED?.trim(),
      true,
    );
  },
  /** Seconds for hot `/api/stocks` cache in Redis (default 15m). */
  stocksCacheTtlSeconds(): number {
    const raw = process.env.STOCKS_CACHE_TTL_SECONDS?.trim();
    const n = raw ? Number(raw) : NaN;
    if (Number.isFinite(n) && n >= 60 && n <= 86400) return Math.floor(n);
    return 900;
  },
  /** Longer retention for stale fallback when live fetch fails (default 7d). */
  stocksStaleTtlSeconds(): number {
    const raw = process.env.STOCKS_STALE_TTL_SECONDS?.trim();
    const n = raw ? Number(raw) : NaN;
    if (Number.isFinite(n) && n >= 3600 && n <= 2592000) return Math.floor(n);
    return 604800;
  },
  /** TTL for cron-written top-opportunities blobs (default 48h). */
  topOpportunitiesCacheTtlSeconds(): number {
    const raw = process.env.TOP_OPPORTUNITIES_CACHE_TTL_SECONDS?.trim();
    const n = raw ? Number(raw) : NaN;
    if (Number.isFinite(n) && n >= 300 && n <= 604800) return Math.floor(n);
    return 172800;
  },
  cronSecret(): string {
    return process.env.CRON_SECRET?.trim() ?? "";
  },
};
