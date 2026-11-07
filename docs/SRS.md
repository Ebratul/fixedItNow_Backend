# FixedItNow --- Final SRS & Full Implementation Architecture

**Document type:** Software Requirements Specification (SRS) + Technical
Architecture + Implementation Plan\
**Product:** FixedItNow\
**Primary market:** Bangladesh\
**Status:** Implementation baseline; validate provider-specific details
and legal/payment requirements before production launch\
**Last updated:** 24 October 2026

------------------------------------------------------------------------

## 1. Executive Summary

FixedItNow is a Bangladesh-focused service marketplace that connects
customers with local service workers. Customers can discover workers,
compare profiles and prices, request or book services, communicate in a
booking-linked conversation, pay through supported payment providers,
review completed work, and participate in a community. Workers can
create a service profile, list skills and prices, manage availability
and bookings, communicate with customers, and view their earnings.
Administrators manage platform operations, verification, moderation,
disputes, service categories, and audit trails.

The product includes an AI-assisted worker-discovery experience. The AI
layer can understand natural-language requests, retrieve platform help
and policy content, and invoke a restricted set of tools to search the
live marketplace. Live prices, ratings, and availability must come from
authoritative database queries rather than model-generated guesses.

The system is designed for incremental delivery, strong privacy
controls, safe payment handling, role-based access, and replaceable
providers. A free-tier-first deployment strategy is preferred, but
production readiness depends on provider limits, uptime, persistent
storage, background-job support, domain/email setup, and
payment-provider approval.

### 1.1 Product goals

1.  Make it easy for customers in Bangladesh to find and book
    trustworthy local service workers.
2.  Give workers a clear way to publish services, manage requests, and
    build reputation.
3.  Support a single account that can hold both Customer and Worker
    capabilities.
4.  Keep Admin access separate and tightly controlled.
5.  Support booking-based messaging, notifications, reviews, and dispute
    handling.
6.  Support bKash and SSLCOMMERZ through server-verified payment
    workflows.
7.  Add a safe AI assistant for discovery and platform guidance.
8.  Provide a moderated community for discussion and feature proposals.
9.  Protect identity documents, private messages, payment records, and
    account sessions.
10. Deliver in testable phases, without pretending that unconfigured
    integrations work.

### 1.2 Non-goals for the initial release

-   No unrestricted AI access to the database, shell, deployment
    credentials, or production code.
-   No automatic production deployment or service-category activation
    based on community votes or AI recommendations.
-   No claim that identity documents are government-verified unless an
    approved verification process actually exists.
-   No claim of real payment success based only on a browser redirect.
-   No guaranteed zero-cost hosting or payment processing; free tiers
    and transaction fees are provider-dependent.
-   No public exposure of a worker's NID image or other private
    verification documents.
-   No arbitrary public access to private booking conversations.

------------------------------------------------------------------------

## 2. Scope and Product Roles

### 2.1 Roles

  -------------------------------------------------------------------------
  Role                    Description             Core permissions
  ----------------------- ----------------------- -------------------------
  Visitor                 Unauthenticated user    Browse public pages and
                                                  public worker/service
                                                  listings; read public
                                                  community content if
                                                  enabled

  Customer                A registered account    Manage profile, search
                          using services          workers, favorite
                                                  workers, create bookings,
                                                  communicate about own
                                                  bookings, pay, review
                                                  eligible completed
                                                  bookings, report issues

  Worker                  A registered account    Maintain worker profile,
                          offering services       submit verification
                                                  documents, list
                                                  skills/services/prices,
                                                  set availability, manage
                                                  own booking requests,
                                                  communicate about own
                                                  bookings, view reviews
                                                  and earnings

  Admin                   Privileged platform     Manage categories,
                          operator                verification, moderation,
                                                  disputes, platform
                                                  configuration, user
                                                  restrictions, operational
                                                  dashboards, and audit
                                                  records
  -------------------------------------------------------------------------

**Dual-role requirement:** One user account may have both Customer and
Worker capabilities. Customer and Worker are capabilities, not mutually
exclusive account types. Admin is a privileged role and must not be
granted through public self-registration.

### 2.2 Role and permission rules

-   Enforce authorization on the server for every protected operation;
    hiding a button is not authorization.
-   Users can access only their own private profile fields, bookings,
    messages, payment history, and uploaded documents unless a
    documented role permission permits otherwise.
-   Workers may access customer details only when necessary for a
    booking and only within the defined privacy policy.
-   Admin access must use explicit RBAC permissions, strong
    authentication, and audit logging.
-   Sensitive admin actions should require a reason and be recorded in
    an append-only audit trail.
-   A worker verification status does not imply Google-account
    verification, and Google OAuth does not imply worker identity
    verification.
-   Admin actions must not silently alter historical payment or booking
    records.

------------------------------------------------------------------------

## 3. User Journeys

### 3.1 Customer journey

1.  Visit the public website and explore service categories.
2.  Search by service, area, location, price range, rating, experience,
    and availability.
3.  Open worker profiles and compare skills, prices, portfolio, reviews,
    and verification status.
4.  Sign up or log in with supported authentication methods.
5.  Submit a booking request with service details, location, preferred
    time, and optional attachments.
6.  Receive a quote or accept the displayed pricing model.
7.  Confirm booking and pay when required.
8.  Use the booking-linked conversation for text and supported voice
    messages.
9.  Track booking status and receive notifications.
10. Mark completion or follow the platform's completion process.
11. Leave one review for an eligible completed booking.
12. Raise a dispute or report an issue when necessary.

### 3.2 Worker journey

1.  Register or sign in.
2.  Enable Worker capability on the existing account.
3.  Complete worker profile, service area, skills, service categories,
    pricing, and availability.
4.  Upload required identity documents through a private upload flow.
5.  Wait for review and see clear verification status/rejection reason.
6.  Receive booking requests and submit/accept quotes according to the
    booking workflow.
7.  Accept, reject, reschedule, or complete eligible bookings.
8.  Communicate with the customer inside the booking context.
9.  Receive review and view earnings/payment status.
10. Update availability and profile information.

### 3.3 Admin journey

1.  Sign in through a restricted admin entry point.
2.  Review operational metrics and pending queues.
3.  Verify or reject worker documents without exposing them publicly.
4.  Manage service categories and content.
5.  Review reports, disputes, and moderation queues.
6.  Restrict accounts or remove content with a recorded reason.
7.  Review payment reconciliation and audit history.
8.  Export only authorized operational reports and avoid exporting
    unnecessary sensitive data.

------------------------------------------------------------------------

## 4. Functional Requirements

Priority labels: **P0** = required for a safe core release; **P1** =
important; **P2** = later enhancement.

### 4.1 Public website and UI

-   **FR-PUB-01 (P0):** Provide responsive public routes: `/`,
    `/services`, `/services/[slug]`, `/workers`, `/workers/[id]`,
    `/how-it-works`, `/about`, `/contact`, `/help`, `/privacy`,
    `/terms`.
-   **FR-PUB-02 (P0):** Use accessible navigation, keyboard focus
    states, semantic HTML, and mobile-first layouts.
-   **FR-PUB-03 (P0):** Provide loading, empty, error, success, and
    retry states for asynchronous screens.
-   **FR-PUB-04 (P1):** Support English and Bangla copy with appropriate
    font fallback and readable line height.
-   **FR-PUB-05 (P1):** Include metadata, social sharing metadata,
    sitemap, and robots configuration where appropriate.
-   **FR-PUB-06 (P0):** Never show fake ratings, fabricated worker
    profiles, or simulated payment success as live data.

### 4.2 Authentication and account management

-   **FR-AUTH-01 (P0):** Support email-based registration and login
    using a verified email flow.
-   **FR-AUTH-02 (P1):** Support Google OAuth where credentials and
    callback configuration are available.
-   **FR-AUTH-03 (P0):** Store password hashes using a modern
    password-hashing algorithm; never store plaintext passwords.
-   **FR-AUTH-04 (P0):** Store OTPs hashed, apply expiry, resend
    throttling, attempt limits, and rate limits.
-   **FR-AUTH-05 (P0):** Create a new user only after the
    pending-registration verification flow succeeds; use a transaction
    where relevant.
-   **FR-AUTH-06 (P0):** Use secure, HttpOnly, SameSite cookies for
    browser sessions or an equivalent secure session design. Do not put
    long-lived bearer tokens in localStorage.
-   **FR-AUTH-07 (P0):** Support session expiry, logout, session
    revocation, and refresh-token rotation if refresh tokens are used.
-   **FR-AUTH-08 (P0):** Permit a user to enable Customer and Worker
    capabilities on one account.
-   **FR-AUTH-09 (P0):** Prevent public users from assigning themselves
    Admin privileges.
-   **FR-AUTH-10 (P1):** Provide password reset and email-change flows
    with verification.
-   **FR-AUTH-11 (P0):** Rate-limit login, registration, OTP,
    password-reset, and OAuth-related endpoints.
-   **FR-AUTH-12 (P0):** Do not reveal whether an email is registered
    where doing so would create account-enumeration risk.

### 4.3 Worker profile and verification

-   **FR-WRK-01 (P0):** Workers can create and edit a public profile
    with display name, description, service area, skills, experience,
    languages, and optional portfolio.
-   **FR-WRK-02 (P0):** Workers can list service categories, pricing
    model, base price, and additional pricing notes.
-   **FR-WRK-03 (P0):** Workers can define availability and block
    unavailable time ranges.
-   **FR-WRK-04 (P0):** Workers can submit identity documents through
    private storage.
-   **FR-WRK-05 (P0):** Verification status values must be explicit,
    such as `NOT_SUBMITTED`, `PENDING`, `VERIFIED`, `REJECTED`, and
    `RESUBMISSION_REQUIRED`.
-   **FR-WRK-06 (P0):** Only authorized reviewers can view identity
    documents; document URLs must not be publicly accessible.
-   **FR-WRK-07 (P0):** Record who reviewed a document, when it was
    reviewed, the decision, and a minimal reason.
-   **FR-WRK-08 (P0):** Public pages show only a truthful verification
    badge/status and must not expose NID numbers or document images.
-   **FR-WRK-09 (P1):** Workers can view booking history, reviews, and a
    summary of earnings/payment states.
-   **FR-WRK-10 (P0):** Profile and pricing edits must be validated
    server-side.

