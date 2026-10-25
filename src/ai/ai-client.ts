import { Inject, Injectable } from "@nestjs/common";
import { ENV, type Env } from "../config/env.js";

export type AiKnowledgeSummary = { source: "files" | "api"; configuredSource: "files" | "api"; documents: number; chunks: number; digest: string };

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

  /** Liveness of the AI service for operators (never for user requests). Null = unreachable or not configured. */
  async health(): Promise<{ status: string; llm: string } | null> {
    const ai = this.env.ai;
    if (!ai) return null;
    try {
      const response = await fetch(`${ai.serviceUrl}/health`, { redirect: "error", signal: AbortSignal.timeout(2_000) });
      if (!response.ok) return null;
      const json = (await response.json()) as { status?: unknown; llm?: unknown };
      return typeof json.status === "string" ? { status: json.status, llm: typeof json.llm === "string" ? json.llm : "unknown" } : null;
    } catch {
      return null;
    }
  }

  /** What the running AI index was built from (admin panel). Null = not configured or unreachable. */
  async knowledgeStatus(): Promise<AiKnowledgeSummary | null> {
    return this.knowledgeCall("GET", "/v1/knowledge");
  }

  /** Ask the AI service to rebuild its index from the configured source. Throws AiClientError on failure. */
  async reloadKnowledge(): Promise<AiKnowledgeSummary> {
    const result = await this.knowledgeCall("POST", "/v1/knowledge/reload", true);
    if (!result) throw new AiClientError("bad_body");
    return result;
  }

  private async knowledgeCall(method: "GET" | "POST", path: string, throwOnError = false): Promise<AiKnowledgeSummary | null> {
    const ai = this.env.ai;
    if (!ai) {
      if (throwOnError) throw new AiClientError("unreachable");
      return null;
    }
    try {
      const response = await fetch(`${ai.serviceUrl}${path}`, {
        method,
        headers: { Accept: "application/json", Authorization: `Bearer ${ai.serviceToken}` },
        redirect: "error",
        signal: AbortSignal.timeout(10_000),
      });
      const json = (await response.json().catch(() => null)) as Partial<AiKnowledgeSummary> | null;
      if (!response.ok) {
        if (throwOnError) throw new AiClientError("bad_status", response.status);
        return null;
      }
      if (!json || typeof json.digest !== "string" || typeof json.chunks !== "number") {
        if (throwOnError) throw new AiClientError("bad_body");
        return null;
      }
      return {
        source: json.source === "api" ? "api" : "files",
        configuredSource: json.configuredSource === "api" ? "api" : "files",
        documents: Number(json.documents ?? 0),
        chunks: json.chunks,
        digest: json.digest,
      };
    } catch (error) {
      if (error instanceof AiClientError) throw error;
      if (!throwOnError) return null;
      const name = (error as { name?: string } | undefined)?.name;
      throw new AiClientError(name === "TimeoutError" || name === "AbortError" ? "timeout" : "unreachable");
    }
  }

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
