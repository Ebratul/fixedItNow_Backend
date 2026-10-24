/**
 * Exact money handling for the provider boundary.
 *
 * The platform stores whole taka as integers (see docs/BOOKINGS.md). Providers
 * speak decimal strings ("500.00"). Binary floating point is never used: amounts
 * are compared as integer poisha (1 BDT = 100 poisha).
 */

/** 500 -> "500.00" */
export function formatDecimalBdt(amountBdt: number): string {
  if (!Number.isSafeInteger(amountBdt) || amountBdt < 0) throw new RangeError("Invalid amount");
  return `${amountBdt}.00`;
}

export const toPoisha = (amountBdt: number): number => amountBdt * 100;

/**
 * Parse a provider amount ("500", "500.0", "500.00", "500.0000", or the same as a
 * JSON number) into integer poisha. Returns null for anything that is not a
 * plain non-negative decimal with at most two significant fraction digits, so a
 * malformed or surprising value can never be mistaken for a match.
 */
export function parseDecimalToPoisha(value: unknown): number | null {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const text = typeof value === "number" ? (Number.isFinite(value) ? String(value) : "") : value.trim();
  const match = /^(\d{1,9})(?:\.(\d{1,6}))?$/.exec(text);
  if (!match) return null;
  const fraction = match[2] ?? "";
  if (/[1-9]/.test(fraction.slice(2))) return null; // sub-poisha precision is not a valid amount
  const poisha = Number(match[1]) * 100 + Number(fraction.padEnd(2, "0").slice(0, 2));
  return Number.isSafeInteger(poisha) ? poisha : null;
}
