# Booking, chat, arrival, payment and review workflow

This is the single description of how one customer-worker job runs from request to review, and which rule is enforced where. Details of each part live in [BOOKINGS.md](BOOKINGS.md) (state machine), [PAYMENTS.md](PAYMENTS.md) (bKash) and [COMMUNITY.md](COMMUNITY.md) (reviews). bKash is the only payment provider; SSLCOMMERZ was removed and is not part of this workflow.

> **What is verified.** Everything below is covered by automated tests against a real PostgreSQL database and a **mock** bKash (`backend/test/fake-providers.ts`). Nothing has been run against the real bKash sandbox, so how real bKash behaves (callback shapes, timings, the checkout host) is **unverified**. See [QA_REPORT.md](QA_REPORT.md), section "Follow-up: booking-to-review workflow".

## The lifecycle

```
customer requests ──► REQUESTED / QUOTED ──worker accepts (or customer accepts a quote)──► CONFIRMED  (slot reserved, chat opens)
                          │ decline / cancel / expire: no chat, nothing reserved               │
                                                                                               ├─ worker "I have arrived": arrivedAt set, still CONFIRMED
                                                                                               ▼
                                                                          IN_PROGRESS ──worker "mark finished"──► COMPLETION_PENDING   ("work finished, payment due")
                                                                                                                          │ customer pays; server asks bKash
                                                                                                          verified payment▼
                                                                                                                       COMPLETED  ──► customer may review
```

| Product wording | Status in the code | Notes |
| --- | --- | --- |
| pending worker confirmation | `REQUESTED`, `QUOTED` | quote-priced services go through a quote first |
| confirmed | `CONFIRMED` | the slot is reserved by a DB exclusion constraint |
| worker arrived | `CONFIRMED` + `arrivedAt` | a milestone, **not a status**: no schema enum change, the reserved slot and every `CONFIRMED` rule are untouched |
| work in progress | `IN_PROGRESS` | optional explicit "start job" |
| work completed, pending payment | `COMPLETION_PENDING` | payable; not paid, not completed. Reached by the professional's "mark finished" **or** the customer's "Work is finished: pay now" |
| completed and paid | `COMPLETED` | reached only by the system after a verified payment (or by an administrator through a dispute, see below) |
| cancelled / rejected / disputed | `CANCELLED` / `DECLINED` / `DISPUTED` | `EXPIRED` for requests nobody answered |

### Who may do what

| Step | Endpoint | Who | Rules |
| --- | --- | --- | --- |
| Request | `POST /bookings` | any signed-in customer (not the worker themself) | worker must be verified, published, serve the area and offer the service; slot must be inside weekly hours, outside time off, on the 30-minute grid, 2 h-90 days ahead; idempotency key supported; price is a server snapshot |
| Accept | `POST /bookings/:id/accept` | assigned worker | still eligible; slot re-validated under a per-worker row lock **and** the DB exclusion constraint; stores `confirmedAt`, `agreedAmountBdt` |
| Decline | `POST /bookings/:id/decline` | assigned worker | no chat, nothing reserved |
| Arrive | `POST /bookings/:id/arrive` | assigned worker | `CONFIRMED` only, within the start window (30 min before start until 24 h after end), once; stamps `arrivedAt`; body must be empty (no location is accepted or stored) |
| Start | `POST /bookings/:id/start` | assigned worker | arrival is not required |
| Finish | `POST /bookings/:id/complete` | assigned worker | `IN_PROGRESS` only; stamps `completionRequestedAt`; **does not pay or complete**; tells the customer what is due |
| Finish (customer) | `POST /bookings/:id/mark-finished` | the booking's customer | `CONFIRMED` or `IN_PROGRESS`, any time (typically work done **earlier than scheduled**, before the professional's arrival window opens). Same effect as the professional's report: `COMPLETION_PENDING`, payment due; the professional is notified and can still open a dispute. Completes and pays nothing; history shows the actor as the customer. |
| Pay | `POST /bookings/:id/payments` | the booking's customer | only in `COMPLETION_PENDING`; amount = stored `agreedAmountBdt`, never a client value |
| Complete | *(system)* | `PaymentsService` | `payment_verified`, `COMPLETION_PENDING` to `COMPLETED`, same transaction as the payment becoming `SUCCEEDED` |
| Review | `POST /bookings/:id/review` | the booking's customer | see "Review eligibility" |

Anyone who is not a participant gets the same `404` as for an unknown id. A participant of the wrong role gets `403 NOT_ALLOWED`. No endpoint accepts a status, an amount, a user id, a worker id or a role from the client (strict schemas, tested).