### 4.4 Service categories and discovery

-   **FR-SVC-01 (P0):** Admins can create, edit, deactivate, and order
    service categories.
-   **FR-SVC-02 (P0):** Public users can browse active categories and
    category detail pages.
-   **FR-SVC-03 (P0):** Search workers by keyword, category,
    location/service area, price range, minimum rating, experience, and
    availability where supported.
-   **FR-SVC-04 (P0):** Filters and sorting must be applied to
    database-backed data.
-   **FR-SVC-05 (P0):** Return pagination and stable sorting; avoid
    loading the entire worker table.
-   **FR-SVC-06 (P1):** Support map-based discovery through a compliant
    map/geocoding provider. Do not scrape or misuse public map tiles.
-   **FR-SVC-07 (P0):** Ratings and review counts must be calculated
    from eligible stored reviews or a correctly maintained aggregate.
-   **FR-SVC-08 (P0):** The AI assistant must not invent a worker's
    price, rating, location, availability, or verification state.

### 4.5 Favorites

-   **FR-FAV-01 (P1):** Customers can favorite/unfavorite a worker.
-   **FR-FAV-02 (P0):** A favorite belongs to one user and one worker;
    enforce uniqueness.
-   **FR-FAV-03 (P0):** Users can only read and modify their own
    favorites.

### 4.6 Booking and quote workflow

-   **FR-BKG-01 (P0):** Customers can create a booking request with
    worker, service, description, location, preferred schedule, and
    optional permitted attachments.
-   **FR-BKG-02 (P0):** The server validates that the worker is active,
    the service is available, and the requested schedule is allowed.
-   **FR-BKG-03 (P0):** The booking workflow supports quote-required and
    fixed-price service models.
-   **FR-BKG-04 (P0):** Workers can accept, reject, or quote a request
    according to policy; customers can accept or decline a quote.
-   **FR-BKG-05 (P0):** Store booking status transitions and their
    timestamps in a history table.
-   **FR-BKG-06 (P0):** Prevent overlapping accepted bookings using
    transactions and appropriate database constraints/locking.
-   **FR-BKG-07 (P0):** Revalidate price, status, ownership, and
    schedule on the server for every state-changing request.
-   **FR-BKG-08 (P0):** Support cancellation according to documented
    rules and record actor, reason, and time.
-   **FR-BKG-09 (P1):** Support rescheduling with explicit confirmation
    and conflict checks.
-   **FR-BKG-10 (P0):** Support disputes with status, reason, evidence
    references, decisions, and audit history.
-   **FR-BKG-11 (P0):** Do not allow users to modify bookings belonging
    to other users.
-   **FR-BKG-12 (P0):** Booking completion must be explicit and
    auditable; reviews and payouts must depend on the configured
    completion rules.

Suggested booking states (adapt only with a documented migration and
updated tests):

`REQUESTED → QUOTED (optional) → ACCEPTED → CONFIRMED → IN_PROGRESS → COMPLETION_PENDING → COMPLETED`

Alternative terminal or side states may include `REJECTED`, `CANCELLED`,
`EXPIRED`, and `DISPUTED`. Define allowed transitions in one domain
service; do not accept arbitrary client-provided status changes.

### 4.7 Payments and refunds

-   **FR-PAY-01 (P0):** Integrate bKash and SSLCOMMERZ through provider
    adapters and documented sandbox flows.
-   **FR-PAY-02 (P0):** Compute payable amount on the server from stored
    booking/pricing data; never trust the browser's amount.
-   **FR-PAY-03 (P0):** Verify provider callbacks/signatures and confirm
    transaction status with the provider where the provider supports
    server-side verification.
-   **FR-PAY-04 (P0):** A redirect to a success page is not proof of
    payment.
-   **FR-PAY-05 (P0):** Use idempotency keys/provider transaction
    identifiers to prevent duplicate payment processing.
-   **FR-PAY-06 (P0):** Maintain an append-only payment ledger or event
    history for financial state changes.
-   **FR-PAY-07 (P0):** Store payment attempts and provider events with
    deduplication and safe retry semantics.
-   **FR-PAY-08 (P0):** Handle pending, successful, failed, cancelled,
    expired, refunded, and reconciliation-required states.
-   **FR-PAY-09 (P0):** Refunds must be authorized, tracked, and
    reconciled; never silently rewrite historical payment rows.
-   **FR-PAY-10 (P0):** Do not store raw card data, payment passwords,
    PINs, or provider secrets.
-   **FR-PAY-11 (P0):** Never claim a real payment integration is
    operational until credentials, callback configuration, sandbox
    tests, and production approval are complete.
-   **FR-PAY-12 (P1):** Provide a scheduled/manual reconciliation
    workflow for unresolved transactions.

### 4.8 Chat, voice, and notifications

-   **FR-COM-01 (P0):** Provide booking-linked conversations between the
    customer and worker for that booking.
-   **FR-COM-02 (P0):** Enforce conversation membership and booking
    ownership on every read/write.
-   **FR-COM-03 (P1):** Support real-time messaging using a supported
    WebSocket/realtime provider or a documented polling fallback.
-   **FR-COM-04 (P1):** Support voice-message uploads through a private,
    size-limited, type-validated upload flow.
-   **FR-COM-05 (P1):** If transcription is enabled, use a replaceable
    provider adapter and show transcription status. Do not imply that
    transcription exists when not configured.
-   **FR-COM-06 (P0):** Validate upload MIME type, file signature where
    feasible, file size, and ownership; store private files outside
    public static directories.
-   **FR-COM-07 (P0):** Notifications are persisted and scoped to the
    recipient.
-   **FR-COM-08 (P1):** Support in-app and email notifications for
    important booking, payment, verification, and dispute events.
-   **FR-COM-09 (P0):** Notification dispatch should use a durable
    queue/outbox pattern or a clearly documented retry-safe alternative.
-   **FR-COM-10 (P0):** Do not expose message content to admins unless a
    specific, authorized moderation/dispute process requires it.

### 4.9 AI assistant and RAG

-   **FR-AI-01 (P1):** Provide a natural-language assistant for service
    discovery, FAQs, and platform guidance.
-   **FR-AI-02 (P1):** Use OpenRouter with model/provider configuration
    via environment variables; do not hard-code a single model into
    business logic.
-   **FR-AI-03 (P1):** Use Python FastAPI as a separate AI service; use
    LangChain/LangGraph only where they add clear value.
-   **FR-AI-04 (P1):** Use RAG for approved FAQ, policy, category, and
    help content.
-   **FR-AI-05 (P0):** Live worker results, prices, ratings, and
    availability must be retrieved through allowlisted structured tools
    backed by the application API/database.
-   **FR-AI-06 (P0):** The AI service must not have arbitrary SQL
    execution, unrestricted database access, shell access, deployment
    access, or payment mutation tools.
-   **FR-AI-07 (P0):** Validate tool inputs and outputs with schemas and
    authorization checks.
-   **FR-AI-08 (P0):** Treat retrieved documents, user prompts, and tool
    output as untrusted data; defend against prompt injection.
-   **FR-AI-09 (P0):** Do not return private user data or another
    customer's booking/chat information.
-   **FR-AI-10 (P0):** Do not claim to have booked, cancelled, paid,
    refunded, or changed a record unless the application has performed
    and confirmed the action.
-   **FR-AI-11 (P1):** LangSmith tracing may be used only with
    sensitive-data redaction, documented retention, and appropriate
    access controls.
-   **FR-AI-12 (P0):** Keep secrets and provider API keys on the server;
    never expose them to the browser.
-   **FR-AI-13 (P1):** Add timeouts, token/output limits, per-user rate
    limits, cost monitoring, and graceful provider-failure handling.
-   **FR-AI-14 (P1):** Show users when the assistant is uncertain and
    provide links to source policies when useful.

### 4.10 Reviews and sentiment

-   **FR-REV-01 (P0):** Only an eligible customer associated with a
    completed booking can review that booking.
-   **FR-REV-02 (P0):** Enforce one review per eligible booking unless a
    documented correction mechanism is used.
-   **FR-REV-03 (P0):** Validate rating range, text length, and content
    policy server-side.
-   **FR-REV-04 (P0):** Prevent workers from reviewing their own service
    as the customer.
-   **FR-REV-05 (P1):** Provide report/moderation flows for abusive or
    fraudulent reviews.
-   **FR-REV-06 (P2):** Sentiment analysis may provide internal
    aggregate insights but must not silently replace user ratings or
    make unsupported accusations.
-   **FR-REV-07 (P0):** Label AI-generated sentiment as an estimate and
    keep a path for human review.

> **Implementation status (Step 9):** FR-REV-01..05 and FR-REV-07's human-review path are implemented ([COMMUNITY.md](COMMUNITY.md)). FR-REV-06/07 sentiment analysis is **not** implemented (deliberate: privacy and evaluation reasons are in COMMUNITY.md); no AI-generated sentiment is shown anywhere.

### 4.11 Community and feature proposals

-   **FR-COMM-01 (P1):** Signed-in users can create community posts,
    comment, react, and report content.
-   **FR-COMM-02 (P1):** Enforce content length limits, input
    validation, abuse throttling, and authorization.
-   **FR-COMM-03 (P1):** Feature proposals can receive votes from
    eligible accounts, with one vote per user per proposal.
-   **FR-COMM-04 (P0):** A vote threshold can move a proposal into an
    admin review queue only; it must not automatically change production
    code or activate a service category.
-   **FR-COMM-05 (P1):** Moderators can review reports and record
    moderation reasons/actions.
-   **FR-COMM-06 (P0):** Community content is untrusted input and must
    not be treated as privileged instructions by the AI system.

> **Implementation status (Step 9):** FR-COMM-01..06 are implemented. The community is a signed-in space ("Public/auth policy" in §9.8 resolved as: reviews public, community and proposals signed-in). The vote threshold (10) only adds a proposal to the admin "needs review" filter. There is no separate moderator role; `ADMIN` moderates.

### 4.12 Admin and operations

-   **FR-ADM-01 (P0):** Provide a protected admin dashboard with
    role-appropriate metrics.
-   **FR-ADM-02 (P0):** Manage categories, verification queues, user
    restrictions, reports, disputes, and feature proposals.
-   **FR-ADM-03 (P0):** Record sensitive actions in audit logs with
    actor, action, target, timestamp, and reason where applicable.
