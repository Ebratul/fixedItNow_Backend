import { createHash, randomUUID } from "node:crypto";
import type { PrismaClient } from "../generated/prisma/client.js";
import type { BookingStatus } from "../generated/prisma/enums.js";
import { DEMO_EMAIL_DOMAIN, DEMO_PROFILES, DEMO_ROLE_KEY } from "./demo.config.js";

/**
 * The fictional demo data (docs/DEMO.md): the three login identities, a handful of fictional professionals and
 * customers around them, and a booking history that covers every screen of the web app and the admin panel.
 *
 * - Everything is created with `isDemo = true`, so it lives in the demo realm: ordinary users never see it and demo
 *   sessions never see anything else. Names are invented and every address ends in `.invalid` (it can never receive
 *   mail). No NID, phone number or payment credential exists anywhere in it.
 * - Idempotent: every row is looked up by a stable natural key and only created when missing, so re-running never
 *   duplicates, never resets what visitors did, and never touches a real row (a demo row is recognised by its
 *   reserved address or `isDemo`). It does not delete anything: `npm run demo:reset` is the (explicit) way back to a
 *   clean state.
 * - Dates are relative to the moment it runs, so run it again (or reset) to refresh a demo that has aged.
 * - Uses the UNSCOPED client: it deliberately works across realms. Never call it from a request.
 */

type Db = PrismaClient;

/** Same shape as a real reference (`FIN` + 24 hex), stable per fixture so a re-run finds it again. */
const stableReference = (prefix: "FIN" | "RFD", key: string) => prefix + createHash("sha256").update(`demo-seed:${key}`).digest("hex").slice(0, 24).toUpperCase();

const email = (local: string) => `${local}@${DEMO_EMAIL_DOMAIN}`;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/** A UTC instant for `hour`:00 Asia/Dhaka (UTC+6, no daylight saving) on the Dhaka calendar day `days` from `now`. */
export function dhaka(now: Date, days: number, hour: number, minute = 0): Date {
  const local = new Date(now.getTime() + 6 * HOUR);
  return new Date(Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate() + days, hour - 6, minute));
}

/**
 * The first Dhaka calendar day at least `from` days ahead that is a working day of the demo professionals (Sunday-Thursday),
 * as an offset in days. Future demo bookings use it so they stay inside the working hours and can be accepted.
 */
export function workday(now: Date, from: number): number {
  for (let days = from; days < from + 7; days++) {
    // 12:00 in Dhaka is 06:00 UTC on the same calendar date, so the UTC weekday is the Dhaka weekday (Sunday = 0).
    if (dhaka(now, days, 12).getUTCDay() <= 4) return days;
  }
  return from;
}

type WorkerSpec = {
  key: string;
  email: string;
  name: string;
  slug: string | null;
  headline: string;
  bio: string;
  years: number;
  areas: string[];
  services: { category: string; model: "FIXED" | "HOURLY" | "QUOTE"; price?: number; notes?: string }[];
  status: "VERIFIED" | "PENDING";
};

