import { HttpException } from "@nestjs/common";

/**
 * Per-user creation cap measured from the database (rolling window). It backs
 * the per-IP throttler, which cannot tell users behind one address apart and is
 * disabled in tests. Counts include the user's soft-deleted items on purpose,
 * so deleting and re-posting does not reset the allowance.
 */
export function assertUnderCap(recent: number, cap: number, code: string, message: string): void {
  if (recent >= cap) {
    throw new HttpException({ statusCode: 429, error: "Too Many Requests", message, code }, 429);
  }
}

export const hoursAgo = (hours: number, now = new Date()) => new Date(now.getTime() - hours * 3_600_000);
