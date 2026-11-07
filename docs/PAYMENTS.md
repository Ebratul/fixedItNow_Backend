# Payments, bKash and refunds (Step 6)

> **SSLCOMMERZ was removed (2026-10-25).** bKash is the only payment provider. Sections below that still mention SSLCOMMERZ
> are historical and describe code that no longer exists. The `SSLCOMMERZ` value stays in the database enum only so old rows
> stay valid; nothing creates it.
>
> **bKash sandbox facts found on 2026-10-25** (grant-token, create payment and a bKash checkout URL were run against
> `https://tokenized.sandbox.bka.sh/v2/tokenized-checkout`; execute, query and refunds were **not** run against bKash):
> * `BKASH_BASE_URL` must be the **v2** base `https://tokenized.sandbox.bka.sh/v2/tokenized-checkout`. The older
>   `.../v1.2.0-beta` base uses different paths (`/tokenized/checkout/...`) and answers `Missing Authentication Token` here.
> * The sandbox `id_token` is about 880 characters and the checkout URL (host `sandbox.payment.bkash.com`) about 215; the
>   adapter used to reject anything over 200 characters, which made every payment fail with `TOKEN_UNAVAILABLE`.

This is the single description of how payments work. Code: `backend/src/payments/`. It describes what the code does, and it separates what
was **tested against mocks** from what was **verified with a real provider**. Nothing here was verified with a real provider.

> **A payment is successful only when the backend has verified it with the provider (server to server).** A browser redirect, a query
> parameter, a form field in a callback, or anything the client sends is a *hint*, never proof.

## Provider status

| Provider | Label | Evidence |
| --- | --- | --- |
| bKash (tokenized checkout v2) | **Implemented and unit-tested** (against mocked HTTP) | Adapter written from the official pages under `developer.bka.sh/docs` (read 2026-10-24). **No bKash credentials or sandbox access existed, so nothing was run against bKash.** It is *disabled* until all five `BKASH_*` credentials are set. |
| SSLCOMMERZ (hosted checkout v4) | **Implemented and unit-tested** (against mocked HTTP) | Adapter written from `developer.sslcommerz.com/doc/v4/` (read 2026-10-24). **No SSLCOMMERZ store or sandbox access existed; nothing was run against SSLCOMMERZ.** Disabled until the store id and password are set. |

