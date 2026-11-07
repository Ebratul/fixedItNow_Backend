import { randomBytes } from "node:crypto";
import { faker } from "@faker-js/faker";
import type { Prisma } from "../src/generated/prisma/client.js";
import type { BookingStatus, DisputeStatus, PaymentStatus, PricingModel, VerificationStatus } from "../src/generated/prisma/enums.js";
import { DIVISIONS } from "../src/common/constants.js";
import { createScriptClient } from "./db.js";
import { PERF_EMAIL_DOMAIN, PERF_KEY_PREFIX, PERF_MARKER, guardDatabase, intArg, parseArgs } from "./perf-common.js";

/**
 * Performance / volume seed: fills a LOCAL database with realistic fake data so list, table, search and chart
 * screens can be measured under load. It changes no application code and no existing row.
 *
 *   npm run perf:seed                                  1500 users, 1500 bookings, 2000 audit rows, 60 days of payments
 *   npm run perf:seed -- --users=3000 --bookings=5000  bigger run (also --audit=, --days=, --seed=)
 *   npm run perf:clean                                 removes everything this script wrote (scripts/clean-perf.ts)
 *
 * What it writes (all in the ordinary realm, isDemo = false):
 *   - users: customers, professionals and some with both profiles, plus a handful of admin users (no password, so
 *     nobody can sign in as them) who appear as the actors of the audit entries
 *   - worker profiles across every verification state, services with prices, weekly availability
 *   - bookings in every status, with coherent timestamps, quotes, booking events and disputes
 *   - bKash (sandbox, isLive = false) payment attempts: successful payments spread over the last --days days, plus
 *     failed / cancelled / expired / open attempts and refunds, so Admin > Financial reports draws a full chart
 *   - audit log entries spread over the same period, written through the normal hash-chain trigger
 *
 * Markers: see scripts/perf-common.ts. Refuses to run on a non-local database unless --allow-remote is given, and
 * refuses to run twice (clean first). The whole seed is one transaction: it either all lands or none of it does.
 */

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const DHAKA_OFFSET = 6 * HOUR;

const args = parseArgs();
const host = guardDatabase(args, "seed performance data");
const USERS = intArg(args, "users", 1500, 10);
const BOOKINGS = intArg(args, "bookings", 1500, 0);
const AUDIT = intArg(args, "audit", 2000, 0);
const DAYS = intArg(args, "days", 60, 7, 366);
faker.seed(intArg(args, "seed", 20261107, 0, 2 ** 31 - 1));

const now = Date.now();

// ---------------------------------------------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------------------------------------------

