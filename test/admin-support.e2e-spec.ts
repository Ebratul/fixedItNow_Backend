import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { bookableWorker, customer, type Person } from "./booking-helpers.js";
import { payableBooking } from "./payment-helpers.js";
import { createTestApp, type TestApp } from "./helpers.js";

describe("support tickets and complaints", () => {
  let t: TestApp;
  beforeAll(async () => { t = await createTestApp(); });
  afterAll(() => t.close());
  beforeEach(() => t.resetData());

  const open = (u: Person, body: object = {}) =>
    u.agent.post(`${t.api}/support/tickets`).send({ category: "GENERAL", subject: "I cannot update my profile", body: "The save button does nothing for me.", ...body });

  describe("requester side", () => {
    it("creates, lists, reads and replies to their own tickets only", async () => {
      const a = await customer(t, "Alice");
      const b = await customer(t, "Bob");
      const created = await open(a);
      expect(created.status).toBe(201);
      expect(created.body.ticket).toMatchObject({ status: "OPEN", category: "GENERAL", number: expect.any(Number) });
      expect(created.body.ticket).not.toHaveProperty("priority");
      const id = created.body.ticket.id as string;

      const mine = await a.agent.get(`${t.api}/support/tickets`);
      expect(mine.body.total).toBe(1);
      const detail = await a.agent.get(`${t.api}/support/tickets/${id}`);
      expect(detail.body.ticket.messages).toEqual([expect.objectContaining({ body: "The save button does nothing for me.", fromStaff: false })]);
      const reply = await a.agent.post(`${t.api}/support/tickets/${id}/messages`).send({ body: "Still happening on my phone." });
      expect(reply.status).toBe(201);
      expect(reply.body.ticket.messages).toHaveLength(2);

      // IDOR: another user sees nothing, and cannot reply or close
      expect((await b.agent.get(`${t.api}/support/tickets/${id}`)).status).toBe(404);
      expect((await b.agent.post(`${t.api}/support/tickets/${id}/messages`).send({ body: "hijack" })).status).toBe(404);
      expect((await b.agent.post(`${t.api}/support/tickets/${id}/close`).send({})).status).toBe(404);
      expect((await b.agent.get(`${t.api}/support/tickets`)).body.total).toBe(0);
      expect((await t.client().get(`${t.api}/support/tickets`)).status).toBe(401);
    });

    it("validates input, caps open tickets and refuses unknown fields", async () => {
      const a = await customer(t);
      for (const body of [{ subject: "ab" }, { body: "short" }, { category: "BILLING" }, { priority: "URGENT" }, { requesterId: "someone" }, { subject: "Bad\u0007one" }, { bookingId: "nope" }]) {
        expect((await open(a, body)).status, JSON.stringify(body)).toBe(400);
      }
      for (let i = 0; i < 5; i++) expect((await open(a, { subject: `Question number ${i}` })).status).toBe(201);
      const sixth = await open(a, { subject: "One more please" });
      expect(sixth.status).toBe(409);
      expect(sixth.body.code).toBe("TOO_MANY_OPEN_TICKETS");
      // parallel creation cannot beat the cap either
      const b = await customer(t);
      const results = await Promise.all(Array.from({ length: 8 }, (_, i) => open(b, { subject: `Parallel request ${i}` })));
      expect(results.filter((r) => r.status === 201)).toHaveLength(5);
    });

    it("complaints must name a booking the user took part in", async () => {
      const ctx = await payableBooking(t);
      const stranger = await customer(t);
      expect((await open(ctx.cust, { category: "WORKER_COMPLAINT" })).status).toBe(400); // no booking
      expect((await open(stranger, { category: "WORKER_COMPLAINT", bookingId: ctx.bookingId })).status).toBe(404);
      expect((await open(ctx.cust, { category: "WORKER_COMPLAINT", bookingId: ctx.bookingId })).status).toBe(201);
      expect((await open(ctx.worker, { category: "CUSTOMER_COMPLAINT", bookingId: ctx.bookingId })).status).toBe(201);
    });
  });

  describe("staff side", () => {
    it("works the queue: filters, assignment, public replies vs private notes, resolution", async () => {
      const agent = await t.newAdmin("support_agent");
      const u = await customer(t, "Alice");
      const id = (await open(u)).body.ticket.id as string;
      await open(u, { subject: "Different topic entirely", category: "PAYMENT" });

      const q = await agent.agent.get(`${t.api}/admin/support/tickets?status=OPEN`);
      expect(q.body).toMatchObject({ total: 2, statusCounts: { OPEN: 2 } });
      expect(q.body.tickets[0].requester).toEqual({ id: u.userId, name: "Alice" });
      expect(JSON.stringify(q.body)).not.toMatch(/@example\.com/);
      expect((await agent.agent.get(`${t.api}/admin/support/tickets?category=PAYMENT`)).body.total).toBe(1);
      expect((await agent.agent.get(`${t.api}/admin/support/tickets?assignee=unassigned`)).body.total).toBe(2);
      expect((await agent.agent.get(`${t.api}/admin/support/tickets?q=different`)).body.total).toBe(1);
      const number = q.body.tickets.find((x: { id: string }) => x.id === id).number;
      expect((await agent.agent.get(`${t.api}/admin/support/tickets?q=${number}`)).body.total).toBeGreaterThanOrEqual(1);

      // private note: invisible to the requester, no notification
      const note = await agent.agent.post(`${t.api}/admin/support/tickets/${id}/messages`).send({ body: "Looks like a caching problem.", internal: true });
      expect(note.status).toBe(201);
      expect((await u.agent.get(`${t.api}/support/tickets/${id}`)).body.ticket.messages).toHaveLength(1);
      expect(await t.prisma.notification.count({ where: { userId: u.userId } })).toBe(0);

      // public reply: requester sees it, is notified, status waits for them, ticket is auto-assigned
      const reply = await agent.agent.post(`${t.api}/admin/support/tickets/${id}/messages`).send({ body: "Please clear your cache and try again." });
      expect(reply.body.ticket).toMatchObject({ status: "WAITING_FOR_USER", assignee: { id: agent.userId } });
      const seen = (await u.agent.get(`${t.api}/support/tickets/${id}`)).body.ticket;
      expect(seen.messages.map((m: { fromStaff: boolean }) => m.fromStaff)).toEqual([false, true]);
      expect(JSON.stringify(seen)).not.toMatch(/caching problem/);
      const notes = await u.agent.get(`${t.api}/notifications`);
      expect(notes.body.notifications[0]).toMatchObject({ type: "support.reply", link: `/account/support/${id}`, readAt: null });

      // the requester's reply reopens it
      await u.agent.post(`${t.api}/support/tickets/${id}/messages`).send({ body: "That fixed it, thanks!" });
      expect((await agent.agent.get(`${t.api}/admin/support/tickets/${id}`)).body.ticket.status).toBe("OPEN");

      // resolve needs a resolution; closed is final
      const patch = (b: object) => agent.agent.patch(`${t.api}/admin/support/tickets/${id}`).send(b);
      expect((await patch({ status: "RESOLVED" })).body.code).toBe("RESOLUTION_REQUIRED");
      expect((await patch({ status: "RESOLVED", resolution: "Cache cleared; works now." })).body.ticket).toMatchObject({ status: "RESOLVED", resolution: "Cache cleared; works now." });
      expect((await u.agent.get(`${t.api}/support/tickets/${id}`)).body.ticket.resolution).toBe("Cache cleared; works now.");
      expect((await patch({ status: "RESOLVED", resolution: "again" })).body.code).toBe("NO_CHANGE");
      expect((await patch({ status: "CLOSED" })).status).toBe(200);
      expect((await patch({ status: "OPEN" })).body.code).toBe("INVALID_TRANSITION");
      expect((await agent.agent.post(`${t.api}/admin/support/tickets/${id}/messages`).send({ body: "late" })).body.code).toBe("TICKET_CLOSED");
      expect((await u.agent.post(`${t.api}/support/tickets/${id}/messages`).send({ body: "late" })).body.code).toBe("TICKET_CLOSED");

      const trail = (await t.prisma.auditLog.findMany({ where: { targetType: "SupportTicket", targetId: id }, orderBy: { seq: "asc" } })).map((r) => r.action);
      expect(trail).toEqual(["support.note", "support.reply", "support.update", "support.update"]);
      expect(JSON.stringify(await t.prisma.auditLog.findMany({ where: { targetId: id } }))).not.toMatch(/caching problem|clear your cache/); // message text is not copied into the audit log
    });

    it("validates assignees and priorities, and shows the booking context of complaints", async () => {
      const agent = await t.newAdmin("support_agent");
      const noSupport = await t.newAdmin("content_moderator");
      const ctx = await payableBooking(t);
      const id = (await open(ctx.cust, { category: "WORKER_COMPLAINT", bookingId: ctx.bookingId, subject: "Worker was late" })).body.ticket.id as string;
      const patch = (b: object) => agent.agent.patch(`${t.api}/admin/support/tickets/${id}`).send(b);
      expect((await patch({ assigneeId: noSupport.userId })).body.code).toBe("INVALID_ASSIGNEE");
      expect((await patch({ assigneeId: ctx.cust.userId })).body.code).toBe("INVALID_ASSIGNEE");
      expect((await patch({ priority: "SEVERE" })).status).toBe(400);
      expect((await patch({ assigneeId: agent.userId, priority: "HIGH" })).body.ticket).toMatchObject({ priority: "HIGH", assignee: { id: agent.userId } });
      expect((await patch({ assigneeId: null })).body.ticket.assignee).toBeNull();
      expect((await agent.agent.get(`${t.api}/admin/support/assignees`)).body.staff.map((s: { id: string }) => s.id)).toContain(agent.userId);
      const detail = await agent.agent.get(`${t.api}/admin/support/tickets/${id}`);
      expect(detail.body.ticket.booking).toMatchObject({ id: ctx.bookingId, status: "COMPLETION_PENDING", customer: { id: ctx.cust.userId }, worker: { id: expect.any(String) } });
    });

    it("separates reading from handling, and keeps staff away from their own tickets", async () => {
      const reader = await t.newAdminWith(["support.read"]);
      const handler = await t.newAdminWith(["support.read", "support.manage"]);
      const none = await t.newAdminWith(["users.read"]);
      const u = await customer(t);
      const id = (await open(u)).body.ticket.id as string;
      expect((await reader.agent.get(`${t.api}/admin/support/tickets/${id}`)).status).toBe(200);
      expect((await reader.agent.post(`${t.api}/admin/support/tickets/${id}/messages`).send({ body: "hello" })).status).toBe(403);
      expect((await reader.agent.patch(`${t.api}/admin/support/tickets/${id}`).send({ priority: "LOW" })).status).toBe(403);
      expect((await none.agent.get(`${t.api}/admin/support/tickets`)).status).toBe(403);
      // staff raising a ticket cannot answer it themselves
      const mine = (await handler.agent.post(`${t.api}/support/tickets`).send({ category: "GENERAL", subject: "Question from staff", body: "Staff user asking something." })).body.ticket.id as string;
      expect((await handler.agent.post(`${t.api}/admin/support/tickets/${mine}/messages`).send({ body: "self reply" })).body.code).toBe("OWN_TICKET");
      expect((await handler.agent.patch(`${t.api}/admin/support/tickets/${mine}`).send({ status: "RESOLVED", resolution: "me, myself" })).body.code).toBe("OWN_TICKET");
    });

    it("validates query strings and ids", async () => {
      const agent = await t.newAdmin("support_agent");
      for (const q of ["status=DONE", "priority=1", "category=X", "assignee=a b", "pageSize=999"]) expect((await agent.agent.get(`${t.api}/admin/support/tickets?${q}`)).status, q).toBe(400);
      expect((await agent.agent.get(`${t.api}/admin/support/tickets/nope`)).status).toBe(400);
      expect((await agent.agent.get(`${t.api}/admin/support/tickets/0192a000-0000-7000-8000-000000000000`)).status).toBe(404);
      expect(bookableWorker).toBeDefined();
    });
  });

  it("the requester can close their own ticket", async () => {
    const u = await customer(t);
    const id = (await open(u)).body.ticket.id as string;
    const closed = await u.agent.post(`${t.api}/support/tickets/${id}/close`).send({});
    expect(closed.body.ticket.status).toBe("CLOSED");
    expect((await u.agent.post(`${t.api}/support/tickets/${id}/close`).send({})).body.code).toBe("TICKET_CLOSED");
  });
});