const WORKERS: WorkerSpec[] = [
  {
    key: "demo-worker", email: DEMO_PROFILES.worker.email, name: DEMO_PROFILES.worker.name, slug: "demo-worker",
    headline: "Electrician and AC technician (demo profile)",
    bio: "This is a fictional demonstration profile. Wiring, fans, lighting and fault finding, plus AC servicing. Prices and reviews are made up.",
    years: 9, areas: ["Dhaka", "Gazipur"],
    services: [
      { category: "electrical", model: "FIXED", price: 600, notes: "Per visit, parts extra." },
      { category: "ac-repair", model: "QUOTE", notes: "Quoted after inspection." },
    ],
    status: "VERIFIED",
  },
  {
    key: "karim", email: email("persona.karim"), name: "Karim Hossain (Demo)", slug: "karim-hossain-demo",
    headline: "Licensed electrician, 12 years (demo)", bio: "Fictional profile for the demo: house wiring, switchboards and safety checks.",
    years: 12, areas: ["Dhaka"], services: [{ category: "electrical", model: "HOURLY", price: 450 }], status: "VERIFIED",
  },
  {
    key: "shafiq", email: email("persona.shafiq"), name: "Shafiq Rahman (Demo)", slug: "shafiq-rahman-demo",
    headline: "Plumber for leaks and fittings (demo)", bio: "Fictional profile for the demo: taps, pipes, drainage and bathroom fittings.",
    years: 7, areas: ["Dhaka", "Narayanganj"], services: [{ category: "plumbing", model: "FIXED", price: 500 }], status: "VERIFIED",
  },
  {
    key: "mitu", email: email("persona.mitu"), name: "Mitu Akter (Demo)", slug: "mitu-akter-demo",
    headline: "Home deep-cleaning (demo)", bio: "Fictional profile for the demo: kitchens, bathrooms and whole-home cleaning.",
    years: 5, areas: ["Dhaka"], services: [{ category: "home-cleaning", model: "FIXED", price: 1800 }], status: "VERIFIED",
  },
  {
    key: "anwar", email: email("persona.anwar"), name: "Anwar Hossen (Demo)", slug: "anwar-hossen-demo",
    headline: "Appliance repair (demo)", bio: "Fictional profile for the demo: fridges, washing machines and ovens.",
    years: 10, areas: ["Dhaka", "Chattogram"], services: [{ category: "appliance-repair", model: "QUOTE" }], status: "VERIFIED",
  },
  {
    key: "jamal", email: email("persona.jamal"), name: "Jamal Uddin (Demo)", slug: "jamal-uddin-demo",
    headline: "Carpenter and painter (demo)", bio: "Fictional profile for the demo: doors, furniture repair and interior painting.",
    years: 15, areas: ["Dhaka", "Sylhet"],
    services: [{ category: "carpentry", model: "HOURLY", price: 400 }, { category: "painting", model: "QUOTE" }], status: "VERIFIED",
  },
  {
    key: "rubel", email: email("persona.rubel"), name: "Rubel Mia (Demo)", slug: null,
    headline: "Laptop and network support (demo)", bio: "Fictional application waiting for review, so the verification screens have something to show.",
    years: 3, areas: ["Dhaka"], services: [{ category: "computer-it", model: "HOURLY", price: 350 }], status: "PENDING",
  },
];

const CUSTOMERS = [
  { key: "nusrat", email: email("persona.nusrat"), name: "Nusrat Jahan (Demo)" },
  { key: "tanvir", email: email("persona.tanvir"), name: "Tanvir Ahmed (Demo)" },
] as const;

export type DemoSeedSummary = { users: number; workers: number; bookings: number; created: { users: number; bookings: number; other: number } };

