import { createHash, createHmac, randomInt } from "node:crypto";

/**
 * Email verification codes (OTP). Policy lives here as named constants so it is
 * documented in one place (docs/AUTH.md) and covered by tests.
 */
export const OTP_LENGTH = 6;
/** A code is valid for 10 minutes. */
export const OTP_TTL_SECONDS = 600;
/** Wrong guesses allowed per code; the code is destroyed on the next wrong guess. */
export const OTP_MAX_ATTEMPTS = 5;
/** Minimum time between two codes sent to the same address (per ADDRESS, not per IP). */
export const OTP_RESEND_COOLDOWN_SECONDS = 60;
/** At most this many codes per address per rolling hour. */
export const OTP_MAX_SENDS_PER_HOUR = 5;

/** Uniformly random decimal code from the OS CSPRNG (`crypto.randomInt`, no modulo bias). */
export function generateOtp(): string {
  return randomInt(0, 10 ** OTP_LENGTH).toString().padStart(OTP_LENGTH, "0");
}

/**
 * Codes are stored as a keyed hash (HMAC-SHA-256 under a key derived from the
 * server secret), never in plain text. A bare hash of a 6-digit code could be
 * reversed instantly from a database copy; the keyed hash cannot without the secret.
 * The plugin compares hashes in constant time.
 */
export function makeOtpHasher(secret: string) {
  const key = createHmac("sha256", secret).update("fixeditnow:email-otp:v1").digest();
  return async (otp: string): Promise<string> => createHmac("sha256", key).update(otp).digest("hex");
}

export const normalizeEmail = (email: string) => email.trim().toLowerCase();

/** Identifier of the per-address send counter row (hashed: no email in the table). */
export const throttleIdentifier = (email: string) =>
  `otp-send:${createHash("sha256").update(normalizeEmail(email)).digest("hex")}`;

export type SendState = { count: number; lastSentMs: number };

export function parseSendState(value: string | undefined): SendState | null {
  if (!value) return null;
  const [count, last] = value.split(":").map(Number);
  return Number.isInteger(count) && Number.isFinite(last) ? { count: count!, lastSentMs: last! } : null;
}

export const formatSendState = (state: SendState) => `${state.count}:${state.lastSentMs}`;

/** May another code be sent to this address now? */
export function mayResend(state: SendState | null, nowMs: number): boolean {
  if (!state) return true;
  if (nowMs - state.lastSentMs < OTP_RESEND_COOLDOWN_SECONDS * 1000) return false;
  return state.count < OTP_MAX_SENDS_PER_HOUR;
}

export function nextSendState(state: SendState | null, nowMs: number): SendState {
  return { count: (state?.count ?? 0) + 1, lastSentMs: nowMs };
}
