import { z } from "zod";

/**
 * User-generated text is PLAIN TEXT everywhere (reviews, posts, comments,
 * proposals, reports): it is stored verbatim, returned as a JSON string, and
 * rendered by React as text. There is no Markdown/HTML, so nothing to sanitise
 * into markup; instead control characters and bidirectional-override characters
 * (used to spoof text direction) are rejected.
 */
// eslint-disable-next-line no-control-regex
export const FORBIDDEN_TEXT = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f‪-‮⁦-⁩﻿]/;

export function userText(min: number, max: number, label = "Text") {
  return z
    .string()
    .transform((value) => value.normalize("NFC").replace(/\r\n?/g, "\n").trim())
    .pipe(
      z
        .string()
        .min(min, min === 1 ? `${label} is required` : `${label} must be at least ${min} characters`)
        .max(max, `${label} must be ${max} characters or fewer`)
        .refine((value) => !FORBIDDEN_TEXT.test(value), `${label} contains unsupported characters`),
    );
}

/** Optional text: blank means "not provided". */
export function optionalUserText(max: number, label = "Text") {
  return z
    .string()
    .transform((value) => value.normalize("NFC").replace(/\r\n?/g, "\n").trim())
    .pipe(
      z
        .string()
        .max(max, `${label} must be ${max} characters or fewer`)
        .refine((value) => !FORBIDDEN_TEXT.test(value), `${label} contains unsupported characters`),
    )
    .transform((value) => (value === "" ? undefined : value))
    .optional();
}

/** Text that may be cleared: blank or null becomes null (used by PUT/PATCH edits). */
export function nullableUserText(max: number, label = "Text") {
  return z
    .union([
      z
        .string()
        .transform((value) => value.normalize("NFC").replace(/\r\n?/g, "\n").trim())
        .pipe(
          z
            .string()
            .max(max, `${label} must be ${max} characters or fewer`)
            .refine((value) => !FORBIDDEN_TEXT.test(value), `${label} contains unsupported characters`),
        )
        .transform((value) => (value === "" ? null : value)),
      z.null(),
    ])
    .optional();
}

/**
 * The public name shown next to user content: the customer display name if the
 * user set one, otherwise the first word of the account name. Never an email.
 */
export function publicName(user: { name: string; customerProfile?: { displayName: string } | null }): string {
  const chosen = user.customerProfile?.displayName?.trim();
  if (chosen) return chosen;
  const first = user.name.trim().split(/\s+/)[0];
  return first || "Member";
}

export const authorSelect = {
  name: true,
  customerProfile: { select: { displayName: true } },
} as const;

export function excerpt(text: string, max = 280): { text: string; truncated: boolean } {
  if (text.length <= max) return { text, truncated: false };
  let cut = text.slice(0, max);
  // Do not split a surrogate pair (emoji, some Bangla symbols).
  const last = cut.charCodeAt(cut.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) cut = cut.slice(0, -1);
  return { text: `${cut.trimEnd()}…`, truncated: true };
}