**Arrival is self-reported.** The server stores who pressed the button and when. It does not read a GPS position, and the UI says "reported by the professional (location is not verified)". Do not describe it as location verification.

## Payment

* **Trusted inputs only.** The payable amount is read from the booking (`agreedAmountBdt`, set at acceptance from the rate or the accepted quote). The browser sends only the provider name.
* **Idempotency.** An `Idempotency-Key` makes a double click a replay. A partial unique index allows one open payment per booking; a paid booking cannot be paid again.
* **Verification.** The only code that makes a payment `SUCCEEDED` is `PaymentsService.applyCompleted`, which runs only on the answer of bKash's own query API (reference, amount, currency, ids must match). A redirect, `?status=success`, a forged or repeated callback, or the frontend's success message prove nothing; the page polls the server.
* **Uncertain outcomes.** A timeout or a "not yet" answer leaves the payment `PROCESSING` (never `FAILED`), re-checked on the next status read or by the reconcile job. A customer can retry after `FAILED`/`CANCELLED`/`EXPIRED`; while one attempt is open, another is refused (`PAYMENT_IN_PROGRESS`). A mismatch parks the payment as `REQUIRES_REVIEW` for an administrator and the booking stays `COMPLETION_PENDING`.
* **Booking effect.** A verified payment on a `COMPLETION_PENDING` booking sets `COMPLETED` and `completedAt`, writes `payment.verified` and `booking.completed` history events, and notifies both people, atomically with the payment. A payment arriving for a booking that is `DISPUTED` or `CANCELLED` is recorded but changes nothing about the booking (`BOOKING_INELIGIBLE`, for an administrator).
* **Administrator-completed disputes.** A dispute outcome `MARK_COMPLETED` can complete a booking nobody paid. It stays payable and is **not reviewable** until a verified payment exists.

## Review eligibility

One rule, evaluated on the server (`reviews/ratings.ts`, used by creation, the booking detail, public lists, ratings on cards, and the AI assistant):

1. the caller is the booking's customer (anyone else: `404`; the professional cannot review their own job);
2. the booking is `COMPLETED`;
3. a payment for it is `SUCCEEDED` or `PARTIALLY_REFUNDED` (verified by the provider);
4. no review exists yet (`UNIQUE (bookingId)`, so parallel submissions create one row).

A review **counts** (average, count, distribution, "Verified booking") while it is `VISIBLE` **and** conditions 2 and 3 still hold. A dispute that moves the booking away from `COMPLETED`, or a full refund, stops it counting without deleting it. Rating is an integer 1-5, the comment is optional plain text of at most 1000 characters; unknown fields (`workerId`, `customerId`) are rejected. Ratings are computed from rows on every read; there is no stored or hardcoded rating. Edit (7 days) and withdraw already existed and keep their audit rows.

**Behaviour change to know about:** before this workflow, completing a job needed only the customer's own confirmation, so existing reviews on bookings that were completed without any verified payment **stop counting** (they are kept). Count them before deploying with the query in "Migration".

## Private chat

| Booking state | Chat |
| --- | --- |
| `REQUESTED`, `QUOTED`, `DECLINED`, `EXPIRED`, cancelled before it was ever confirmed | **not available** (`409 CHAT_NOT_AVAILABLE`; the UI shows no chat button) |
| `CONFIRMED`, `IN_PROGRESS`, `COMPLETION_PENDING` | open: read and send |
| `COMPLETED` | open for 14 days after `completedAt` (the dispute window), then read-only |
| `DISPUTED` | read-only (the dispute thread is the channel; the record does not move under it); restored with the booking if the dispute is withdrawn |
| `CANCELLED` after confirmation | read-only history |

* **Access.** Only the booking's customer and its assigned professional, on every request (default-deny session, then a participant check; others get `404`). There is no admin, public, search or profile endpoint that returns messages, and message text is never copied into notifications or the booking history.
* **Identity.** Sender id, role and booking come from the session and the URL. The body is `{ body, clientMessageId }` and nothing else (strict). A database trigger independently rejects a message whose sender is not a participant in the stated role, or whose booking was never confirmed.
* **Persistence and retries.** A message is shown as sent only after the server stored it. `clientMessageId` plus `UNIQUE (bookingId, senderId, clientMessageId)` make a network retry or double click a no-op replay (`200` with the same message); the same key with different text is `409`. Messages are ordered by a database sequence, never by timestamps.
* **Immutability.** `chat_message` is append-only (trigger): nobody can edit or delete a message, which keeps a dispute's evidence intact. There is no edit or delete route.
* **Limits.** 1-2000 characters, control/bidi characters rejected, 1000 messages per booking, 30 sends and 60 reads per minute per IP.
* **Delivery.** The web page polls every 5 seconds while the conversation is open and the tab is visible. There is **no WebSocket push and no read receipt**; the UI says so. Retention: kept indefinitely (no deletion job exists), readable by the two participants.
* Do not put real identity documents or admin notes in chat; the product has no attachment support at all.

