import { Inject, Injectable } from "@nestjs/common";
import { ENV, type Env } from "../config/env.js";

export type AiCallContext = { correlationId: string; subject: string };

/** The AI service answered with an error, or something unusable. */
export class AiClientError extends Error {
  constructor(readonly kind: "timeout" | "unreachable" | "rate_limited" | "bad_status" | "bad_body", readonly status?: number) {
    super(`AI service call failed: ${kind}`);
  }
}

/**
 * The only code that talks to the Python AI service. Injectable so tests
 * replace it with a fake (no network). Errors carry no URL, header or body.
 */
@Injectable()
export class AiClient {
  constructor(@Inject(ENV) private readonly env: Env) {}

  async chat(body: unknown, ctx: AiCallContext): Promise<unknown> {
    const ai = this.env.ai;
    if (!ai) throw new AiClientError("unreachable");
    let response: Response;
    try {
      response = await fetch(`${ai.serviceUrl}/v1/chat`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
          Authorization: `Bearer ${ai.serviceToken}`,
          "X-Correlation-Id": ctx.correlationId,
          "X-Subject": ctx.subject,
        },
        body: JSON.stringify(body),
        redirect: "error",
        signal: AbortSignal.timeout(ai.timeoutMs),
      });
    } catch (error) {
      const name = (error as { name?: string } | undefined)?.name;
      throw new AiClientError(name === "TimeoutError" || name === "AbortError" ? "timeout" : "unreachable");
    }
    if (response.status === 429) throw new AiClientError("rate_limited", 429);
    let json: unknown;
    try {
      json = await response.json();
    } catch {
      throw new AiClientError(response.ok ? "bad_body" : "bad_status", response.status);
    }
    if (!response.ok) throw new AiClientError("bad_status", response.status);
    return json;
  }
}
