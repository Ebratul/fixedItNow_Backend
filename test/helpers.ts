import type { NestExpressApplication } from "@nestjs/platform-express";
import { Test } from "@nestjs/testing";
import request from "supertest";
import { AppModule } from "../src/app.module.js";
import { configureApp } from "../src/app.setup.js";
import { ENV, loadEnv } from "../src/config/env.js";
import { Clock } from "../src/bookings/clock.js";
import { AiClient } from "../src/ai/ai-client.js";
import { DEFAULT_ROLES } from "../src/admin/permissions.js";
import { SettingsService } from "../src/admin/settings/settings.service.js";
import { MailService } from "../src/mail/mail.service.js";
import { HttpClient } from "../src/payments/providers/http.js";
import { PrismaService } from "../src/prisma/prisma.service.js";
import { FakeProviderNet } from "./fake-providers.js";
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

export async function createTestApp(overrides: Record<string, string> = {}, fakes: { aiClient?: Pick<AiClient, "chat"> } = {}) {
  const env = loadEnv({
    NODE_ENV: "test",
    DATABASE_URL: testDatabaseUrl(),
    BETTER_AUTH_SECRET: "test-secret-test-secret-test-secret-123456",
    BETTER_AUTH_URL: WEB_ORIGIN,
    FRONTEND_ORIGIN: WEB_ORIGIN,
    MAIL_TRANSPORT: "console",
    // Fixed test key (never used outside tests): enables the encrypted identity-document store.
    DOCUMENT_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"),
    // Most tests make many sign-ins from one IP; dedicated tests turn this on.
    RATE_LIMIT_ENABLED: "false",
    ...overrides,
  });

  const clock = new FakeClock();
  // Tests never reach a real payment provider: the HTTP client is always the fake.
  const net = new FakeProviderNet();
  let builder = Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(ENV)
    .useValue(env)
    .overrideProvider(Clock)
    .useValue(clock)
    .overrideProvider(HttpClient)
    .useValue(net);
  // Tests never reach the real AI service: when a fake is given it replaces the client.
  if (fakes.aiClient) builder = builder.overrideProvider(AiClient).useValue(fakes.aiClient);
  const moduleRef = await builder.compile();

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
      `TRUNCATE "chat_message","payment_event","refund","payment","dispute_message","dispute","booking_event","reschedule_request","quote","booking","worker_time_off","worker_availability_rule","audit_log","favorite","worker_service","worker_profile","customer_profile","session","account","verification","rateLimit","platform_setting","knowledge_revision","knowledge_document","user" CASCADE`,
    );
    // Admin roles: keep super_admin (created by the migration) and the seeded starting roles at their
    // defaults; drop anything a test created. Categories created by tests are removed too.
    await prisma.adminRole.deleteMany({ where: { key: { notIn: ["super_admin", "demo_admin", ...DEFAULT_ROLES.map((r) => r.key)] } } });
    for (const role of DEFAULT_ROLES) await prisma.adminRole.updateMany({ where: { key: role.key }, data: { name: role.name, description: role.description, permissions: role.permissions } });
    app.get(SettingsService).invalidate();
    mail.outbox.length = 0;
    net.reset();
    clock.set("2026-11-01T06:00:00Z");
  }

  /** Latest captured email of a kind, and the in-app path of its link. */
  function lastLink(kind: string, to: string) {
    const message = [...mail.outbox].reverse().find((m) => m.kind === kind && m.to === to);
    if (!message) return undefined;
    const url = new URL(/https?:\/\/\S+/.exec(message.text)![0]);
    return url.pathname + url.search;
  }

  /** The 6-digit code in the latest verification email to `to` (console transport only). */
  function lastOtp(to: string) {
    const message = [...mail.outbox].reverse().find((m) => m.kind === "verify-otp" && m.to === to);
    return message ? /\b(\d{6})\b/.exec(message.text)?.[1] : undefined;
  }

  /** Registers, verifies the emailed CODE (sets the session cookie), and returns a logged-in client. */
  async function signUpAndLogin(email: string, name = "Test User") {
    const agent = client();
    await agent.post(`${api}/auth/sign-up/email`).send({ name, email, password: PASSWORD });
    const otp = lastOtp(email);
    if (!otp) throw new Error("verification code was not sent");
    const verified = await agent.post(`${api}/auth/email-otp/verify-email`).send({ email, otp, password: PASSWORD });
    if (verified.status !== 200) throw new Error(`code verification failed: ${verified.status}`);
    const me = await agent.get(`${api}/me`);
    if (me.status !== 200) throw new Error(`login failed: ${me.status}`);
    return { agent, userId: me.body.user.id as string, email };
  }

  /** Simulates the trusted operator process (`npm run admin:grant`). Defaults to the super_admin role. */
  async function makeAdmin(userId: string, roleKey = "super_admin") {
    const role = await prisma.adminRole.findUniqueOrThrow({ where: { key: roleKey } });
    await prisma.user.update({ where: { id: userId }, data: { role: "ADMIN", adminRoleId: role.id } });
  }

  async function newAdmin(roleKey = "super_admin") {
    const admin = await signUpAndLogin(uniqueEmail("admin"));
    await makeAdmin(admin.userId, roleKey);
    return admin;
  }

  /** An admin whose role holds exactly `permissions` (a throwaway custom role). */
  async function newAdminWith(permissions: string[], key = `t_${Math.random().toString(36).slice(2, 10)}`) {
    const role = await prisma.adminRole.create({ data: { key, name: key, description: "test role", permissions } });
    const admin = await signUpAndLogin(uniqueEmail("limited"));
    await prisma.user.update({ where: { id: admin.userId }, data: { role: "ADMIN", adminRoleId: role.id } });
    return { ...admin, roleId: role.id, roleKey: key };
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
    app, prisma, mail, env, clock, net, api, client, resetData, lastLink, lastOtp, signUpAndLogin, makeAdmin,
    newAdmin, newAdminWith, createWorker,
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