Neither is "sandbox-tested" or "production-configured". Until the checklist in [Sandbox verification](#sandbox-verification) is done, treat both as
unproven. The mocks (`backend/test/fake-providers.ts`) prove *our* logic; they are not evidence about the providers' real behaviour.

## Business rules (assumptions, all reversible)

The SRS and Step 5 do not define a payment policy beyond FR-PAY-01..12, so these are the smallest safe choices. **Product owner: please confirm.**

| Question | What the code does |
| --- | --- |
| When is payment required? | **Payment is the gate for completion and reviews, not for confirmation.** A booking is confirmed without payment. The customer pays **after the professional reports the work finished** (`COMPLETION_PENDING` = "payment due"); payment is refused in every other status (`422 BOOKING_NOT_PAYABLE`), except `COMPLETED` for the one case of a disputed job an administrator completed without payment. A **verified** payment moves `COMPLETION_PENDING` to `COMPLETED` in the same transaction (see "Payment completes the booking" below). |
| Full, deposit or partial? | **Full payment of the agreed price only.** No deposits or instalments. |
| Amount | `booking.agreedAmountBdt` (fixed/hourly price computed at acceptance, or the accepted quote total). Never from the client. Currency is `BDT` only (CHECK-constrained). |
| Multiple attempts? | Sequentially. At most **one open attempt per booking** (database-enforced). A new attempt is allowed after the previous one is `FAILED`, `CANCELLED` or `EXPIRED`. Max 10 attempts per booking per hour. |
| Abandoned attempts | `PENDING` older than 5 min that never reached the provider is expired at once. `INITIATED` older than 30 min is expired **only after the provider says nothing was paid**. `PROCESSING` is never auto-expired (an unknown outcome waits for the provider or an admin). |
| Fee / commission | **None.** The customer pays the agreed price; no platform fee is added or deducted. |
| Worker payouts, escrow, split settlement | **Out of scope. Nothing is held in escrow, transferred or paid out.** A verified payment means *FixedItNow's provider account received the customer's money*; the UI says "payment verified", never "worker paid". |
| Cancellation | Cancelling never refunds anything by itself. After a cancellation the customer may *request* a refund (below). An open payment attempt is left alone: if it completes after the cancellation it is recorded and flagged (below). |
| Disputes | A disputed booking cannot be paid. A paid booking can be disputed as before. Dispute outcomes have no refund/payout effect; an admin may start a refund separately. |
| Who may request a refund? | The paying customer, for a verified payment, **only when the booking is `CANCELLED`** (the one case where "refund the customer" needs no policy). Admins may also create an (already approved) refund for a verified payment or a verified duplicate. |
| Who approves a refund? | An administrator who is not part of the booking. There is **no refund percentage, penalty or time limit** in the code; every decision is a human one. |

## Architecture

```
PaymentsController          customer API   (/bookings/:id/payments, /payments*)
PaymentCallbacksController  PUBLIC         (/payments/callbacks/*, /payments/ipn/sslcommerz)   <- untrusted input
AdminPaymentsController     admin API      (/admin/payments*, /admin/refunds*)
        |
PaymentsService      initiate, read, reverify(), applyVerification()  <- the ONLY place payment state comes from provider data
PaymentCallbacksService   turns a callback into "ask the provider", then calls applyVerification
RefundsService       request / approve / reject / process / verify
        |
PaymentProviders  ->  BkashAdapter, SslcommerzAdapter   (protocol only; never touch the DB; return neutral results)
        |
HttpClient           the single network boundary (replaced by a fake in every automated test)
```

* An adapter returns what the provider **reported** (`completed` with reference/amount/currency/ids, `not_completed`, or `indeterminate`).
  `PaymentsService` compares that with the stored attempt; adapters never decide acceptance.
* `PaymentsModule` does not import the bookings module. Booking detail calls `paymentSummary()` (a pure query) so there is no dependency cycle.
* A provider exists only if configured: `PaymentProviders` simply has no adapter for it, and `GET /payments/providers` says `available: false`.

## Data model

Migration `20261026000000_step6_payments` (additive; creates 3 tables, 3 enums, constraints, one trigger; alters nothing existing).

| Table | Purpose |
| --- | --- |
| `payment` | One attempt to pay one booking through one provider. `reference` = opaque public id (`FIN` + 24 hex = 96 random bits, also the provider-facing transaction id). Money is **integer BDT**. `providerPaymentId` (bKash paymentID / SSL session key), `providerTransactionId` (bKash trxID / SSL `bank_tran_id`), `providerValidationId` (SSL `val_id`), `isLive`, timestamps. FKs are `RESTRICT`: financial history cannot be cascaded away. |
| `payment_event` | **Append-only** history (UPDATE/DELETE rejected by a trigger). Type, from/to status, actor role, sanitised metadata, optional `dedupeKey` (unique) so a replayed notification cannot add a second row. |
| `refund` | One refund request/decision/execution. Unique `providerRefundReference` (our id sent to the provider). |

Database invariants (raw SQL, because Prisma cannot model them):
`amountBdt > 0`, `currency = 'BDT'`, `0 <= refundedAmountBdt <= amountBdt`; a paid status requires a provider transaction id; `REFUNDED` means fully refunded;
**one paid payment per booking** (partial unique index; a parked duplicate with `reviewReason = DUPLICATE_PAYMENT` is exempt so it can be refunded);
**one open attempt per booking**; **one open refund per payment**; approved refund amount `<= requested`.

Not stored: card numbers, PINs, tokens, credentials, raw provider payloads (events keep a few fixed keys built by our code; provider codes are reduced to `[A-Za-z0-9_.-]{1,40}`).

## State machines

Payment (`payment.state.ts`; every change goes through `assertPaymentTransition` plus a conditional `UPDATE ... WHERE status = <read>`):

```
PENDING --> INITIATED --> PROCESSING --> SUCCEEDED --> PARTIALLY_REFUNDED --> REFUNDED
   |            |             |             \----------------------------------^
   |            +-------------+--> FAILED | CANCELLED | EXPIRED --(provider-verified late payment)--> SUCCEEDED
   +--> FAILED | EXPIRED       +--> REQUIRES_REVIEW (money seen but not acceptable) --> (refund of a verified duplicate) --> REFUNDED
```

| Status | Meaning |
| --- | --- |
| `PENDING` | Row created; provider call not recorded yet. |
| `INITIATED` | Provider session created; waiting for the customer. |
| `PROCESSING` | The customer came back (callback) but the outcome is not verified yet, or verification was inconclusive. |
| `SUCCEEDED` | **Verified** with the provider: reference, amount, currency and ids matched. |
| `FAILED` / `CANCELLED` / `EXPIRED` | Not paid, as far as the provider can say. **Not final**: a later provider-verified payment can still move it to `SUCCEEDED`. |
| `REQUIRES_REVIEW` | The provider reports money moved but we cannot accept it: amount/currency/reference mismatch, a second payment for an already paid booking (`DUPLICATE_PAYMENT`) or a provider risk flag. No booking effect; blocks further payment attempts; an admin deals with it. |
| `PARTIALLY_REFUNDED` / `REFUNDED` | Reached **only** when the provider confirmed a refund. |

There is no `SUCCEEDED -> FAILED` edge: a late failure/cancel callback can never downgrade a verified payment (unit-tested and integration-tested).
`REFUND_PENDING` from the brief is not a payment status here: a refund in progress is a `refund` row, so the payment keeps telling the truth about money received.

Refund: `REQUESTED -> APPROVED -> PROCESSING -> SUCCEEDED | FAILED`, and `REQUESTED|APPROVED -> REJECTED`. **Approved is a decision, not money.**
`SUCCEEDED` requires the provider's refund-status API to confirm; a refund the provider merely accepted stays `PROCESSING`.

`SUCCEEDED` with `reviewReason = BOOKING_INELIGIBLE` = verified payment that arrived after the booking was cancelled/disputed. The booking is **not** reactivated;
the payment is recorded accurately and shown as "paid but booking no longer active" with a refund request offered.

## Initiation (`POST /bookings/:id/payments`, body `{ provider }`)

1. Authenticated; strict body (`amount`, `currency`, `status`, ids, ... are `400`).
2. One transaction: lock the booking row; booking must belong to the caller (else the same `404` as an unknown id); not already paid; no payment under review; no open attempt; booking payable; `agreedAmountBdt` present, `BDT`, inside the provider's limits (SSLCOMMERZ 10-500,000 BDT per its docs); attempt cap; then insert a `PENDING` row (random reference, `isLive` copied from the adapter).
3. **Outside** the transaction (no locks held over the network) call the provider with the stored amount.
4. Second transaction: `PENDING -> INITIATED` with the session id and checkout URL, or `PENDING -> FAILED` if the provider refused / was unreachable. Closing the row on a timeout is safe **here only**, because no checkout URL was ever issued, so no charge is possible.
5. The checkout URL must be `https` on the provider's own domain (`.bka.sh`, `.sslcommerz.com`); anything else is treated as a provider failure and never returned.

`Idempotency-Key` (8-64 chars) replays return the same payment (and its URL while `INITIATED`) with no second provider session. Parallel requests without a key are
serialised by the booking lock and the one-open-attempt index: exactly one wins (`409 PAYMENT_IN_PROGRESS` for the others).

## Verification and callbacks

All callback routes are `@Public()` and exempt from the browser-Origin (CSRF) check (`@SkipOriginCheck()`, because providers and cross-site browsers call them). A unit test asserts that
decorator is used by the callback controller and nowhere else. They answer with a fixed redirect/`OK`, never provider data or error details, and never trust a field in the request.

### bKash

Flow: grant token -> `create` -> customer pays on bKash -> bKash redirects the browser to
`GET /api/v1/payments/callbacks/bkash/:reference?paymentID=&status=&signature=` -> we call **`execute` once** -> we confirm with **`query/payment`** -> compare.

* The payment is found by **our** reference in the path. `paymentID` in the query must equal the stored one, else the callback is recorded as rejected and ignored.
* `status` and `signature` are **not trusted** (the docs give no way to verify the signature, and we do not invent one).
* bKash allows one `execute` per paymentID: a database claim (`executeStartedAt`) guarantees exactly one caller executes, even with parallel callbacks. If the execute request never reached bKash (token problem / 401) the claim is released so a later callback or reconcile retries it.
* The execute response is never trusted: only a `query` result of `Completed` (with `trxID`, matching `paymentID`, invoice number, amount and currency) counts. After an execute whose query still says `Initiated`, the paymentID is dead (docs) and the attempt becomes `FAILED`.
* Timeouts/5xx/auth errors leave the attempt `PROCESSING`; it is re-queried later. **A new charge is never started to resolve an unknown state.**
* The token is cached in memory (single-flight, 2-minute safety margin); after a failed grant there is a 5-minute cooldown because the docs limit grant-token to 2 calls/hour. The refresh-token endpoint is not documented on the page I could read, so expiry simply grants a new token.

### SSLCOMMERZ

Flow: session `POST /gwprocess/v4/api.php` -> customer pays on the hosted page -> the browser POSTs (form) to our `.../callbacks/sslcommerz/{success|fail|cancel}` and SSLCOMMERZ POSTs the IPN to
`/api/v1/payments/ipn/sslcommerz` -> we call the **Order Validation API** with the `val_id` -> compare.

* Found by `tran_id` = our reference. The validation response must say `VALID`/`VALIDATED`, its `tran_id` must be ours, `amount` and `currency_amount` must equal the agreed amount and the currency must be `BDT`.
* A `val_id` in the request that validates to a **different** `tran_id` (reference substitution) is discarded and logged; we then look the transaction up by our own `tran_id` (`merchantTransIDvalidationAPI`).
  A bogus `val_id` cannot make a payment succeed, and cannot poison the real owner of the transaction.
* A lost callback/IPN is recovered the same way (lookup by `tran_id`); two different successful sessions for one `tran_id` are *not* guessed between (inconclusive).
* `risk_level = 1` is parked as `REQUIRES_REVIEW (PROVIDER_RISK_FLAG)` (the docs say the merchant should review such transactions).
* **The IPN `verify_sign`/`verify_key` hash is not implemented**: the official page does not state the algorithm or secret, and we do not guess one. The IPN is treated as a hint that triggers the Validation API, which is what the page requires anyway.
* The IPN always gets a plain `200 OK` (even for unknown references, so nothing leaks); a transient internal error returns `500` so SSLCOMMERZ retries.

### Payment completes the booking

`applyCompleted` is the only code that turns a provider report into `SUCCEEDED`. Inside that same transaction (booking row locked first, then the payment row) it also runs the booking state-machine action `payment_verified` (system role only) when the booking is `COMPLETION_PENDING`: `completedAt` is stamped and a `booking.completed` history event is written. Any other booking status is left alone: a late payment on a `DISPUTED` or `CANCELLED` booking is recorded as `SUCCEEDED` with `reviewReason = BOOKING_INELIGIBLE`, never revives it, and needs an administrator. A browser redirect, `?status=success`, or a forged callback never reaches this code path as proof: the booking completes only after the provider's own query API confirmed reference, amount and currency. Customer and professional are notified **after** the commit (best effort; a failed notification never undoes the payment).

Because payment now happens after the work, a paid booking can no longer be cancelled by the customer. The self-service refund route ("the booking is `CANCELLED`") is therefore reached through a dispute whose administrator outcome is `CANCEL_BOOKING`. This is a consequence of the workflow, not a refund policy: there is still no fee, deadline or automatic refund.

### Comparison rules (`PaymentsService.applyCompleted`)

| Check | Failure |
| --- | --- |
| reported reference == stored | `REFERENCE_MISMATCH` |
| reported provider payment id == stored (when both exist) | `REFERENCE_MISMATCH` |
| currency == `BDT` | `CURRENCY_MISMATCH` |
| amount (integer poisha, exact decimal parse) == `amountBdt * 100` | `AMOUNT_MISMATCH` |
| the provider transaction id is not already attached to another attempt | `REFERENCE_MISMATCH` |
| provider did not flag the transaction as risky | `PROVIDER_RISK_FLAG` |
| no other paid payment exists for the booking | `DUPLICATE_PAYMENT` |

Any failure -> `REQUIRES_REVIEW` (quarantine, never silently attached or dropped). Amounts are compared as integer poisha; malformed or sub-poisha provider values never match.

## Idempotency and concurrency

* `applyVerification` runs in **one transaction that locks the booking row, then the payment row** (fixed lock order). Concurrent callbacks, IPNs and polls for a booking are applied one at a time.
* Repeating the same information changes nothing and writes no event (`dedupeKey`s, conditional updates, and "already settled" short-circuit). Tests send 6 parallel bKash callbacks and repeated SSLCOMMERZ IPNs: one `SUCCEEDED`, one execute call, one `payment.succeeded` event, one booking-history line.
* A different provider transaction id reported for an already settled payment is recorded as `payment.provider_mismatch` and changes nothing.
* The database backstops the application: two paid payments for one booking, or two open attempts, are rejected by unique indexes even if code is wrong.
* Booking lifecycle is untouched by payment. The only booking write is an informational `booking_event` (`payment.verified`) written once, in the same transaction.
* **Notifications:** none exist in this codebase (Step 5). Nothing is sent. When a notification system arrives, it should be driven from the committed `payment_event` / `booking_event` rows.

## Reconciliation

* **Lazy re-verification**: reading a payment (`GET /payments/:reference`, which the return page polls every 3 s for up to ~2 min) re-asks the provider when the attempt is unresolved. It is throttled per payment (>= 10 s apart, claimed with a conditional update), so polling cannot hammer the provider.
* **Admin**: `POST /admin/payments/:reference/reconcile` (10/min, audit-logged) force-checks one payment, including `FAILED`/`CANCELLED`/`EXPIRED` ones (it can discover a late success; it cannot invent one). `POST /admin/payments/reconcile-stale` (2/min) re-verifies up to 20 stale unresolved payments. Both are idempotent and admins cannot act on bookings they are party to.
* **Not implemented**: a scheduler. There is no job runner in this codebase and I did not add infrastructure. Until one exists, stale `PROCESSING` payments are resolved when the customer opens the payment, or when an admin calls the endpoints above (they could be called from an authenticated cron). The admin queue is `GET /admin/payments?status=NEEDS_ATTENTION|PROCESSING|REQUIRES_REVIEW`.

## Refunds

1. **Request** (`POST /payments/:reference/refunds`, `{ reason 10-500, amountBdt? }`): own, verified payment, booking `CANCELLED`, amount `<=` remaining (`amount - refunded`). Creates a `REQUESTED` row. Nothing else changes; no provider call.
2. **Admin create** (`POST /admin/payments/:reference/refunds`): for a verified payment (or a verified `DUPLICATE_PAYMENT`), created already `APPROVED`. Not allowed for amount-mismatch/risk/other review items (they are handled with the provider manually).
3. **Approve / reject** (`POST /admin/refunds/:id/approve|reject`): a decision with an optional smaller amount; audit-logged. Still no money moved.
4. **Process** (`POST /admin/refunds/:id/process`): only if `BKASH_REFUNDS_ENABLED` / `SSLCOMMERZ_REFUNDS_ENABLED` is `true`. Otherwise `422 REFUNDS_NOT_SUPPORTED` and the refund stays `APPROVED`. The refund becomes `PROCESSING` (one winner under parallel calls), the provider is asked, and then the provider's **refund-status** API is queried; only `refunded` makes it `SUCCEEDED`, which atomically adds to `payment.refundedAmountBdt` once and moves the payment to `PARTIALLY_REFUNDED`/`REFUNDED`.
5. A refund request that gets no answer (timeout) stays `PROCESSING`; it is **never re-sent automatically** (a retry could refund twice). `POST /admin/refunds/:id/reconcile` re-queries the refund status.

Limits, honestly:
* A refund can never exceed the remaining refundable amount (checked at request, approval and processing; CHECK-constrained; one open refund per payment so concurrent requests cannot share the same balance).
* **Manual refunds in a provider's merchant panel are not recorded as done.** If the refund API is unavailable for your merchant account, the refund stays `APPROVED`; do it in the panel and import/record it in a later step.
* SSLCOMMERZ refunds need your server's public IP whitelisted with SSLCOMMERZ (docs). bKash allows partial refunds (max 10 per transaction, within 60 days, duplicates within 10 min blocked).
* After a *full* refund the booking is not payable again through the app (the unique "paid" rule is conservative).
* Worker payouts are not part of any refund: no payout exists to reverse.

## Configuration

Server-side only (`backend/.env`). Nothing here is exposed to the browser or any API.

| Variable | Secret | Meaning |
| --- | --- | --- |
| `BKASH_BASE_URL` | no | e.g. `https://tokenized.sandbox.bka.sh/v2/tokenized-checkout` (host must be under `bka.sh`, https). The live URL is **not** in the docs I could read: take it from your bKash onboarding. |
| `BKASH_APP_KEY`, `BKASH_APP_SECRET`, `BKASH_USERNAME`, `BKASH_PASSWORD` | **yes** | Merchant API credentials from bKash. All five `BKASH_*` credentials or none. |
| `BKASH_IS_LIVE` | no | `false` (default) for sandbox. Must match the URL (a `sandbox` host cannot be live and vice versa) and `true` is only accepted when `NODE_ENV=production`. |
| `BKASH_AUTH_SCHEME` | no | `bearer` (default) or `raw`: how `Authorization` carries the id_token (the docs contradict themselves; see unverified details). |
| `BKASH_REFUNDS_ENABLED` | no | `true` only if your bKash agreement allows the refund API. |
| `SSLCOMMERZ_STORE_ID`, `SSLCOMMERZ_STORE_PASSWORD` | id no / **password yes** | Both or neither. |
| `SSLCOMMERZ_IS_LIVE` | no | `false` (default) uses `sandbox.sslcommerz.com`; `true` (production only) uses `securepay.sslcommerz.com`. The host is derived, never configured. |
| `SSLCOMMERZ_REFUNDS_ENABLED` | no | `true` only when the refund API and IP whitelisting are set up. |

Startup validation refuses inconsistent combinations (partial credentials, live outside production, live/sandbox URL mixups). Missing credentials are not an error: the provider is just unavailable.
Callback URLs are built from `BETTER_AUTH_URL` (the **public** origin; the web app proxies `/api/v1/*`) and the post-payment return page is the fixed `FRONTEND_ORIGIN/payments/<reference>`;
no redirect target is ever taken from user input.

## Sandbox verification

Do this with your own sandbox credentials (never paste them in chat or commit them), on a deployment reachable by the providers' servers over https (IPN/callbacks cannot reach `localhost`; use a tunnel for development):

1. Set the variables above in `backend/.env`; start backend + web. `GET /api/v1/payments/providers` (logged in) should show the provider `available` and `mode: "sandbox"`.
2. Book and confirm a job (fixed price, e.g. 500), open `/bookings/<id>/pay`, pay with the provider's **test** wallet/card.
3. Confirm: the return page reaches "Payment has been verified"; `payment_event` shows `payment.succeeded`; the amount in the provider's sandbox panel matches.
4. Repeat with: cancel on the provider page; failed payment; closing the tab after paying (then wait for the poll/IPN); a second payment attempt after a failure.
5. Try a refund of a small amount on a cancelled booking (needs the refund flag, and for SSLCOMMERZ the IP whitelist).
6. Resolve each item in [Unverified provider details](#unverified-provider-details) and update this file with the observed behaviour. Only then relabel the provider **Sandbox-tested**.

Mocked tests (no network, no credentials): `cd backend && npm test` (unit) and `npm run test:e2e` (needs the disposable `*_test` Postgres; see DEPLOYMENT.md).
The provider HTTP boundary is replaced by `backend/test/fake-providers.ts` in every test.

## Unverified provider details

Things I could not confirm without real accounts; the code is written so each is one small change:

| # | Detail | Current choice |
| --- | --- | --- |
| 1 | bKash `Authorization` header: docs table says `Bearer <id_token>`, curl samples send the raw token | `BKASH_AUTH_SCHEME=bearer` (flip to `raw` if the sandbox answers 401) |
| 2 | bKash refresh-token endpoint is not on the page I read | not used; a new grant-token is requested on expiry |
| 3 | bKash production base URL | must be supplied by you |
| 4 | bKash `amount` JSON type (docs: BigDecimal) | sent as a string `"500.00"` |
| 5 | bKash callback `signature` format | not verified (unspecified); verification is by execute + query |
| 6 | bKash refund-status body: `trxId` is described as the refund request id on one page and the original trx id on another | original trx id is sent; the response is matched on `refundTrxId` |
| 7 | bKash HTTP status codes for errors (docs only show `externalCode`) | any `externalCode` = provider error; 401/403 = auth error; 5xx = unknown |
| 8 | SSLCOMMERZ mandatory customer fields we do not collect (`cus_phone`, `cus_postcode`, `cus_add1`, `cus_city`) | the placeholder `N/A`; the sandbox may reject it, in which case collect a phone number at checkout |
| 9 | SSLCOMMERZ IPN `verify_sign` algorithm | not implemented; Validation API is authoritative |
| 10 | SSLCOMMERZ `risk_level` semantics | `1` is parked for review |
| 11 | Whether SSLCOMMERZ `VALIDATED` (repeat validation) always carries the same `tran_id`/amount | treated like `VALID` |
| 12 | SSLCOMMERZ refund idempotency on a repeated `refund_trans_id` | never re-sent automatically |

## Production-readiness checklist

- [ ] Merchant agreements, live credentials and (SSLCOMMERZ) IP whitelisting; the checklist above passed in the sandbox for each provider.
- [ ] A reverse proxy routes `/api/v1/*` (including the callbacks and IPN) to the backend over https; `BETTER_AUTH_URL` is the public https origin (see DEPLOYMENT.md).
- [ ] Product decisions confirmed: payment timing, refund policy, who may approve, whether to collect a deposit/commission.
- [ ] A scheduler (or cron against the admin endpoints) for reconciliation, and alerting on `REQUIRES_REVIEW` / stale `PROCESSING`.
- [ ] An admin UI for the payment/refund queues (API only today).
- [ ] A way to record refunds made manually in a provider panel (not supported).
- [ ] Notifications (customer/receipt), terms/privacy text covering payments, receipts/invoices, and VAT/tax decisions.
- [ ] A review of retention of `payment_event` rows and of personal data sent to providers (name, email).
- [ ] Decide on worker payouts (Step 6 does none).

## Not built in this step

Worker payouts, escrow, commissions/fees, deposits, subscription/recurring payments, bKash agreements/tokenized wallets, payment-link emails/SMS, receipts/invoices,
admin UI for payments, manual-refund recording, scheduled reconciliation, notifications.

## Simulated payments for demo accounts

`PaymentProvider` has a third value, `DEMO`, used **only** for the public demo ([DEMO.md](DEMO.md) section 8). `DemoPaymentAdapter` has no credentials and never touches the network; `PaymentProviders.get()` returns it only inside the demo realm and returns bKash only outside it. A database trigger (`payment_realm_guard`) refuses a `DEMO` payment for an ordinary customer and a real-provider payment for a demo customer, and a `DEMO` payment can never be `isLive`. `POST /payments/:reference/demo-outcome` (demo customers only, strict body `{outcome}`) settles a simulated payment through `applyVerification`, with a verification built from the stored attempt. Everything above for real payments (idempotency, one open attempt, one paid payment per booking, verification before completion, append-only events) applies unchanged, and demo payments are excluded from real finance reports. Still unverified: the real bKash sandbox.
