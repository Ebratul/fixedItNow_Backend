import {
  ConflictException,
  ForbiddenException,
  NotFoundException,
  UnprocessableEntityException,
} from "@nestjs/common";

/**
 * Domain errors carry a stable machine-readable `code` next to the message so
 * the UI can react without parsing text.
 *   404 not found / not a participant (indistinguishable on purpose)
 *   409 the resource is in the wrong state, or lost a race
 *   422 the request is well-formed but breaks a business rule
 */
export const conflict = (code: string, message: string) =>
  new ConflictException({ statusCode: 409, error: "Conflict", message, code });

export const unprocessable = (code: string, message: string) =>
  new UnprocessableEntityException({ statusCode: 422, error: "Unprocessable Entity", message, code });

export const forbidden = (code: string, message: string) =>
  new ForbiddenException({ statusCode: 403, error: "Forbidden", message, code });

export const bookingNotFound = () => new NotFoundException("Booking not found");

/** Postgres exclusion_violation (23P01) raised by `booking_no_overlap`. */
export function isExclusionViolation(error: unknown): boolean {
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (current && typeof current === "object" && !seen.has(current)) {
    seen.add(current);
    const e = current as { code?: string; message?: string; cause?: unknown; meta?: unknown };
    const text = `${e.code ?? ""} ${e.message ?? ""} ${JSON.stringify(e.meta ?? "")}`;
    if (text.includes("23P01") || text.includes("booking_no_overlap")) return true;
    current = e.cause;
  }
  return false;
}

/** Postgres unique_violation (23505) / Prisma P2002. */
export function isUniqueViolation(error: unknown): boolean {
  const e = error as { code?: string; message?: string } | undefined;
  return e?.code === "P2002" || (e?.message ?? "").includes("23505");
}