-   **FR-ADM-04 (P0):** Admin endpoints must be server-authorized and
    must not rely on client-side role checks.
-   **FR-ADM-05 (P0):** Use pagination and bounded queries for
    dashboards and audit history.
-   **FR-ADM-06 (P0):** Avoid showing NID values, secrets, or
    unnecessary personal data in analytics.
-   **FR-ADM-07 (P1):** Provide operational views for payment
    reconciliation and failed background jobs.

------------------------------------------------------------------------

## 5. Non-Functional Requirements

### 5.1 Security and privacy

-   Use TLS in production and secure cookie settings.
-   Validate all request bodies, query parameters, route parameters, and
    uploaded files.
-   Use parameterized database access through the ORM; do not
    concatenate user input into SQL.
-   Apply CSRF protection where the authentication/session design
    requires it.
-   Use a restrictive CORS allowlist; do not enable wildcard
    credentialed CORS.
-   Apply rate limits to authentication, search, messaging, uploads, AI,
    voting, and report endpoints.
-   Keep secrets in deployment environment variables or a secret
    manager; commit only placeholders.
-   Minimize collection and retention of NID, voice, location, and other
    sensitive data.
-   Define retention/deletion policies for identity documents, chat, and
    logs.
-   Redact secrets, access tokens, email addresses, phone numbers, NID
    data, and private message content from logs/traces when not needed.
-   Do not put private uploads in a public bucket or public static
    folder.
-   Use least-privilege database and service credentials.
-   Add security headers, dependency scanning, and secret scanning to CI
    where practical.

### 5.2 Reliability and consistency

-   Use transactions for multi-row operations that must succeed or fail
    together.
-   Use idempotency for payment callbacks, notification events, and
    retryable jobs.
-   Use a durable outbox or equivalent approach when a database update
    must trigger an external side effect.
-   Make background jobs retry-safe and define maximum
    attempts/dead-letter handling.
-   Provide health/readiness endpoints without disclosing secrets.
-   Use database migrations committed to source control; never rely on
    undocumented manual schema changes.
-   Use explicit time zones and store timestamps consistently in UTC;
    render local time appropriately.
-   Keep booking and payment state transitions in domain services, not
    scattered across UI components.

### 5.3 Performance and accessibility

-   Target mobile-first responsive design and usable keyboard
    navigation.
-   Avoid unbounded database queries and large unpaginated lists.
-   Optimize public images and use appropriate caching.
-   Set timeouts for external providers and provide graceful failure
    states.
-   Use accessible contrast, visible focus, labels, and semantic
    controls.
-   Use skeletons only while loading; provide meaningful empty and error
    states.
-   Establish measurable performance budgets during implementation
    rather than claiming untested scores.

### 5.4 Maintainability and observability

-   Use TypeScript strict mode where feasible.
-   Keep business logic out of presentation components.
-   Use shared validation schemas where appropriate.
-   Maintain structured, privacy-safe logs and correlation/request IDs.
-   Add metrics for errors, queue backlog, provider failures, payment
    reconciliation, and AI cost.
-   Document architecture decisions and provider setup.
-   Keep integrations behind interfaces/adapters to permit provider
    changes.

------------------------------------------------------------------------

## 6. Recommended Technology Stack

The stack below is a recommended implementation baseline. Preserve an
existing working stack when repository inspection shows a materially
different but sound architecture; document the decision instead of
blindly rewriting the project.

  -----------------------------------------------------------------------
  Layer                   Recommended technology  Notes
  ----------------------- ----------------------- -----------------------
  Web UI                  Next.js App Router,     Server components by
                          React, TypeScript       default; client
                                                  components for
                                                  interactivity

  Styling                 Tailwind CSS +          Reusable accessible
                          shadcn/ui               design system

  Forms/validation        React Hook Form + Zod,  Client feedback plus
                          or equivalent           server validation

  Main API                NestJS with TypeScript  REST API under
                                                  `/api/v1`

  ORM/database            Prisma + PostgreSQL     Migrations tracked in
                                                  Git

  Cache/queue             Redis-compatible        OTP TTL, rate limiting,
                          service                 queue/cache where
                                                  supported

  AI service              Python FastAPI          Separate deployable
                                                  service

  AI orchestration        OpenRouter +            Configurable model and
                          LangChain/LangGraph     restricted tools
                          where useful            

  Vector retrieval        PostgreSQL/pgvector if  Only add when RAG needs
                          required                semantic retrieval

  Realtime                WebSocket provider or   Verify hosting support
                          application gateway     and persistent
                                                  connections

  Private/public media    S3-compatible storage   Private identity
                          or Cloudinary for       documents must use
                          suitable public media   private access controls

  Maps                    Leaflet + compliant     Respect provider usage
                          tile/geocoding provider policies

  Testing                 Vitest/Jest, API        Include auth, booking,
                          integration tests,      payment and
                          Playwright              access-control tests

  Observability           Structured logs;        Never send secrets or
                          optional                unnecessary PII
                          Sentry/LangSmith with   
                          redaction               

  CI                      GitHub Actions or       Lint, type-check,
                          existing CI             tests, build, migration
                                                  checks
  -----------------------------------------------------------------------

### 6.1 Architecture overview

``` text
Browser / Mobile Web
        |
        v
Next.js Web Application
  - Public pages
  - Customer dashboard
  - Worker dashboard
  - Admin dashboard
        |
        v
NestJS API (/api/v1)
  - Authentication / authorization
  - Profiles / categories / discovery
  - Bookings / quotes / disputes
  - Payments / ledger / callbacks
  - Reviews / community / notifications
        |
        +--------------------+
        |                    |
        v                    v
PostgreSQL + Prisma       Redis / Queue
        |                    |
        |                    v
        |               Background workers
        |
        +------> Private object storage
        |
        +------> Payment providers: bKash / SSLCOMMERZ
        |
        +------> Email provider

Next.js / NestJS
        |
        v
Python FastAPI AI Service
  - OpenRouter adapter
  - RAG retrieval
  - Allowlisted marketplace tools
  - Input/output validation
        |
        +------> Approved knowledge base
        +------> Authenticated application API
```

**Trust boundary:** The browser is untrusted. The AI service is a
separate service with narrowly scoped access. Payment callbacks are
untrusted until verified. Public media and private verification
documents use separate access rules.

------------------------------------------------------------------------

## 7. Repository Structure

Adapt names to the existing repository rather than duplicating
applications unnecessarily.

``` text
first-eat-now/
├── apps/
│   └── web/                       # Next.js UI
├── services/
│   ├── api/                       # NestJS API
│   └── ai/                        # Python FastAPI AI service
├── packages/
│   ├── ui/                        # Shared UI components if needed
│   ├── config/                    # Shared lint/TypeScript config if useful
│   └── validation/                # Shared schemas if practical
├── prisma/
│   ├── schema.prisma
│   ├── migrations/
│   └── seed.ts
├── docs/
│   ├── SRS.md
│   ├── ARCHITECTURE.md
│   ├── API.md
│   ├── SECURITY.md
│   ├── DEPLOYMENT.md
│   └── RUNBOOK.md
├── scripts/
├── tests/
├── .github/workflows/
├── .env.example
├── .gitignore
├── README.md
└── package.json                   # If using a JS workspace/monorepo
```

If the current repository uses `frontend/`, `backend/`, and
`rag_agent/`, retain those directories if they already work. Do not
rename or replace project structure solely to match this illustration.

------------------------------------------------------------------------

## 8. Data Model and Prisma Baseline

The schema below is a conceptual baseline, not a substitute for
reviewing the repository's current schema and generating migrations
carefully. Field types, enums, relations, indexes, and deletion policies
should be validated against the chosen Prisma/PostgreSQL versions. Add
migrations incrementally; do not reset a database containing important
data.

### 8.1 Core entities

-   `User`: identity, email, password hash where applicable, account
    status.
-   `OAuthAccount`: provider and provider account mapping.
-   `Session` or `RefreshToken`: revocable authenticated sessions,
    depending on auth design.
-   `WorkerProfile`: public worker information and verification status.
-   `WorkerDocument`: private identity/verification document metadata
    and review outcome.
-   `ServiceCategory`: category hierarchy and active state.
-   `WorkerSkill`: worker-to-category/skill mapping.
-   `WorkerPricing`: fixed-price or quote-required pricing.
-   `WorkerAvailability`: recurring or dated availability windows.
-   `Favorite`: customer-worker favorites.
-   `Booking`: request, quote, schedule, price snapshot, and status.
-   `BookingStatusHistory`: append-only record of status changes.
-   `Dispute`: booking-related dispute and resolution.
-   `Payment`: payment attempt and current provider state.
-   `PaymentEvent`: deduplicated provider callback/event record.
-   `PaymentLedgerEntry`: append-only financial ledger entries.
-   `Review`: booking-linked customer review.
-   `Conversation`, `ConversationMember`, `Message`: private
    booking-linked communication.
-   `MediaAsset`: metadata and storage key for uploaded media, with
    visibility/access policy.
-   `Notification`: recipient-specific notification state.
-   `CommunityPost`, `PostComment`, `PostReaction`, `ContentReport`:
    community and moderation.
-   `FeatureProposal`, `FeatureVote`: feature governance.
-   `AuditLog`: privileged/security-sensitive actions.
-   `OutboxEvent` / job record: durable dispatch of external side
    effects where needed.

### 8.2 Prisma schema starter

This is a compact schema outline to guide implementation. Claude Code
must compare it with the repository and expand it into a complete,
validated schema before migrations are applied. Do not paste it over an
existing production schema without reconciliation.