export async function seedDemo(db: Db, options: { now?: Date } = {}): Promise<DemoSeedSummary> {
  const now = options.now ?? new Date();
  const created = { users: 0, bookings: 0, other: 0 };

  // ---- prerequisites (reference data and the migration's role) -------------------------------------------------
  const demoRole = await db.adminRole.findUnique({ where: { key: DEMO_ROLE_KEY }, select: { id: true } });
  if (!demoRole) throw new Error(`The ${DEMO_ROLE_KEY} role is missing: run the migrations first (npm run db:deploy).`);
  const categories = new Map((await db.serviceCategory.findMany({ select: { id: true, slug: true, name: true } })).map((c) => [c.slug, c]));
  for (const slug of new Set(WORKERS.flatMap((w) => w.services.map((s) => s.category)))) {
    if (!categories.has(slug)) throw new Error(`Service category "${slug}" is missing: run the reference seed first (npm run db:seed).`);
  }

  // ---- users ----------------------------------------------------------------------------------------------------
  const ids = new Map<string, string>();
  const ensureUser = async (key: string, address: string, name: string, extra: { demoRole?: "CUSTOMER" | "WORKER" | "ADMIN"; admin?: boolean } = {}) => {
    const existing = await db.user.findUnique({ where: { email: address }, select: { id: true, isDemo: true } });
    if (existing) {
      // A reserved demo address that belongs to a NON-demo account would mean someone registered it by hand: refuse to guess.
      if (!existing.isDemo) throw new Error(`${address} belongs to a non-demo account; refusing to seed over it.`);
      ids.set(key, existing.id);
      return;
    }
    const user = await db.user.create({
      data: {
        id: randomUUID(), name, email: address, emailVerified: true, isDemo: true,
        ...(extra.demoRole && { demoRole: extra.demoRole }),
        ...(extra.admin && { role: "ADMIN" as const, adminRole: { connect: { id: demoRole.id } } }),
      },
      select: { id: true },
    });
    ids.set(key, user.id);
    created.users += 1;
  };
  await ensureUser("customer", DEMO_PROFILES.customer.email, DEMO_PROFILES.customer.name, { demoRole: "CUSTOMER" });
  await ensureUser("admin", DEMO_PROFILES.admin.email, DEMO_PROFILES.admin.name, { demoRole: "ADMIN", admin: true });
  for (const c of CUSTOMERS) await ensureUser(c.key, c.email, c.name);
  for (const w of WORKERS) await ensureUser(w.key, w.email, w.name, w.key === "demo-worker" ? { demoRole: "WORKER" } : {});
  const id = (key: string) => ids.get(key)!;

  // ---- profiles -------------------------------------------------------------------------------------------------
  for (const [key, name] of [["customer", DEMO_PROFILES.customer.name], ["nusrat", CUSTOMERS[0].name], ["tanvir", CUSTOMERS[1].name]] as const) {
    await db.customerProfile.upsert({
      where: { userId: id(key) },
      create: { userId: id(key), displayName: name, preferredDivision: "Dhaka" },
      update: {},
    });
  }

  const profiles = new Map<string, { id: string; name: string; userId: string }>();
  for (const w of WORKERS) {
    const verified = w.status === "VERIFIED";
    const priced = w.services.flatMap((s) => (s.price ? [s.price] : []));
    let profile = await db.workerProfile.findUnique({ where: { userId: id(w.key) }, select: { id: true } });
    if (!profile) {
      profile = await db.workerProfile.create({
        data: {
          userId: id(w.key), onboardingStatus: "SUBMITTED", onboardingStep: 5, displayName: w.name,
          headline: w.headline, bio: w.bio, experienceYears: w.years, languages: ["Bangla", "English"], serviceAreas: w.areas,
          submittedAt: new Date(now.getTime() - 14 * DAY),
          verificationStatus: w.status,
          ...(verified && { reviewedById: id("admin"), reviewedAt: new Date(now.getTime() - 13 * DAY), slug: w.slug, publishedAt: new Date(now.getTime() - 13 * DAY) }),
          startingPriceBdt: priced.length ? Math.min(...priced) : null,
        },
        select: { id: true },
      });
      created.other += 1;
    }
    for (const s of w.services) {
      await db.workerService.upsert({
        where: { workerProfileId_categoryId: { workerProfileId: profile.id, categoryId: categories.get(s.category)!.id } },
        create: { workerProfileId: profile.id, categoryId: categories.get(s.category)!.id, pricingModel: s.model, basePriceBdt: s.price ?? null, pricingNotes: s.notes ?? null },
        update: {},
      });
    }
    // Sunday-Thursday 09:00-18:00 (Asia/Dhaka), only when the worker has no schedule at all (never overwrite an edit).
    if (verified && (await db.workerAvailabilityRule.count({ where: { workerProfileId: profile.id } })) === 0) {
      await db.workerAvailabilityRule.createMany({
        data: [0, 1, 2, 3, 4].map((weekday) => ({ workerProfileId: profile.id, weekday, startMinute: 9 * 60, endMinute: 18 * 60 })),
      });
    }
    profiles.set(w.key, { id: profile.id, name: w.name, userId: id(w.key) });
  }

  // ---- bookings (and what hangs off them) ---------------------------------------------------------------------
  type Spec = {
    key: string; customer: string; worker: string; category: string; status: BookingStatus; description: string;
    start: [day: number, hour: number]; minutes: number; amount?: number;
    quote?: { labor: number; materials: number; status: "PENDING" | "ACCEPTED" };
    chat?: [from: "customer" | "worker", text: string][];
    payment?: "SUCCEEDED" | "NONE";
    review?: { rating: number; comment: string };
    dispute?: boolean;
    cancelled?: boolean;
  };
  const SPECS: Spec[] = [
    { key: "b1-requested", customer: "customer", worker: "demo-worker", category: "electrical", status: "REQUESTED", start: [workday(now, 3), 14], minutes: 60, description: "Two ceiling fans in the bedroom are noisy and one has stopped. Please check the regulators too." },
    { key: "b2-quoted", customer: "customer", worker: "demo-worker", category: "ac-repair", status: "QUOTED", start: [workday(now, 5), 11], minutes: 120, description: "The split AC in the living room blows warm air. It has not been serviced for two years.", quote: { labor: 1500, materials: 1200, status: "PENDING" } },
    {
      key: "b3-confirmed", customer: "customer", worker: "demo-worker", category: "electrical", status: "CONFIRMED", start: [workday(now, 1), 10], minutes: 60, amount: 600,
      description: "Replace the kitchen switchboard and fit a new socket next to the fridge.",
      chat: [["customer", "Hello! The building has a lift, the flat is on the 4th floor."], ["worker", "Thanks, I will bring the replacement socket. See you tomorrow at 10."], ["customer", "Perfect. The guard will let you in."]],
    },
    {
      key: "b4-payment-due", customer: "customer", worker: "demo-worker", category: "electrical", status: "COMPLETION_PENDING", start: [-1, 14], minutes: 120, amount: 600,
      description: "Install two LED panel lights in the study room.",
      chat: [["worker", "The panel lights are fitted and tested. Please check them."], ["customer", "They look great, thank you. I will pay now."]],
    },
    {
      key: "b5-completed", customer: "customer", worker: "demo-worker", category: "electrical", status: "COMPLETED", start: [-8, 9], minutes: 60, amount: 600,
      description: "Fix a tripping circuit breaker in the hallway.", payment: "SUCCEEDED",
      chat: [["worker", "Found a loose neutral and fixed it. The breaker is stable now."], ["customer", "Thank you, it works."]],
      review: { rating: 5, comment: "Quick, tidy and explained the fault clearly. (Fictional demo review.)" },
    },
    { key: "b6-cancelled", customer: "customer", worker: "demo-worker", category: "electrical", status: "CANCELLED", start: [-3, 10], minutes: 60, amount: 600, payment: "SUCCEEDED", cancelled: true, description: "Fit a doorbell. (Cancelled after the customer had already paid.)" },
    { key: "b7-disputed", customer: "customer", worker: "demo-worker", category: "ac-repair", status: "DISPUTED", start: [-5, 15], minutes: 60, amount: 1800, description: "AC gas refill and cleaning.", dispute: true },
    { key: "c1-completed", customer: "nusrat", worker: "karim", category: "electrical", status: "COMPLETED", start: [-12, 10], minutes: 120, amount: 900, description: "Rewire the balcony lights.", payment: "SUCCEEDED", review: { rating: 5, comment: "Professional and on time. (Fictional demo review.)" } },
    { key: "c2-completed", customer: "tanvir", worker: "shafiq", category: "plumbing", status: "COMPLETED", start: [-10, 11], minutes: 60, amount: 500, description: "Replace a leaking kitchen tap.", payment: "SUCCEEDED", review: { rating: 4, comment: "Fixed the leak, a little late. (Fictional demo review.)" } },
    { key: "c3-completed", customer: "nusrat", worker: "mitu", category: "home-cleaning", status: "COMPLETED", start: [-15, 9], minutes: 240, amount: 1800, description: "Deep clean of a two-bedroom flat.", payment: "SUCCEEDED", review: { rating: 5, comment: "Spotless. (Fictional demo review.)" } },
    { key: "c4-completed", customer: "tanvir", worker: "jamal", category: "carpentry", status: "COMPLETED", start: [-20, 10], minutes: 120, amount: 800, description: "Repair a wardrobe door.", payment: "SUCCEEDED", review: { rating: 4, comment: "Solid work. (Fictional demo review.)" } },
  ];

  const bookings = new Map<string, { id: string; workerUserId: string; customerUserId: string }>();
  const event = (bookingId: string, actorUserId: string | null, actorRole: "CUSTOMER" | "WORKER" | "ADMIN" | "SYSTEM", type: string, fromStatus: BookingStatus | null, toStatus: BookingStatus | null, at: Date, reason?: string) =>
    db.bookingEvent.create({ data: { bookingId, actorUserId, actorRole, type, fromStatus, toStatus, createdAt: at, ...(reason && { reason }) } });

  for (const spec of SPECS) {
    const idempotencyKey = `demo-seed-${spec.key}`;
    const customerId = id(spec.customer);
    const worker = profiles.get(spec.worker)!;
    const found = await db.booking.findUnique({ where: { customerId_idempotencyKey: { customerId, idempotencyKey } }, select: { id: true } });
    if (found) {
      bookings.set(spec.key, { id: found.id, workerUserId: worker.userId, customerUserId: customerId });
      continue;
    }
    const category = categories.get(spec.category)!;
    const service = WORKERS.find((w) => w.key === spec.worker)!.services.find((s) => s.category === spec.category)!;
    const startAt = dhaka(now, spec.start[0], spec.start[1]);
    const endAt = new Date(startAt.getTime() + spec.minutes * 60_000);
    const reserved = spec.status === "CONFIRMED" || spec.status === "COMPLETION_PENDING" || spec.status === "COMPLETED" || spec.status === "DISPUTED" || spec.status === "CANCELLED";
    const confirmedAt = reserved && !(spec.status === "CANCELLED" && !spec.payment) ? new Date(startAt.getTime() - 2 * DAY) : null;
    const worked = spec.status === "COMPLETION_PENDING" || spec.status === "COMPLETED" || spec.status === "DISPUTED";
    const completionAt = worked ? new Date(endAt.getTime() + 10 * 60_000) : null;

    const booking = await db.booking.create({
      data: {
        customerId, workerProfileId: worker.id, categoryId: category.id, status: spec.status,
        description: spec.description, serviceArea: "Dhaka", serviceAddress: "House 12, Road 5, Demo Residential Area, Dhaka (fictional address)",
        startAt, endAt, durationMinutes: spec.minutes,
        pricingModel: service.model, unitPriceBdt: service.price ?? null,
        pricingSnapshot: { categoryName: category.name, workerDisplayName: worker.name, pricingModel: service.model, basePriceBdt: service.price ?? null, pricingNotes: service.notes ?? null },
        agreedAmountBdt: spec.amount ?? null,
        confirmedAt,
        arrivedAt: worked ? new Date(startAt.getTime() - 5 * 60_000) : null,
        startedAt: worked ? startAt : null,
        completionRequestedAt: completionAt,
        completedAt: spec.status === "COMPLETED" ? completionAt : null,
        ...(spec.cancelled && { cancelledAt: new Date(startAt.getTime() - 4 * HOUR), cancelledByUserId: customerId, cancellationReason: "Plans changed (demo)." }),
        idempotencyKey,
        createdAt: new Date(startAt.getTime() - 4 * DAY),
      },
      select: { id: true },
    });
    created.bookings += 1;
    bookings.set(spec.key, { id: booking.id, workerUserId: worker.userId, customerUserId: customerId });

    // history
    const t0 = new Date(startAt.getTime() - 4 * DAY);
    await event(booking.id, customerId, "CUSTOMER", "booking.requested", null, "REQUESTED", t0);
    if (confirmedAt) await event(booking.id, worker.userId, "WORKER", "booking.accepted", "REQUESTED", "CONFIRMED", confirmedAt);
    if (worked) {
      await event(booking.id, worker.userId, "WORKER", "booking.arrived", "CONFIRMED", "CONFIRMED", new Date(startAt.getTime() - 5 * 60_000));
      await event(booking.id, worker.userId, "WORKER", "booking.started", "CONFIRMED", "IN_PROGRESS", startAt);
      await event(booking.id, worker.userId, "WORKER", "booking.completion_requested", "IN_PROGRESS", "COMPLETION_PENDING", completionAt!);
    }
    if (spec.status === "COMPLETED") await event(booking.id, null, "SYSTEM", "booking.completed", "COMPLETION_PENDING", "COMPLETED", completionAt!);
    if (spec.cancelled) await event(booking.id, customerId, "CUSTOMER", "booking.cancelled", "CONFIRMED", "CANCELLED", new Date(startAt.getTime() - 4 * HOUR), "Plans changed (demo).");

    if (spec.quote) {
      const total = spec.quote.labor + spec.quote.materials;
      const quote = await db.quote.create({
        data: {
          bookingId: booking.id, status: spec.quote.status, laborBdt: spec.quote.labor, materialsBdt: spec.quote.materials, otherBdt: 0, totalBdt: total,
          description: "Inspection, cleaning and gas top-up if needed.", terms: "Valid for 48 hours.", estimatedDurationMinutes: spec.minutes,
          expiresAt: new Date(now.getTime() + 2 * DAY), createdByUserId: worker.userId,
        },
        select: { id: true },
      });
      await event(booking.id, worker.userId, "WORKER", "quote.sent", "REQUESTED", "QUOTED", new Date(startAt.getTime() - 3 * DAY));
      void quote;
    }

    for (const [index, [from, text]] of (spec.chat ?? []).entries()) {
      await db.chatMessage.create({
        data: {
          bookingId: booking.id, senderId: from === "customer" ? customerId : worker.userId, senderRole: from === "customer" ? "CUSTOMER" : "WORKER", body: text,
          clientMessageId: `demo-seed-${spec.key}-${index}`.padEnd(8, "0"), createdAt: new Date((confirmedAt ?? t0).getTime() + (index + 1) * 20 * 60_000),
        },
      });
    }

    if (spec.payment === "SUCCEEDED") {
      const reference = stableReference("FIN", spec.key);
      const paidAt = completionAt ?? new Date(startAt.getTime() - 3 * HOUR);
      const payment = await db.payment.create({
        data: {
          reference, bookingId: booking.id, customerId, provider: "DEMO", isLive: false, status: "SUCCEEDED", amountBdt: spec.amount!, currency: "BDT",
          providerPaymentId: `demo_${reference}`, providerTransactionId: `DEMO-${reference}`, initiatedAt: paidAt, succeededAt: paidAt, createdAt: paidAt,
          // The cancelled booking was paid and then cancelled: the payments screen flags it for an administrator.
          ...(spec.cancelled && { reviewReason: "BOOKING_INELIGIBLE" as const }),
        },
        select: { id: true },
      });
      for (const [type, from, to] of [["payment.created", null, "PENDING"], ["payment.initiated", "PENDING", "INITIATED"], ["payment.succeeded", "INITIATED", "SUCCEEDED"]] as const) {
        await db.paymentEvent.create({ data: { paymentId: payment.id, type, fromStatus: from, toStatus: to, actorUserId: customerId, actorRole: "CUSTOMER", createdAt: paidAt, metadata: { provider: "DEMO", simulated: true } } });
      }
      if (spec.cancelled) {
        await db.refund.create({
          data: {
            paymentId: payment.id, requestedByUserId: customerId, requestedByRole: "CUSTOMER", requestedAmountBdt: spec.amount!,
            reason: "I cancelled the booking after paying; please refund the payment.", providerRefundReference: stableReference("RFD", spec.key), createdAt: new Date(paidAt.getTime() + HOUR),
          },
        });
        await db.paymentEvent.create({ data: { paymentId: payment.id, type: "refund.requested", actorUserId: customerId, actorRole: "CUSTOMER", createdAt: new Date(paidAt.getTime() + HOUR), metadata: { simulated: true } } });
      }
    }

    if (spec.review) {
      await db.review.create({
        data: { bookingId: booking.id, customerId, workerProfileId: worker.id, rating: spec.review.rating, comment: spec.review.comment, createdAt: new Date(endAt.getTime() + DAY) },
      });
    }

    if (spec.dispute) {
      const dispute = await db.dispute.create({
        data: {
          bookingId: booking.id, openedByUserId: customerId, openedByRole: "CUSTOMER", category: "SERVICE_QUALITY", status: "OPEN", previousBookingStatus: "COMPLETION_PENDING",
          description: "The AC still does not cool properly after the service. I would like the visit reviewed.", createdAt: new Date(endAt.getTime() + 6 * HOUR),
        },
        select: { id: true },
      });
      await db.disputeMessage.create({ data: { disputeId: dispute.id, authorUserId: id("customer"), authorRole: "CUSTOMER", body: "The room temperature only dropped by two degrees.", createdAt: new Date(endAt.getTime() + 7 * HOUR) } });
      await event(booking.id, customerId, "CUSTOMER", "dispute.opened", "COMPLETION_PENDING", "DISPUTED", new Date(endAt.getTime() + 6 * HOUR));
    }
  }

  // ---- support, community, notifications ------------------------------------------------------------------------
  const ensureOnce = async (exists: () => Promise<unknown>, make: () => Promise<unknown>) => {
    if (!(await exists())) {
      await make();
      created.other += 1;
    }
  };
  const customerId = id("customer");

  await ensureOnce(
    () => db.supportTicket.findFirst({ where: { requesterId: customerId, subject: "Refund for a cancelled booking" }, select: { id: true } }),
    async () => {
      const ticket = await db.supportTicket.create({
        data: { requesterId: customerId, category: "PAYMENT", priority: "HIGH", subject: "Refund for a cancelled booking", status: "OPEN", bookingId: bookings.get("b6-cancelled")?.id },
        select: { id: true },
      });
      await db.supportTicketMessage.create({ data: { ticketId: ticket.id, authorId: customerId, authorRole: "CUSTOMER", body: "I paid for the doorbell booking and then cancelled it. Could you refund the payment? (Fictional demo ticket.)" } });
    },
  );
  await ensureOnce(
    () => db.supportTicket.findFirst({ where: { requesterId: id("nusrat"), subject: "How do I change my service area?" }, select: { id: true } }),
    async () => {
      const ticket = await db.supportTicket.create({
        data: { requesterId: id("nusrat"), category: "GENERAL", priority: "NORMAL", subject: "How do I change my service area?", status: "RESOLVED", resolution: "Open your profile and pick the new division.", resolvedAt: new Date(now.getTime() - DAY) },
        select: { id: true },
      });
      await db.supportTicketMessage.create({ data: { ticketId: ticket.id, authorId: id("nusrat"), authorRole: "CUSTOMER", body: "Where can I change the division I want to search in? (Fictional demo ticket.)" } });
      await db.supportTicketMessage.create({ data: { ticketId: ticket.id, authorId: id("admin"), authorRole: "ADMIN", body: "Open your profile and pick the new division. (Fictional demo reply.)" } });
    },
  );

  await ensureOnce(
    () => db.communityPost.findFirst({ where: { authorId: id("nusrat"), title: "Tips for describing an electrical fault" }, select: { id: true } }),
    async () => {
      const post = await db.communityPost.create({
        data: { authorId: id("nusrat"), title: "Tips for describing an electrical fault", body: "When a switch or fan stops working, say when it started and whether other devices on the same line are affected. It helps the professional bring the right parts. (Fictional demo post.)" },
        select: { id: true },
      });
      await db.postComment.create({ data: { postId: post.id, authorId: id("tanvir"), body: "Photos of the switchboard helped me a lot, too. (Fictional demo comment.)" } });
      await db.postReaction.create({ data: { postId: post.id, userId: customerId, type: "LIKE" } });
      // An open report so the moderation screen has a queue.
      const spam = await db.communityPost.create({
        data: { authorId: id("tanvir"), title: "Buy cheap followers now!!!", body: "This is a fictional spam post created to show the moderation queue. (Demo.)" },
        select: { id: true },
      });
      await db.contentReport.create({
        data: { reporterId: customerId, targetType: "POST", targetKey: `POST:${spam.id}`, postId: spam.id, reason: "SPAM", details: "Looks like an advertisement. (Fictional demo report.)" },
      });
    },
  );
  await ensureOnce(
    () => db.featureProposal.findFirst({ where: { authorId: id("tanvir"), title: "Show worker response time on profiles" }, select: { id: true } }),
    async () => {
      const proposal = await db.featureProposal.create({
        data: { authorId: id("tanvir"), title: "Show worker response time on profiles", description: "It would help to see how quickly a professional usually answers a request before booking. (Fictional demo proposal.)" },
        select: { id: true },
      });
      await db.featureVote.create({ data: { proposalId: proposal.id, userId: customerId } });
    },
  );

  const notify = (userKey: string, type: string, title: string, body: string, link: string) =>
    ensureOnce(
      () => db.notification.findFirst({ where: { userId: id(userKey), type, title }, select: { id: true } }),
      () => db.notification.create({ data: { userId: id(userKey), type, title, body, link } }),
    );
  await notify("customer", "booking.accepted", "Your booking was accepted", "The professional accepted your electrical booking for tomorrow. You can chat with them now.", `/bookings/${bookings.get("b3-confirmed")!.id}`);
  await notify("customer", "booking.payment_due", "Payment due", "The work on your lighting booking is finished. Pay with the simulated payment to complete it.", `/bookings/${bookings.get("b4-payment-due")!.id}`);
  await notify("customer", "booking.quoted", "You received a quote", "The professional sent a quote for your AC service. Review and accept it.", `/bookings/${bookings.get("b2-quoted")!.id}`);
  await notify("demo-worker", "booking.requested", "New booking request", "A customer asked for Electrical Services. Open the request to accept, decline or send a quote.", `/bookings/${bookings.get("b1-requested")!.id}`);
  await notify("demo-worker", "payment.succeeded", "The customer's payment was verified", "Payment for the circuit breaker booking was verified and the booking is complete.", `/bookings/${bookings.get("b5-completed")!.id}`);

  const counts = await Promise.all([db.user.count({ where: { isDemo: true } }), db.workerProfile.count({ where: { user: { isDemo: true } } }), db.booking.count({ where: { customer: { isDemo: true } } })]);
  return { users: counts[0], workers: counts[1], bookings: counts[2], created };
}
