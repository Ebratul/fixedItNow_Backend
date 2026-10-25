import request from "supertest";
import { addDays, localInstant, localParts } from "../src/bookings/time.js";
import type { TestApp } from "./helpers.js";
import { uniqueEmail } from "./helpers.js";

export type Person = Awaited<ReturnType<TestApp["signUpAndLogin"]>>;
export type Worker = Awaited<ReturnType<TestApp["createWorker"]>>;

/** Every day 08:00-20:00 Dhaka time. */
export const ALL_WEEK = [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, startMinute: 8 * 60, endMinute: 20 * 60 }));

/** A published worker who has set working hours (so they can be booked). */
export async function bookableWorker(
  t: TestApp,
  opts: Parameters<TestApp["createWorker"]>[0] & { rules?: typeof ALL_WEEK } = {},
): Promise<Worker> {
  const { rules = ALL_WEEK, ...rest } = opts;
  const worker = await t.createWorker(rest);
  const res = await worker.agent.put(`${t.api}/me/availability`).send({ rules });
  if (res.status !== 200) throw new Error(`availability failed: ${res.status} ${JSON.stringify(res.body)}`);
  return worker;
}

export const customer = (t: TestApp, name = "Customer") => t.signUpAndLogin(uniqueEmail("cust"), name);

/** An instant at hh:mm Dhaka time, `daysAhead` days after the fake clock's current Dhaka date. */
export function at(t: TestApp, daysAhead: number, hour: number, minute = 0): Date {
  const key = addDays(localParts(t.clock.now()).dateKey, daysAhead);
  return localInstant(key, hour * 60 + minute);
}

export const bookingBody = (worker: Pick<Worker, "profileId">, start: Date, extra: object = {}) => ({
  workerId: worker.profileId,
  categorySlug: "electrical",
  description: "The ceiling fan in my bedroom is noisy and slow.",
  serviceArea: "Dhaka",
  serviceAddress: "House 12, Road 5, Dhanmondi",
  startAt: start.toISOString(),
  durationMinutes: 60,
  ...extra,
});

export async function requestBooking(t: TestApp, cust: Person, worker: Pick<Worker, "profileId">, start: Date, extra: object = {}) {
  return cust.agent.post(`${t.api}/bookings`).send(bookingBody(worker, start, extra));
}

/** Request + (fixed-price) accept: a CONFIRMED booking. Returns its id. */
export async function confirmedBooking(t: TestApp, cust: Person, worker: Worker, start: Date, extra: object = {}) {
  const created = await requestBooking(t, cust, worker, start, extra);
  if (created.status !== 201) throw new Error(`request failed ${created.status} ${JSON.stringify(created.body)}`);
  const id = created.body.booking.id as string;
  const accepted = await worker.agent.post(`${t.api}/bookings/${id}/accept`).send({});
  if (accepted.status !== 200) throw new Error(`accept failed ${accepted.status} ${JSON.stringify(accepted.body)}`);
  return id;
}

/** A QUOTE-priced booking request (ac-repair is QUOTE in the default profile). */
export const quoteBody = (extra: object = {}) => ({
  laborBdt: 800,
  materialsBdt: 300,
  otherBdt: 50,
  description: "Gas refill and filter cleaning, parts included.",
  ...extra,
});

/**
 * The customer pays through the MOCK bKash (test/fake-providers.ts): start the payment, approve it "inside bKash",
 * and let bKash's callback reach us. Our server then asks the (mock) provider and decides. The test app must have
 * been created with TEST_ENV so the provider is configured. Returns the payment reference.
 */
export async function payBooking(t: TestApp, cust: Person, bookingId: string) {
  const started = await cust.agent
    .post(`${t.api}/bookings/${bookingId}/payments`)
    .set("Idempotency-Key", `pay-${bookingId.slice(0, 8)}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`)
    .send({ provider: "BKASH" });
  if (started.status !== 201) throw new Error(`payment start failed ${started.status} ${JSON.stringify(started.body)}`);
  const reference = started.body.payment.reference as string;
  const providerPaymentId = [...t.net.bkash.keys()].at(-1)!;
  t.net.bkashApprove(providerPaymentId);
  await request(t.app.getHttpServer())
    .get(`${t.api}/payments/callbacks/bkash/${reference}`)
    .query({ paymentID: providerPaymentId, status: "success", signature: "not-verified" });
  return reference;
}

/** request -> accept -> start -> complete: a booking whose work is finished and whose payment is DUE. Leaves the fake clock inside the appointment. */
export async function payableBooking(t: TestApp, cust: Person, worker: Worker, extra: object = {}, daysAhead = 3, hour = 10) {
  const start = at(t, daysAhead, hour);
  const id = await confirmedBooking(t, cust, worker, start, extra);
  t.clock.set(new Date(start.getTime() - 10 * 60_000));
  const started = await worker.agent.post(`${t.api}/bookings/${id}/start`).send({});
  if (started.status !== 200) throw new Error(`start failed ${started.status}`);
  const done = await worker.agent.post(`${t.api}/bookings/${id}/complete`).send({});
  if (done.status !== 200) throw new Error(`complete failed ${done.status}`);
  return id;
}

/** payableBooking + a verified payment: a COMPLETED booking. */
export async function completedBooking(t: TestApp, cust: Person, worker: Worker, extra: object = {}) {
  const id = await payableBooking(t, cust, worker, extra);
  await payBooking(t, cust, id);
  const detail = await cust.agent.get(`${t.api}/bookings/${id}`);
  if (detail.body.booking.status !== "COMPLETED") throw new Error(`payment did not complete the booking: ${detail.body.booking.status}`);
  return id;
}