/** RFC 9562 UUIDv7 whose time prefix is `ms`, so ids sort like the rows' createdAt (as the app's own ids do). */
function uuidv7(ms: number): string {
  const b = randomBytes(16);
  b.writeUIntBE(Math.max(0, Math.floor(ms)), 0, 6);
  b[6] = (b[6]! & 0x0f) | 0x70;
  b[8] = (b[8]! & 0x3f) | 0x80;
  const h = b.toString("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

const int = (min: number, max: number) => faker.number.int({ min, max });
const pick = <T>(items: readonly T[]) => faker.helpers.arrayElement(items);
const chance = (probability: number) => faker.datatype.boolean({ probability });
const weighted = <T>(items: [weight: number, value: T][]) => faker.helpers.weightedArrayElement(items.map(([weight, value]) => ({ weight, value })));
/** A random instant in [a, b] (b clamped to "one minute ago" so nothing lands in the future by accident). */
const between = (a: number, b: number, cap = now - MIN) => {
  const hi = Math.min(b, cap);
  return new Date(hi <= a ? a : int(a, hi));
};
const step = (min: number, max: number, by: number) => int(Math.ceil(min / by), Math.floor(max / by)) * by;
/** Asia/Dhaka wall-clock time `minuteOfDay` on the day `dayOffset` days from today, as a UTC instant. */
function dhakaAt(dayOffset: number, minuteOfDay: number): number {
  const local = new Date(now + DHAKA_OFFSET);
  return Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate() + dayOffset, 0, minuteOfDay) - DHAKA_OFFSET;
}
const hex = (bytes: number) => randomBytes(bytes).toString("hex").toUpperCase();
/** Same shape as the app's payment.db.ts newReference (the API's ReferencePipe accepts only this). */
const reference = (prefix: "FIN" | "RFD") => prefix + hex(12);
const key = (kind: string, n: number) => `${PERF_KEY_PREFIX}${kind}:${n}`;

async function inChunks<T>(rows: T[], size: number, write: (chunk: T[]) => Promise<unknown>) {
  for (let i = 0; i < rows.length; i += size) await write(rows.slice(i, i + size));
}

// ---------------------------------------------------------------------------------------------------------------
// Fake-but-plausible content (Bangladesh)
// ---------------------------------------------------------------------------------------------------------------

const MALE = ["Rahim", "Karim", "Jamal", "Shafiq", "Rubel", "Tanvir", "Arif", "Sohel", "Imran", "Hasan", "Mahmud", "Rakib", "Sakib", "Nayeem", "Fahim", "Mizanur", "Habib", "Kamal", "Faruk", "Shahin", "Monir", "Jahid", "Riyad", "Tareq", "Anis", "Biplob", "Delwar", "Emon", "Faisal", "Golam", "Hridoy", "Ibrahim", "Jewel", "Kawsar", "Liton", "Masud", "Nasir", "Parvez", "Rasel", "Sabbir", "Shuvo", "Tuhin", "Zahid"];
const FEMALE = ["Nusrat", "Mitu", "Fatema", "Ayesha", "Sumaiya", "Tahmina", "Shirin", "Rokeya", "Nasrin", "Farzana", "Sadia", "Jannatul", "Lamia", "Mehjabin", "Nadia", "Rumana", "Sharmin", "Tania", "Afsana", "Bushra", "Dilruba", "Eshita", "Habiba", "Ishrat", "Jesmin", "Kulsum", "Lima", "Maliha", "Nabila", "Priya", "Rehana", "Sabrina", "Tasnim", "Zarin"];
const SURNAMES = ["Ahmed", "Hossain", "Rahman", "Islam", "Khan", "Chowdhury", "Uddin", "Mia", "Akter", "Begum", "Sarkar", "Talukder", "Bhuiyan", "Sheikh", "Mollah", "Haque", "Alam", "Kabir", "Siddique", "Roy", "Das", "Barua", "Majumder", "Sultana", "Karim", "Hasan", "Miah", "Mondal", "Paul", "Saha"];
const AREAS: Record<string, string[]> = {
  Dhaka: ["Mirpur", "Dhanmondi", "Uttara", "Mohammadpur", "Banani", "Gulshan", "Bashundhara", "Badda", "Motijheel", "Jatrabari", "Gazipur", "Narayanganj", "Savar"],
  Chattogram: ["Agrabad", "Nasirabad", "Halishahar", "Panchlaish", "Khulshi", "Cox's Bazar"],
  Rajshahi: ["Shaheb Bazar", "Uposhohor", "Bogura", "Pabna"],
  Khulna: ["Sonadanga", "Khalishpur", "Jessore", "Kushtia"],
  Barishal: ["Nathullabad", "Rupatali", "Patuakhali"],
  Sylhet: ["Zindabazar", "Amberkhana", "Moulvibazar"],
  Rangpur: ["Jahaj Company More", "Dinajpur", "Lalmonirhat"],
  Mymensingh: ["Ganginarpar", "Jamalpur", "Netrokona"],
};
const TASKS: Record<string, { headline: string; jobs: string[] }> = {
  electrical: { headline: "Licensed electrician for homes and offices", jobs: ["Two ceiling fans are noisy and one has stopped.", "Replace the kitchen switchboard and add a socket.", "The main breaker keeps tripping in the evening.", "Install LED panel lights in the study room.", "Rewire the balcony lights."] },
  plumbing: { headline: "Plumbing repairs, fittings and leak detection", jobs: ["The kitchen tap is leaking all day.", "Bathroom drain is blocked.", "Fit a new commode and check the flush.", "Water pressure in the shower is very low.", "Replace a cracked pipe under the sink."] },
  "ac-repair": { headline: "AC servicing, gas refill and repairs", jobs: ["The split AC blows warm air.", "Annual servicing for two 1.5 ton ACs.", "AC is dripping water inside the room.", "Gas refill and cleaning for a window AC.", "Install a new split AC in the bedroom."] },
  "home-cleaning": { headline: "Deep cleaning for flats and offices", jobs: ["Deep clean of a two-bedroom flat.", "Kitchen and bathroom deep cleaning.", "Move-out cleaning for a three-bedroom flat.", "Sofa and carpet shampoo.", "Office cleaning after renovation."] },
  "appliance-repair": { headline: "Fridge, washing machine and oven repair", jobs: ["Fridge is not cooling properly.", "Washing machine does not spin.", "Microwave turns on but does not heat.", "Water purifier needs a filter change.", "Geyser is not heating water."] },
  painting: { headline: "Interior and exterior painting", jobs: ["Repaint the living room and dining area.", "Damp patches on the bedroom wall need treatment.", "Paint the front gate and grill.", "Two-bedroom flat repaint before moving in.", "Touch-up after plumbing work."] },
  carpentry: { headline: "Furniture repair and custom woodwork", jobs: ["Repair a wardrobe door hinge.", "Fix a wobbly dining table.", "Install new kitchen cabinet shutters.", "Make a bookshelf for the study.", "Door lock replacement and frame fix."] },
  "moving-shifting": { headline: "Packing, loading and house shifting", jobs: ["Shift a two-bedroom flat within the city.", "Move office furniture to a new floor.", "Pack and move a fridge and washing machine.", "Small move: ten boxes and a bed.", "Inter-city move with packing."] },
  "pest-control": { headline: "Cockroach, termite and rodent control", jobs: ["Cockroach treatment for the kitchen.", "Termite inspection for wooden furniture.", "Rodent control in the store room.", "Bed bug treatment for two rooms.", "Quarterly pest control for a restaurant."] },
  "computer-it": { headline: "Laptop, desktop and network support", jobs: ["Laptop is very slow and overheats.", "Set up home Wi-Fi with two routers.", "Desktop does not boot after a power cut.", "Install Windows and recover files.", "Printer is not connecting to the network."] },
};
const GENERIC = { headline: "Reliable home service professional", jobs: ["General repair visit.", "Inspection and estimate needed.", "Follow-up visit for earlier work."] };
const tasksFor = (slug: string) => TASKS[slug] ?? GENERIC;
const REVIEW_NOTES = ["The NID photo is blurred; please upload a clearer one.", "Name on the ID does not match the profile name.", "Please add at least one priced service.", "Selfie with ID is missing."];
const CANCEL_REASONS = ["Plans changed.", "Found someone closer.", "The problem fixed itself.", "Schedule clash, will book again later.", "Professional could not make the time."];
const DISPUTE_TEXT = ["The work is not finished properly.", "The professional did not come at the agreed time.", "The final price was higher than agreed.", "The same problem came back the next day.", "The professional was rude."];

// ---------------------------------------------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------------------------------------------

const prisma = createScriptClient();
try {
  console.log(`Seeding performance data into ${host} (${USERS} users, ${BOOKINGS} bookings, ${AUDIT} audit rows, ${DAYS} days) ...`);

  const existing = await prisma.user.count({ where: { email: { endsWith: `@${PERF_EMAIL_DOMAIN}` } } });
  if (existing > 0) {
    console.error(`${existing} performance users already exist. Run "npm run perf:clean" first.`);
    process.exit(1);
  }
  const categories = await prisma.serviceCategory.findMany({ where: { isActive: true }, select: { id: true, slug: true, name: true } });
  if (categories.length === 0) throw new Error("No active service categories: run the migrations and the reference seed first (npm run db:deploy && npm run db:seed).");
  const roles = new Map((await prisma.adminRole.findMany({ select: { id: true, key: true } })).map((r) => [r.key, r.id]));

  // ---- users ----------------------------------------------------------------------------------------------------
  type Kind = "customer" | "worker" | "both";
  type U = { id: string; name: string; createdAt: number; kind: Kind };
  const users: Prisma.UserCreateManyInput[] = [];
  const people: U[] = [];
  for (let i = 0; i < USERS; i++) {
    const kind = weighted<Kind>([[65, "customer"], [25, "worker"], [10, "both"]]);
    const first = chance(0.55) ? pick(MALE) : pick(FEMALE);
    const name = `${first} ${pick(SURNAMES)}`;
    // Professionals joined earlier than most customers, so the bookings of the last two months have published workers.
    const createdAt = kind === "customer" ? now - int(HOUR, 180 * DAY) : now - int(65 * DAY, 400 * DAY);
    const id = uuidv7(createdAt);
    const suspended = chance(0.015);
    users.push({
      id, name, email: `${name.toLowerCase().replace(/[^a-z]+/g, ".")}.${i + 1}@${PERF_EMAIL_DOMAIN}`, emailVerified: chance(0.92),
      createdAt: new Date(createdAt), updatedAt: new Date(createdAt),
      ...(suspended && { suspendedAt: between(createdAt, now), suspensionReason: "Repeated no-shows (performance seed)." }),
    });
    people.push({ id, name, createdAt, kind });
  }
  // Audit actors: admins with narrow (non-super) roles and no credential account, so they cannot sign in.
  const ADMIN_SPECS = [["verification_officer", 2], ["finance_admin", 1], ["operations_admin", 2], ["support_agent", 1]] as const;
  const admins = new Map<string, string[]>();
  for (const [roleKey, count] of ADMIN_SPECS) {
    const roleId = roles.get(roleKey);
    if (!roleId) continue;
    for (let n = 0; n < count; n++) {
      const createdAt = now - int(200 * DAY, 400 * DAY);
      const id = uuidv7(createdAt);
      users.push({ id, name: `${pick(MALE)} ${pick(SURNAMES)} (Perf admin)`, email: `admin.${roleKey}.${n + 1}@${PERF_EMAIL_DOMAIN}`, emailVerified: true, role: "ADMIN", adminRoleId: roleId, createdAt: new Date(createdAt), updatedAt: new Date(createdAt) });
      admins.set(roleKey, [...(admins.get(roleKey) ?? []), id]);
    }
  }
  const adminFor = (roleKey: string) => {
    const list = admins.get(roleKey) ?? admins.get("operations_admin") ?? [...admins.values()].flat();
    return list.length ? pick(list) : null;
  };

  // ---- profiles -------------------------------------------------------------------------------------------------
  const customerProfiles: Prisma.CustomerProfileCreateManyInput[] = [];
  const customers: U[] = [];
  type W = { profileId: string; userId: string; name: string; areas: string[]; publishedAt: number | null; services: { categoryId: string; slug: string; name: string; model: PricingModel; price: number | null }[] };
  const workerProfiles: Prisma.WorkerProfileCreateManyInput[] = [];
  const workerServices: Prisma.WorkerServiceCreateManyInput[] = [];
  const availability: Prisma.WorkerAvailabilityRuleCreateManyInput[] = [];
  const workers: W[] = [];
  const reviewedWorkers: { profileId: string; status: VerificationStatus; at: number }[] = [];

  for (const p of people) {
    if (p.kind !== "worker") {
      customerProfiles.push({ id: uuidv7(p.createdAt), userId: p.id, displayName: p.name, preferredDivision: chance(0.8) ? weighted(DIVISIONS.map((d, i) => [i === 0 ? 8 : 1, d] as [number, string])) : null, createdAt: new Date(p.createdAt), updatedAt: new Date(p.createdAt) });
      customers.push(p);
    }
    if (p.kind === "customer") continue;

    const status = weighted<VerificationStatus>([[60, "VERIFIED"], [15, "PENDING"], [5, "RESUBMISSION_REQUIRED"], [5, "REJECTED"], [15, "NOT_SUBMITTED"]]);
    const submitted = status !== "NOT_SUBMITTED";
    const areas = faker.helpers.arrayElements([...DIVISIONS], int(1, 3));
    if (chance(0.6) && !areas.includes("Dhaka")) areas[0] = "Dhaka";
    const chosen = faker.helpers.arrayElements(categories, int(1, Math.min(3, categories.length)));
    const services = chosen.map((c) => {
      const model = weighted<PricingModel>([[45, "FIXED"], [35, "HOURLY"], [20, "QUOTE"]]);
      const price = model === "FIXED" ? step(300, 3000, 50) : model === "HOURLY" ? step(200, 900, 50) : null;
      return { categoryId: c.id, slug: c.slug, name: c.name, model, price };
    });
    const priced = services.flatMap((s) => (s.price === null ? [] : [s.price]));
    const submittedAt = submitted ? between(p.createdAt, p.createdAt + 5 * DAY).getTime() : null;
    const reviewed = status === "VERIFIED" || status === "REJECTED" || status === "RESUBMISSION_REQUIRED";
    const reviewedAt = reviewed ? between(submittedAt!, submittedAt! + 3 * DAY).getTime() : null;
    const published = status === "VERIFIED" && chance(0.92);
    const publishedAt = published ? between(reviewedAt!, reviewedAt! + 2 * DAY).getTime() : null;
    const suspended = published && chance(0.04);
    const profileId = uuidv7(p.createdAt);
    const years = int(1, 25);
    const headline = tasksFor(services[0]!.slug).headline;

    workerProfiles.push({
      id: profileId, userId: p.id,
      onboardingStatus: submitted ? "SUBMITTED" : "DRAFT", onboardingStep: submitted ? 5 : int(1, 4),
      displayName: p.name, headline, bio: `${years} years of experience in ${services.map((s) => s.name.toLowerCase()).join(", ")}. Serving ${areas.join(", ")}. ${faker.helpers.arrayElement(["Punctual and tidy.", "Brings own tools.", "Fair prices, clear estimates.", "Available on short notice.", "Warranty on all work."])}`,
      experienceYears: years, languages: chance(0.5) ? ["Bangla", "English"] : ["Bangla"], serviceAreas: areas,
      submittedAt: submittedAt === null ? null : new Date(submittedAt),
      verificationStatus: status,
      reviewedById: reviewed ? adminFor("verification_officer") : null,
      reviewedAt: reviewedAt === null ? null : new Date(reviewedAt),
      reviewNote: status === "REJECTED" || status === "RESUBMISSION_REQUIRED" ? pick(REVIEW_NOTES) : null,
      slug: published ? `${p.name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-${randomBytes(4).toString("hex")}` : null,
      publishedAt: publishedAt === null ? null : new Date(publishedAt),
      ...(suspended && { suspendedAt: between(publishedAt!, now), suspensionReason: "Customer complaints under review (performance seed)." }),
      startingPriceBdt: priced.length ? Math.min(...priced) : null,
      createdAt: new Date(p.createdAt), updatedAt: new Date(p.createdAt),
    });
    for (const s of services) workerServices.push({ id: uuidv7(p.createdAt), workerProfileId: profileId, categoryId: s.categoryId, pricingModel: s.model, basePriceBdt: s.price, pricingNotes: s.model === "QUOTE" ? "Price after inspection." : null });
    if (status === "VERIFIED") {
      const start = pick([8, 9, 10]) * 60;
      const end = pick([17, 18, 20]) * 60;
      for (const weekday of chance(0.4) ? [0, 1, 2, 3, 4, 6] : [0, 1, 2, 3, 4]) availability.push({ id: uuidv7(p.createdAt), workerProfileId: profileId, weekday, startMinute: start, endMinute: end, createdAt: new Date(p.createdAt) });
    }
    if (reviewed) reviewedWorkers.push({ profileId, status, at: reviewedAt! });
    if (published && !suspended) workers.push({ profileId, userId: p.id, name: p.name, areas, publishedAt, services });
  }

  // ---- bookings -------------------------------------------------------------------------------------------------
  const bookings: Prisma.BookingCreateManyInput[] = [];
  const quotes: Prisma.QuoteCreateManyInput[] = [];
  const events: Prisma.BookingEventCreateManyInput[] = [];
  const disputes: Prisma.DisputeCreateManyInput[] = [];
  const disputeMessages: Prisma.DisputeMessageCreateManyInput[] = [];
  const payments: Prisma.PaymentCreateManyInput[] = [];
  const refunds: Prisma.RefundCreateManyInput[] = [];
  const disputeIds: string[] = [];
  const busy = new Map<string, [number, number][]>();
  const stats = { bookings: {} as Record<string, number>, payments: {} as Record<string, number>, collectedBdt: 0, refundedBdt: 0 };
  let paymentN = 0;
  let refundN = 0;

  if (BOOKINGS > 0 && (workers.length === 0 || customers.length === 0)) throw new Error("Not enough published professionals or customers to create bookings; raise --users.");

  /** Pareto-ish: a few professionals get many bookings (busy profile pages), most get a handful. */
  const pickWorker = () => workers[Math.floor(workers.length * faker.number.float({ min: 0, max: 0.9999 }) ** 1.6)]!;
  const STATUS_WEIGHTS: [number, BookingStatus][] = [[34, "COMPLETED"], [10, "CONFIRMED"], [10, "REQUESTED"], [5, "QUOTED"], [2, "IN_PROGRESS"], [6, "COMPLETION_PENDING"], [14, "CANCELLED"], [6, "DECLINED"], [7, "EXPIRED"], [6, "DISPUTED"]];
  const DAY_RANGE: Record<BookingStatus, [number, number]> = {
    COMPLETED: [-(DAYS - 1), 0], COMPLETION_PENDING: [-6, -1], DISPUTED: [-Math.min(40, DAYS), -2], CANCELLED: [-Math.min(50, DAYS), 20],
    DECLINED: [-Math.min(50, DAYS), 10], EXPIRED: [-Math.min(50, DAYS), -1], REQUESTED: [1, 21], QUOTED: [2, 21], CONFIRMED: [1, 30], IN_PROGRESS: [0, 0],
  };

  for (let n = 0; n < BOOKINGS; n++) {
    const status = weighted(STATUS_WEIGHTS);
    // Find a professional, a free slot and a customer who already had an account at that time.
    let slot: { worker: W; startAt: number; minutes: number } | null = null;
    for (let attempt = 0; attempt < 40 && !slot; attempt++) {
      const worker = pickWorker();
      const service = pick(worker.services);
      const minutes = service.model === "FIXED" ? step(60, 180, 30) : step(60, 240, 30);
      let startAt: number;
      if (status === "IN_PROGRESS") {
        startAt = Math.floor((now - int(15 * MIN, 90 * MIN)) / (5 * MIN)) * 5 * MIN;
      } else {
        const [lo, hi] = DAY_RANGE[status];
        startAt = dhakaAt(int(lo, hi), step(8 * 60, 21 * 60 - minutes, 30));
      }
      const endAt = startAt + minutes * MIN;
      if (status === "IN_PROGRESS" && endAt <= now) continue;
      if (status === "COMPLETED" && endAt + HOUR > now) continue; // today's completed work must already be over
      if (worker.publishedAt !== null && worker.publishedAt > startAt - 8 * DAY) continue;
      if ((busy.get(worker.profileId) ?? []).some(([s, e]) => s < endAt && startAt < e)) continue;
      slot = { worker, startAt, minutes };
    }
    if (!slot) continue;
    const { worker, startAt, minutes } = slot;
    const endAt = startAt + minutes * MIN;
    busy.set(worker.profileId, [...(busy.get(worker.profileId) ?? []), [startAt, endAt]]);

    const service = pick(worker.services);
    const createdAt = Math.min(startAt - int(HOUR, 7 * DAY), now - int(10 * MIN, 2 * DAY));
    let customer = pick(customers);
    for (let t = 0; t < 20 && (customer.createdAt > createdAt || customer.id === worker.userId); t++) customer = pick(customers);
    if (customer.id === worker.userId) continue;

    const bookingId = uuidv7(createdAt);
    const division = pick(worker.areas);
    const confirmed = ["CONFIRMED", "IN_PROGRESS", "COMPLETION_PENDING", "COMPLETED", "DISPUTED"].includes(status) || (status === "CANCELLED" && chance(0.5));
    const confirmedAt = confirmed ? between(createdAt + 10 * MIN, Math.min(createdAt + 20 * HOUR, startAt - 10 * MIN)).getTime() : null;
    const disputeFrom: BookingStatus = chance(0.7) ? "COMPLETION_PENDING" : "CONFIRMED";
    const worked = status === "COMPLETION_PENDING" || status === "COMPLETED" || (status === "DISPUTED" && disputeFrom === "COMPLETION_PENDING");
    const arrivedAt = worked || status === "IN_PROGRESS" ? startAt - int(0, 15) * MIN : null;
    const startedAt = worked || status === "IN_PROGRESS" ? startAt : null;
    const completionAt = worked ? endAt + int(0, 30) * MIN : null;

    // Price: snapshot from the service; QUOTE work is priced by a quote.
    const unit = service.price;
    let amount: number | null = null;
    let acceptedQuoteId: string | null = null;
    if (service.model === "FIXED") amount = unit;
    else if (service.model === "HOURLY") amount = Math.round((unit! * minutes) / 60);
    if (service.model === "QUOTE" && (confirmed || status === "QUOTED")) {
      const labor = step(500, 6000, 50);
      const materials = chance(0.5) ? step(100, 3000, 50) : 0;
      const quoteAt = between(createdAt + 5 * MIN, (confirmedAt ?? startAt) - 5 * MIN).getTime();
      const quoteId = uuidv7(quoteAt);
      quotes.push({
        id: quoteId, bookingId, status: status === "QUOTED" ? "PENDING" : "ACCEPTED", laborBdt: labor, materialsBdt: materials, otherBdt: 0, totalBdt: labor + materials,
        description: "Inspection, labour and parts as discussed.", terms: "Valid for 48 hours.", estimatedDurationMinutes: minutes,
        expiresAt: new Date(status === "QUOTED" ? now + int(1, 3) * DAY : quoteAt + 2 * DAY), createdByUserId: worker.userId,
        decidedAt: status === "QUOTED" ? null : new Date(confirmedAt!), createdAt: new Date(quoteAt),
      });
      events.push({ id: uuidv7(quoteAt), bookingId, actorUserId: worker.userId, actorRole: "WORKER", type: "booking.quoted", fromStatus: "REQUESTED", toStatus: "QUOTED", createdAt: new Date(quoteAt) });
      amount = labor + materials;
      if (confirmed) acceptedQuoteId = quoteId;
    }

    const cancelledAt = status === "CANCELLED" ? between(confirmedAt ?? createdAt + 10 * MIN, startAt - 30 * MIN).getTime() : null;
    const cancelledBy = status === "CANCELLED" ? (chance(0.75) ? customer.id : worker.userId) : null;
    const reason = status === "CANCELLED" ? pick(CANCEL_REASONS) : null;
    const task = pick(tasksFor(service.slug).jobs);

    // ---- payments (COMPLETED = a verified payment completed it; see docs/BOOKINGS.md) ----
    let completedAt: number | null = null;
    if (status === "COMPLETED") {
      let attemptAt = Math.min(completionAt! + int(2 * MIN, 6 * HOUR), now - 3 * MIN);
      const succeededAt = Math.min(attemptAt + int(1, 10) * MIN, now - MIN);
      attemptAt = Math.min(attemptAt, succeededAt - MIN);
      completedAt = succeededAt;
      if (chance(0.15)) {
        const failedAt = attemptAt - int(5 * MIN, 2 * HOUR);
        const failedStatus = weighted<PaymentStatus>([[60, "FAILED"], [25, "CANCELLED"], [15, "EXPIRED"]]);
        payments.push({
          id: uuidv7(failedAt), reference: reference("FIN"), bookingId, customerId: customer.id, provider: "BKASH", isLive: false, status: failedStatus, amountBdt: amount!,
          idempotencyKey: key("pay", ++paymentN), providerPaymentId: `PERF${hex(10)}`, failureCode: failedStatus === "FAILED" ? pick(["insufficient_balance", "otp_failed", "provider_timeout"]) : null,
          initiatedAt: new Date(failedAt), lastVerifiedAt: new Date(failedAt + 10 * MIN), verificationAttempts: 1, createdAt: new Date(failedAt), updatedAt: new Date(failedAt + 10 * MIN),
        });
        stats.payments[failedStatus] = (stats.payments[failedStatus] ?? 0) + 1;
      }
      const paymentId = uuidv7(attemptAt);
      let paymentStatus: PaymentStatus = "SUCCEEDED";
      let refunded = 0;
      const refundRoll = succeededAt < now - DAY ? faker.number.float({ min: 0, max: 1 }) : 1;
      if (refundRoll < 0.11) {
        // 0-5%: partial refund done, 5-8%: full refund done, 8-10%: refund waiting for a decision, 10-11%: refund rejected
        const full = refundRoll >= 0.05 && refundRoll < 0.08;
        const open = refundRoll >= 0.08 && refundRoll < 0.1;
        const rejected = refundRoll >= 0.1;
        const requested = full ? amount! : Math.max(1, Math.round(amount! * faker.number.float({ min: 0.2, max: 0.6 })));
        const requestedAt = between(succeededAt + HOUR, succeededAt + 5 * DAY, now - 12 * HOUR).getTime();
        const doneAt = open ? null : between(requestedAt + 30 * MIN, requestedAt + 5 * DAY).getTime();
        refunds.push({
          id: uuidv7(requestedAt), paymentId, requestedByUserId: customer.id, requestedByRole: "CUSTOMER", requestedAmountBdt: requested,
          approvedAmountBdt: open || rejected ? null : requested, reason: pick(["Part of the work was not done.", "Booked by mistake.", "Overcharged for materials.", "The professional agreed to a partial refund."]),
          status: open ? "REQUESTED" : rejected ? "REJECTED" : "SUCCEEDED",
          decidedByUserId: open ? null : adminFor("finance_admin"), decidedAt: doneAt === null ? null : new Date(doneAt - 20 * MIN),
          decisionNote: rejected ? "The work was completed as agreed." : null, providerRefundReference: reference("RFD"),
          providerRefundId: open || rejected ? null : `PERFRF${hex(8)}`, completedAt: open || rejected ? null : new Date(doneAt!),
          idempotencyKey: key("refund", ++refundN), createdAt: new Date(requestedAt), updatedAt: new Date(doneAt ?? requestedAt),
        });
        if (!open && !rejected) {
          refunded = requested;
          paymentStatus = full ? "REFUNDED" : "PARTIALLY_REFUNDED";
          stats.refundedBdt += requested;
        }
      }
      payments.push({
        id: paymentId, reference: reference("FIN"), bookingId, customerId: customer.id, provider: "BKASH", isLive: false, status: paymentStatus, amountBdt: amount!,
        refundedAmountBdt: refunded, idempotencyKey: key("pay", ++paymentN), providerPaymentId: `PERF${hex(10)}`, providerTransactionId: `PERFTX${hex(6)}`,
        initiatedAt: new Date(attemptAt), callbackReceivedAt: new Date(succeededAt), executeStartedAt: new Date(succeededAt), lastVerifiedAt: new Date(succeededAt),
        verificationAttempts: 1, succeededAt: new Date(succeededAt), createdAt: new Date(attemptAt), updatedAt: new Date(succeededAt),
      });
      stats.payments[paymentStatus] = (stats.payments[paymentStatus] ?? 0) + 1;
      stats.collectedBdt += amount!;
    } else if (status === "COMPLETION_PENDING") {
      const roll = weighted<"INITIATED" | "FAILED" | "none">([[40, "INITIATED"], [30, "FAILED"], [30, "none"]]);
      if (roll !== "none") {
        const at = between(completionAt! + 2 * MIN, completionAt! + DAY).getTime();
        payments.push({
          id: uuidv7(at), reference: reference("FIN"), bookingId, customerId: customer.id, provider: "BKASH", isLive: false, status: roll, amountBdt: amount!,
          idempotencyKey: key("pay", ++paymentN), providerPaymentId: `PERF${hex(10)}`, failureCode: roll === "FAILED" ? "insufficient_balance" : null,
          initiatedAt: new Date(at), verificationAttempts: roll === "FAILED" ? 1 : 0, createdAt: new Date(at), updatedAt: new Date(at),
        });
        stats.payments[roll] = (stats.payments[roll] ?? 0) + 1;
      }
    }

    bookings.push({
      id: bookingId, customerId: customer.id, workerProfileId: worker.profileId, categoryId: service.categoryId, status,
      description: `${task} ${faker.helpers.arrayElement(["Please call before coming.", "Flat is on the 4th floor, there is a lift.", "Weekend visit preferred.", "Parking is available.", ""])}`.trim(),
      serviceArea: division, serviceAddress: `House ${int(1, 120)}, Road ${int(1, 30)}, ${pick(AREAS[division] ?? [division])}, ${division}`,
      startAt: new Date(startAt), endAt: new Date(endAt), durationMinutes: minutes,
      pricingModel: service.model, unitPriceBdt: unit,
      pricingSnapshot: { categoryName: service.name, workerDisplayName: worker.name, pricingModel: service.model, basePriceBdt: unit, pricingNotes: service.model === "QUOTE" ? "Price after inspection." : null },
      agreedAmountBdt: confirmed ? amount : null, acceptedQuoteId,
      confirmedAt: confirmedAt === null ? null : new Date(confirmedAt),
      arrivedAt: arrivedAt === null ? null : new Date(arrivedAt), startedAt: startedAt === null ? null : new Date(startedAt),
      completionRequestedAt: completionAt === null ? null : new Date(completionAt), completedAt: completedAt === null ? null : new Date(completedAt),
      cancelledAt: cancelledAt === null ? null : new Date(cancelledAt), cancelledByUserId: cancelledBy, cancellationReason: reason,
      idempotencyKey: key("booking", n + 1), createdAt: new Date(createdAt), updatedAt: new Date(Math.max(createdAt, completedAt ?? cancelledAt ?? completionAt ?? startedAt ?? confirmedAt ?? createdAt)),
    });
    stats.bookings[status] = (stats.bookings[status] ?? 0) + 1;

    // ---- history ----
    const ev = (at: number, actorUserId: string | null, actorRole: "CUSTOMER" | "WORKER" | "SYSTEM", type: string, from: BookingStatus | null, to: BookingStatus | null, why?: string) =>
      events.push({ id: uuidv7(at), bookingId, actorUserId, actorRole, type, fromStatus: from, toStatus: to, reason: why ?? null, createdAt: new Date(at) });
    ev(createdAt, customer.id, "CUSTOMER", "booking.requested", null, "REQUESTED");
    if (confirmedAt !== null) ev(confirmedAt, worker.userId, "WORKER", "booking.accepted", acceptedQuoteId ? "QUOTED" : "REQUESTED", "CONFIRMED");
    if (startedAt !== null) {
      ev(arrivedAt!, worker.userId, "WORKER", "booking.arrived", "CONFIRMED", "CONFIRMED");
      ev(startedAt, worker.userId, "WORKER", "booking.started", "CONFIRMED", "IN_PROGRESS");
    }
    if (completionAt !== null) ev(completionAt, worker.userId, "WORKER", "booking.completion_requested", "IN_PROGRESS", "COMPLETION_PENDING");
    if (completedAt !== null) ev(completedAt, null, "SYSTEM", "booking.completed", "COMPLETION_PENDING", "COMPLETED");
    if (status === "CANCELLED") ev(cancelledAt!, cancelledBy, cancelledBy === customer.id ? "CUSTOMER" : "WORKER", "booking.cancelled", confirmedAt ? "CONFIRMED" : "REQUESTED", "CANCELLED", reason!);
    if (status === "DECLINED") ev(between(createdAt + 10 * MIN, Math.min(createdAt + DAY, startAt)).getTime(), worker.userId, "WORKER", "booking.declined", "REQUESTED", "DECLINED", "Not available at that time.");
    if (status === "EXPIRED") ev(Math.min(startAt, now - MIN), null, "SYSTEM", "booking.expired", "REQUESTED", "EXPIRED");

    // ---- dispute ----
    if (status === "DISPUTED") {
      const openedAt = between((completionAt ?? endAt) + HOUR, (completionAt ?? endAt) + DAY).getTime();
      const disputeStatus = weighted<DisputeStatus>([[50, "OPEN"], [35, "UNDER_REVIEW"], [15, "WAITING_FOR_INFORMATION"]]);
      const disputeId = uuidv7(openedAt);
      const text = pick(DISPUTE_TEXT);
      disputes.push({
        id: disputeId, bookingId, openedByUserId: customer.id, openedByRole: "CUSTOMER",
        category: disputeFrom === "CONFIRMED" ? "NO_SHOW" : pick(["SERVICE_QUALITY", "PRICE_DISAGREEMENT", "CONDUCT", "OTHER"] as const),
        description: text, status: disputeStatus, previousBookingStatus: disputeFrom,
        assignedAdminId: disputeStatus === "OPEN" ? null : adminFor("operations_admin"), createdAt: new Date(openedAt), updatedAt: new Date(openedAt),
      });
      disputeMessages.push({ id: uuidv7(openedAt + MIN), disputeId, authorUserId: customer.id, authorRole: "CUSTOMER", body: `${text} I would like an administrator to review it.`, createdAt: new Date(openedAt + MIN) });
      ev(openedAt, customer.id, "CUSTOMER", "dispute.opened", disputeFrom, "DISPUTED");
      disputeIds.push(disputeId);
    }
  }

  // ---- audit log ------------------------------------------------------------------------------------------------
  const userIds = people.map((p) => p.id);
  const successful = payments.filter((p) => p.status !== "FAILED" && p.status !== "CANCELLED" && p.status !== "EXPIRED").map((p) => p.id!);
  const decidedRefunds = refunds.filter((r) => r.status !== "REQUESTED").map((r) => r.id!);
  const SETTINGS = ["platform.maintenanceMessage", "platform.registrationsOpen", "workers.requireIdentityDocuments", "finance.commissionBps", "ai.assistantEnabled"];
  type A = { weight: number; action: string; role: string; targetType: string; target: () => string; meta: () => Record<string, unknown> };
  const ACTIONS: A[] = [
    { weight: 18, action: "worker.verification.review", role: "verification_officer", targetType: "WorkerProfile", target: () => pick(reviewedWorkers).profileId, meta: () => ({ decision: pick(["VERIFIED", "VERIFIED", "REJECTED", "RESUBMISSION_REQUIRED"]) }) },
    { weight: 14, action: "worker.document.view", role: "verification_officer", targetType: "WorkerProfile", target: () => pick(reviewedWorkers).profileId, meta: () => ({ kind: pick(["NID_FRONT", "NID_BACK", "SELFIE_WITH_ID"]) }) },
    { weight: 3, action: "worker.suspend", role: "operations_admin", targetType: "WorkerProfile", target: () => pick(workers).profileId, meta: () => ({ reason: "Customer complaints under review." }) },
    { weight: 2, action: "worker.unsuspend", role: "operations_admin", targetType: "WorkerProfile", target: () => pick(workers).profileId, meta: () => ({}) },
    { weight: 3, action: "user.suspend", role: "operations_admin", targetType: "User", target: () => pick(userIds), meta: () => ({ reason: "Repeated no-shows." }) },
    { weight: 2, action: "user.restore", role: "operations_admin", targetType: "User", target: () => pick(userIds), meta: () => ({}) },
    { weight: 12, action: "payment.reconcile", role: "finance_admin", targetType: "Payment", target: () => pick(successful), meta: () => ({ result: pick(["unchanged", "SUCCEEDED", "FAILED"]) }) },
    { weight: 6, action: "refund.approve", role: "finance_admin", targetType: "Refund", target: () => pick(decidedRefunds), meta: () => ({ approvedAmountBdt: step(100, 3000, 50) }) },
    { weight: 2, action: "refund.reject", role: "finance_admin", targetType: "Refund", target: () => pick(decidedRefunds), meta: () => ({ note: "The work was completed as agreed." }) },
    { weight: 8, action: "dispute.review", role: "operations_admin", targetType: "Dispute", target: () => pick(disputeIds), meta: () => ({}) },
    { weight: 4, action: "dispute.request_info", role: "operations_admin", targetType: "Dispute", target: () => pick(disputeIds), meta: () => ({}) },
    { weight: 4, action: "dispute.resolve", role: "operations_admin", targetType: "Dispute", target: () => pick(disputeIds), meta: () => ({ outcome: pick(["MARK_COMPLETED", "CANCEL_BOOKING", "RESTORE_BOOKING"]) }) },
    { weight: 5, action: "finance.export", role: "finance_admin", targetType: "Report", target: () => "commission", meta: () => ({ days: int(7, 60), rateBps: pick([0, 500, 1000]) }) },
    { weight: 2, action: "audit.export", role: "operations_admin", targetType: "AuditLog", target: () => "export", meta: () => ({ rows: int(10, 5000) }) },
    { weight: 3, action: "setting.update", role: "operations_admin", targetType: "PlatformSetting", target: () => pick(SETTINGS), meta: () => ({}) },
    { weight: 2, action: "category.update", role: "operations_admin", targetType: "ServiceCategory", target: () => pick(categories).id, meta: () => ({ fields: ["description"] }) },
  ];
  // Drop actions whose target pool is empty (e.g. no disputes in a tiny run): arrayElement throws on an empty list.
  const usable = ACTIONS.filter((a) => {
    try {
      a.target();
      return true;
    } catch {
      return false;
    }
  });
  const auditTimes = Array.from({ length: usable.length && admins.size ? AUDIT : 0 }, () => now - int(MIN, DAYS * DAY)).sort((a, b) => a - b);
  const audit: Prisma.AuditLogCreateManyInput[] = auditTimes.map((at) => {
    const a = weighted(usable.map((x) => [x.weight, x] as [number, A]));
    return { id: uuidv7(at), actorId: adminFor(a.role), action: a.action, targetType: a.targetType, targetId: a.target(), metadata: { ...a.meta(), perfSeed: PERF_MARKER }, createdAt: new Date(at) };
  });

  // ---- write everything in one transaction ----------------------------------------------------------------------
  const t0 = Date.now();
  await prisma.$transaction(
    async (tx) => {
      await inChunks(users, 1000, (c) => tx.user.createMany({ data: c }));
      await inChunks(customerProfiles, 1000, (c) => tx.customerProfile.createMany({ data: c }));
      await inChunks(workerProfiles, 1000, (c) => tx.workerProfile.createMany({ data: c }));
      await inChunks(workerServices, 1000, (c) => tx.workerService.createMany({ data: c }));
      await inChunks(availability, 1000, (c) => tx.workerAvailabilityRule.createMany({ data: c }));
      await inChunks(bookings, 500, (c) => tx.booking.createMany({ data: c }));
      await inChunks(quotes, 1000, (c) => tx.quote.createMany({ data: c }));
      await inChunks(events, 1000, (c) => tx.bookingEvent.createMany({ data: c }));
      await inChunks(disputes, 1000, (c) => tx.dispute.createMany({ data: c }));
      await inChunks(disputeMessages, 1000, (c) => tx.disputeMessage.createMany({ data: c }));
      await inChunks(payments, 1000, (c) => tx.payment.createMany({ data: c }));
      await inChunks(refunds, 1000, (c) => tx.refund.createMany({ data: c }));
      // Oldest first, so the hash chain's seq order matches createdAt order.
      await inChunks(audit, 500, (c) => tx.auditLog.createMany({ data: c }));
    },
    { timeout: 15 * 60_000, maxWait: 30_000 },
  );

  const workerCount = people.filter((p) => p.kind !== "customer").length;
  console.log(`Done in ${((Date.now() - t0) / 1000).toFixed(1)} s.`);
  console.log(`Users: ${people.length} (${customers.length} with a customer profile, ${workerCount} with a worker profile, ${workers.length} bookable) + ${users.length - people.length} perf admins`);
  console.log(`Worker services: ${workerServices.length}, availability rules: ${availability.length}`);
  console.log(`Bookings: ${bookings.length} ${JSON.stringify(stats.bookings)}`);
  console.log(`Quotes: ${quotes.length}, booking events: ${events.length}, disputes: ${disputes.length}`);
  console.log(`Payments: ${payments.length} ${JSON.stringify(stats.payments)}, refunds: ${refunds.length}`);
  console.log(`Collected (successful payments): ${stats.collectedBdt} BDT, refunded: ${stats.refundedBdt} BDT, over the last ${DAYS} days`);
  console.log(`Audit log entries: ${audit.length}`);
  if (bookings.length < BOOKINGS) console.log(`Note: ${BOOKINGS - bookings.length} bookings were skipped because no free slot was found.`);
  console.log(`Markers: users @${PERF_EMAIL_DOMAIN}, idempotency keys "${PERF_KEY_PREFIX}...", audit metadata.perfSeed = "${PERF_MARKER}". Remove with: npm run perf:clean`);
} finally {
  await prisma.$disconnect();
}
