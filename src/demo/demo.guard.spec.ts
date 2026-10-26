import type { ExecutionContext } from "@nestjs/common";
import { describe, expect, it } from "vitest";
import type { DemoRole } from "../generated/prisma/enums.js";
import { DemoGuard } from "./demo.guard.js";

const ctx = (demo: DemoRole | null, method: string, path: string, sessionId = "s1") =>
  ({ switchToHttp: () => ({ getRequest: () => ({ method, path: `/api/v1${path}`, auth: demo === undefined ? undefined : { demo, sessionId } }) }) }) as unknown as ExecutionContext;
const code = (fn: () => unknown) => {
  try {
    fn();
    return "allowed";
  } catch (e) {
    return (e as { getResponse: () => { code: string } }).getResponse().code;
  }
};

describe("DemoGuard", () => {
  const guard = new DemoGuard();

  it("does nothing for ordinary sessions and anonymous requests", () => {
    expect(guard.canActivate(ctx(null, "POST", "/admin/settings/x"))).toBe(true);
    expect(guard.canActivate({ switchToHttp: () => ({ getRequest: () => ({ method: "POST", path: "/api/v1/x" }) }) } as unknown as ExecutionContext)).toBe(true);
  });

  it("makes the demo administrator read-only on every path and every state-changing method", () => {
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      for (const path of ["/admin/users/1/suspension", "/bookings", "/payments/x/refunds", "/anything/at/all"]) {
        expect(code(() => guard.canActivate(ctx("ADMIN", method, path))), `${method} ${path}`).toBe("DEMO_READ_ONLY");
      }
    }
    for (const method of ["GET", "HEAD", "OPTIONS"]) expect(guard.canActivate(ctx("ADMIN", method, "/admin/users"))).toBe(true);
  });

  it("closes the AI model and document uploads to every demo role", () => {
    for (const role of ["CUSTOMER", "WORKER"] as const) {
      expect(code(() => guard.canActivate(ctx(role, "POST", "/ai/chat")))).toBe("DEMO_RESTRICTED");
      expect(code(() => guard.canActivate(ctx(role, "PUT", "/me/worker-profile/documents/NID_FRONT")))).toBe("DEMO_RESTRICTED");
    }
  });

  it("keeps the demo customer from becoming a worker and the shared worker profile from being taken offline", () => {
    expect(code(() => guard.canActivate(ctx("CUSTOMER", "PUT", "/me/worker-profile")))).toBe("DEMO_RESTRICTED");
    expect(guard.canActivate(ctx("CUSTOMER", "GET", "/me/worker-profile"))).toBe(true);
    expect(code(() => guard.canActivate(ctx("WORKER", "POST", "/me/worker-profile/unpublish")))).toBe("DEMO_RESTRICTED");
    expect(guard.canActivate(ctx("WORKER", "PUT", "/me/worker-profile"))).toBe(true);
  });

  it("budgets writes per session and never limits reads", () => {
    const g = new DemoGuard();
    for (let i = 0; i < 60; i++) expect(g.canActivate(ctx("CUSTOMER", "POST", "/notifications/read-all", "budget"))).toBe(true);
    expect(code(() => g.canActivate(ctx("CUSTOMER", "POST", "/notifications/read-all", "budget")))).toBe("DEMO_RATE_LIMITED");
    expect(g.canActivate(ctx("CUSTOMER", "GET", "/me", "budget"))).toBe(true);
    expect(g.canActivate(ctx("CUSTOMER", "POST", "/notifications/read-all", "another-session"))).toBe(true);
  });
});
