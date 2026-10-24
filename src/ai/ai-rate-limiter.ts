import { Injectable } from "@nestjs/common";

/**
 * Per-user sliding window for the (paid) assistant. In-memory, so per process:
 * run a shared store (Redis) if the API is scaled out. The AI service has its
 * own limiter as a second layer.
 */
@Injectable()
export class AiRateLimiter {
  private readonly hits = new Map<string, number[]>();

  /** Returns 0 when allowed, otherwise the seconds until the next slot. */
  check(key: string, limit: number, now = Date.now(), windowMs = 60_000): number {
    const recent = (this.hits.get(key) ?? []).filter((t) => now - t < windowMs);
    if (recent.length >= limit) {
      this.hits.set(key, recent);
      return Math.max(1, Math.ceil((recent[0]! + windowMs - now) / 1000));
    }
    recent.push(now);
    this.hits.set(key, recent);
    if (this.hits.size > 10_000) {
      for (const [k, v] of this.hits) if (v.every((t) => now - t >= windowMs)) this.hits.delete(k);
    }
    return 0;
  }
}