``` prisma
generator client {
  provider = "prisma-client-js"
}

datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}

enum UserStatus {
  ACTIVE
  SUSPENDED
  DEACTIVATED
}

enum AccountRole {
  CUSTOMER
  WORKER
  ADMIN
}

enum VerificationStatus {
  NOT_SUBMITTED
  PENDING
  VERIFIED
  REJECTED
  RESUBMISSION_REQUIRED
}

enum PricingType {
  FIXED
  QUOTE_REQUIRED
}

enum BookingStatus {
  REQUESTED
  QUOTED
  ACCEPTED
  CONFIRMED
  IN_PROGRESS
  COMPLETION_PENDING
  COMPLETED
  REJECTED
  CANCELLED
  EXPIRED
  DISPUTED
}

enum PaymentStatus {
  CREATED
  PENDING
  SUCCEEDED
  FAILED
  CANCELLED
  EXPIRED
  REFUND_PENDING
  REFUNDED
  RECONCILIATION_REQUIRED
}

enum PaymentProvider {
  BKASH
  SSLCOMMERZ
}

enum DisputeStatus {
  OPEN
  UNDER_REVIEW
  NEEDS_INFORMATION
  RESOLVED_CUSTOMER
  RESOLVED_WORKER
  RESOLVED_OTHER
  CLOSED
}

enum ConversationType {
  BOOKING
  SUPPORT
}

enum NotificationStatus {
  UNREAD
  READ
  ARCHIVED
}

enum ProposalStatus {
  SUBMITTED
  UNDER_REVIEW
  ACCEPTED
  DECLINED
  PLANNED
  COMPLETED
}

enum ReportStatus {
  OPEN
  REVIEWING
  ACTIONED
  DISMISSED
}

model User {
  id                 String       @id @default(cuid())
  email              String?      @unique
  emailVerifiedAt    DateTime?
  passwordHash       String?
  displayName        String
  avatarUrl          String?
  phoneNumber        String?
  status             UserStatus   @default(ACTIVE)
  roles              AccountRole[] @default([CUSTOMER])
  createdAt          DateTime     @default(now())
  updatedAt          DateTime     @updatedAt

  oauthAccounts      OAuthAccount[]
  workerProfile      WorkerProfile?
  customerBookings   Booking[]    @relation("CustomerBookings")
  reviews            Review[]
  favorites          Favorite[]
  notifications      Notification[]
  communityPosts     CommunityPost[]
  comments           PostComment[]
  reactions          PostReaction[]
  featureVotes       FeatureVote[]
  auditLogs          AuditLog[]   @relation("AuditActor")
}

model OAuthAccount {
  id                 String   @id @default(cuid())
  userId             String
  provider           String
  providerAccountId  String
  createdAt          DateTime @default(now())
  user               User     @relation(fields: [userId], references: [id], onDelete: Cascade)

  @@unique([provider, providerAccountId])
  @@index([userId])
}

model WorkerProfile {
  id                 String             @id @default(cuid())
  userId             String             @unique
  slug               String             @unique
  headline           String?
  bio                String?
  yearsExperience    Int                @default(0)
  serviceAreas       Json?
  languages          String[]           @default([])
  verificationStatus VerificationStatus @default(NOT_SUBMITTED)
  isPublished        Boolean            @default(false)
  averageRating      Decimal?           @db.Decimal(3, 2)
  reviewCount        Int                @default(0)
  createdAt          DateTime           @default(now())
  updatedAt          DateTime           @updatedAt

  user               User               @relation(fields: [userId], references: [id], onDelete: Cascade)
  documents          WorkerDocument[]
  skills             WorkerSkill[]
  pricing            WorkerPricing[]
  availability       WorkerAvailability[]
  workerBookings     Booking[]          @relation("WorkerBookings")
  reviews            Review[]
  favorites          Favorite[]
}

model WorkerDocument {
  id                 String             @id @default(cuid())
  workerProfileId    String
  documentType       String
  privateStorageKey  String
  verificationStatus VerificationStatus @default(PENDING)
  reviewerUserId     String?
  reviewedAt         DateTime?
  reviewReason       String?
  createdAt          DateTime           @default(now())
  updatedAt          DateTime           @updatedAt

  workerProfile      WorkerProfile      @relation(fields: [workerProfileId], references: [id], onDelete: Cascade)
  @@index([workerProfileId, verificationStatus])
}

model ServiceCategory {
  id                 String          @id @default(cuid())
  parentId           String?
  slug               String          @unique
  nameEn             String
  nameBn             String?
  description        String?
  isActive           Boolean         @default(true)
  sortOrder          Int             @default(0)
  createdAt          DateTime        @default(now())
  updatedAt          DateTime        @updatedAt

  parent             ServiceCategory? @relation("CategoryTree", fields: [parentId], references: [id])
  children           ServiceCategory[] @relation("CategoryTree")
  skills             WorkerSkill[]
  pricing            WorkerPricing[]
  bookings           Booking[]
}

model WorkerSkill {
  id                 String          @id @default(cuid())
  workerProfileId    String
  categoryId         String
  title              String
  description        String?
  createdAt          DateTime        @default(now())

  workerProfile      WorkerProfile   @relation(fields: [workerProfileId], references: [id], onDelete: Cascade)
  category           ServiceCategory @relation(fields: [categoryId], references: [id])
  @@unique([workerProfileId, categoryId, title])
  @@index([categoryId])
}

model WorkerPricing {
  id                 String          @id @default(cuid())
  workerProfileId    String
  categoryId         String
  pricingType        PricingType
  currency           String          @default("BDT")
  baseAmount         Decimal?        @db.Decimal(12, 2)
  unitLabel          String?
  notes              String?
  isActive           Boolean         @default(true)
  createdAt          DateTime        @default(now())
  updatedAt          DateTime        @updatedAt

  workerProfile      WorkerProfile   @relation(fields: [workerProfileId], references: [id], onDelete: Cascade)
  category           ServiceCategory @relation(fields: [categoryId], references: [id])
  @@index([workerProfileId, categoryId, isActive])
}

model WorkerAvailability {
  id                 String        @id @default(cuid())
  workerProfileId    String
  weekday            Int?
  startAt            String?
  endAt              String?
  availableFrom      DateTime?
  availableUntil     DateTime?
  isBlocked          Boolean       @default(false)
  createdAt          DateTime      @default(now())

  workerProfile      WorkerProfile @relation(fields: [workerProfileId], references: [id], onDelete: Cascade)
  @@index([workerProfileId, weekday])
}

model Favorite {
  id                 String        @id @default(cuid())
  userId             String
  workerProfileId    String
  createdAt          DateTime      @default(now())

  user               User          @relation(fields: [userId], references: [id], onDelete: Cascade)
  workerProfile      WorkerProfile @relation(fields: [workerProfileId], references: [id], onDelete: Cascade)
  @@unique([userId, workerProfileId])
  @@index([userId, createdAt])
}

model Booking {
  id                 String        @id @default(cuid())
  customerId         String
  workerProfileId    String
  categoryId         String
  status             BookingStatus @default(REQUESTED)
  description        String
  serviceAddress     String?
  serviceArea        String?
  requestedStartAt   DateTime?
  requestedEndAt     DateTime?
  agreedStartAt      DateTime?
  agreedEndAt        DateTime?
  currency           String        @default("BDT")
  quotedAmount       Decimal?      @db.Decimal(12, 2)
  finalAmount        Decimal?      @db.Decimal(12, 2)
  pricingSnapshot    Json?
  cancellationReason String?
  cancelledByUserId  String?
  completedAt        DateTime?
  createdAt          DateTime      @default(now())
  updatedAt          DateTime      @updatedAt

  customer           User          @relation("CustomerBookings", fields: [customerId], references: [id])
  workerProfile      WorkerProfile @relation("WorkerBookings", fields: [workerProfileId], references: [id])
  category           ServiceCategory @relation(fields: [categoryId], references: [id])
  statusHistory      BookingStatusHistory[]
  payments           Payment[]
  review             Review?
  dispute            Dispute?
  conversation       Conversation?

  @@index([customerId, status, createdAt])
  @@index([workerProfileId, status, requestedStartAt])
}

model BookingStatusHistory {
  id                 String        @id @default(cuid())
  bookingId          String
  fromStatus         BookingStatus?
  toStatus           BookingStatus
  actorUserId        String?
  reason             String?
  metadata           Json?
  createdAt          DateTime      @default(now())

  booking            Booking       @relation(fields: [bookingId], references: [id], onDelete: Cascade)
  @@index([bookingId, createdAt])
}

model Dispute {
  id                 String        @id @default(cuid())
  bookingId          String        @unique
  openedByUserId     String
  status             DisputeStatus @default(OPEN)
  reason             String
  evidenceKeys       String[]      @default([])
  resolution         String?
  resolvedByUserId   String?
  resolvedAt         DateTime?
  createdAt          DateTime      @default(now())
  updatedAt          DateTime      @updatedAt

  booking            Booking       @relation(fields: [bookingId], references: [id])
  @@index([status, createdAt])
}

model Payment {
  id                 String          @id @default(cuid())
  bookingId          String
  provider           PaymentProvider
  status             PaymentStatus   @default(CREATED)
  currency           String          @default("BDT")
  amount             Decimal         @db.Decimal(12, 2)
  idempotencyKey     String          @unique
  providerTransactionId String?      @unique
  providerReference  String?
  checkoutUrl        String?
  paidAt             DateTime?
  createdAt          DateTime        @default(now())
  updatedAt          DateTime        @updatedAt

  booking            Booking         @relation(fields: [bookingId], references: [id])
  events             PaymentEvent[]
  ledgerEntries      PaymentLedgerEntry[]
  @@index([bookingId, createdAt])
  @@index([status, createdAt])
}

model PaymentEvent {
  id                 String        @id @default(cuid())
  paymentId          String
  providerEventId    String?
  eventType          String
  payloadRedacted    Json?
  processedAt        DateTime?
  receivedAt         DateTime      @default(now())

  payment            Payment       @relation(fields: [paymentId], references: [id])
  @@unique([providerEventId])
  @@index([paymentId, receivedAt])
}

model PaymentLedgerEntry {
  id                 String        @id @default(cuid())
  paymentId          String
  entryType          String
  amount             Decimal       @db.Decimal(12, 2)
  currency           String        @default("BDT")
  reference          String?
  createdAt          DateTime      @default(now())

  payment            Payment       @relation(fields: [paymentId], references: [id])
  @@index([paymentId, createdAt])
}

model Review {
  id                 String        @id @default(cuid())
  bookingId          String        @unique
  customerId         String
  workerProfileId    String
  rating             Int
  comment            String?
  sentimentLabel     String?
  sentimentScore     Decimal?      @db.Decimal(5, 4)
  isHidden           Boolean       @default(false)
  createdAt          DateTime      @default(now())
  updatedAt          DateTime      @updatedAt

  booking            Booking       @relation(fields: [bookingId], references: [id])
  customer           User          @relation(fields: [customerId], references: [id])
  workerProfile      WorkerProfile @relation(fields: [workerProfileId], references: [id])
  @@index([workerProfileId, createdAt])
}

model Conversation {
  id                 String            @id @default(cuid())
  bookingId          String?           @unique
  type               ConversationType  @default(BOOKING)
  createdAt          DateTime          @default(now())
  updatedAt          DateTime          @updatedAt

  booking            Booking?          @relation(fields: [bookingId], references: [id])
  members            ConversationMember[]
  messages           Message[]
}

model ConversationMember {
  id                 String        @id @default(cuid())
  conversationId     String
  userId             String
  joinedAt           DateTime      @default(now())
  lastReadAt         DateTime?

  conversation       Conversation  @relation(fields: [conversationId], references: [id], onDelete: Cascade)
  @@unique([conversationId, userId])
  @@index([userId, conversationId])
}

model Message {
  id                 String        @id @default(cuid())
  conversationId     String
  senderUserId       String
  body               String?
  mediaAssetId       String?
  messageType        String        @default("TEXT")
  createdAt          DateTime      @default(now())
  deletedAt          DateTime?

  conversation       Conversation  @relation(fields: [conversationId], references: [id], onDelete: Cascade)
  @@index([conversationId, createdAt])
}

model MediaAsset {
  id                 String        @id @default(cuid())
  ownerUserId        String
  storageKey         String        @unique
  mediaType          String
  mimeType           String
  sizeBytes          Int
  visibility         String        @default("PRIVATE")
  createdAt          DateTime      @default(now())
  deletedAt          DateTime?
  @@index([ownerUserId, createdAt])
}

model Notification {
  id                 String             @id @default(cuid())
  userId             String
  type               String
  title              String
  body               String?
  data               Json?
  status             NotificationStatus @default(UNREAD)
  readAt             DateTime?
  createdAt          DateTime           @default(now())

  user               User               @relation(fields: [userId], references: [id], onDelete: Cascade)
  @@index([userId, status, createdAt])
}

model CommunityPost {
  id                 String        @id @default(cuid())
  authorId           String
  title              String?
  body               String
  isHidden           Boolean       @default(false)
  createdAt          DateTime      @default(now())
  updatedAt          DateTime      @updatedAt

  author             User          @relation(fields: [authorId], references: [id])
  comments           PostComment[]
  reactions          PostReaction[]
  reports            ContentReport[]
  @@index([isHidden, createdAt])
}

model PostComment {
  id                 String        @id @default(cuid())
  postId             String
  authorId           String
  body               String
  isHidden           Boolean       @default(false)
  createdAt          DateTime      @default(now())
  updatedAt          DateTime      @updatedAt

  post               CommunityPost @relation(fields: [postId], references: [id], onDelete: Cascade)
  author             User          @relation(fields: [authorId], references: [id])
  @@index([postId, createdAt])
}

model PostReaction {
  id                 String        @id @default(cuid())
  postId             String
  userId             String
  reaction           String        @default("LIKE")
  createdAt          DateTime      @default(now())

  post               CommunityPost @relation(fields: [postId], references: [id], onDelete: Cascade)
  user               User          @relation(fields: [userId], references: [id], onDelete: Cascade)
  @@unique([postId, userId, reaction])
}

model ContentReport {
  id                 String        @id @default(cuid())
  reporterUserId     String
  postId             String?
  targetType         String
  targetId           String
  reason             String
  status             ReportStatus  @default(OPEN)
  moderatorUserId    String?
  moderatorNote      String?
  createdAt          DateTime      @default(now())
  resolvedAt         DateTime?

  post               CommunityPost? @relation(fields: [postId], references: [id])
  @@index([status, createdAt])
}

model FeatureProposal {
  id                 String         @id @default(cuid())
  authorId           String
  title              String
  description        String
  status             ProposalStatus @default(SUBMITTED)
  reviewNote         String?
  createdAt          DateTime       @default(now())
  updatedAt          DateTime       @updatedAt

  author             User           @relation(fields: [authorId], references: [id])
  votes              FeatureVote[]
  @@index([status, createdAt])
}

model FeatureVote {
  id                 String         @id @default(cuid())
  proposalId          String
  userId              String
  createdAt           DateTime       @default(now())

  proposal            FeatureProposal @relation(fields: [proposalId], references: [id], onDelete: Cascade)
  user                User            @relation(fields: [userId], references: [id], onDelete: Cascade)
  @@unique([proposalId, userId])
}

model AuditLog {
  id                 String   @id @default(cuid())
  actorUserId        String?
  action             String
  targetType         String
  targetId           String?
  reason             String?
  requestId          String?
  metadataRedacted   Json?
  createdAt          DateTime @default(now())

  actor              User?    @relation("AuditActor", fields: [actorUserId], references: [id])
  @@index([actorUserId, createdAt])
  @@index([targetType, targetId, createdAt])
}

model OutboxEvent {
  id                 String   @id @default(cuid())
  eventType          String
  aggregateType      String
  aggregateId        String
  payload            Json
  status             String   @default("PENDING")
  attempts           Int      @default(0)
  availableAt        DateTime @default(now())
  processedAt        DateTime?
  lastErrorRedacted  String?
  createdAt          DateTime @default(now())

  @@index([status, availableAt])
}
```

