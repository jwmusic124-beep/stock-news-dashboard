import { NextResponse } from "next/server";
import { env } from "@/lib/env";
import { getRedis } from "@/lib/redis";
import { computeTopBullishPayload } from "@/lib/top-opportunities";

export const dynamic = "force-dynamic";

const REDIS_KEY = "sd:top:bullish:v1";

export async function GET() {
  if (!env.topOpportunitiesEnabled()) {
    return NextResponse.json({
      generatedAt: new Date().toISOString(),
      ideas: [],
    });
  }

  const finnhubKey = env.finnhubKey();
  if (!finnhubKey) {
    return NextResponse.json(
      { error: "FINNHUB_KEY is required." },
      { status: 500 },
    );
  }

  const redis = getRedis();
  if (redis) {
    const raw = await redis.get(REDIS_KEY);
    if (typeof raw === "string" && raw.length > 0) {
      try {
        return NextResponse.json(JSON.parse(raw) as object);
      } catch {
        /* fall through */
      }
    }
    return NextResponse.json({
      generatedAt: new Date().toISOString(),
      ideas: [],
      cacheStatus: "miss",
      message:
        "No cached top list yet. After adding Upstash Redis on Vercel, run the cron job once (Vercel Cron hits /api/cron/refresh-top-opportunities) or invoke that URL with Authorization: Bearer CRON_SECRET.",
    });
  }

  try {
    const payload = await computeTopBullishPayload(finnhubKey);
    return NextResponse.json(payload);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
