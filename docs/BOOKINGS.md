# Bookings, availability, quotes, rescheduling and disputes (Step 5)

This document is the single description of how the booking domain works. The state machine lives in
`backend/src/bookings/booking.state.ts` (bookings) and `dispute.state.ts` (disputes); everything below is
what the code actually does. Bookings never move, hold or refund money by themselves: payment is a separate domain ([PAYMENTS.md](PAYMENTS.md)) that reads the agreed price. **Since the booking-to-payment-to-review workflow ([WORKFLOW.md](WORKFLOW.md)) the two meet in exactly one place:** a provider-verified payment is what moves a finished job (`COMPLETION_PENDING`) to `COMPLETED`.

## Concepts and data

| Table | Purpose |
| --- | --- |
| `booking` | One request/appointment. `startAt`/`endAt` (UTC instants, half-open `[start, end)`) are the **only** schedule columns. Pricing is a **snapshot** taken at request time (`pricingModel`, `unitPriceBdt`, `pricingSnapshot`); `agreedAmountBdt` is set only at confirmation from server data. |
| `booking_event` | Append-only history/audit (actor role, type, from/to status, reason). Also the intended source for future notifications. |
| `quote` | A priced offer for a quote-priced booking. Integer BDT; `totalBdt = labor + materials + other` computed **by the server** and enforced by a CHECK constraint. |
| `reschedule_request` | A request to move a confirmed appointment (keeps the previous and proposed windows). |
| `dispute`, `dispute_message` | One dispute per booking, text-only messages (some admin-internal). |
| `worker_availability_rule`, `worker_time_off` | Weekly working windows and unavailable ranges. |

* **Money:** whole BDT integers (same unit as worker prices). The payment adapters convert to the provider's decimal format with integer arithmetic (`"500.00"`).
* **Time zone:** instants are stored in UTC. Weekly hours are interpreted in **Asia/Dhaka (UTC+06:00, no daylight saving)**. All UI times are shown in Bangladesh time. A unit test guards the fixed-offset assumption.
* **Grid:** appointments start/end on 30-minute marks; duration is 30-480 minutes in 30-minute steps.
* A booking is **never** created or changed from a client-supplied customer id, price, role or status; unknown fields are rejected (`400`).

## Pricing models (from the worker's service)

| Model | How it confirms |
| --- | --- |
| `FIXED` | Worker **accepts** -> `CONFIRMED`, `agreedAmountBdt = unitPriceBdt`. |
| `HOURLY` | Worker **accepts** -> `CONFIRMED`, `agreedAmountBdt = round(rate x minutes / 60)`. |
| `QUOTE` | Worker **sends a quote** -> `QUOTED`; customer **accepts** it -> `CONFIRMED`, `agreedAmountBdt = quote.totalBdt`. Workers cannot "accept" a quote-priced request, and cannot quote a fixed/hourly one. |

## Booking state machine

```
                    +--decline--> DECLINED
REQUESTED --quote--> QUOTED --accept quote--> CONFIRMED --start--> IN_PROGRESS --complete--> COMPLETION_PENDING --verified payment--> COMPLETED
   |  ^  <--reject/withdraw quote--+              |                                                  |              |
   |  +--accept (fixed/hourly)---------------------+                                                  |              |
   +--cancel/expire--> CANCELLED / EXPIRED          +--cancel--> CANCELLED       open dispute (from IN_PROGRESS, COMPLETION_PENDING,
                                                                               COMPLETED <= 14 days, or CONFIRMED after its start time)
                                                                                         v
                                                                                     DISPUTED --admin outcome / withdrawal--> COMPLETED | CANCELLED | previous status
```

Deviations from the SRS sketch: no separate `ACCEPTED` (accepting confirms directly: payment is not a gate for *confirmation*; it is the gate for *completion* and reviews), and `REJECTED` is named `DECLINED`.