**Schema implementation notes:**

1.  This starter schema intentionally leaves some fields generic.
    Replace generic strings with enums where useful, add missing reverse
    relations required by Prisma validation, and run `prisma validate`
    before creating migrations.
2.  Decide whether `roles` should be a PostgreSQL enum array or a
    normalized role/capability join table. If using arrays, verify the
    exact Prisma support and authorization strategy. A normalized
    `UserRole` table may be preferable for evolving permissions.
3.  `PaymentEvent.providerEventId` uniqueness may need a composite key
    including provider, depending on provider semantics. Ensure nullable
    uniqueness behaves as intended in PostgreSQL.
4.  Avoid storing raw provider callback payloads. Persist only redacted,
    minimized fields needed for verification/reconciliation.
5.  Booking-overlap protection may require a PostgreSQL exclusion
    constraint or carefully scoped transaction/locking beyond a simple
    Prisma model.
6.  Consider a separate `Session` model if the selected authentication
    library requires it.
7.  Add foreign keys, delete policies, retention handling, and indexes
    based on real query patterns.
8.  Use decimal-safe money handling; never use JavaScript floating-point
    arithmetic for authoritative financial totals.
9.  Keep identity document content outside normal user profile rows and
    store only private storage keys/metadata in the database.
10. Generate and review migrations; never run destructive schema resets
    against a production database.

------------------------------------------------------------------------

## 9. API Design

### 9.1 General conventions

-   Base path: `/api/v1`.
-   JSON request/response bodies unless an upload endpoint explicitly
    uses multipart form data.
-   Use consistent response envelopes where useful.
-   Validate all inputs at the API boundary.
-   Require authentication and authorization for protected endpoints.
-   Use pagination for list endpoints (`limit`, `cursor` or `page`);
    enforce a server-side maximum.
-   Use ISO-8601 timestamps and document timezone behavior.
-   Use idempotency keys for payment creation and other retry-sensitive
    mutations.
-   Version breaking changes and keep API documentation synchronized
    with code.

Suggested success response:

``` json
{
  "data": {},
  "meta": {
    "requestId": "request-id"
  }
}
```

Suggested error response:

``` json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Please check the submitted fields.",
    "details": [
      {
        "field": "requestedStartAt",
        "issue": "Invalid date"
      }
    ],
    "requestId": "request-id"
  }
}
```

Do not expose stack traces, SQL errors, provider secrets, internal file
paths, or private record details in production error responses.

### 9.2 Authentication endpoints

  -----------------------------------------------------------------------------------------------
  Method            Endpoint                      Access                   Purpose
  ----------------- ----------------------------- ------------------------ ----------------------
  POST              `/auth/register`              Public, rate-limited     Start
                                                                           registration/pending
                                                                           verification

  POST              `/auth/verify-email`          Public, rate-limited     Verify email OTP/token

  POST              `/auth/resend-verification`   Public, rate-limited     Resend verification

  POST              `/auth/login`                 Public, rate-limited     Authenticate

  POST              `/auth/logout`                Authenticated            Revoke current session

  POST              `/auth/refresh`               Session-dependent        Rotate/refresh session
                                                                           if applicable

  POST              `/auth/forgot-password`       Public, rate-limited     Start reset flow

  POST              `/auth/reset-password`        Public, rate-limited     Complete reset

  GET               `/auth/me`                    Authenticated            Current user and
                                                                           capabilities

  POST              `/auth/roles/worker`          Customer/authenticated   Enable Worker
                                                                           capability and create
                                                                           onboarding draft
  -----------------------------------------------------------------------------------------------

OAuth callback routes depend on the selected authentication
library/provider. Configure the exact callback URI in the provider
console; do not invent or hard-code production credentials.

### 9.3 Public discovery endpoints

  --------------------------------------------------------------------------------------
  Method            Endpoint                        Access            Purpose
  ----------------- ------------------------------- ----------------- ------------------
  GET               `/categories`                   Public            Active categories

  GET               `/categories/:slug`             Public            Category details

  GET               `/workers`                      Public            Filtered,
                                                                      paginated worker
                                                                      search

  GET               `/workers/:idOrSlug`            Public            Public worker
                                                                      profile

  GET               `/workers/:idOrSlug/reviews`    Public            Eligible public
                                                                      reviews

  GET               `/workers/:idOrSlug/services`   Public            Public
                                                                      services/pricing
  --------------------------------------------------------------------------------------

Example query:

``` text
GET /api/v1/workers?category=plumbing&area=Sylhet&minRating=4&minPrice=300&maxPrice=2000&sort=rating&limit=20
```

All filters must be validated and applied server-side. Do not trust
client-supplied aggregate ratings or worker verification values.

### 9.4 Worker endpoints

  ----------------------------------------------------------------------------------
  Method            Endpoint                    Access            Purpose
  ----------------- --------------------------- ----------------- ------------------
  GET               `/worker/me`                Worker            Own worker profile

  PATCH             `/worker/me`                Worker            Update own profile

  PUT               `/worker/me/services`       Worker            Replace/update
                                                                  service listings

  PUT               `/worker/me/pricing`        Worker            Update pricing

  PUT               `/worker/me/availability`   Worker            Update
                                                                  availability

  POST              `/worker/me/documents`      Worker            Upload private
                                                                  verification
                                                                  document

  GET               `/worker/me/documents`      Worker            Own document
                                                                  status; not public
                                                                  document URL

  GET               `/worker/me/earnings`       Worker            Own
                                                                  earnings/payment
                                                                  summary
  ----------------------------------------------------------------------------------

