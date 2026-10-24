import { type ArgumentsHost, Catch, HttpException, type ExceptionFilter, HttpStatus } from "@nestjs/common";
import type { Response } from "express";
import { currentRequestId } from "./request-context.js";

/**
 * Unexpected (non-HTTP) errors: log a SAFE summary server-side and return a
 * generic 500 with the request id so support can find the log line.
 *
 * Logged: the error class, Prisma/Node error code, and up to 5 stack frames
 * (file:line only). Never logged or returned: the error MESSAGE (database errors
 * can embed query parameters), request data, or the full stack.
 * HttpExceptions (validation, 4xx business errors) keep Nest's normal handling.
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost) {
    const res = host.switchToHttp().getResponse<Response>();
    if (exception instanceof HttpException) {
      // Same body Nest's default filter produces for HTTP exceptions.
      const body = exception.getResponse();
      if (!res.headersSent) res.status(exception.getStatus()).json(typeof body === "object" ? body : { statusCode: exception.getStatus(), message: body });
      return;
    }
    const requestId = currentRequestId();
    const error = exception as { name?: string; code?: unknown; stack?: string; status?: unknown; statusCode?: unknown } | undefined;

    // Client errors raised outside Nest's own exceptions (body-parser: 413 too large, 400 malformed JSON, ...)
    // keep their 4xx status. The text is fixed: the library's message can quote the offending input.
    const status = [error?.statusCode, error?.status].find((value): value is number => typeof value === "number");
    if (status !== undefined && status >= 400 && status < 500) {
      const reason = status === 413 ? "Payload Too Large" : (HttpStatus[status] ?? "Bad Request").toString().replaceAll("_", " ");
      if (!res.headersSent) res.status(status).json({ statusCode: status, error: reason, message: status === 413 ? "Request body too large" : "Bad request" });
      return;
    }
    const frames = (error?.stack ?? "")
      .split("\n")
      .filter((line) => line.trimStart().startsWith("at "))
      .slice(0, 5)
      .map((line) => line.replace(/^\s*at\s+/, "").replace(/\(?file:\/\/\/[^)]*?([^/\\)]+:\d+):\d+\)?/, "$1"));
    process.stderr.write(
      `${JSON.stringify({ event: "unhandled_error", requestId, name: error?.name ?? "Error", code: typeof error?.code === "string" ? error.code : undefined, frames })}\n`,
    );
    if (res.headersSent) return;
    res.status(HttpStatus.INTERNAL_SERVER_ERROR).json({
      statusCode: 500,
      error: "Internal Server Error",
      message: "Internal server error",
      requestId,
    });
  }
}
