import { Prisma } from "../generated/prisma/client.js";
import { currentRealm } from "../common/request-context.js";

/**
 * The realm firewall (docs/DEMO.md).
 *
 * Demo accounts and everything they own are the "demo realm"; every other row is the "real realm". This Prisma
 * extension adds the realm condition to every query that PrismaService runs, so:
 *
 *   - a demo session (admin, customer or worker) can only ever read or change demo rows, and
 *   - an ordinary session, a public visitor and a payment-provider callback never see a demo row,
 *     so demo activity can never reach real users, admin screens, reports or revenue figures.
 *
 * Ownership is decided through the user who owns the row (`SCOPES` names the path). Reference data that is the
 * same for everyone (categories, settings, admin roles, announcements, knowledge base) is `SHARED`. A model with no
 * entry makes every query on it throw (fail closed), and a test fails until it is classified, so a table added in a
 * later release cannot silently skip the firewall.
 *
 * Not covered here, on purpose: raw SQL (`$queryRaw`; the few reads that need it filter by realm themselves and a
 * test lists them), and nested writes that `connect` to an id (the database triggers in the demo_access migration
 * refuse a booking or payment that crosses the line, and every id a request supplies is first read through this
 * firewall, so a row of the other realm is simply "not found").
 */

type Filter = Record<string, unknown>;
type Scope = (demo: boolean) => Filter;

/** Reference data shared by both realms. */
export const SHARED = "shared" as const;

/** `owner(["booking", "customer"])` -> a filter on the demo flag of `row.booking.customer`. */
const owner =
  (...path: string[]): Scope =>
  (demo) =>
    path.reduceRight<Filter>((inner, key) => ({ [key]: inner }), { isDemo: demo });

export const SCOPES: Record<Prisma.ModelName, Scope | typeof SHARED> = {
  User: (demo) => ({ isDemo: demo }),
  Session: owner("user"),
  Account: owner("user"),
  Verification: SHARED,
  RateLimit: SHARED,
  CustomerProfile: owner("user"),
  ServiceCategory: SHARED,
  WorkerProfile: owner("user"),
  WorkerService: owner("workerProfile", "user"),
  Favorite: owner("user"),
  // Operator-script rows have no actor and belong to the real realm.
  AuditLog: (demo) => (demo ? { actor: { isDemo: true } } : { OR: [{ actorId: null }, { actor: { isDemo: false } }] }),
  WorkerAvailabilityRule: owner("workerProfile", "user"),
  WorkerTimeOff: owner("workerProfile", "user"),
  Booking: owner("customer"),
  ChatMessage: owner("sender"),
  BookingEvent: owner("booking", "customer"),
  Quote: owner("booking", "customer"),
  RescheduleRequest: owner("booking", "customer"),
  Dispute: owner("booking", "customer"),
  DisputeMessage: owner("dispute", "booking", "customer"),
  Payment: owner("customer"),
  PaymentEvent: owner("payment", "customer"),
  Refund: owner("payment", "customer"),
  Review: owner("customer"),
  ReviewRevision: owner("review", "customer"),
  CommunityPost: owner("author"),
  PostComment: owner("author"),
  PostReaction: owner("user"),
  FeatureProposal: owner("author"),
  FeatureVote: owner("user"),
  ContentReport: owner("reporter"),
  AdminRole: SHARED,
  WorkerDocument: owner("workerProfile", "user"),
  SupportTicket: owner("requester"),
  SupportTicketMessage: owner("ticket", "requester"),
  Announcement: SHARED,
  Notification: owner("user"),
  PlatformSetting: SHARED,
  KnowledgeDocument: SHARED,
  KnowledgeRevision: SHARED,
};

type Args = { where?: Filter } & Record<string, unknown>;

const asList = (value: unknown): unknown[] => (value === undefined ? [] : Array.isArray(value) ? value : [value]);

/** `where` AND the realm filter. AND (not a spread) so it also works on unique lookups and never collides with a key. */
const withFilter = (args: Args, filter: Filter): Args => ({ ...args, where: { ...args.where, AND: [...asList(args.where?.AND), filter] } });

const FILTERED = new Set([
  "findMany", "findFirst", "findFirstOrThrow", "findUnique", "findUniqueOrThrow",
  "count", "aggregate", "groupBy",
  "update", "updateMany", "updateManyAndReturn", "upsert", "delete", "deleteMany",
]);
const CREATES = new Set(["create", "createMany", "createManyAndReturn"]);

/** Whether a `data` payload for a User row puts the account in (or tries to create) the demo realm. */
const touchesDemoIdentity = (data: unknown): boolean =>
  asList(data).some((row) => typeof row === "object" && row !== null && ((row as Filter).isDemo === true || (row as Filter).demoRole != null));

export function realmFirewall() {
  return Prisma.defineExtension({
    name: "realm-firewall",
    query: {
      $allModels: {
        async $allOperations({ model, operation, args, query }) {
          const scope = SCOPES[model as Prisma.ModelName] as Scope | typeof SHARED | undefined;
          if (scope === undefined) throw new Error(`Realm firewall: model ${model} is not classified in prisma/realm.ts`);
          if (scope === SHARED) return query(args);

          const demo = currentRealm() === "demo";
          if (model === "User" && CREATES.has(operation)) {
            // Demo identities are created by the operator seed with the unscoped client, never by a request.
            const data = (args as { data?: unknown }).data;
            if (demo || touchesDemoIdentity(data)) throw new Error("Realm firewall: a request cannot create a demo account");
            return query(args);
          }
          if (CREATES.has(operation)) return query(args);
          if (!FILTERED.has(operation)) throw new Error(`Realm firewall: operation ${model}.${operation} is not supported`);

          // For an upsert the filter applies to its lookup: a row of the other realm is "not found", so the upsert
          // tries to create it and hits the unique constraint instead of overwriting it.
          return query(withFilter(args as Args, scope(demo)) as never);
        },
      },
    },
  });
}