### 9.5 Booking and dispute endpoints

  --------------------------------------------------------------------------------------
  Method            Endpoint                       Access              Purpose
  ----------------- ------------------------------ ------------------- -----------------
  POST              `/bookings`                    Customer            Create booking
                                                                       request

  GET               `/bookings`                    Customer/Worker     Own bookings only

  GET               `/bookings/:id`                Booking participant Booking detail

  POST              `/bookings/:id/quote`          Assigned Worker     Submit/update
                                                                       quote when
                                                                       allowed

  POST              `/bookings/:id/accept-quote`   Customer            Accept quote

  POST              `/bookings/:id/accept`         Assigned Worker     Accept request if
                                                                       workflow allows

  POST              `/bookings/:id/reject`         Assigned Worker     Reject request

  POST              `/bookings/:id/cancel`         Authorized          Cancel according
                                                   participant         to policy

  POST              `/bookings/:id/reschedule`     Authorized          Request/confirm
                                                   participant         reschedule

  POST              `/bookings/:id/start`          Authorized          Start service if
                                                   participant         workflow allows

  POST              `/bookings/:id/complete`       Authorized          Completion
                                                   participant         confirmation

  POST              `/bookings/:id/disputes`       Booking participant Open dispute

  GET               `/bookings/:id/history`        Booking             Read status
                                                   participant/Admin   history
                                                   permission          
  --------------------------------------------------------------------------------------

Prefer explicit domain actions over a generic endpoint that accepts any
status value.

### 9.6 Payment endpoints

  ----------------------------------------------------------------------------------------------
  Method            Endpoint                          Access                   Purpose
  ----------------- --------------------------------- ------------------------ -----------------
  POST              `/bookings/:id/payments`          Booking customer         Create payment
                                                                               attempt

  GET               `/payments/:id`                   Payment owner/authorized Read payment
                                                      admin                    state

  POST              `/payments/webhooks/bkash`        Provider callback;       Process bKash
                                                      signature/verification   event
                                                      required                 

  POST              `/payments/webhooks/sslcommerz`   Provider callback;       Process
                                                      verification required    SSLCOMMERZ event

  POST              `/admin/payments/:id/reconcile`   Authorized Admin         Trigger
                                                                               authorized
                                                                               reconciliation
  ----------------------------------------------------------------------------------------------

Payment creation must calculate the amount from the authoritative
booking snapshot, persist a payment attempt, and then call the provider.
Provider callbacks must be idempotent and verified. A browser-return URL
is for user experience only and cannot independently finalize payment
state.

### 9.7 Messaging and notifications endpoints

  -------------------------------------------------------------------------------------
  Method            Endpoint                        Access            Purpose
  ----------------- ------------------------------- ----------------- -----------------
  GET               `/conversations`                Member            List own
                                                                      conversations

  GET               `/conversations/:id/messages`   Member            Paginated
                                                                      messages

  POST              `/conversations/:id/messages`   Member            Send text message

  POST              `/conversations/:id/media`      Member            Upload/send
                                                                      allowed media

  POST              `/conversations/:id/read`       Member            Update read
                                                                      marker

  GET               `/notifications`                Authenticated     Own notifications

  POST              `/notifications/:id/read`       Recipient         Mark read

  POST              `/notifications/read-all`       Authenticated     Mark own
                                                                      notifications
                                                                      read
  -------------------------------------------------------------------------------------

### 9.8 Reviews, community, and feature requests

  ----------------------------------------------------------------------------------------
  Method            Endpoint                           Access            Purpose
  ----------------- ---------------------------------- ----------------- -----------------
  POST              `/bookings/:id/review`             Eligible Customer Submit eligible
                                                                         review

  POST              `/reviews/:id/report`              Authenticated     Report review

  GET               `/community/posts`                 Public/auth       List posts
                                                       policy            

  POST              `/community/posts`                 Authenticated     Create post

  POST              `/community/posts/:id/comments`    Authenticated     Comment

  POST              `/community/posts/:id/reactions`   Authenticated     React

  POST              `/community/reports`               Authenticated     Report content

  GET               `/feature-proposals`               Public/auth       List proposals
                                                       policy            

  POST              `/feature-proposals`               Authenticated     Submit proposal

  POST              `/feature-proposals/:id/vote`      Authenticated     Vote once

  DELETE            `/feature-proposals/:id/vote`      Authenticated     Remove own vote
                                                                         if policy permits
  ----------------------------------------------------------------------------------------

### 9.9 Admin endpoints

Examples (must be protected by specific server-side permissions):

-   `GET /admin/overview`
-   `GET /admin/verifications`
-   `POST /admin/verifications/:documentId/decision`
-   `GET /admin/disputes`
-   `POST /admin/disputes/:id/decision`
-   `GET /admin/reports`
-   `POST /admin/reports/:id/decision`
-   `POST /admin/categories`
-   `PATCH /admin/categories/:id`
-   `POST /admin/users/:id/suspend`
-   `POST /admin/users/:id/restore`
-   `GET /admin/audit-logs`
-   `GET /admin/payments/reconciliation`

Admin route names may be refined during implementation, but the
authorization model and audit requirements must remain.

> **As implemented (Step 9):** `POST /bookings/:id/review` (plus `GET/PUT/DELETE` on the same path), `GET /workers/:slug/reviews`, `POST /reviews/:id/report`, `/community/posts*`, `/community/comments/:id`, `/community/reports`, `/feature-proposals*`, and admin `GET /admin/reports`, `POST /admin/reports/:id/decision`, `GET/POST /admin/proposals*`, `POST /admin/moderation/:type/:id/visibility`, `GET /admin/moderation/overview|history`. Reactions are `POST .../reactions` and `DELETE .../reactions/:type`. See [API.md](API.md).

### 9.10 AI endpoints

-   `POST /ai/chat`: authenticated assistant request with limits.
-   `POST /ai/worker-search`: structured natural-language search mapped
    to allowlisted filters/tools.
-   `GET /ai/health`: service health without secrets.
-   Optional admin-only knowledge-base ingestion endpoints must be
    authenticated and must not be publicly exposed.

AI responses should contain a user-facing answer and, where appropriate,
structured references to real workers or help articles. The API must
validate any worker IDs returned by tools before sending them to the
browser.

------------------------------------------------------------------------

## 10. Environment Variables

Keep a committed `.env.example` with placeholders only. Never commit
`.env`, production secrets, private keys, provider tokens, or actual
database credentials.

### 10.1 Web app

``` dotenv
NODE_ENV=development
NEXT_PUBLIC_APP_NAME="FixedItNow"
NEXT_PUBLIC_APP_URL=http://localhost:3000
API_BASE_URL=http://localhost:4000/api/v1
```

### 10.2 Main API

``` dotenv
NODE_ENV=development
PORT=4000
APP_URL=http://localhost:3000
API_PUBLIC_URL=http://localhost:4000
DATABASE_URL=postgresql://USER:PASSWORD@HOST:5432/first_eat_now
DIRECT_URL=postgresql://USER:PASSWORD@HOST:5432/first_eat_now
REDIS_URL=redis://localhost:6379
SESSION_SECRET=replace-with-a-long-random-secret
AUTH_SECRET=replace-with-a-long-random-secret
ALLOWED_ORIGINS=http://localhost:3000
EMAIL_PROVIDER=console
EMAIL_FROM="FixedItNow <no-reply@example.com>"
EMAIL_API_KEY=
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=
GOOGLE_CALLBACK_URL=
STORAGE_PROVIDER=local
S3_ENDPOINT=
S3_REGION=
S3_BUCKET=
S3_ACCESS_KEY_ID=
S3_SECRET_ACCESS_KEY=
S3_PUBLIC_BASE_URL=
BKASH_BASE_URL=
BKASH_APP_KEY=
BKASH_APP_SECRET=
BKASH_USERNAME=
BKASH_PASSWORD=
SSLCOMMERZ_BASE_URL=
SSLCOMMERZ_STORE_ID=
SSLCOMMERZ_STORE_PASSWORD=
SSLCOMMERZ_IS_LIVE=false
AI_SERVICE_URL=http://localhost:8000
```

### 10.3 Python AI service

``` dotenv
APP_ENV=development
AI_PORT=8000
OPENROUTER_API_KEY=
OPENROUTER_BASE_URL=https://openrouter.ai/api/v1
OPENROUTER_MODEL=
AI_REQUEST_TIMEOUT_SECONDS=30
AI_MAX_OUTPUT_TOKENS=1200
AI_RATE_LIMIT_PER_MINUTE=10
DATABASE_URL=
APP_API_BASE_URL=http://localhost:4000/api/v1
APP_API_SERVICE_TOKEN=
VECTOR_DATABASE_URL=
LANGSMITH_TRACING=false
LANGSMITH_API_KEY=
LANGSMITH_PROJECT=first-eat-now-dev
REDACT_TELEMETRY=true
```

### 10.4 Environment rules

-   Validate required variables at service startup and fail with a clear
    message that does not reveal secret values.
-   Separate development, test, staging, and production credentials.
-   Use the provider's exact current callback and sandbox configuration.
-   Do not put private server secrets in `NEXT_PUBLIC_*` variables.
-   A `.env.example` documents names only; it does not mean a provider
    is configured.
-   `APP_API_SERVICE_TOKEN` must be narrowly scoped, rotated, and never
    returned to the browser.
-   Disable sensitive tracing by default until redaction and access
    controls are verified.

------------------------------------------------------------------------

## 11. UI/UX and Design System Requirements

### 11.1 Visual direction

Design FixedItNow as a polished, trustworthy, modern Bangladesh
service marketplace. The UI should feel clear, welcoming, premium, and
practical rather than overly decorative.

Suggested visual language: - White and light neutral surfaces with deep
navy/blue for trust and hierarchy. - Teal/green accents for positive
actions and confirmed states. - Consistent spacing, restrained shadows,
subtle borders, rounded cards, and clear typography. - Support Bangla
and English text without clipping or awkward line wrapping. - Use real
product data and genuine empty states rather than decorative fake
metrics. - Avoid excessive gradients, animation, glassmorphism, or huge
hero sections that bury the main task.

