import request from "supertest";
import { bookableWorker, customer, payableBooking as workFinished, type Person, type Worker } from "./booking-helpers.js";
import type { TestApp } from "./helpers.js";

export type Provider = "BKASH";

/** A fixed-price booking (৳500) whose work the professional reported finished: payment is due (COMPLETION_PENDING). */
export async function payableBooking(t: TestApp, opts: { days?: number; hour?: number; worker?: Worker; cust?: Person } = {}) {
  const worker = opts.worker ?? (await bookableWorker(t));
  const cust = opts.cust ?? (await customer(t));
  const bookingId = await workFinished(t, cust, worker, {}, opts.days ?? 3, opts.hour ?? 10);
  return { worker, cust, bookingId };
}

let keyCounter = 0;
export const newKey = () => `test-key-${Date.now().toString(36)}-${keyCounter++}`;

export const startPayment = (t: TestApp, cust: Person, bookingId: string, provider: Provider, key: string | null = newKey(), body: object = {}) => {
  const req = cust.agent.post(`${t.api}/bookings/${bookingId}/payments`);
  if (key) req.set("Idempotency-Key", key);
  return req.send({ provider, ...body });
};

export const paymentStatus = (t: TestApp, cust: Person, reference: string) => cust.agent.get(`${t.api}/payments/${reference}`);

/** The callback requests come from provider pages / servers, with NO web-app Origin and no cookies. */
export const raw = (t: TestApp) => request(t.app.getHttpServer());

export const bkashCallback = (t: TestApp, reference: string, paymentId: string, status = "success") =>
  raw(t).get(`${t.api}/payments/callbacks/bkash/${reference}`).query({ paymentID: paymentId, status, signature: "not-verified" });

export const latestBkashId = (t: TestApp) => [...t.net.bkash.keys()].at(-1)!;

/** Seconds past the per-payment re-verification throttle. */
export const pastThrottle = (t: TestApp) => t.clock.advanceMinutes(1);

export async function events(t: TestApp, reference: string, type?: string) {
  const payment = await t.prisma.payment.findUniqueOrThrow({ where: { reference } });
  return t.prisma.paymentEvent.findMany({ where: { paymentId: payment.id, ...(type ? { type } : {}) }, orderBy: { createdAt: "asc" } });
}

/**
 * A paid-for booking can only be cancelled through a dispute now (payment is due after the work is finished, and
 * ordinary cancellation ends once a job starts): the customer reports a problem, an administrator reviews it and
 * resolves it by cancelling the booking. Returns the admin who resolved it.
 */
export async function cancelViaDispute(t: TestApp, cust: Person, bookingId: string) {
  const opened = await cust.agent.post(`${t.api}/bookings/${bookingId}/disputes`).send({ category: "SERVICE_QUALITY", description: "The work was not done properly, I want this cancelled." });
  if (opened.status !== 200) throw new Error(`dispute failed ${opened.status} ${JSON.stringify(opened.body)}`);
  const dispute = await t.prisma.dispute.findUniqueOrThrow({ where: { bookingId } });
  const admin = await t.newAdmin();
  const review = await admin.agent.post(`${t.api}/admin/disputes/${dispute.id}/review`).send({});
  if (review.status !== 200) throw new Error(`review failed ${review.status}`);
  const resolved = await admin.agent.post(`${t.api}/admin/disputes/${dispute.id}/resolve`).send({ outcome: "CANCEL_BOOKING", resolution: "Cancelled after review of the complaint." });
  if (resolved.status !== 200) throw new Error(`resolve failed ${resolved.status} ${JSON.stringify(resolved.body)}`);
  return admin;
}