## Notifications

In-app only (the existing `notification` table and bell). Created **after** the action committed, with one retry; a failure is logged (type and recipient id, never the text) and never undoes the booking, payment or review. Nothing sends an email, SMS or push for these events, so nothing here claims an email was delivered.

| Event | Recipient |
| --- | --- |
| request created | professional |
| accepted / declined (also: quote accepted) | customer (professional for an accepted quote) |
| quote received | customer |
| cancelled | the other person |
| arrival reported | customer |
| work finished: payment due | customer |
| payment verified | customer and professional |
| payment failed / needs review | customer |
| new chat message | the other person (one unread notice per conversation) |
| review received | professional |

## Migration

New migration `20261102000000_booking_chat_arrival_payment_gate` (additive): `booking.arrivedAt` (+ check), `chat_message` (+ constraints, participant trigger, append-only trigger), and a data fix completing any `COMPLETION_PENDING` booking that already has a verified payment. It changes no enum and drops nothing.

```bash
cd backend
# review what would run, against STAGING only
DATABASE_URL="<staging url>" npx prisma migrate status
DATABASE_URL="<staging url>" npm run db:deploy
```

Before running it on any database that holds real data, look at what it will touch:

```sql
-- bookings the data fix will complete (verified payment already recorded)
SELECT count(*) FROM booking b WHERE b.status = 'COMPLETION_PENDING'
  AND EXISTS (SELECT 1 FROM payment p WHERE p."bookingId" = b.id AND p.status IN ('SUCCEEDED','PARTIALLY_REFUNDED','REFUNDED'));
-- reviews that stop counting under the new rule (kept, but not counted or shown as verified)
SELECT count(*) FROM review r JOIN booking b ON b.id = r."bookingId"
 WHERE b.status = 'COMPLETED' AND NOT EXISTS (SELECT 1 FROM payment p WHERE p."bookingId" = b.id AND p.status IN ('SUCCEEDED','PARTIALLY_REFUNDED'));
```

Rolling back means dropping `chat_message` and `booking.arrivedAt`; there is no automated down-migration.

## Known limits

* No real bKash sandbox or production run, so callback and timing behaviour is assumed from the mock.
* Chat is polling, not push; there are no read receipts, attachments, typing indicators or unread counts beyond the notification.
* Arrival is not location-verified.
* A paid booking can only be cancelled through a dispute, and there is still no refund fee/deadline policy.
* Email/SMS/push notifications for these events do not exist.

## The same workflow in the demo (see [DEMO.md](DEMO.md))

Demo Customer and Demo Worker run exactly this lifecycle, with these differences, all enforced in the backend:

- They live in the **demo realm**: they can only see and book the fictional demo professionals, and nothing they do is visible to ordinary users, admin lists, revenue figures or the public directory. The database also refuses a booking that connects a demo account with an ordinary one.
- **Payment is simulated.** `POST /bookings/:id/payments` accepts only `{provider:"DEMO"}` for them (bKash is unreachable even when configured). The "checkout" is `/payments/demo/<reference>`; the outcome the visitor picks is applied through the same `applyVerification` state machine, so only a *successful* simulated payment moves `COMPLETION_PENDING` to `COMPLETED` and unlocks the review. A real booking can never be paid by the simulation, and a real payment can never be settled by a demo outcome.
- No email is sent and no provider is called by any demo action; the AI assistant and identity-document uploads are closed.
- Refunds follow the normal rule (cancelled bookings only) and can never be executed: the `DEMO` adapter has refunds disabled and the Demo Admin is read-only.
- Chat authorization is unchanged (only the booking's two participants); a Demo Admin or a real user gets "not found".

Verified by `backend/test/demo-workflow.e2e-spec.ts` (request, accept, chat, arrive, start, finish, simulated pay incl. a failed attempt and retry, complete, review, no provider call, no mail) and a real-Chrome pass (`frontend/e2e/demo.mjs`).