### 11.2 Core layout

-   Public pages: responsive header, clear service search, category
    discovery, worker cards, how-it-works, trust/safety content, footer.
-   Customer area: compact dashboard navigation, booking overview,
    favorites, messages, notifications, profile/settings.
-   Worker area: profile completion, verification status, incoming
    requests, availability, services/pricing, reviews, earnings.
-   Admin area: operational navigation, queue counts, searchable tables,
    safe confirmation dialogs, audit history.
-   Mobile: accessible bottom navigation or compact menu where
    appropriate; avoid horizontal overflow.

### 11.3 Required component states

For every async screen, implement: - Initial loading/skeleton state. -
Empty state with a meaningful next action. - Error state with safe
message and retry. - Form validation state. - Disabled/loading button
state. - Success feedback. - Permission-denied state where applicable. -
Responsive and keyboard-focus states.

### 11.4 UI implementation rules

-   Reuse shared components and design tokens.
-   Avoid giant single-file pages and duplicated styling.
-   Use semantic forms and labels; don't rely only on placeholder text.
-   Make destructive actions explicit and confirm them.
-   Do not expose private information in client-side serialized objects.
-   Do not add UI controls that have no implemented action.
-   If a feature is not implemented, label it clearly as unavailable/not
    configured rather than pretending it works.

------------------------------------------------------------------------

## 12. Background Jobs, Notifications, and Reliability

Use a durable queue/outbox pattern where the hosting environment
supports it. If a free host does not support persistent workers,
document a safe alternative and its limitations.

Candidate jobs: - Email verification and password reset delivery. -
Booking status notifications. - Payment callback retry/reconciliation. -
Voice transcription. - Review sentiment analysis. - AI knowledge-base
ingestion. - Scheduled expiry of pending bookings/verification tokens. -
Cleanup of expired temporary uploads according to retention policy.

Job requirements: 1. Jobs must be idempotent or have deduplication keys.
2. Retry only transient failures, with backoff and maximum attempts. 3.
Persist failure metadata without secrets or unnecessary PII. 4. Ensure
duplicate delivery does not create duplicate payments, votes, reviews,
or messages. 5. Provide a way to inspect failed jobs and safely retry
authorized operations. 6. Never rely on an in-memory queue for a
production workflow that must survive process restarts.

------------------------------------------------------------------------

## 13. Testing Strategy and Acceptance Criteria

### 13.1 Test layers

-   Unit tests: validation, pricing calculations, booking transitions,
    permissions, payment state machine.
-   Integration tests: API + test database, transactions, uniqueness
    constraints, auth, access control.
-   Provider tests: sandbox payment verification and callback
    idempotency using provider documentation/test credentials.
-   UI tests: key user journeys, validation, responsive layout,
    accessibility basics.
-   End-to-end tests: register/login, dual role, worker onboarding,
    search, booking, quote, sandbox payment, messaging, review, admin
    verification.
-   Security tests: unauthorized access, IDOR, role escalation, rate
    limiting, upload validation, prompt injection, secret leakage.
-   Migration tests: apply migrations to a clean test database and
    verify upgrade path from supported prior schema.
-   Build checks: lint, type-check, unit/integration tests, production
    build.

### 13.2 Minimum acceptance criteria

**Authentication** - A user cannot access protected data without a valid
session. - A customer cannot access another customer's bookings or
conversations. - A public user cannot become Admin by changing a request
body. - OTPs expire and cannot be reused beyond policy.

**Worker verification** - NID documents are not reachable through public
URLs. - Only authorized reviewers can access document content. -
Decisions record reviewer, time, and reason.

**Bookings** - Invalid transitions are rejected. - Concurrent
overlapping booking attempts cannot both reserve the same worker/time
when policy disallows it. - Price and booking ownership are checked on
the server. - Status history is recorded.

**Payments** - Browser redirects alone do not mark payments
successful. - Invalid/unverified callbacks are rejected. - Duplicate
callbacks do not create duplicate ledger entries or payouts. -
Reconciliation-required cases are visible to authorized operators.

**Chat and media** - A non-member cannot read or send conversation
messages. - Upload type/size and ownership are validated. - Private
media requires authorized access.

**AI** - Worker search uses real database-backed tool results. - Prompt
injection cannot grant tools or permissions. - AI cannot claim that a
booking/payment changed unless a verified application operation confirms
it. - Logs/traces redact sensitive data.

**Community/admin** - Votes are unique per user/proposal. - Reaching a
vote threshold never deploys code or activates categories
automatically. - Admin actions create audit records.

**Release** - `lint`, type-check, tests, and production build pass. -
Required environment variables are documented and validated. -
Deployment, rollback, backup, and incident procedures are documented. -
Any unconfigured provider is marked as a release blocker, not a
completed integration.

------------------------------------------------------------------------

## 14. Deployment Architecture and Free-Tier-First Plan

### 14.1 Logical deployment topology

-   Web: managed Next.js hosting or a compatible Node host.
-   API: Node/NestJS hosting with health checks.
-   Database: managed PostgreSQL with backups and migration support.
-   Cache/queue: managed Redis-compatible service if needed.
-   AI: separate Python/FastAPI service; scale or disable independently.
-   Files: private object storage for verification documents and
    sensitive uploads; public media storage only for intentionally
    public assets.
-   Domain and email: configure DNS, sender verification, and callback
    URLs.
-   Payment: sandbox first, then provider-approved production
    credentials and verified callbacks.

Specific free tiers, quotas, sleep behavior, persistent-volume support,
queue limits, and commercial-use conditions change frequently. Verify
them immediately before choosing a provider. Do not assume a free tier
supports persistent WebSockets, scheduled jobs, private object storage,
or production-grade backups.

### 14.2 Deployment checklist

1.  Create separate development/staging/production environments.
2.  Set secrets through the host's secret manager/environment
    configuration.
3.  Provision PostgreSQL and Redis only if required by the chosen
    design.
4.  Apply reviewed migrations; do not use destructive reset commands in
    production.
5.  Configure CORS, trusted origins, cookie settings, TLS, and public
    URLs.
6.  Configure email sender and verify delivery.
7.  Configure Google OAuth callback URL if Google login is enabled.
8.  Configure private/public storage policies and verify unauthorized
    access fails.
9.  Test payment sandbox callbacks and duplicate callback behavior.
10. Configure monitoring, logs, backup/restore, and incident contacts.
11. Run smoke tests after deployment.
12. Verify rollback steps before announcing launch.

### 14.3 Release gates

Do not declare production-ready until: - Critical tests pass. - Auth,
authorization, and private-file checks pass. - Payment provider
integration is verified in sandbox and production approval is obtained
if real payments are enabled. - Database backups and restoration are
tested. - Required environment variables are configured. - The
production domain and callback URLs are correct. - Known limitations are
documented. - No critical secrets or private data appear in logs,
traces, repository history, or public files.

------------------------------------------------------------------------

## 15. Implementation Roadmap: Phase 0--11

Claude Code should execute one phase at a time. It must inspect the
repository first, produce a plan, implement a bounded phase, run tests,
report exact results, and stop before the next phase if there are
unresolved failures or risky migrations.

### Phase 0 --- Repository audit and implementation plan

Tasks: - Inspect current files, branches, package managers, frameworks,
schema, tests, environment templates, and deployment configuration. -
Identify existing functionality and incomplete areas. - Run current
lint/type-check/test/build commands where available. - Create/update
`docs/SRS.md`, `docs/ARCHITECTURE.md`, `docs/API.md`,
`docs/SECURITY.md`, and `docs/DEPLOYMENT.md`. - Write an implementation
gap matrix: existing / incomplete / missing / risky. - Propose a
dependency-aware phase plan. - Do not rewrite or delete working code.

Exit criteria: - A grounded architecture report exists. - Risks and
migration needs are documented. - Baseline tests and failures are
recorded.

### Phase 1 --- Foundation and design system

Tasks: - Establish UI tokens, typography, spacing, buttons, forms,
cards, dialogs, tables, alerts, skeletons, and toasts. - Implement
responsive app shell and public navigation. - Ensure accessibility and
Bangla/English rendering. - Set lint, type-check, formatting, and test
scripts. - Build reusable layout primitives.

Exit criteria: - Public shell renders on mobile and desktop. - Shared
components have meaningful states. - CI/build passes.

### Phase 2 --- Authentication and dual-role account

Tasks: - Implement registration, verification, login, logout, session
lifecycle, password reset, and optional Google OAuth. - Secure
cookie/session strategy and rate limits. - Implement Customer + Worker
capability model. - Keep Admin assignment privileged. - Add integration
tests for authorization and account enumeration risks.

Exit criteria: - Authentication journeys pass. - Cross-user access and
role escalation tests fail safely. - Provider-dependent features are
clearly marked if credentials are absent.

### Phase 3 --- Worker onboarding, documents, categories, discovery

Tasks: - Worker profile and onboarding wizard. - Private document upload
and verification queue. - Category management. - Worker listing/profile
pages and database-backed filters. - Favorites. - Pagination, sorting,
empty/error states.

Exit criteria: - Search is real, paginated, and validated. - NID
documents are private. - Worker verification status is accurate.

### Phase 4 --- Booking, quotes, availability, disputes

Tasks: - Booking creation, quotes, acceptance/rejection, cancellation,
rescheduling, completion. - Booking state machine and status history. -
Availability checks and concurrent booking protection. - Dispute
creation and admin review. - Customer and Worker dashboards.

Exit criteria: - Invalid transitions are rejected. - Ownership checks
cover all booking operations. - Concurrency tests cover overlapping
booking attempts.

### Phase 5 --- Payments

Tasks: - Provider adapters for bKash and SSLCOMMERZ. - Server-side
amount calculation. - Sandbox checkout/callback/verification. -
Idempotency and append-only payment event/ledger. - Reconciliation and
refund-state workflows.

Exit criteria: - Duplicate/invalid callbacks are handled safely. -
Browser redirects do not independently finalize payment. - Production
payment status is explicitly blocked until provider
approval/configuration.

### Phase 6 --- Messaging, media, and notifications

