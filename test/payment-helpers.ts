import request from "supertest";
import { at, bookableWorker, confirmedBooking, customer, type Person, type Worker } from "./booking-helpers.js";
import type { TestApp } from "./helpers.js";

export type Provider = "BKASH" | "SSLCOMMERZ";

/** A confirmed fixed-price booking (৳500) ready to be paid. */
export async function payableBooking(t: TestApp, opts: { days?: number; hour?: number; worker?: Worker; cust?: Person } = {}) {
  const worker = opts.worker ?? (await bookableWorker(t));
  const cust = opts.cust ?? (await customer(t));
  const bookingId = await confirmedBooking(t, cust, worker, at(t, opts.days ?? 3, opts.hour ?? 10));
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

export const sslCallback = (t: TestApp, kind: "success" | "fail" | "cancel", form: Record<string, string>) =>
  raw(t).post(`${t.api}/payments/callbacks/sslcommerz/${kind}`).type("form").send(form);

export const sslIpn = (t: TestApp, form: Record<string, string>) =>
  raw(t).post(`${t.api}/payments/ipn/sslcommerz`).type("form").send(form);

export const latestBkashId = (t: TestApp) => [...t.net.bkash.keys()].at(-1)!;

/** Seconds past the per-payment re-verification throttle. */
export const pastThrottle = (t: TestApp) => t.clock.advanceMinutes(1);

export async function events(t: TestApp, reference: string, type?: string) {
  const payment = await t.prisma.payment.findUniqueOrThrow({ where: { reference } });
  return t.prisma.paymentEvent.findMany({ where: { paymentId: payment.id, ...(type ? { type } : {}) }, orderBy: { createdAt: "asc" } });
}
