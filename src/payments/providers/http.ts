import { Injectable } from "@nestjs/common";
import { PROVIDER_TIMEOUT_MS } from "../payment.config.js";

export type HttpRequest = {
  method: "GET" | "POST";
  /** Built from fixed, validated provider configuration; never from user input. */
  url: string;
  query?: Record<string, string>;
  headers?: Record<string, string>;
  json?: unknown;
  form?: Record<string, string>;
  timeoutMs?: number;
};

export type HttpResponse = {
  status: number;
  /** Parsed JSON, or undefined when the body was empty or not JSON. */
  body: unknown;
};

/** No response arrived (timeout, DNS, TLS, reset). The outcome at the provider is UNKNOWN. */
export class HttpUnreachableError extends Error {
  constructor(readonly reason: "timeout" | "network") {
    super(`Provider request failed: ${reason}`);
  }
}

/**
 * The only place that talks to payment providers over the network. It is an
 * injectable class so automated tests replace it with a deterministic fake:
 * ordinary tests never reach a real provider.
 *
 * Errors deliberately carry no URL, query string, header or body: the query
 * string of some provider calls contains credentials.
 */
@Injectable()
export class HttpClient {
  async request(req: HttpRequest): Promise<HttpResponse> {
    const url = new URL(req.url);
    for (const [key, value] of Object.entries(req.query ?? {})) url.searchParams.set(key, value);
    const headers: Record<string, string> = { Accept: "application/json", ...req.headers };
    let body: string | undefined;
    if (req.json !== undefined) {
      headers["Content-Type"] = "application/json";
      body = JSON.stringify(req.json);
    } else if (req.form) {
      headers["Content-Type"] = "application/x-www-form-urlencoded";
      body = new URLSearchParams(req.form).toString();
    }
    try {
      const response = await fetch(url, {
        method: req.method,
        headers,
        body,
        redirect: "error",
        signal: AbortSignal.timeout(req.timeoutMs ?? PROVIDER_TIMEOUT_MS),
      });
      const text = await response.text();
      let parsed: unknown;
      try {
        parsed = text ? JSON.parse(text) : undefined;
      } catch {
        parsed = undefined;
      }
      return { status: response.status, body: parsed };
    } catch (error) {
      const name = (error as { name?: string } | undefined)?.name;
      throw new HttpUnreachableError(name === "TimeoutError" || name === "AbortError" ? "timeout" : "network");
    }
  }
}