Tasks: - Booking-linked conversations. - Private messages and media
uploads. - Realtime transport or documented fallback. - Notifications
and delivery outbox/jobs. - Optional voice-message transcription behind
a provider adapter.

Exit criteria: - Conversation membership checks pass. - Upload security
tests pass. - Notification retries are safe.

### Phase 7 --- AI assistant and RAG

Tasks: - FastAPI service and health endpoint. - OpenRouter provider
adapter and configurable model. - RAG for approved
FAQs/policies/category content. - Allowlisted worker-search tools backed
by the API. - Input/output schema validation, limits, redaction,
prompt-injection tests. - Optional LangSmith tracing only after
redaction is tested.

Exit criteria: - Live facts are retrieved, not hallucinated. - No
arbitrary SQL/shell/admin/payment mutation tools exist. - Provider
failures degrade gracefully.

### Phase 8 --- Reviews, community, sentiment, feature proposals

Tasks: - Eligible booking reviews and one-review uniqueness. - Community
posts, comments, reactions, reports. - Feature proposals and one vote
per user. - Admin moderation queue. - Optional sentiment insights with
clear caveats.

Exit criteria: - Review eligibility and vote uniqueness are enforced. -
User content cannot trigger privileged AI actions. - Vote thresholds
only create admin review work.

### Phase 9 --- Admin dashboard and operations

Tasks: - Verification, categories, users, reports, disputes, payment
reconciliation, and audit views. - Permission-specific admin actions. -
Searchable/paginated tables and safe confirmation dialogs. -
Privacy-safe operational metrics.

Exit criteria: - Every sensitive action is authorized and audited. -
Sensitive documents and payment secrets are not exposed.

### Phase 10 --- Reliability and security hardening

Tasks: - Complete unit/integration/E2E test coverage for critical
paths. - Rate limits, secure headers, CORS, CSRF as applicable, file
validation, IDOR checks. - Queue retries/outbox, timeouts, health
checks, backup/restore tests. - Dependency/secret scans and privacy-safe
logs. - Load/performance checks appropriate to the target release.

Exit criteria: - Critical security tests pass. - No known
critical/high-severity release blockers remain unaddressed. - Migrations
and rollback steps are reviewed.

### Phase 11 --- Deployment, smoke tests, and release

Tasks: - Configure production secrets, domain, email, OAuth, storage,
database, AI, and payment adapters. - Apply reviewed migrations. - Run
smoke tests and end-to-end critical flows. - Verify logs, metrics,
backups, and rollback. - Publish user-facing limitations and support
procedures.

Exit criteria: - Release checklist is signed off. - No feature is
described as live unless it has been tested in the deployed
environment. - Provider-dependent blockers are documented clearly.

------------------------------------------------------------------------

## 16. Claude Code Operating Instructions

Use these instructions as the project-wide guardrails for Claude Code.
Give it one phase prompt at a time, then review the result before
proceeding.

``` text
You are the senior engineer responsible for implementing FixedItNow from the
existing repository.

MANDATORY RULES
1. Inspect the repository before editing. Never assume the stack, directory names,
   current branch, schema, or deployment state.
2. Preserve working features. Do not replace the project wholesale or delete
   files/configuration without explaining why and getting approval.
3. Follow docs/SRS.md and the agreed architecture. If the repository conflicts
   with this document, explain the conflict and propose the smallest safe change.
4. Work on only the requested phase. Do not silently implement future phases.
5. Before editing, list the files/areas to change and the acceptance criteria.
6. Use small, reviewable changes. Keep business logic out of UI components.
7. Validate all inputs server-side and enforce authorization for every protected
   operation. Client-side hiding is not security.
8. Never hard-code secrets or commit .env files. Update .env.example with names
   and placeholders only.
9. Never fake successful payments, email delivery, OAuth, uploads, AI results,
   or production deployment.
10. Never run destructive database commands, production migrations, deployments,
    pushes, merges, or irreversible actions unless explicitly authorized.
11. For schema changes, inspect current data/schema, create a migration, explain
    data impact, and run safe validation. Do not use db push/reset as a shortcut
    for production.
12. Use real persisted data for implemented features. If an integration is not
    configured, provide a clear disabled/unavailable state and document the setup.
13. Add/update tests for each changed behavior, especially authorization, booking
    transitions, payment idempotency, file access, and AI tool permissions.
14. Run the relevant lint, type-check, tests, and build. Report commands and
    actual pass/fail results; never claim tests passed if they were not run.
15. End each phase with: summary, files changed, migrations, env variables,
    commands run, test results, known limitations, security considerations,
    and exact next step. Stop if a critical check fails.
```

### 16.1 Phase prompt template

``` text
Implement Phase [NUMBER] — [PHASE NAME] from docs/SRS.md.

First inspect the current repository and relevant documentation. Do not assume
files or functionality exist. Report:
1. Current state relevant to this phase.
2. Acceptance criteria and implementation plan.
3. Files/modules likely to change.
4. Risks, migrations, and required environment variables.

Then implement only this phase using small, reviewable changes. Preserve existing
working behavior. Add or update tests. Run the relevant lint, type-check, tests,
and build commands that are actually available. Do not perform destructive
database operations, deploy, push, or merge.

At the end, report exact files changed, commands executed, actual test results,
migration status, configuration still needed, known limitations, and unresolved
risks. If any critical check fails, fix it before declaring the phase complete.
```

### 16.2 Mandatory verification prompt after each phase

``` text
Audit the implementation from the previous phase against docs/SRS.md.

Do not add new features. Inspect the diff and look for:
- broken or duplicated architecture,
- unimplemented UI controls,
- fake/mock data presented as live data,
- missing server-side validation or authorization,
- IDOR and cross-user data exposure,
- secret or private-data leakage,
- race conditions and missing transactions,
- missing tests or tests that do not assert real behavior,
- environment/documentation gaps,
- responsive/accessibility regressions.

Run the relevant checks. Fix only issues introduced by or blocking this phase.
Report every check with its actual result. Do not say PASS unless the command or
test was actually executed and passed.
```

------------------------------------------------------------------------

## 17. Security Threat Model

  -------------------------------------------------------------------------------
  Threat                  Example                 Required mitigation
  ----------------------- ----------------------- -------------------------------
  Broken access control / Customer reads another  Server-side ownership checks
  IDOR                    booking                 and negative tests

  Role escalation         User sends `role=ADMIN` Privileged role assignment only
                                                  through controlled admin
                                                  process

  Identity document       Public NID URL          Private storage, short-lived
  exposure                                        authorized access, audit trail

  Payment spoofing        User edits success URL  Server-side provider
                                                  verification and idempotent
                                                  callbacks

  Duplicate callbacks     Provider retries event  Event deduplication and
                                                  transactional state changes

  Booking race            Two customers reserve   Transaction/locking/exclusion
                          same slot               constraint

  OTP abuse               Brute-force or resend   Hash, TTL, attempts, rate
                          flood                   limit, generic responses

  Prompt injection        Community post asks AI  Treat content as untrusted,
                          to reveal secrets       tool allowlist, no
                                                  secret-bearing tools

  AI hallucination        Model invents           Structured live search tools
                          availability            and validated results

  Secret leakage          API key appears in      Server-only secrets, redaction,
                          browser bundle/logs     secret scanning

  Malicious upload        Spoofed file MIME       Size/type/signature checks,
                                                  private storage, scanning where
                                                  available

  Community abuse         Spam, harassment, vote  Rate limits, moderation,
                          manipulation            uniqueness, report queue

  Admin misuse            Untracked suspension or Least privilege, reasoned
                          document access         actions, audit logging

  Queue retry side        Duplicate               Idempotent jobs, outbox,
  effects                 notification/payment    deduplication
                          processing              
  -------------------------------------------------------------------------------

------------------------------------------------------------------------

## 18. Open Decisions and Release Blockers

The following require a deliberate choice or provider confirmation
during implementation:

1.  **Authentication library:** Select based on the current repository;
    document session/cookie and OAuth callback behavior.
2.  **Email provider:** Verify sender/domain requirements and free-tier
    limits.
3.  **File storage:** Confirm private object access, upload size limits,
    retention, and cost. Cloudinary may be used for appropriate public
    media, not automatically for private NID files.
4.  **Realtime messaging:** Confirm host support for WebSockets;
    otherwise use a documented compatible provider or polling fallback.
5.  **Voice transcription:** Select a provider only if cost, privacy,
    and language support meet requirements.
6.  **Payment production approval:** bKash/SSLCOMMERZ merchant
    onboarding, credentials, callback URLs, fees, and production
    verification are external dependencies.
7.  **Worker verification policy:** Define acceptable documents,
    authorized reviewers, retention period, deletion process, and
    truthful badge wording.
8.  **Cancellation/refund policy:** Define time windows, fees, and who
    can approve refunds before enabling real payments.
9.  **Dispute policy:** Define evidence, review process, timelines, and
    escalation.
10. **Location provider:** Verify usage limits and terms for
    tiles/geocoding.
11. **Deployment providers:** Verify current free-tier quotas, sleeping
    behavior, backups, background worker support, and data location.
12. **Legal/privacy review:** Review applicable Bangladesh requirements
    and provider terms before production launch.

Do not silently invent a policy for a high-impact open decision. Add a
documented default for development and flag the production decision.

------------------------------------------------------------------------

## 19. Definition of Done

A feature is done only when all relevant conditions are met:

-   Its behavior matches an explicit requirement.
-   UI has loading, empty, error, success, and permission states as
    applicable.
-   Server-side validation and authorization are implemented.
-   Data is persisted correctly and protected by appropriate
    constraints.
-   Tests cover happy path and important negative/security paths.
-   Logs and errors do not expose secrets or unnecessary personal data.
-   Documentation and environment examples are updated.
-   Relevant lint/type-check/tests/build have been run and their results
    reported.
-   Provider dependencies and deployment setup are documented.
-   No fake or mock success is presented as a real production
    capability.

A phase is not complete merely because the page looks correct or the
code compiles.

------------------------------------------------------------------------

## 20. Final Implementation Principle

Build FixedItNow as a real, secure marketplace---not merely a
collection of attractive screens. Start with repository discovery and a
tested foundation, then implement each workflow from database to API to
UI. Keep the payment, identity verification, messaging, and AI trust
boundaries explicit. Use free tiers where practical, but treat their
limitations as deployment constraints rather than assumptions. Deliver
one verified phase at a time.
