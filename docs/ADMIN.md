# Admin panel

How the FixedItNow admin panel works, what it needs to run, and what is (and is not) verified. The code
is the source of truth for request and response shapes; [API.md](API.md) has the endpoint index and
[SECURITY.md](SECURITY.md) the wider threat model.

## 1. Model

```
User.role          USER | ADMIN          (DB only; no public API can write it)
User.adminRoleId   -> admin_role         (CHECK: only an ADMIN can hold a role)
admin_role.permissions  text[]           ("*" only on the system role super_admin)
```

* **An ADMIN with no role has no permissions** (fails closed). Existing administrators were migrated to the
  system role `super_admin`.
* Permissions are read from the database **on every request** (the auth guard joins the role). Changing a
  role, demoting or suspending an admin takes effect on their next request; there is no stale token.
* `/me` returns `admin.permissions` so the UI can hide controls. That is a convenience; the server decides.
* The catalogue of permissions lives in one file, `backend/src/admin/permissions.ts` (32 permissions in 11
  groups). Every `/admin/*` route declares what it needs with `@RequirePermission(...)`.
  `test/admin-rbac.e2e-spec.ts` fails if a route has no declaration **or** if a permission guards no route.

### Roles

| Role | How it is created | Notes |
| --- | --- | --- |
| `super_admin` | migration | Stores `["*"]` = every permission including future ones. Immutable: a trigger rejects any UPDATE/DELETE of a system role. |
| `operations_admin`, `verification_officer`, `finance_admin`, `support_agent`, `content_moderator` | `npm run db:seed` (only if missing) | Editable starting points; never overwritten by a re-seed. |
| custom | admin panel (`roles.manage`) | Any subset of the catalogue. |

### Who can do what to whom (anti-escalation)

* You can only give a role permissions **you hold**, and only edit, delete or assign roles that are **not more
  powerful than you** (`ROLE_TOO_POWERFUL`, `PERMISSION_ESCALATION`).
* `super_admin` can only be assigned by a super administrator, even to someone holding every current permission.
* Nobody changes their own admin access or suspends themself (`SELF_ACTION`); nobody restricts an admin more
  powerful than they are (`TARGET_TOO_POWERFUL`).
* Promotion needs a verified, unsuspended account. Granting needs `admins.assign` plus `confirm: true` and a reason.
* **The last active super administrator cannot be demoted or suspended**, enforced by a database trigger (with an
  advisory lock, so two simultaneous demotions cannot both succeed). Deleting a user row is an operator action and is not blocked.
* **First administrator:** `npm run admin:grant -- someone@example.com [--role key] [--revoke]` (operator script, needs
  `DATABASE_URL`, never reachable over HTTP, audited). After that, admins with `admins.assign` do it in the panel.
* **Public users cannot grant themselves anything.** `role` and `adminRoleId` are not Better Auth fields, so sign-up and
  profile-update bodies that include them are ignored (tested).

## 2. Modules

