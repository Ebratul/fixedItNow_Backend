import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { documentAad, open, seal, sniffImage } from "./document-crypto.js";

describe("document encryption", () => {
  const key = randomBytes(32);
  const plain = Buffer.from("not really an image, but any bytes round-trip");

  it("round-trips and never stores the plaintext in the ciphertext", () => {
    const sealed = seal(key, "doc|profile|NID_FRONT", plain);
    expect(sealed.ciphertext.includes(plain)).toBe(false);
    expect(open(key, "doc|profile|NID_FRONT", sealed).equals(plain)).toBe(true);
  });

  it("uses a fresh IV for every document", () => {
    const a = seal(key, "x", plain);
    const b = seal(key, "x", plain);
    expect(a.iv.equals(b.iv)).toBe(false);
    expect(a.ciphertext.equals(b.ciphertext)).toBe(false);
  });

  it("fails when the ciphertext is moved to another row, tampered with, or opened with another key", () => {
    const sealed = seal(key, documentAad("d1", "p1", "NID_FRONT"), plain);
    expect(() => open(key, documentAad("d2", "p1", "NID_FRONT"), sealed)).toThrow();
    expect(() => open(key, documentAad("d1", "p2", "NID_FRONT"), sealed)).toThrow();
    expect(() => open(key, documentAad("d1", "p1", "NID_BACK"), sealed)).toThrow();
    expect(() => open(randomBytes(32), documentAad("d1", "p1", "NID_FRONT"), sealed)).toThrow();
    const flipped = Buffer.from(sealed.ciphertext);
    flipped[0] = flipped[0]! ^ 1;
    expect(() => open(key, documentAad("d1", "p1", "NID_FRONT"), { ...sealed, ciphertext: flipped })).toThrow();
  });
});

describe("sniffImage", () => {
  it("recognises JPEG, PNG and WebP by content", () => {
    expect(sniffImage(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0]))).toBe("image/jpeg");
    expect(sniffImage(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0]))).toBe("image/png");
    expect(sniffImage(Buffer.concat([Buffer.from("RIFF"), Buffer.from([1, 2, 3, 4]), Buffer.from("WEBPVP8 ")]))).toBe("image/webp");
  });
  it("rejects everything else, including active content", () => {
    expect(sniffImage(Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'></svg>"))).toBeNull();
    expect(sniffImage(Buffer.from("%PDF-1.7"))).toBeNull();
    expect(sniffImage(Buffer.from("GIF89a"))).toBeNull();
    expect(sniffImage(Buffer.alloc(0))).toBeNull();
  });
});
