import { Redis } from "@upstash/redis";

let cached: Redis | null | undefined;

/**
 * Upstash Redis (REST). Set UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN on Vercel.
 * Returns null when unset so local dev works without Redis.
 */
export function getRedis(): Redis | null {
  if (cached !== undefined) return cached;
  const url = process.env.UPSTASH_REDIS_REST_URL?.trim();
  const token = process.env.UPSTASH_REDIS_REST_TOKEN?.trim();
  if (!url || !token) {
    cached = null;
    return null;
  }
  cached = new Redis({ url, token });
  return cached;
}
