import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { runInRealm } from "../src/common/request-context.js";
import { DEMO_ADMIN_PERMISSIONS, DEMO_EMAIL_DOMAIN } from "../src/demo/demo.config.js";
import { at, bookableWorker, completedBooking, confirmedBooking, customer, type Person, type Worker } from "./booking-helpers.js";
import { allDemoOn, demoSession, seedDemoData, setDemoSwitches } from "./demo-helpers.js";
import { TEST_ENV } from "./fake-providers.js";
import { createTestApp, type TestApp } from "./helpers.js";

/**
 * THE DEMO REALM (docs/DEMO.md). Demo sessions and ordinary sessions live in separate data realms: neither can read or
 * change the other's records, whatever id or route is used. These tests fill BOTH realms with data, then try to cross
 * the line from each side, and prove the demo administrator is read-only and sees only fictional data.
 */
describe("demo realm isolation", () => {
  let t: TestApp;
  beforeAll(async () => { t = await createTestApp(TEST_ENV); });
  afterAll(() => t.close());

  type World = {
    realCustomer: Person; realWorker: Worker; realAdmin: Awaited<ReturnType<TestApp["newAdmin"]>>;
    realBooking: string; realPaidBooking: string; realReference: string; realTicket: string; realPost: string;
    demoIds: string[]; demoBooking: string; demoWorkerSlug: string; demoWorkerProfile: string; demoReference: string; demoTicket: string; demoPost: string;
    realIds: string[]; realEmails: string[];
  };
  let w: World;

  beforeEach(async () => {
    await t.resetData();
    await seedDemoData(t);
    await setDemoSwitches(t, allDemoOn);

    // ordinary world
    const realWorker = await bookableWorker(t, { displayName: "Rahim Real" });
    const realCustomer = await customer(t, "Real Customer");
    const realAdmin = await t.newAdmin();
    const realBooking = await confirmedBooking(t, realCustomer, realWorker, at(t, 5, 10));
    const realPaidBooking = await completedBooking(t, realCustomer, realWorker);
    t.clock.set("2026-11-01T06:00:00Z");
    const realReference = (await t.prisma.payment.findFirstOrThrow({ where: { bookingId: realPaidBooking } })).reference;
    const ticket = await realCustomer.agent.post(`${t.api}/support/tickets`).send({ category: "PAYMENT", subject: "Real ticket about my payment", body: "Please help me with my real payment." });
    const post = await realCustomer.agent.post(`${t.api}/community/posts`).send({ title: "A real community post", body: "Written by a real customer." });
    await realCustomer.agent.post(`${t.api}/bookings/${realBooking}/chat/messages`).send({ body: "Real private chat message", clientMessageId: "real-chat-0001" });

    // demo world (looked up with the unscoped client)
    const u = t.prisma.unscoped;
    const demoUsers = await u.user.findMany({ where: { isDemo: true }, select: { id: true } });
    const demoBooking = (await u.booking.findFirstOrThrow({ where: { idempotencyKey: "demo-seed-b3-confirmed" } })).id;
    const demoProfile = await u.workerProfile.findFirstOrThrow({ where: { user: { demoRole: "WORKER" } } });
    const demoPayment = await u.payment.findFirstOrThrow({ where: { customer: { isDemo: true } } });
    w = {
      realCustomer, realWorker, realAdmin, realBooking, realPaidBooking, realReference,
      realTicket: (ticket.body.ticket?.id ?? ticket.body.id) as string, realPost: (post.body.post?.id ?? post.body.id) as string,
      demoIds: [...demoUsers.map((x) => x.id), demoBooking, demoProfile.id, demoPayment.id, demoPayment.reference],
      demoBooking, demoWorkerSlug: demoProfile.slug!, demoWorkerProfile: demoProfile.id, demoReference: demoPayment.reference,
      demoTicket: (await u.supportTicket.findFirstOrThrow({ where: { requester: { isDemo: true } } })).id,
      demoPost: (await u.communityPost.findFirstOrThrow({ where: { author: { isDemo: true } } })).id,
      realIds: [realCustomer.userId, realWorker.userId, realAdmin.userId, realWorker.profileId, realBooking, realPaidBooking, realReference],
      realEmails: [realCustomer.email, realWorker.email, realAdmin.email],
    };
  });

  const json = (body: unknown) => JSON.stringify(body);
  const containsAny = (body: unknown, needles: string[]) => needles.filter((n) => json(body).includes(n));

  // ================================================================ ordinary users never meet the demo realm
  describe("ordinary visitors and users never see demo data", () => {
    it("the public directory, categories, profile, reviews and availability contain no demo professional", async () => {
      const list = await t.client().get(`${t.api}/workers?pageSize=30`);
      expect(list.status).toBe(200);
      expect(json(list.body)).toContain("Rahim Real");
      expect(json(list.body)).not.toMatch(/Demo|demo-worker|-demo/);
      for (const slug of [w.demoWorkerSlug, "karim-hossain-demo", "mitu-akter-demo"]) {
        expect((await t.client().get(`${t.api}/workers/${slug}`)).status, slug).toBe(404);
        expect((await t.client().get(`${t.api}/workers/${slug}/reviews`)).status, slug).toBe(404);
        expect((await t.client().get(`${t.api}/workers/${slug}/availability`)).status, slug).toBe(404);
      }
      const categories = (await t.client().get(`${t.api}/categories`)).body.categories as { slug: string; workerCount: number }[];
      expect(categories.find((c) => c.slug === "electrical")!.workerCount).toBe(1); // the one real electrician only
      expect(categories.find((c) => c.slug === "plumbing")!.workerCount).toBe(0);
      expect(categories.find((c) => c.slug === "home-cleaning")!.workerCount).toBe(0);
      expect(categories.some((c) => json(c).includes("Demo"))).toBe(false);
    });

    it("a signed-in real customer cannot see, book, message, pay or favourite anything of the demo realm", async () => {
      const c = w.realCustomer;
      expect((await c.agent.get(`${t.api}/workers/${w.demoWorkerSlug}`)).status).toBe(404);
      const booked = await c.agent.post(`${t.api}/bookings`).send({ workerId: w.demoWorkerProfile, categorySlug: "electrical", description: "Please fix the fan", serviceArea: "Dhaka", serviceAddress: "House 1", startAt: at(t, 4, 10).toISOString(), durationMinutes: 60 });
      expect(booked.status).toBe(422);
      expect(booked.body.code).toBe("WORKER_UNAVAILABLE");
      expect((await c.agent.get(`${t.api}/bookings/${w.demoBooking}`)).status).toBe(404);
      expect((await c.agent.get(`${t.api}/bookings/${w.demoBooking}/chat`)).status).toBe(404);
      expect((await c.agent.post(`${t.api}/bookings/${w.demoBooking}/chat/messages`).send({ body: "hi", clientMessageId: "intruder-0001" })).status).toBe(404);
      expect((await c.agent.get(`${t.api}/payments/${w.demoReference}`)).status).toBe(404);
      expect((await c.agent.post(`${t.api}/payments/${w.demoReference}/demo-outcome`).send({ outcome: "success" })).status).toBe(404);
      expect((await c.agent.put(`${t.api}/me/favorites/${w.demoWorkerProfile}`).send({})).status).toBe(404);
      expect((await c.agent.get(`${t.api}/support/tickets/${w.demoTicket}`)).status).toBe(404);
      expect((await c.agent.get(`${t.api}/community/posts/${w.demoPost}`)).status).toBe(404);
      const feed = await c.agent.get(`${t.api}/community/posts?pageSize=30`);
      expect(json(feed.body)).toContain("A real community post");
      expect(json(feed.body)).not.toContain("Tips for describing an electrical fault");
      expect(containsAny((await c.agent.get(`${t.api}/bookings?role=customer&pageSize=30`)).body, w.demoIds)).toEqual([]);
      expect(containsAny((await c.agent.get(`${t.api}/notifications`)).body, w.demoIds)).toEqual([]);
    });

    it("a real professional cannot act on a demo booking either", async () => {
      for (const action of ["accept", "decline", "arrive", "start", "complete", "cancel"]) {
        expect((await w.realWorker.agent.post(`${t.api}/bookings/${w.demoBooking}/${action}`).send({})).status, action).toBe(404);
      }
      expect(containsAny((await w.realWorker.agent.get(`${t.api}/bookings?role=worker&pageSize=30`)).body, w.demoIds)).toEqual([]);
    });

    it("an administrator never sees a demo record in any list, count or report", async () => {
      const admin = w.realAdmin.agent;
      const routes = [
        "/admin/dashboard?days=30", "/admin/users?pageSize=30", "/admin/workers?pageSize=30", "/admin/bookings?pageSize=30", "/admin/disputes?pageSize=30",
        "/admin/payments?pageSize=30", "/admin/refunds?pageSize=30", "/admin/support/tickets?pageSize=30", "/admin/moderation/overview",
        "/admin/reports?pageSize=30", "/admin/proposals?pageSize=30", "/admin/content/posts", "/admin/content/comments", "/admin/content/reviews",
        "/admin/audit?pageSize=30", "/admin/finance/summary?from=2026-10-01&to=2026-12-31", "/admin/finance/commission?from=2026-10-01&to=2026-12-31", "/admin/roles", "/admin/support/assignees",
      ];
      for (const route of routes) {
        const res = await admin.get(`${t.api}${route}`);
        expect([200, 400], `${route} -> ${res.status}`).toContain(res.status);
        expect(containsAny(res.body, [...w.demoIds, DEMO_EMAIL_DOMAIN]), route).toEqual([]);
      }
      // aggregate numbers count real records only
      const dash = (await admin.get(`${t.api}/admin/dashboard?days=30`)).body;
      const realUsers = await t.prisma.user.count();
      expect(dash.users.total).toBe(realUsers);
      expect(dash.users.total).toBe(4); // customer, worker, admin... and nobody from the demo
      const finance = (await admin.get(`${t.api}/admin/finance/summary?from=2026-10-01&to=2026-12-31`)).body;
      expect(finance.totals.collectedBdt).toBe(500); // the one real, paid booking: demo payments never count as revenue
    });

    it("an administrator cannot reach a demo record by id, nor suspend, promote or refund anything in the demo realm", async () => {
      const admin = w.realAdmin.agent;
      const demoUser = (await t.prisma.unscoped.user.findFirstOrThrow({ where: { demoRole: "CUSTOMER" } })).id;
      const demoAdminUser = (await t.prisma.unscoped.user.findFirstOrThrow({ where: { demoRole: "ADMIN" } })).id;
      expect((await admin.get(`${t.api}/admin/users/${demoUser}`)).status).toBe(404);
      expect((await admin.post(`${t.api}/admin/users/${demoUser}/suspension`).send({ suspended: true, reason: "test reason", confirm: true })).status).toBe(404);
      expect((await admin.post(`${t.api}/admin/users/${demoAdminUser}/suspension`).send({ suspended: true, reason: "test reason", confirm: true })).status).toBe(404);
      expect((await admin.get(`${t.api}/admin/workers/${w.demoWorkerProfile}`)).status).toBe(404);
      expect((await admin.get(`${t.api}/admin/bookings/${w.demoBooking}`)).status).toBe(404);
      expect((await admin.get(`${t.api}/admin/payments/${w.demoReference}`)).status).toBe(404);
      expect((await admin.post(`${t.api}/admin/payments/${w.demoReference}/reconcile`).send({})).status).toBe(404);
      expect((await admin.post(`${t.api}/admin/payments/${w.demoReference}/refunds`).send({ reason: "Admin refunds a demo payment", confirm: true })).status).toBe(404);
      const roles = (await admin.get(`${t.api}/admin/roles`)).body.roles as { id: string; key: string }[];
      const demoRole = roles.find((r) => r.key === "demo_admin")!;
      // the demo administrator's role cannot be handed to an ordinary account through the API
      const grant = await admin.post(`${t.api}/admin/users/${w.realCustomer.userId}/admin-access`).send({ roleId: demoRole.id, reason: "give the demo role", confirm: true });
      expect(grant.status).toBe(403);
      expect(grant.body.code).toBe("DEMO_ROLE");
      expect((await t.prisma.user.findUniqueOrThrow({ where: { id: w.realCustomer.userId } })).role).toBe("USER");
    });
  });

  // ================================================================ demo sessions never meet the real realm
  describe("demo sessions never see real data", () => {
    it("the demo customer browses the demo professionals only", async () => {
      const s = await demoSession(t, "customer");
      const list = await s.agent.get(`${t.api}/workers?pageSize=30`);
      expect(list.status).toBe(200);
      expect(json(list.body)).toContain("Karim Hossain (Demo)");
      expect(json(list.body)).not.toContain("Rahim Real");
      expect(list.body.total).toBe(6); // the demo worker and five fictional professionals (the applicant is not published)
      expect((await s.agent.get(`${t.api}/workers/${w.demoWorkerSlug}`)).status).toBe(200);
      expect((await s.agent.get(`${t.api}/workers/${w.realWorker.slug}`)).status).toBe(404);
      expect((await s.agent.get(`${t.api}/workers/${w.realWorker.slug}/reviews`)).status).toBe(404);
      expect((await s.agent.get(`${t.api}/workers/${w.realWorker.slug}/availability`)).status).toBe(404);
      const categories = (await s.agent.get(`${t.api}/categories`)).body.categories as { slug: string; workerCount: number }[];
      expect(categories.find((c) => c.slug === "electrical")!.workerCount).toBe(2); // demo worker + Karim (real Rahim is not counted)
      expect(categories.find((c) => c.slug === "plumbing")!.workerCount).toBe(1);
    });

    it("the demo customer cannot book, read, message, pay, favourite or report anything real", async () => {
      const s = await demoSession(t, "customer");
      const booked = await s.agent.post(`${t.api}/bookings`).send({ workerId: w.realWorker.profileId, categorySlug: "electrical", description: "Please fix the fan", serviceArea: "Dhaka", serviceAddress: "House 1", startAt: at(t, 4, 10).toISOString(), durationMinutes: 60 });
      expect(booked.status).toBe(422);
      expect(booked.body.code).toBe("WORKER_UNAVAILABLE");
      for (const [method, path, body] of [
        ["get", `/bookings/${w.realBooking}`, undefined],
        ["get", `/bookings/${w.realBooking}/chat`, undefined],
        ["post", `/bookings/${w.realBooking}/chat/messages`, { body: "hi", clientMessageId: "intruder-0002" }],
        ["post", `/bookings/${w.realBooking}/cancel`, {}],
        ["post", `/bookings/${w.realPaidBooking}/payments`, { provider: "DEMO" }],
        ["get", `/payments/${w.realReference}`, undefined],
        ["post", `/payments/${w.realReference}/demo-outcome`, { outcome: "success" }],
        ["post", `/payments/${w.realReference}/refunds`, { reason: "A demo user asks for a real refund" }],
        ["put", `/me/favorites/${w.realWorker.profileId}`, {}],
        ["get", `/support/tickets/${w.realTicket}`, undefined],
        ["get", `/community/posts/${w.realPost}`, undefined],
        ["post", `/bookings/${w.realPaidBooking}/review`, { rating: 1, comment: "A demo user reviews a real booking" }],
      ] as const) {
        const res = await (s.agent as never as Record<string, (u: string) => { send: (b?: object) => Promise<{ status: number }> }>)[method](`${t.api}${path}`).send(body);
        expect(res.status, `${method} ${path}`).toBe(404);
      }
      const feed = await s.agent.get(`${t.api}/community/posts?pageSize=30`);
      expect(json(feed.body)).toContain("Tips for describing an electrical fault");
      expect(json(feed.body)).not.toContain("A real community post");
      for (const path of ["/bookings?role=customer&pageSize=30", "/payments", "/notifications", "/support/tickets", "/me"]) {
        const res = await s.agent.get(`${t.api}${path}`);
        expect(containsAny(res.body, [...w.realIds, ...w.realEmails]), path).toEqual([]);
      }
      expect(await t.prisma.booking.count({ where: { customerId: w.realCustomer.userId } })).toBe(2); // untouched
    });

    it("the demo worker only reaches bookings assigned to the demo worker, and nothing real", async () => {
      const s = await demoSession(t, "worker");
      const mine = await s.agent.get(`${t.api}/bookings?role=worker&group=all&pageSize=30`);
      expect(mine.status).toBe(200);
      expect(mine.body.total).toBe(7); // b1..b7: the other fictional professionals' jobs (c1-c4) are not theirs
      const other = await t.prisma.unscoped.booking.findFirstOrThrow({ where: { idempotencyKey: "demo-seed-c1-completed" } });
      expect((await s.agent.get(`${t.api}/bookings/${other.id}`)).status).toBe(404); // another demo professional's customer record
      expect((await s.agent.post(`${t.api}/bookings/${other.id}/cancel`).send({})).status).toBe(404);
      for (const id of [w.realBooking, w.realPaidBooking]) {
        expect((await s.agent.get(`${t.api}/bookings/${id}`)).status).toBe(404);
        expect((await s.agent.post(`${t.api}/bookings/${id}/accept`).send({})).status).toBe(404);
      }
      expect(containsAny((await s.agent.get(`${t.api}/me`)).body, [...w.realIds, ...w.realEmails])).toEqual([]);
    });

    it("demo sessions cannot reach admin or worker-only endpoints", async () => {
      const customerSession = await demoSession(t, "customer");
      const workerSession = await demoSession(t, "worker");
      for (const s of [customerSession, workerSession]) {
        for (const path of ["/admin/users", "/admin/dashboard", "/admin/payments", "/admin/settings", "/admin/audit", "/admin/roles"]) {
          expect((await s.agent.get(`${t.api}${path}`)).status, path).toBe(403);
        }
      }
      expect((await customerSession.agent.get(`${t.api}/worker/workspace`)).status).toBe(403);
      expect((await workerSession.agent.get(`${t.api}/worker/workspace`)).status).toBe(200);
    });

    it("the AI model, identity-document uploads and becoming a worker are closed to demo sessions", async () => {
      const c = await demoSession(t, "customer");
      const wk = await demoSession(t, "worker");
      expect((await c.agent.post(`${t.api}/ai/chat`).send({ message: "find me a plumber" })).body.code).toBe("DEMO_RESTRICTED");
      expect((await wk.agent.post(`${t.api}/ai/chat`).send({ message: "find me a plumber" })).status).toBe(403);
      expect((await c.agent.put(`${t.api}/me/worker-profile/documents/NID_FRONT`).set("Content-Type", "image/png").send(Buffer.from([137, 80, 78, 71]))).body.code).toBe("DEMO_RESTRICTED");
      expect((await c.agent.put(`${t.api}/me/worker-profile`).send({ displayName: "Becoming a worker" })).body.code).toBe("DEMO_RESTRICTED");
      expect((await c.agent.post(`${t.api}/me/worker-profile/submit`).send({})).status).toBe(403);
      expect((await wk.agent.post(`${t.api}/me/worker-profile/unpublish`).send({})).body.code).toBe("DEMO_RESTRICTED");
      expect((await wk.agent.post(`${t.api}/me/worker-profile/submit`).send({})).body.code).toBe("DEMO_RESTRICTED");
    });
  });

  // ================================================================ the demo administrator
  describe("the demo administrator is read-only and sees fictional data only", () => {
    const routesOf = () => {
      type Layer = { route?: { path: string; methods: Record<string, boolean> } };
      const stack = (t.app.getHttpAdapter().getInstance() as { router: { stack: Layer[] } }).router.stack;
      return stack.flatMap((l) => (l.route ? Object.keys(l.route.methods).map((m) => ({ method: m.toUpperCase(), path: l.route!.path })) : []));
    };
    const fill = (path: string) => path.replace(/:[A-Za-z]+/g, "00000000-0000-7000-8000-000000000000");

    it("every state-changing request is refused, on every route of the API", async () => {
      const s = await demoSession(t, "admin");
      const offenders: string[] = [];
      let checked = 0;
      for (const { method, path } of routesOf()) {
        if (method === "GET" || method === "HEAD" || method === "OPTIONS" || path.includes("splat")) continue;
        checked += 1;
        const res = await (s.agent as never as Record<string, (u: string) => { send: (b?: object) => Promise<{ status: number; body: { code?: string } }> }>)[method.toLowerCase()]!(fill(path)).send({});
        if (res.status !== 403 || res.body.code !== "DEMO_READ_ONLY") offenders.push(`${method} ${path} -> ${res.status} ${res.body.code}`);
      }
      expect(checked).toBeGreaterThan(90);
      expect(offenders).toEqual([]);
    });

    it("named sensitive operations are refused and change nothing", async () => {
      const s = await demoSession(t, "admin");
      const a = s.agent;
      const victim = (await t.prisma.unscoped.user.findFirstOrThrow({ where: { demoRole: "CUSTOMER" } })).id;
      const disputed = await t.prisma.unscoped.dispute.findFirstOrThrow();
      const refund = await t.prisma.unscoped.refund.findFirstOrThrow();
      const worker = await t.prisma.unscoped.workerProfile.findFirstOrThrow({ where: { verificationStatus: "PENDING" } });
      const attempts: [string, string, object][] = [
        ["post", `/admin/users/${victim}/suspension`, { suspended: true, reason: "demo admin suspends a user", confirm: true }],
        ["post", `/admin/users/${victim}/admin-access`, { roleId: null, reason: "demo admin changes admin access", confirm: true }],
        ["post", `/admin/workers/${worker.id}/verification`, { decision: "VERIFIED" }],
        ["post", `/admin/workers/${worker.id}/suspension`, { suspended: true, reason: "demo admin suspends a worker", confirm: true }],
        ["post", `/admin/payments/${w.demoReference}/refunds`, { reason: "Demo admin refunds a payment", confirm: true }],
        ["post", `/admin/refunds/${refund.id}/approve`, { confirm: true }],
        ["post", `/admin/refunds/${refund.id}/process`, { confirm: true }],
        ["post", `/admin/payments/${w.demoReference}/reconcile`, {}],
        ["post", `/admin/payments/reconcile-stale`, {}],
        ["post", `/admin/disputes/${disputed.id}/resolve`, { outcome: "MARK_COMPLETED", resolution: "demo admin resolves" }],
        ["put", `/admin/settings/demo.admin.enabled`, { value: true, reason: "demo admin enables itself" }],
        ["put", `/admin/settings/platform.maintenanceMode`, { value: true, reason: "demo admin turns on maintenance" }],
        ["put", `/admin/settings/platform.registrationsOpen`, { value: false, reason: "demo admin closes registration" }],
        ["post", `/admin/roles`, { key: "evil", name: "Evil", description: "all permissions", permissions: ["*"] }],
        ["post", `/admin/announcements`, { title: "Hello", body: "From the demo admin", audience: "ALL", severity: "INFO" }],
        ["post", `/admin/notifications`, { userId: victim, title: "Hello", body: "From the demo admin" }],
        ["post", `/admin/categories`, { name: "Evil category", slug: "evil", description: "x" }],
        ["post", `/admin/ai/sync`, {}],
      ];
      for (const [method, path, body] of attempts) {
        const res = await (a as never as Record<string, (u: string) => { send: (b?: object) => Promise<{ status: number; body: { code?: string } }> }>)[method]!(`${t.api}${path}`).send(body);
        expect([res.status, res.body.code], `${method} ${path}`).toEqual([403, "DEMO_READ_ONLY"]);
      }
      expect((await t.prisma.unscoped.user.findUniqueOrThrow({ where: { id: victim } })).suspendedAt).toBeNull();
      expect((await t.prisma.unscoped.workerProfile.findUniqueOrThrow({ where: { id: worker.id } })).verificationStatus).toBe("PENDING");
      expect((await t.prisma.unscoped.refund.findUniqueOrThrow({ where: { id: refund.id } })).status).toBe("REQUESTED");
      expect(await t.prisma.platformSetting.findUnique({ where: { key: "platform.maintenanceMode" } })).toBeNull();
      expect(await t.prisma.unscoped.auditLog.count({ where: { actor: { isDemo: true } } })).toBe(0);
    });

    it("cannot read the settings that guard the demo, the real roles, audit trail or environment status", async () => {
      const s = await demoSession(t, "admin");
      const settings = await s.agent.get(`${t.api}/admin/settings`);
      expect(settings.status).toBe(200);
      const keys = (settings.body.settings as { key: string }[]).map((x) => x.key);
      expect(keys.length).toBeGreaterThan(0);
      expect(keys.filter((k) => k.startsWith("demo."))).toEqual([]);
      for (const path of ["/admin/roles", "/admin/audit", "/admin/audit/verify", "/admin/audit/export", "/admin/ops/status", "/admin/categories", "/admin/ai/status", "/admin/ai/knowledge"]) {
        expect((await s.agent.get(`${t.api}${path}`)).status, path).toBe(403);
      }
      expect((await s.agent.get(`${t.api}/admin/workers/${w.demoWorkerProfile}/documents/NID_FRONT`)).status).toBe(403);
    });

    it("sees only demo data on every readable screen, and none of the real records", async () => {
      const s = await demoSession(t, "admin");
      const checked: string[] = [];
      for (const { method, path } of routesOf()) {
        if (method !== "GET" || !path.startsWith("/api/v1/admin/") || path.includes(":")) continue;
        const res = await s.agent.get(`${t.api}${path.replace("/api/v1", "")}`);
        expect([200, 400, 403], `${path} -> ${res.status}`).toContain(res.status);
        if (res.status === 200) {
          checked.push(path);
          expect(containsAny(res.body, [...w.realIds, ...w.realEmails, "Rahim Real", "Real Customer", "Real ticket", "A real community post"]), path).toEqual([]);
        }
      }
      expect(checked.length).toBeGreaterThan(8);
      const users = (await s.agent.get(`${t.api}/admin/users?pageSize=30`)).body;
      expect(users.total).toBe(11); // 3 identities + 2 fictional customers + 6 fictional professionals
      expect((users.users as { email: string }[]).every((u) => u.email.endsWith(`@${DEMO_EMAIL_DOMAIN}`))).toBe(true);
      const dash = (await s.agent.get(`${t.api}/admin/dashboard?days=30`)).body;
      expect(dash.users.total).toBe(11);
      expect(dash.bookings.total).toBe(11);
      expect(dash.finance.collectedBdt).toBeGreaterThan(0);
      expect(dash.finance.collectedBdt).not.toBe(500);
      expect(dash.recentActivity).toBeNull(); // no audit.read: the real administrators' trail is not shown
    });

    it("cannot reach a real record by id, even though the ids are valid", async () => {
      const s = await demoSession(t, "admin");
      for (const path of [
        `/admin/users/${w.realCustomer.userId}`, `/admin/users/${w.realAdmin.userId}`, `/admin/workers/${w.realWorker.profileId}`,
        `/admin/bookings/${w.realBooking}`, `/admin/payments/${w.realReference}`, `/admin/support/tickets/${w.realTicket}`,
      ]) {
        expect((await s.agent.get(`${t.api}${path}`)).status, path).toBe(404);
      }
    });

    it("keeps the read-only allow-list even if the role row is widened behind the application's back", async () => {
      const role = await t.prisma.adminRole.findUniqueOrThrow({ where: { key: "demo_admin" } });
      expect(role.isSystem).toBe(true);
      // The database already refuses to edit a system role...
      await expect(t.prisma.adminRole.update({ where: { id: role.id }, data: { permissions: ["*"] } })).rejects.toThrow(/system admin roles cannot be changed/);
      // ...and if that guard were bypassed, the application still intersects with its allow-list.
      await t.prisma.$executeRawUnsafe(`ALTER TABLE admin_role DISABLE TRIGGER admin_role_system_immutable`);
      try {
        await t.prisma.$executeRawUnsafe(`UPDATE admin_role SET permissions = ARRAY['*'] WHERE key = 'demo_admin'`);
        const s = await demoSession(t, "admin");
        expect([...(s.me.admin.permissions as string[])].sort((a, b) => a.localeCompare(b))).toEqual([...DEMO_ADMIN_PERMISSIONS].sort((a, b) => a.localeCompare(b)));
        expect((await s.agent.get(`${t.api}/admin/roles`)).status).toBe(403);
        expect((await s.agent.get(`${t.api}/admin/ops/status`)).status).toBe(403);
        expect((await s.agent.put(`${t.api}/admin/settings/demo.admin.enabled`).send({ value: true, reason: "escalate" })).body.code).toBe("DEMO_READ_ONLY");
      } finally {
        await t.prisma.$executeRawUnsafe(`UPDATE admin_role SET permissions = ARRAY['${DEMO_ADMIN_PERMISSIONS.join("','")}'] WHERE key = 'demo_admin'`);
        await t.prisma.$executeRawUnsafe(`ALTER TABLE admin_role ENABLE TRIGGER admin_role_system_immutable`);
      }
    });
  });

  // ================================================================ the database's own barrier
  describe("the database refuses to mix the realms, even for a script", () => {
    const u = () => t.prisma.unscoped;

    it("a booking cannot connect a demo account with an ordinary one", async () => {
      const demoCustomer = await u().user.findFirstOrThrow({ where: { demoRole: "CUSTOMER" } });
      const category = await u().serviceCategory.findFirstOrThrow({ where: { slug: "electrical" } });
      const base = { categoryId: category.id, description: "x", serviceArea: "Dhaka", serviceAddress: "y", startAt: new Date("2026-12-01T04:00:00Z"), endAt: new Date("2026-12-01T05:00:00Z"), durationMinutes: 60, pricingModel: "FIXED" as const, pricingSnapshot: {} };
      await expect(u().booking.create({ data: { ...base, customerId: demoCustomer.id, workerProfileId: w.realWorker.profileId } })).rejects.toThrow(/cannot connect a demo account/);
      await expect(u().booking.create({ data: { ...base, customerId: w.realCustomer.userId, workerProfileId: w.demoWorkerProfile } })).rejects.toThrow(/cannot connect a demo account/);
    });

    it("a simulated payment is only for demo customers, and demo customers never get a real provider", async () => {
      const real = await u().payment.findFirstOrThrow({ where: { reference: w.realReference } });
      await expect(u().payment.update({ where: { id: real.id }, data: { provider: "DEMO" } })).rejects.toThrow(/demo accounts only/);
      const demoPayment = await u().payment.findFirstOrThrow({ where: { reference: w.demoReference } });
      await expect(u().payment.update({ where: { id: demoPayment.id }, data: { provider: "BKASH" } })).rejects.toThrow(/demo accounts only/);
      await expect(u().payment.update({ where: { id: demoPayment.id }, data: { isLive: true } })).rejects.toThrow(/payment_demo_never_live/);
    });

    it("the realm of an account is permanent, and ordinary accounts cannot become (or be made) demo administrators", async () => {
      const demoCustomer = await u().user.findFirstOrThrow({ where: { demoRole: "CUSTOMER" } });
      await expect(u().user.update({ where: { id: demoCustomer.id }, data: { isDemo: false } })).rejects.toThrow(/cannot enter or leave the demo realm/);
      await expect(u().user.update({ where: { id: w.realCustomer.userId }, data: { isDemo: true } })).rejects.toThrow(/cannot enter or leave the demo realm/);
      await expect(u().user.update({ where: { id: w.realCustomer.userId }, data: { demoRole: "ADMIN" } })).rejects.toThrow(/demo realm|user_demo/);
      await expect(u().user.update({ where: { id: demoCustomer.id }, data: { role: "ADMIN" } })).rejects.toThrow(/only hold the demo_admin role/);
      const superAdmin = await u().adminRole.findUniqueOrThrow({ where: { key: "super_admin" } });
      const demoAdmin = await u().user.findFirstOrThrow({ where: { demoRole: "ADMIN" } });
      await expect(u().user.update({ where: { id: demoAdmin.id }, data: { adminRoleId: superAdmin.id } })).rejects.toThrow(/only hold the demo_admin role/);
      const demoRole = await u().adminRole.findUniqueOrThrow({ where: { key: "demo_admin" } });
      await expect(u().user.update({ where: { id: w.realAdmin.userId }, data: { adminRoleId: demoRole.id } })).rejects.toThrow(/only be held by the demo administrator/);
    });

    it("a request cannot create a demo account through the application's own data layer", async () => {
      await expect(t.prisma.user.create({ data: { id: "x1", name: "Sneaky", email: "sneaky@example.com", isDemo: true } })).rejects.toThrow(/cannot create a demo account/);
      await expect(t.prisma.user.create({ data: { id: "x2", name: "Sneaky", email: "sneaky2@example.com", demoRole: "ADMIN" } })).rejects.toThrow(/cannot create a demo account/);
      // inside a demo-realm request no account may be created at all
      await expect(runInRealm("demo", () => t.prisma.user.create({ data: { id: "x3", name: "Sneaky", email: "sneaky3@example.com" } }))).rejects.toThrow(/cannot create a demo account/);
      expect(await t.prisma.unscoped.user.count({ where: { email: { startsWith: "sneaky" } } })).toBe(0);
    });
  });
});
