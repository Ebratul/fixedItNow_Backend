import { Inject, Injectable, Logger } from "@nestjs/common";
import { waitUntil } from "@vercel/functions";
import { createTransport, type Transporter } from "nodemailer";
import { ENV, type Env } from "../config/env.js";

export type MailMessage = {
  to: string;
  subject: string;
  text: string;
  /** Short label for logs. Never log the body: it contains one-time links. */
  kind: "verify-otp" | "reset-password" | "account-notice";
};

/**
 * Sends transactional email.
 *
 * - `smtp`: production path (nodemailer). Not verified against a real provider
 *   in this repository's tests.
 * - `console`: development only. Prints the message INCLUDING one-time links so
 *   a developer can click them. Refused in production by env validation.
 *
 * Callers must NOT await `send` in request paths (timing side channel); it
 * never throws. Use `sendInBackground` there: on a serverless host (Vercel) the
 * function is frozen as soon as the response is written, so a bare un-awaited
 * `send` would silently never reach the SMTP server.
 */
@Injectable()
export class MailService {
  private readonly logger = new Logger(MailService.name);
  private readonly transporter?: Transporter;
  /** Test hook: messages captured when running with the console transport. */
  readonly outbox: MailMessage[] = [];

  constructor(@Inject(ENV) private readonly env: Env) {
    if (env.MAIL_TRANSPORT === "smtp") {
      // Misconfiguration that has bitten before (credentials pasted into each other's variable): say so at start-up
      // instead of at the first failed login. Names only, never values.
      if (env.SMTP_PASS?.includes("@") && !env.SMTP_USER?.includes("@")) {
        this.logger.warn("SMTP_USER does not look like an address but SMTP_PASS does: the two may be swapped");
      }
      this.transporter = createTransport({
        host: env.SMTP_HOST,
        port: env.SMTP_PORT,
        secure: env.SMTP_SECURE,
        auth: env.SMTP_USER ? { user: env.SMTP_USER, pass: env.SMTP_PASS } : undefined,
        // Bounded waits: a hung SMTP server must not accumulate pending promises.
        connectionTimeout: 10_000,
        greetingTimeout: 10_000,
        socketTimeout: 20_000,
      });
    }
  }

  /**
   * Fire-and-forget that survives serverless freezing: the response is not delayed (no timing side channel), and the
   * platform keeps the function alive until the send settles (`waitUntil`; a no-op outside Vercel).
   */
  sendInBackground(message: MailMessage): void {
    const pending = this.send(message);
    try {
      waitUntil(pending);
    } catch {
      // not on a platform that supports it: a long-running server finishes the promise on its own
    }
  }

  async send(message: MailMessage): Promise<void> {
    try {
      if (this.transporter) {
        await this.transporter.sendMail({
          from: this.env.EMAIL_FROM,
          to: message.to,
          subject: message.subject,
          text: message.text,
        });
        this.logger.log(`Sent ${message.kind} email`);
        return;
      }
      this.outbox.push(message);
      if (this.env.NODE_ENV === "development") {
        this.logger.warn(
          `[dev mail] ${message.kind} to ${message.to}\n${message.text}`,
        );
      }
    } catch (error) {
      // Do not include the message (it holds a token) or recipient in logs.
      this.logger.error(
        `Failed to send ${message.kind} email: ${error instanceof Error ? error.message : "unknown error"}`,
      );
    }
  }
}
