import { Inject, Injectable, Logger } from "@nestjs/common";
import { createTransport, type Transporter } from "nodemailer";
import { ENV, type Env } from "../config/env.js";

export type MailMessage = {
  to: string;
  subject: string;
  text: string;
  /** Short label for logs. Never log the body: it contains one-time links. */
  kind: "verify-email" | "reset-password" | "account-notice";
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
 * never throws.
 */
@Injectable()
export class MailService {
  private readonly logger = new Logger(MailService.name);
  private readonly transporter?: Transporter;
  /** Test hook: messages captured when running with the console transport. */
  readonly outbox: MailMessage[] = [];

  constructor(@Inject(ENV) private readonly env: Env) {
    if (env.MAIL_TRANSPORT === "smtp") {
      this.transporter = createTransport({
        host: env.SMTP_HOST,
        port: env.SMTP_PORT,
        secure: env.SMTP_SECURE,
        auth: env.SMTP_USER ? { user: env.SMTP_USER, pass: env.SMTP_PASS } : undefined,
      });
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