| # | Module | Back end | UI |
| - | --- | --- | --- |
| 1 | Dashboard and analytics | `admin/dashboard` (aggregates only; sections filtered by the caller's permissions; Asia/Dhaka days; zero-filled series) | `/admin` |
| 2 | Users and roles | `admin/users`, `admin/roles`, `auth` (suspension) | `/admin/users`, `/admin/roles` |
| 3 | Worker verification and private documents | `admin/workers`, `worker/worker-documents.*` | `/admin/workers`, worker onboarding upload |
| 4 | Categories and subcategories | `admin/categories`, public `categories` (nested) | `/admin/categories` |
| 5 | Booking monitoring, disputes | `admin/bookings`, existing `admin/disputes` | `/admin/bookings`, `/admin/disputes` |
| 6 | Payments, commission report, refunds | existing `admin/payments` + `admin/refunds` (filters, split permissions, confirmation), `admin/finance` | `/admin/payments`, `/admin/finance` |
| 7 | Tickets, complaints | `support/*` (user), `admin/support` | `/account/support`, `/admin/support` |
| 8 | Community content, reports, reviews | `admin/content` (browse) + existing `moderation/*` | `/admin/moderation` |
| 9 | AI knowledge base and health | `admin/ai`, `GET /internal/ai/knowledge`, `rag_agent` reload | `/admin/ai` |
| 10 | Notifications, announcements | `notifications/*`, `admin/notifications` | `/account/notifications`, `/admin/announcements`, site banners |
| 11 | Audit log | `admin/audit` + DB hash chain | `/admin/audit` |
| 12 | Settings, integration health | `admin/settings`, `admin/ops` | `/admin/settings`, `/admin/system` |

### Suspension

`POST /admin/users/:id/suspension` sets `suspendedAt/suspensionReason`, **deletes every session of that user in the same
transaction**, and the audit row. From then on: the auth guard answers `403 ACCOUNT_SUSPENDED`; sign-in is refused
*after* the password is verified (a wrong password gets the normal answer, so suspension is not an account-probing oracle);
the user's published worker profile disappears from every public read (`ELIGIBLE_WORKER` includes `user.suspendedAt = null`).

### Worker documents (NID and others)

There was no document storage before this work. It now exists as `worker_document` rows holding **ciphertext only**:

* **AES-256-GCM**, key from `DOCUMENT_ENCRYPTION_KEY`, fresh 12-byte IV per document, and the additional authenticated data
  `id|workerProfileId|kind`, so bytes copied into another row fail to decrypt (tested).
* Upload: the request body *is* the image (`PUT /me/worker-profile/documents/:kind`), JPEG/PNG/WebP only, 512 B to 3 MB, type
  taken from **magic bytes** (a declared type that disagrees is refused; SVG, PDF, GIF are refused). Rate-limited. Closed once the profile is verified.
* There is **no read path for the owner or the public**, no URL, no thumbnail. The only read is
  `GET /admin/workers/:id/documents/:kind`: needs `workers.documents.view`, never the owner (a worker who is also an admin gets 404 on
  their own), responds `no-store`, `nosniff`, `Content-Security-Policy: sandbox`, and **writes an audit row in the same
  transaction as the read**: there is no un-logged view. Denied attempts are not "views" and are not logged as such.
* The NID *number* is never collected or stored; only images. Audit metadata never contains hashes or bytes.
* Not implemented: automatic deletion after a retention period, malware scanning, EXIF stripping, key rotation tooling
  (`keyId` is stored so rotation can be added). Losing the key makes documents unreadable.
* Setting `workers.requireIdentityDocuments` makes approval require both sides of the identity document.

### Categories and subcategories

`service_category.parentId` (one level; CHECK + trigger). Slugs are immutable. Deactivating a parent requires its subcategories to be
inactive first, and an active subcategory needs an active parent (trigger, so this holds for any writer). Deletion only for a
category that nothing references (workers, bookings, children), after typing its slug; otherwise deactivate. Public `GET /categories` returns active top-level
categories with `subcategories`; a parent's worker count and the search filter include workers listed under its subcategories.

### Money

* **No payment status ever comes from a client**: there is no admin endpoint that writes one (a test probes this), and `SUCCEEDED` is set only by the provider verification path from Step 6.
* Splitting duties: `payments.read` (view), `payments.reconcile` (ask the provider), `refunds.decide` (approve/reject/create), `refunds.process` (send to provider). Approve, create and process require `confirm: true`.
* Refunds are executed only when the environment enables them (`BKASH_REFUNDS_ENABLED` / `SSLCOMMERZ_REFUNDS_ENABLED`, default **false**). Automated tests use a fake HTTP layer and never reach a provider.
* **Commission is a report, not a ledger.** The platform charges no fee and pays nobody out (docs/PAYMENTS.md). `GET /admin/finance/commission` computes `net collected x rate` for a range (default `finance.commissionBps` = 0, or a what-if `rateBps`), where collected = provider-verified payments, refunded = provider-confirmed refunds on the day they completed. The response says so (`reportingOnly: true`).

### Audit log

* Every privileged change writes an `audit_log` row **in the same transaction** as the change (actor, action, target, time, safe metadata + request id). Metadata passes a sanitiser that redacts keys that look secret (`password`, `otp`, `token`, `nid`, `secret` ...), truncates long strings and bounds depth/size; free text from messages and documents is not copied.
* **Append-only:** a trigger rejects UPDATE and DELETE (the one exception is PostgreSQL's own `ON DELETE SET NULL` when a user is deleted; the actor id is preserved in `actorSnapshot`).
* **Tamper-evident:** a `BEFORE INSERT` trigger (under an advisory lock) assigns a gap-free `seq`, stores `prevHash`, and computes `hash = sha256(canonical JSON of the row + prevHash)`. `GET /admin/audit/verify` recomputes the whole chain inside PostgreSQL and reports the first bad `seq` and whether content changed, the chain broke, or rows were removed/reordered. Verification is itself logged.
* **Limits (be honest about them):** someone with superuser access can disable the triggers and rebuild the whole chain; `TRUNCATE` is not intercepted; deleting the **newest** rows leaves a valid shorter chain. Record the head hash (shown on the verify result and in the operations page) somewhere outside the database on a schedule, and restrict `TRUNCATE`/trigger changes with database roles (RUNBOOK.md).
* CSV export is bounded (5,000 rows), neutralises spreadsheet formulas, and is audited.

### Platform settings

A code registry (`admin/settings/registry.ts`) is the only place a setting exists. Unknown keys are rejected, values are validated by type and range, a stored value that stops validating falls back to its default, every change records before/after and a reason. Secrets are environment variables and are **never** settings.

| Key | Effect |
| --- | --- |
| `platform.maintenanceMode` / `maintenanceMessage` | Non-admin writes answer `503 MAINTENANCE`; reads, admins, sign-in and payment-provider callbacks are unaffected. |
| `platform.registrationsOpen` | Blocks new accounts (email sign-up and first-time Google sign-in). |
| `workers.requireIdentityDocuments` | Approval needs both identity-document images. |
| `finance.commissionBps` | Default rate of the commission report only. |
| `ai.assistantEnabled` | `POST /ai/chat` answers 503 and `GET /ai/status` says unavailable. |

Settings are cached in memory for 5 seconds per instance.

### AI knowledge base

Documents are rows (`knowledge_document` + `knowledge_revision`); only `PUBLISHED` ones are served to the AI service at `GET /internal/ai/knowledge` (service token, never a user session). Editing keeps every previous version; reverting creates a new version. The Python service has `AI_KNOWLEDGE_SOURCE=api`: it loads those documents at start (falling back to the bundled files if the API is unreachable), re-validates every field, and rebuilds its index when an admin presses **Sync now** (`POST /v1/knowledge/reload`, service token); a bad document fails the whole reload and the previous index keeps serving. "In sync" is claimed only if the running index was built from the API **and** its SHA-256 digest equals the digest of the published set (the same algorithm in Python and TypeScript; a cross-process test proves they agree). To seed the table from the bundled files: `npm run kb:import` (idempotent, never overwrites).

### Notifications

In-app only. Personal notifications are created by the system (worker decision, ticket reply/resolution) or by staff (`POST /admin/notifications`). Announcements are not fanned out per user: readers fetch the live ones for their audience (draft/archived never; window respected). Links are in-app paths only (database CHECK). **Not implemented:** email/SMS/push delivery of announcements, per-user notification preferences, and booking-linked messaging (Step 7).

## 3. Environment and manual configuration

| Variable | Where | Required for | Notes |
| --- | --- | --- | --- |
| `DATABASE_URL` | backend | everything | Run `npm run db:deploy` (migrations `20261101000000_admin_panel`, `20261101010000_category_integrity`) then `npm run db:seed` (admin roles). |
| `DOCUMENT_ENCRYPTION_KEY` | backend | worker identity-document upload | `openssl rand -base64 32`. SECRET. Back it up: losing it loses the documents. |
| `DOCUMENT_ENCRYPTION_KEY_ID` | backend | optional | default `k1`. |
| `AI_SERVICE_URL`, `AI_SERVICE_TOKEN`, `APP_API_SERVICE_TOKEN` | backend | AI status/sync | already documented in AI.md. |
| `AI_KNOWLEDGE_SOURCE=api` | rag_agent | admin-managed knowledge reaching the assistant | default `files`. With `files`, "Sync now" works but reports `inSync: false` and explains why. |
| `BKASH_*`, `SSLCOMMERZ_*`, `*_REFUNDS_ENABLED` | backend | payments and provider refunds | unchanged; refunds are off by default. |
| `TRUST_PROXY`, `TRUSTED_PROXIES` | backend | correct client IPs for rate limits | unchanged. |

Manual steps no code can do: create the first administrator (`npm run admin:grant`), set `DOCUMENT_ENCRYPTION_KEY` in the deployment's secret store, run `npm run kb:import` and set `AI_KNOWLEDGE_SOURCE=api` if you want admin-managed knowledge, keep the audit head hash outside the database, and (for real money) complete the provider sandbox/live checks listed in PAYMENTS.md.

## 4. Verification status

See the report at the end of the change for the actual numbers of the run. In short:

* **Verified by automated tests against a real PostgreSQL:** permission enforcement on every admin route (anonymous, ordinary user, role-less admin, limited admin, super admin), escalation rules, last-super-admin protection, suspension effects, audit chain and tamper detection, document encryption/access/audit, category integrity (service and triggers), finance maths, settings effects, support/notification IDOR checks, knowledge sync including a **real Python process**.
* **Verified with mocks only:** everything involving bKash/SSLCOMMERZ (fake HTTP layer). No real payment or refund was made.
* **Not verified anywhere:** real SMTP delivery, Google sign-in, a real language model, hosted (non-local) deployment.

## Demo access (see [DEMO.md](DEMO.md))

- **Settings:** six keys in the "Demo access" group (`demo.<customer|worker|admin>.visible` / `.enabled`), default off, never public. The admin UI renders them as one "Demo Access Settings" section above the generic groups. Changes go through the normal audited `PUT /admin/settings/:key` (reason required); switching `enabled` off also signs out that role's open demo sessions (extra audit entry `demo.sessions_end`). Only a real administrator with `settings.manage` can change them; the Demo Admin cannot even see them.
- **Demo administrator:** a dedicated user with the immutable system role `demo_admin`, whose effective permissions are the stored role intersected with the read-only allow-list `DEMO_ADMIN_PERMISSIONS` (dashboard, users, workers, bookings, disputes, payments, finance reports, support, moderation, settings: read only). It can never hold `super_admin`, the role cannot be given to an ordinary account (`403 DEMO_ROLE`, trigger as backstop), and `DemoGuard` refuses every state-changing request it makes. Real administrators never see demo users, bookings, payments or tickets in any list, count or report.
- **Operator commands:** `npm run demo:seed`, `npm run demo:reset -- --yes`.
