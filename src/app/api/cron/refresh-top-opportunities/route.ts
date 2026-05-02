import { NextResponse } from "next/server";
import { env } from "@/lib/env";
import { getRedis } from "@/lib/redis";
import {
  computeTopBearishPayload,
  computeTopBullishPayload,
} from "@/lib/top-opportunities";

export const dynamic = "force-dynamic";

const REDIS_KEY_BULLISH = "sd:top:bullish:v1";
const REDIS_KEY_BEARISH = "sd:top:bearish:v1";

/**
 * Vercel Cron: configure in vercel.json. Secure with CRON_SECRET (Authorization: Bearer).
 */
export async function GET(req: Request) {
  const auth = req.headers.get("authorization");
  if (env.cronSecret()) {
    if (auth !== `Bearer ${env.cronSecret()}`) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
  } else if (process.env.NODE_ENV === "production") {
    return NextResponse.json(
      { error: "CRON_SECRET must be set in production" },
      { status: 500 },
    );
  }

  if (!env.topOpportunitiesEnabled()) {
    return NextResponse.json({
      ok: true,
      skipped: true,
      reason: "top_opportunities_disabled",
    });
  }

  const finnhubKey = env.finnhubKey();
  if (!finnhubKey) {
    return NextResponse.json({ error: "FINNHUB_KEY missing" }, { status: 500 });
  }

  const redis = getRedis();
  if (!redis) {
    return NextResponse.json(
      {
        error:
          "Redis not configured. Set UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN on Vercel.",
      },
      { status: 500 },
    );
  }

  const ttl = env.topOpportunitiesCacheTtlSeconds();
  const [bullish, bearish] = await Promise.all([
    computeTopBullishPayload(finnhubKey),
    computeTopBearishPayload(finnhubKey),
  ]);

  await Promise.all([
    redis.set(REDIS_KEY_BULLISH, JSON.stringify(bullish), { ex: ttl }),
    redis.set(REDIS_KEY_BEARISH, JSON.stringify(bearish), { ex: ttl }),
  ]);

  return NextResponse.json({
    ok: true,
    bullishGeneratedAt: bullish.generatedAt,
    bearishGeneratedAt: bearish.generatedAt,
    ttlSeconds: ttl,
  });
}
