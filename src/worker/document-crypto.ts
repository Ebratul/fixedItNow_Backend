import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

export const DOCUMENT_KINDS = ["NID_FRONT", "NID_BACK", "SELFIE_WITH_ID"] as const;
export type DocumentKindName = (typeof DOCUMENT_KINDS)[number];
export const MAX_DOCUMENT_BYTES = 3 * 1024 * 1024;
export const MIN_DOCUMENT_BYTES = 512;

export type Sealed = { iv: Buffer; authTag: Buffer; ciphertext: Buffer };

/**
 * AES-256-GCM. The additional authenticated data binds the ciphertext to its row (id, owner, kind),
 * so copying one document's bytes into another row (or another worker's) fails authentication.
 */
export function seal(key: Buffer, aad: string, plaintext: Buffer): Sealed {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(aad, "utf8"));
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return { iv, authTag: cipher.getAuthTag(), ciphertext };
}

export function open(key: Buffer, aad: string, sealed: Sealed): Buffer {
  const decipher = createDecipheriv("aes-256-gcm", key, sealed.iv);
  decipher.setAAD(Buffer.from(aad, "utf8"));
  decipher.setAuthTag(sealed.authTag);
  return Buffer.concat([decipher.update(sealed.ciphertext), decipher.final()]);
}

export const documentAad = (id: string, profileId: string, kind: string) => `${id}|${profileId}|${kind}`;
export const sha256Hex = (data: Buffer) => createHash("sha256").update(data).digest("hex");

export type ImageType = "image/jpeg" | "image/png" | "image/webp";

/** Identify an image by its magic bytes. The declared Content-Type is never trusted on its own. */
export function sniffImage(data: Buffer): ImageType | null {
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return "image/jpeg";
  if (data.length >= 8 && data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (data.length >= 12 && data.subarray(0, 4).toString("latin1") === "RIFF" && data.subarray(8, 12).toString("latin1") === "WEBP") return "image/webp";
  return null;
}
