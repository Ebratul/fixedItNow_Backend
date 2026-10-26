import { Logger } from "@nestjs/common";
import { waitUntil } from "@vercel/functions";
import { describe, expect, it, vi } from "vitest";
import { loadEnv } from "../config/env.js";
import { MailService } from "./mail.service.js";

vi.mock("@vercel/functions", () => ({ waitUntil: vi.fn() }));

const env = (extra: Record<string, string> = {}) =>
  loadEnv({
    DATABASE_URL: "postgresql://u:p@localhost:5432/db",
    BETTER_AUTH_SECRET: "x".repeat(40),
    BETTER_AUTH_URL: "http://localhost:3000",
    FRONTEND_ORIGIN: "http://localhost:3000",
    NODE_ENV: "test",
    ...extra,
  });

describe("MailService", () => {
  it("captures messages with the console transport", async () => {
    const mail = new MailService(env());
    await mail.send({ kind: "verify-otp", to: "a@example.com", subject: "s", text: "code" });
    expect(mail.outbox).toHaveLength(1);
  });

  it("never throws when delivery fails and never logs the message body", async () => {
    const mail = new MailService(env({ MAIL_TRANSPORT: "smtp", SMTP_HOST: "127.0.0.1", SMTP_PORT: "1" }));
    const errors: string[] = [];
    vi.spyOn((mail as any).logger, "error").mockImplementation((...args: unknown[]) => void errors.push(String(args[0])));
    await expect(
      mail.send({ kind: "reset-password", to: "a@example.com", subject: "s", text: "SECRET-TOKEN-LINK" }),
    ).resolves.toBeUndefined();
    expect(errors).toHaveLength(1);
    expect(errors[0]).not.toContain("SECRET-TOKEN-LINK");
    expect(errors[0]).not.toContain("a@example.com");
  });

  it("hands a background send to waitUntil so a serverless function is not frozen before delivery", async () => {
    const mail = new MailService(env());
    mail.sendInBackground({ kind: "reset-password", to: "a@example.com", subject: "s", text: "t" });
    expect(waitUntil).toHaveBeenCalledTimes(1);
    const pending = vi.mocked(waitUntil).mock.calls[0]![0] as Promise<void>;
    await pending;
    expect(mail.outbox).toHaveLength(1);
  });

  it("warns (without values) when SMTP_USER and SMTP_PASS look swapped", () => {
    const warn = vi.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
    new MailService(
      env({ MAIL_TRANSPORT: "smtp", SMTP_HOST: "smtp.example.com", SMTP_USER: "abcdabcdabcdabcd", SMTP_PASS: "me@example.com" }),
    );
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]![0])).not.toContain("me@example.com");
    expect(String(warn.mock.calls[0]![0])).not.toContain("abcdabcdabcdabcd");
    warn.mockClear();
    new MailService(
      env({ MAIL_TRANSPORT: "smtp", SMTP_HOST: "smtp.example.com", SMTP_USER: "me@example.com", SMTP_PASS: "abcdabcdabcdabcd" }),
    );
    expect(warn).not.toHaveBeenCalled();
  });
});