| Action | Who | From | To |
| --- | --- | --- | --- |
| accept (fixed/hourly) | assigned worker | REQUESTED | CONFIRMED |
| decline | worker | REQUESTED, QUOTED | DECLINED |
| quote / revise | worker | REQUESTED, QUOTED | QUOTED |
| withdraw quote | worker | QUOTED | REQUESTED |
| reject quote | customer | QUOTED | REQUESTED |
| accept quote | customer | QUOTED | CONFIRMED |
| cancel | customer (REQUESTED/QUOTED/CONFIRMED), worker (CONFIRMED only) | | CANCELLED |
| arrive | assigned worker (same window as start; once) | CONFIRMED | CONFIRMED (stamps `arrivedAt`; a self-reported milestone, **no location is checked**) |
| start | worker (from 30 min before the start until 24 h after the end) | CONFIRMED | IN_PROGRESS |
| complete | worker | IN_PROGRESS | COMPLETION_PENDING (**payment due**; nothing is paid or completed) |
| mark finished (customer) | **customer** (any time after confirmation, e.g. early) | CONFIRMED, IN_PROGRESS | COMPLETION_PENDING (**payment due**, the same state the worker's report produces) |
| payment verified | **system only**, from `PaymentsService` after the provider confirmed the payment | COMPLETION_PENDING | COMPLETED |
| expire | system (lazy) | REQUESTED, QUOTED once the start time passes | EXPIRED |
| open dispute | either participant | see above | DISPUTED |
| dispute outcome | admin only | DISPUTED | COMPLETED / CANCELLED / previous |

Everything else is a `409 INVALID_TRANSITION`. Terminal statuses (`CANCELLED`, `DECLINED`, `EXPIRED`) allow nothing; `COMPLETED` allows only a dispute.
The old customer "confirm completion" action was **removed**: nobody can mark a booking completed by asking: the customer can only declare the work *finished* (payment due), never *completed*, and a `DISPUTED` booking can only leave that state through the dispute workflow.
Every transition is a single conditional `UPDATE ... WHERE status = <status we read>` plus an event row in one transaction.

**What the statuses mean for the paid workflow** (the product's names in brackets): `REQUESTED`/`QUOTED` [pending worker confirmation], `CONFIRMED` [confirmed; with `arrivedAt` set: worker arrived], `IN_PROGRESS` [work in progress], `COMPLETION_PENDING` [work completed, pending payment], `COMPLETED` [completed and paid; the one exception is a disputed job an administrator marked completed, which stays payable and is not reviewable until it is paid], `CANCELLED`/`DECLINED`/`EXPIRED`, `DISPUTED`. No new status value was added: arrival is a milestone on `CONFIRMED`, so the slot exclusion constraint and every existing rule keep working.

## Availability and conflict prevention

* **Weekly rules** (`PUT /me/availability`, replaces all): windows per weekday in Dhaka time. **No rules = not bookable** (the profile says so and the form shows an honest empty state).
* **Time off** (`POST /me/time-off`): refused (`409`) if it overlaps a *reserving* booking.
* A new request must start >= 2 h ahead and <= 90 days ahead, on the grid, inside one weekly window, outside time off, and not overlap a reserving booking.
* **Which statuses reserve a slot:** `CONFIRMED`, `IN_PROGRESS`, `COMPLETION_PENDING`. `REQUESTED`/`QUOTED` do **not** (many customers can ask for one slot; the first confirmation wins; nothing is blocked indefinitely). Cancelled/declined/expired/completed/disputed do not reserve.
* **Intervals are half-open**: 10:00-11:00 and 11:00-12:00 do not conflict; 10:30-11:30 does.
* **Concurrency, three layers:**
  1. every confirm/reschedule/time-off runs in a transaction that first locks the worker row (`SELECT ... FOR UPDATE`), serialising per worker;
  2. state changes are conditional updates, so a stale actor affects 0 rows -> `409 STALE_BOOKING`;
  3. a PostgreSQL **exclusion constraint** `booking_no_overlap` (`EXCLUDE USING gist (workerProfileId WITH =, tsrange(startAt, endAt, '[)') WITH &&) WHERE status IN (reserving)`) makes a double booking impossible even if application code is wrong. A violation maps to `409 SLOT_UNAVAILABLE`. Needs the `btree_gist` extension.
* Changing weekly hours never cancels confirmed bookings; it only gates new requests and reschedules.

## Quotes

Only for quote-priced bookings. The worker sends `laborBdt`, `materialsBdt`, `otherBdt` (0-1,000,000 each, whole taka), a description, optional terms/estimated duration and a validity (1-168 h, default 48, capped at the appointment start). The **server** computes the total; a client `totalBdt` is rejected.
A revision creates a **new** quote and marks the previous pending one `WITHDRAWN` (a partial unique index allows one `PENDING` quote per booking). Accepted quotes are immutable.

Accepting (customer only, one transaction): owns the booking; the quote belongs to *this* booking (else 404); it is `PENDING` and unexpired; optional `expectedTotalBdt` equals the stored total (else `409 QUOTE_CHANGED`); booking is `QUOTED`; worker still publicly eligible; the slot is still free (re-validated under the worker lock, then by the DB constraint). Then the quote -> `ACCEPTED` and the booking -> `CONFIRMED` at the **stored** price. Statuses: `PENDING, ACCEPTED, REJECTED, WITHDRAWN, EXPIRED`.

## Cancellation policy

Immediate and unilateral, recorded with actor, reason and time (`booking_event` + booking columns):

* **Customer:** before confirmation (reason optional) or after (reason, >= 5 characters, required). Cancelling ends once the job has started; a paid job can only be cancelled by an administrator through a dispute.
* **Worker:** only a `CONFIRMED` booking (reason required). Before confirmation they use **decline**.
* **Nobody:** once the job has started (use a dispute), after completion, or when already closed. Repeated/parallel cancels produce exactly one event.
* Cancelling releases the slot and closes pending quotes and reschedule requests.
* **No fees, penalties or refunds are defined or implied.** A cancellation after confirmation records `paymentReviewRequired: true` in the event metadata, and `lateCancellation: true` when it is under 24 h before the start, as markers for reviewers. Step 6 adds a customer refund *request* for a cancelled, paid booking and an admin review; it still defines no fee, percentage or deadline. Open product decision: a real cancellation/refund policy.

## Rescheduling policy

Request-and-approval, `CONFIRMED` bookings only, same duration (the agreed price stays valid), one open request at a time (partial unique index).
Either participant requests; **the other** accepts or rejects; the requester can withdraw. The original appointment stays valid and reserved until acceptance. On acceptance the new window is re-validated (rules, time off, conflicts, excluding the booking itself) and applied atomically under the worker lock; if it was taken meanwhile -> `409 SLOT_UNAVAILABLE` and nothing changes. Requests expire after 48 h or at the appointment start, whichever is sooner; starting the job or opening a dispute withdraws a pending request. The previous and new windows are kept on the request row.

## Disputes

One per booking; text only. Categories: `SERVICE_QUALITY, NO_SHOW, PRICE_DISAGREEMENT, CONDUCT, OTHER`. Statuses: `OPEN -> UNDER_REVIEW <-> WAITING_FOR_INFORMATION -> RESOLVED | REJECTED`; the opener can withdraw -> `CLOSED`. A party's reply while `WAITING_FOR_INFORMATION` returns it to `UNDER_REVIEW`.
Admin outcomes (`/admin/disputes/:id/resolve`): `MARK_COMPLETED`, `CANCEL_BOOKING`, `RESTORE_BOOKING` (back to the pre-dispute status; fails with `409` if its slot was taken). **There is no refund/payout outcome.** `reject` restores the booking.
Admins cannot act on disputes for bookings they are part of. Every admin action writes an `audit_log` row.
**Evidence upload is not supported** (no private storage exists yet): the API rejects attachment fields rather than accepting public URLs. Internal admin notes are never returned to participants.

## Lazy expiry (no scheduler yet)

There is no background job runner, so expiry is applied **when a booking is read or acted on** (`BookingCore.refresh`): quotes past their expiry -> `EXPIRED` (booking back to `REQUESTED`), reschedule requests past expiry -> `EXPIRED`, `REQUESTED`/`QUOTED` bookings whose start passed -> `EXPIRED`. Lists derive the effective status without writing. Pending quotes never block a slot. A future scheduler can call the same function.

## Privacy

Participants only; everyone else (strangers, other workers, admins on non-disputed bookings, non-existent ids) gets the **same 404**. A worker sees the customer's street address only once the booking is confirmed (before that: area only). Emails and account ids are never returned. Admins see disputes with booking context (names, address) but no emails/ids.

## Not built in this step

Email/SMS/push notifications (in-app notifications exist, see WORKFLOW.md), evidence uploads, an admin dashboard UI (API only), automatic completion after N days, scheduled expiry, travel/preparation buffers, per-service durations, recurring bookings.
