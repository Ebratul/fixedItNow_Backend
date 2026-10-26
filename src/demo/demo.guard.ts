import { type CanActivate, type ExecutionContext, ForbiddenException, HttpException, HttpStatus, Injectable } from "@nestjs/common";
import type { Request } from "express";
import type { DemoRole } from "../generated/prisma/enums.js";
import { DEMO_WRITE_LIMIT } from "./demo.config.js";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

type Rule = { roles: readonly DemoRole[]; methods?: readonly string[]; path: RegExp; code: string; message: string };

/**
 * Per-route limits for demo sessions, on top of the realm firewall. Everything a demo CUSTOMER or WORKER may do is allowed
 * unless it is listed here, because the firewall already keeps it inside the demo realm; this list holds what is unsafe
 * even inside it: calls that leave the system (the AI model), files that nobody reviews, and edits that would turn the
 * shared demo identity into something else.
 */
const RULES: readonly Rule[] = [
  { roles: ["CUSTOMER", "WORKER", "ADMIN"], path: /^\/ai(\/|$)/, code: "DEMO_RESTRICTED", message: "The AI assistant isn't available in the demo." },
  { roles: ["CUSTOMER", "WORKER", "ADMIN"], path: /^\/me\/worker-profile\/documents(\/|$)/, code: "DEMO_RESTRICTED", message: "Identity documents can't be uploaded in the demo." },
  { roles: ["CUSTOMER"], methods: ["PUT", "POST", "PATCH", "DELETE"], path: /^\/me\/worker-profile(\/|$)/, code: "DEMO_RESTRICTED", message: "The demo customer can't become a worker. Try the Demo Worker instead." },
  { roles: ["WORKER"], methods: ["POST"], path: /^\/me\/worker-profile\/(submit|unpublish)$/, code: "DEMO_RESTRICTED", message: "The shared demo worker profile can't be resubmitted or taken offline." },
];

const demoForbidden = (code: string, message: string) => new ForbiddenException({ statusCode: 403, error: "Forbidden", code, message });

/**
 * The backend's rules for demo sessions (docs/DEMO.md). Runs after authentication, for every route:
 *
 *   - the demo ADMINISTRATOR is read-only: any request that changes state is refused, wherever it is aimed, so no
 *     sensitive operation (suspending a user, deciding or processing a refund, changing roles, settings, the catalogue,
 *     announcements, the audit trail, ...) is reachable, whatever permission its route asks for;
 *   - the per-role limits in RULES;
 *   - a write budget per session, so a public identity cannot be used to hammer the shared demo data.
 *
 * It never relies on the web app: a banner or a disabled button is only a courtesy.
 */
@Injectable()
export class DemoGuard implements CanActivate {
  /** session id -> timestamps of recent writes. Per process: a best-effort brake, not an exact quota across instances. */
  private readonly writes = new Map<string, number[]>();

  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<Request>();
    const demo = req.auth?.demo;
    if (!demo) return true;

    const safe = SAFE_METHODS.has(req.method);
    if (demo === "ADMIN" && !safe) {
      throw demoForbidden("DEMO_READ_ONLY", "The demo administrator is read-only: changes are disabled in the demo.");
    }
    const path = req.path.replace(/^\/api\/v1/, "");
    const rule = RULES.find((r) => r.roles.includes(demo) && (!r.methods || r.methods.includes(req.method)) && r.path.test(path));
    if (rule) throw demoForbidden(rule.code, rule.message);

    if (!safe) this.spend(req.auth!.sessionId);
    return true;
  }

  private spend(sessionId: string) {
    const now = Date.now();
    const recent = (this.writes.get(sessionId) ?? []).filter((t) => now - t < DEMO_WRITE_LIMIT.windowMs);
    if (recent.length >= DEMO_WRITE_LIMIT.count) {
      this.writes.set(sessionId, recent);
      throw new HttpException(
        { statusCode: 429, error: "Too Many Requests", code: "DEMO_RATE_LIMITED", message: "You're making changes very quickly. Please slow down a little." },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    recent.push(now);
    this.writes.set(sessionId, recent);
    if (this.writes.size > 5000) this.prune(now); // bounded memory
  }

  private prune(now: number) {
    for (const [id, times] of this.writes) {
      if (times.every((t) => now - t >= DEMO_WRITE_LIMIT.windowMs)) this.writes.delete(id);
    }
  }
}
