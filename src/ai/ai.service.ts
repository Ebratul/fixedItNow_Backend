import { HttpException, HttpStatus, Inject, Injectable, Logger } from "@nestjs/common";
import { createHash, randomUUID } from "node:crypto";
import { currentRequestId } from "../common/request-context.js";
import { ENV, type Env } from "../config/env.js";
import { WorkersService } from "../workers/workers.service.js";
import { AiClient, AiClientError } from "./ai-client.js";
import { AiRateLimiter } from "./ai-rate-limiter.js";
import { aiResponseSchema, type AiResponse, type ChatErrorCode, type ChatRequest } from "./ai.schemas.js";

const aiError = (status: HttpStatus, code: ChatErrorCode, message: string) =>
  new HttpException({ statusCode: status, error: HttpStatus[status], message, code }, status);

const CHANGED_MESSAGE = {
  en: "The matching professionals changed while I was checking. Please search again.",
  bn: "যাচাই করার সময় মিলে যাওয়া পেশাদারদের তালিকা বদলে গেছে। আবার খুঁজুন।",
} as const;

/**
 * Main-API side of the assistant.
 *
 *  1. The user is the authenticated session user (never a body field).
 *  2. A per-user limit protects the paid provider.
 *  3. The AI service's answer is validated against a strict schema.
 *  4. Every recommended worker is RE-READ from the database under the public
 *     visibility rule and the stated filters; unknown / ineligible ids are
 *     dropped, and all displayed facts come from that read, never from the AI.
 */
@Injectable()
export class AiService {
  private readonly log = new Logger("AiService");

  constructor(
    @Inject(ENV) private readonly env: Env,
    private readonly client: AiClient,
    private readonly workers: WorkersService,
    private readonly limiter: AiRateLimiter,
  ) {}

  status() {
    return { available: this.env.ai !== null };
  }

  async chat(userId: string, request: ChatRequest) {
    const ai = this.env.ai;
    if (!ai) throw aiError(HttpStatus.SERVICE_UNAVAILABLE, "AI_NOT_CONFIGURED", "The assistant is not available right now.");

    const wait = this.limiter.check(userId, ai.ratePerMinute);
    if (wait > 0) {
      throw new HttpException(
        { statusCode: 429, error: "Too Many Requests", message: "Too many assistant requests. Please wait a moment.", code: "AI_RATE_LIMITED", retryAfterSeconds: wait },
        429,
      );
    }

    // The same id the client received in X-Request-Id, so one request can be followed across services.
    const correlationId = currentRequestId() ?? randomUUID().replaceAll("-", "");
    const started = Date.now();
    const subject = createHash("sha256").update(userId).digest("hex");
    let raw: unknown;
    try {
      raw = await this.client.chat(request, { correlationId, subject });
    } catch (error) {
      const kind = error instanceof AiClientError ? error.kind : "unreachable";
      this.log.warn(`ai_chat failed correlationId=${correlationId} kind=${kind} ms=${Date.now() - started}`);
      if (kind === "timeout") throw aiError(HttpStatus.GATEWAY_TIMEOUT, "AI_TIMEOUT", "The assistant took too long to answer.");
      if (kind === "rate_limited") throw aiError(HttpStatus.TOO_MANY_REQUESTS, "AI_RATE_LIMITED", "Too many assistant requests. Please wait a moment.");
      throw aiError(HttpStatus.BAD_GATEWAY, "AI_UNAVAILABLE", "The assistant is unavailable right now.");
    }

    const parsed = aiResponseSchema.safeParse(raw);
    if (!parsed.success) {
      // Paths only: never the offending values.
      this.log.warn(`ai_chat invalid response correlationId=${correlationId} paths=${parsed.error.issues.map((i) => i.path.join(".")).slice(0, 5).join(",")}`);
      throw aiError(HttpStatus.BAD_GATEWAY, "AI_UNAVAILABLE", "The assistant is unavailable right now.");
    }
    const result = await this.ground(parsed.data);
    this.log.log(
      `ai_chat correlationId=${correlationId} kind=${result.kind} mode=${result.mode} references=${parsed.data.recommendations.length} grounded=${result.recommendations.length} ms=${Date.now() - started}`,
    );
    return result;
  }

  /** Replaces worker references with fresh, public, filter-checked database rows. */
  private async ground(response: AiResponse) {
    const { recommendations, ...rest } = response;
    const ids = [...new Set(recommendations.map((r) => r.workerId))].slice(0, 10);
    const intent = response.intent;
    const cards = await this.workers.findCardsByIds(ids, {
      category: intent.category ?? undefined,
      location: intent.location ?? undefined,
      maxPrice: intent.maxBudgetBdt ?? undefined,
      minExperience: intent.minExperienceYears ?? undefined,
    });
    const byId = new Map(cards.map((card) => [card.id, card]));
    const grounded = recommendations
      .filter((r) => byId.has(r.workerId))
      .sort((a, b) => a.rank - b.rank)
      .map((r) => ({ rank: r.rank, matchedOn: r.matchedOn, worker: byId.get(r.workerId)! }));

    const dropped = grounded.length < recommendations.length;
    if (response.kind === "results" && (dropped || grounded.length === 0)) {
      return {
        ...rest,
        kind: grounded.length === 0 ? ("no_results" as const) : rest.kind,
        message: CHANGED_MESSAGE[rest.language],
        total: grounded.length,
        recommendations: grounded,
      };
    }
    return { ...rest, recommendations: grounded };
  }
}
