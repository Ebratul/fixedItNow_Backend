import { describe, expect, it, vi } from "vitest";
import { loadEnv } from "../config/env.js";
import { MailService } from "./mail.service.js";

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
    await mail.send({ kind: "verify-email", to: "a@example.com", subject: "s", text: "link" });
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
});
