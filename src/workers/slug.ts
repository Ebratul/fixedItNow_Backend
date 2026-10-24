import { randomBytes } from "node:crypto";

export const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const MAX_SLUG_LENGTH = 60;

/** ASCII slug stem from a display name; falls back to "worker" (e.g. Bangla-only names). */
export function slugStem(name: string): string {
  const stem = name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/g, "");
  return stem || "worker";
}

/** Stable public identifier: readable stem + random suffix (not guessable/sequential). */
export function newSlug(name: string): string {
  return `${slugStem(name)}-${randomBytes(4).toString("hex")}`;
}

export function isValidSlug(value: string): boolean {
  return value.length <= MAX_SLUG_LENGTH && SLUG_PATTERN.test(value);
}
