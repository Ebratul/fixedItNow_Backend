import type { NestExpressApplication } from "@nestjs/platform-express";
import { Test } from "@nestjs/testing";
import request from "supertest";
import { AppModule } from "../src/app.module.js";
import { configureApp } from "../src/app.setup.js";
import { ENV, loadEnv } from "../src/config/env.js";
import { Clock } from "../src/bookings/clock.js";
import { MailService } from "../src/mail/mail.service.js";
import { PrismaService } from "../src/prisma/prisma.service.js";
import { testDatabaseUrl } from "./test-db.js";

/** Controllable time for the booking domain (the real clock is never slept on). */
export class FakeClock extends Clock {
  private current: Date;
  constructor(iso = "2026-11-01T06:00:00Z") { // Sunday 12:00 in Asia/Dhaka
    super();
    this.current = new Date(iso);
  }
  override now() { return new Date(this.current); }
  set(date: Date | string) { this.current = new Date(date); }
  advanceMinutes(minutes: number) { this.current = new Date(this.current.getTime() + minutes * 60_000); }
}

export const WEB_ORIGIN = "http://localhost:3000";
export const PASSWORD = "correct-horse-battery";

export type TestApp = Awaited<ReturnType<typeof createTestApp>>;

export async function createTestApp(overrides: Record<string, string> = {}) {
  const env = loadEnv({
    NODE_ENV: "test",
    DATABASE_URL: testDatabaseUrl(),
    BETTER_AUTH_SECRET: "test-secret-test-secret-test-secret-123456",
    BETTER_AUTH_URL: WEB_ORIGIN,
    FRONTEND_ORIGIN: WEB_ORIGIN,
    MAIL_TRANSPORT: "console",
    // Most tests make many sign-ins from one IP; dedicated tests turn this on.
    RATE_LIMIT_ENABLED: "false",
    ...overrides,
  });

  const clock = new FakeClock();
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(ENV)
    .useValue(env)
    .overrideProvider(Clock)
    .useValue(clock)
    .compile();

  const app = moduleRef.createNestApplication<NestExpressApplication>({
    bodyParser: false,
    logger: process.env.TEST_LOG ? ["error"] : false,
  });
  configureApp(app);
  await app.init();

  const prisma = app.get(PrismaService);
  const mail = app.get(MailService);
  const server = app.getHttpServer();
  const api = "/api/v1";

  /** Fresh cookie-keeping client that always sends the web app's Origin. */
  const client = () => request.agent(server).set("Origin", WEB_ORIGIN);

  async function resetData() {
    await prisma.$executeRawUnsafe(
      `TRUNCATE "dispute_message","dispute","booking_event","reschedule_request","quote","booking","worker_time_off","worker_availability_rule","audit_log","favorite","worker_service","worker_profile","customer_profile","session","account","verification","rateLimit","user" CASCADE`,
    );
    mail.outbox.length = 0;
    clock.set("2026-11-01T06:00:00Z");
  }

  /** Latest captured email of a kind, and the in-app path of its link. */
  function lastLink(kind: string, to: string) {
    const message = [...mail.outbox].reverse().find((m) => m.kind === kind && m.to === to);
    if (!message) return undefined;
    const url = new URL(/https?:\/\/\S+/.exec(message.text)![0]);
    return url.pathname + url.search;
  }

  /** Registers, verifies via the emailed link, and returns a logged-in client. */
  async function signUpAndLogin(email: string, name = "Test User") {
    const agent = client();
    await agent.post(`${api}/auth/sign-up/email`).send({ name, email, password: PASSWORD });
    const link = lastLink("verify-email", email);
    if (!link) throw new Error("verification email was not sent");
    await agent.get(link); // verifies + sets the session cookie
    const me = await agent.get(`${api}/me`);
    if (me.status !== 200) throw new Error(`login failed: ${me.status}`);
    return { agent, userId: me.body.user.id as string, email };
  }

  /** Simulates the trusted operator process (`npm run admin:grant`). */
  async function makeAdmin(userId: string) {
    await prisma.user.update({ where: { id: userId }, data: { role: "ADMIN" } });
  }

  async function newAdmin() {
    const admin = await signUpAndLogin(uniqueEmail("admin"));
    await makeAdmin(admin.userId);
    return admin;
  }

  /**
   * Creates a worker through the real API. `stage` controls how far the
   * profile gets: draft -> submitted (PENDING) -> approved (VERIFIED) -> published.
   */
  async function createWorker(
    opts: Partial<typeof validWorkerProfile> & {
      stage?: "draft" | "submitted" | "approved" | "published";
      admin?: Awaited<ReturnType<typeof signUpAndLogin>>;
    } = {},
  ) {
    const { stage = "published", admin: givenAdmin, ...profileOverrides } = opts;
    const worker = await signUpAndLogin(uniqueEmail("w"));
    const body = { ...validWorkerProfile, ...profileOverrides };
    const saved = await worker.agent.put(`${api}/me/worker-profile`).send(body);
    if (saved.status !== 200) throw new Error(`save failed ${saved.status} ${JSON.stringify(saved.body)}`);
    const profileId = saved.body.profile.id as string;
    let slug: string | undefined;
    if (stage !== "draft") {
      const sub = await worker.agent.post(`${api}/me/worker-profile/submit`).send({});
      if (sub.status !== 200) throw new Error(`submit failed ${sub.status}`);
    }
    if (stage === "approved" || stage === "published") {
      const admin = givenAdmin ?? (await newAdmin());
      const rev = await admin.agent.post(`${api}/admin/workers/${profileId}/verification`).send({ decision: "VERIFIED" });
      if (rev.status !== 200) throw new Error(`review failed ${rev.status}`);
    }
    if (stage === "published") {
      const pub = await worker.agent.post(`${api}/me/worker-profile/publish`).send({});
      if (pub.status !== 200) throw new Error(`publish failed ${pub.status}`);
      slug = pub.body.profile.slug as string;
    }
    return { ...worker, profileId, slug };
  }

  return {
    app, prisma, mail, env, clock, api, client, resetData, lastLink, signUpAndLogin, makeAdmin,
    newAdmin, createWorker,
    close: () => app.close(),
  };
}

let counter = 0;
export const uniqueEmail = (prefix = "user") =>
  `${prefix}${Date.now().toString(36)}${counter++}@example.com`;

export const validWorkerProfile = {
  displayName: "Rahim Uddin",
  headline: "Licensed electrician",
  bio: "Ten years of residential wiring, fan and light fitting across Dhaka.",
  experienceYears: 10,
  languages: ["Bangla", "English"],
  serviceAreas: ["Dhaka"],
  services: [
    { categorySlug: "electrical", pricingModel: "FIXED", basePriceBdt: 500 },
    { categorySlug: "ac-repair", pricingModel: "QUOTE" },
  ],
};
