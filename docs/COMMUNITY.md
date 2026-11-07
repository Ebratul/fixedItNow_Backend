# Reviews, ratings, community, feature proposals and moderation (Step 9)

This is the single description of how reviews, the community, feature proposals, reports and admin moderation work. Code:
`backend/src/reviews/`, `backend/src/community/`, `backend/src/proposals/`, `backend/src/moderation/`; web pages under `frontend/src/app/community`, `admin/moderation`, plus the reviews section on `/workers/[slug]` and the review panel on `/bookings/[id]`.
It describes what the code does and separates what was tested from what was not.

## Status

| Capability | Status |
| --- | --- |
| Booking-verified reviews: create / edit (14 days) / withdraw, one per booking, DB-enforced | **Implemented and verified** (integration tests on real PostgreSQL, incl. parallel submissions) |
| Ratings (average + count) on cards, search, favourites, profile, AI assistant cards; rounding; honest "No reviews yet" | **Implemented and verified** |
| Public review list with server-derived "Verified booking" | **Implemented and verified** |
| Community posts, flat comments, likes (idempotent), soft delete, author edit | **Implemented and verified** |
| Reports (posts, comments, reviews, proposals), one per user per item, daily cap | **Implemented and verified** |
| Feature proposals + one vote per user, withdrawal, closed-voting rule, vote threshold -> admin filter only | **Implemented and verified** |
| Admin moderation API: queue, report detail with context and history, decisions, hide/restore, proposal decisions, overview counts, history | **Implemented and verified** |
| Audit log rows for every privileged action, written in the same transaction as the change | **Implemented and verified** (including a forced audit failure) |
| Web UI: reviews, review form, community feed / post / comments / likes, proposals, report dialog, admin console | **Implemented and component-tested**; see the verification section for what was and was not exercised in a real browser |
| Sentiment analysis | **Not implemented, deliberately** (see below) |
| A separate moderator role | **Not implemented**: the existing `ADMIN` role is the only privileged role |
| Worker replies to reviews, review photos, notifications of moderation outcomes, scheduled/bulk moderation | **Not implemented** (deferred) |

## Decisions (all reversible; product owner: please confirm)

| Question | Decision and reason |
| --- | --- |
| Who is privileged? | Only `UserRole.ADMIN`, re-read from the database on every request (`AuthGuard`/`AdminGuard`). No moderator role exists and nothing in registration, onboarding or any request body can grant one. Admin-granting stays the operator script `npm run admin:grant`. |
| Who may read the community? | **Signed-in users only.** The pages show per-viewer state (liked, mine) so they are never cacheable, and member names are not exposed to anonymous scrapers. **Reviews on a professional's public profile are public.** |
| Formatting | **Plain text everywhere.** No Markdown/HTML, so there is nothing to sanitise into markup; control and bidirectional-override characters are rejected, and React renders everything as text. |
| Public name next to content | The customer-profile display name if set, otherwise the first word of the account name. Never an email, account id or full name. |
| Reactions | One type, `LIKE`, on posts only (the SRS names reactions on posts). The schema and API take a server allow-list so more types are an additive change. |
| Comments | One level (no nesting): nested threads are not in the SRS. |
| Edits | Posts and comments: the author may edit while the content is `VISIBLE`. Reviews: see below. Proposals cannot be edited (that would let an author change an idea after people voted). |
| Deleting | Author deletion is a **soft delete, final** (`DELETED`): it cannot be restored by anyone, which also keeps reports and audit rows meaningful. |
| Hidden content | A moderator **hides** (`HIDDEN`, reason required) or **restores** it. The text is never rewritten. Only the author can still see their own hidden post (marked "Removed by moderators", reason not shown) and cannot edit or delete it, so removal cannot be dodged. |

## Reviews

**Eligibility** (decided on the server in `ReviewsService.create`, never from the request): the caller is the booking's customer **and** the booking is `COMPLETED` **and** a payment for it was **verified by the provider** (`SUCCEEDED` or `PARTIALLY_REFUNDED`; `422 BOOKING_NOT_REVIEWABLE` before completion, `422 PAYMENT_NOT_VERIFIED` for a completed-but-unpaid job). A booking that is not yours is the same `404` as one that does not exist; a non-completed booking is `422 BOOKING_NOT_REVIEWABLE`. A professional cannot review their own service (they are never the customer; self-booking is refused anyway). There is no time limit for writing the first review (open product decision).
**One per booking:** `UNIQUE (bookingId)`; parallel submissions create one row, the rest get `409 REVIEW_EXISTS` (tested with 6 simultaneous requests).
**Content:** `rating` integer 1-5 (also a DB `CHECK`), optional plain-text `comment` <= 1000 characters (blank = none). The body is a strict schema: `customerId`, `workerProfileId`, `bookingId`, `status`, `verified`, moderation fields, timestamps... are `400`, never silently ignored. The review is addressed **through its booking** (`/bookings/:id/review`), so there is no review id to guess.
**Editing:** the author may edit rating and/or comment for **14 days** after posting, only while the review is `VISIBLE`. Each edit stores the previous values in `review_revision` (visible to administrators in the report detail) and the review shows "edited". A review hidden by a moderator can no longer be edited or withdrawn (no escaping moderation by rewriting).
**Withdrawing:** the author can withdraw at any time while `VISIBLE`; it is final and idempotent, and the booking cannot be reviewed again (so reviews cannot be churned).
**Moderation:** an administrator can hide/restore a review (reason required, audited). Hiding does not touch the text or rating.
**Verified booking:** the public list only returns reviews whose booking is **currently** `COMPLETED` with a verified payment, and `verifiedBooking: true` is derived from that join. There is no field a client can send to get the label.

### Which reviews count (one definition: `reviews/ratings.ts`)

A review counts toward a rating, the public list and the "verified" label if and only if **its status is `VISIBLE`, its booking is `COMPLETED` and that booking has a verified payment (fully refunded payments no longer count)**. Consequences, all tested: hidden reviews, withdrawn reviews, and reviews of a booking that is currently in dispute (`DISPUTED`) are excluded; when the dispute is withdrawn or resolved back to `COMPLETED` they count again. A suspended or unpublished professional's reviews are not public (`404`), like their profile.
**Display policy:** average rounded to **one decimal, halves up** (4.25 -> 4.3); count is the number of counted reviews; no reviews -> `rating: null, reviewCount: 0` and the UI says "No reviews yet". Ratings are computed at read time from stored rows with **one grouped query per page of workers** (no N+1; tested with a spy). There is no cached aggregate, so there is nothing to drift. Existing index `(workerProfileId, status, createdAt)` serves it. Sorting/filtering by rating is **deferred** (it needs a denormalised aggregate; not required yet).

## Community, reactions, reports, proposals

* **Posts:** title 3-120, body 1-5000. List newest first (`createdAt desc, id`), page size <= 30. `scope=mine` also lists the user's own hidden posts. Counts (`likeCount`, `commentCount` = visible comments) are computed from rows.
* **Comments:** 1-1000 characters, oldest first, page size <= 50, only on a visible post.
* **Likes:** `POST .../reactions {type:"LIKE"}` is idempotent (`INSERT ... ON CONFLICT DO NOTHING` on `UNIQUE (postId, userId, type)`): any number of repeats or parallel requests leave one row and return the same body; `DELETE .../reactions/LIKE` is idempotent too. Hidden/deleted/unknown posts are `404`.
* **Creation caps** (per user, rolling window, counted from the database and including the user's deleted items; the per-IP throttler cannot tell users behind one address apart and is off in tests): 10 posts/hour, 30 comments/hour, 3 proposals/day, 20 reports/day -> `429` with `POST_LIMIT | COMMENT_LIMIT | PROPOSAL_LIMIT | REPORT_LIMIT`.
* **Reports:** `POST /community/reports {targetType: POST|COMMENT|PROPOSAL, targetId, reason, details?}` and `POST /reviews/:id/report {reason, details?}`. Reasons: `SPAM, ABUSE, FRAUD, INAPPROPRIATE, PRIVACY, OTHER`; details <= 500. The reporter is the session user. The target must exist **and be visible to ordinary users** (else `404`); you cannot report your own content (`422`); `UNIQUE (reporterId, targetKey)` makes a second report of the same item by the same user `409 ALREADY_REPORTED` (race-safe). A database `CHECK` guarantees a report points at exactly one record, of the kind `targetType` names, so arbitrary references are impossible. The response contains only `{id, status, createdAt}`. **Reporting never hides anything.**
* **Proposals:** created `SUBMITTED` (title 5-120, description 10-2000). A client cannot send status, votes, author, response or visibility.

### Voting policy

One vote per user per proposal (`UNIQUE (proposalId, userId)`; the proposal's author may vote). Votes can be cast and **withdrawn only while voting is open** (`SUBMITTED`, `UNDER_REVIEW`); once a decision is made votes are frozen (`409 VOTING_CLOSED`). Counts are always `COUNT(*)` of stored votes. Hidden proposals are `404`.
**Vote threshold (FR-COMM-04):** at **10 votes** (`REVIEW_VOTE_THRESHOLD`) a `SUBMITTED` proposal shows up under *"Proposals that reached the vote threshold"* in the admin queue (`needsReview=true`). **That is all it does**: no status changes, nothing is deployed, no category is activated, no audit row is written (tested).

## State machines

**Content visibility** (posts, comments, reviews, proposals' `visibility`): `VISIBLE -> HIDDEN` (admin, reason) `-> VISIBLE` (admin, reason); `VISIBLE -> DELETED` (author, final). `HIDDEN -> DELETED` is refused for the author (`CONTENT_UNDER_MODERATION`); a moderator cannot touch `DELETED` (`CONTENT_DELETED`). A `HIDDEN` row must have a reason (`CHECK`). An administrator cannot moderate their own content.

**Reports:** `OPEN -> REVIEWING -> ACTIONED | DISMISSED`, and `OPEN -> ACTIONED | DISMISSED`. `ACTIONED` and `DISMISSED` are final. Decision endpoint `POST /admin/reports/:id/decision`:

| `decision` | From | To | Needs `note` |
| --- | --- | --- | --- |
| `REVIEW` | `OPEN` | `REVIEWING` | no |
| `RESOLVE` | `OPEN`, `REVIEWING` | `ACTIONED` | yes |
| `DISMISS` | `OPEN`, `REVIEWING` | `DISMISSED` | yes |

A report's status and the content's visibility are **separate**. Content changes only if the moderator sends `contentAction: "HIDE" | "RESTORE"` together with `RESOLVE`, or uses the standalone visibility endpoint; both run in one transaction with the audit row (a failure rolls everything back, tested by forcing the audit insert to fail). Conditional updates (`WHERE status = <read status>`) mean two moderators cannot both decide one report (`409`). An administrator cannot decide a report they filed or one about their own content.

**Proposals** (admin only, `POST /admin/proposals/:id/status {status, response?}`): `SUBMITTED -> UNDER_REVIEW | DECLINED`; `UNDER_REVIEW -> ACCEPTED | PLANNED | DECLINED`; `ACCEPTED -> PLANNED | DECLINED`; `PLANNED -> COMPLETED | DECLINED`; `DECLINED` and `COMPLETED` are final. `DECLINED` requires a public `response` (also a `CHECK`). Meaning: submitted = waiting; under review = being looked at; accepted = good idea, not scheduled; planned = scheduled; completed = done; declined = not going ahead. An administrator cannot decide their own proposal. These statuses are **editorial**; none triggers code, deployment or configuration.

## API

All paths are under `/api/v1`. "Session" = signed-in, verified-email user; unsafe methods also need the web `Origin`. IDs are UUIDs (malformed = `400`, unknown/hidden/not yours = `404`).

| Method & path | Access | Notes |
| --- | --- | --- |
| `POST /bookings/:id/review` | the booking's customer | `{ rating 1-5, comment? <=1000 }` strict. `201 { review }`. `404` not your booking, `422 BOOKING_NOT_REVIEWABLE`, `409 REVIEW_EXISTS`. 10/min. |
| `GET /bookings/:id/review` | the booking's customer | Own review (`404` if none / not yours). |
| `PUT /bookings/:id/review` | the booking's customer | `{ rating?, comment? }` (`null`/blank clears the comment). `422 EDIT_WINDOW_CLOSED`, `409 REVIEW_NOT_EDITABLE`. |
| `DELETE /bookings/:id/review` | the booking's customer | Withdraw (final, idempotent). |
| `GET /workers/:slug/reviews?page&pageSize<=48` | **Public** | `{ summary: {rating, reviewCount, distribution}, reviews[{id, rating, comment, createdAt, edited, author:{displayName}, service, verifiedBooking}], page... }`. `404` for non-public professionals. No per-viewer data. |
| `GET /bookings/:id` | participant | Now includes `review`: customer `{canReview, review}`; professional `{review}` only while public. |
| `GET /workers`, `GET /workers/:slug`, `GET /me/favorites` | as before | `rating`/`reviewCount` are now real. |
| `GET/POST /community/posts`, `GET/PATCH/DELETE /community/posts/:id` | session | List `?scope=all|mine&page&pageSize<=30`. PATCH/DELETE: author only. |
| `GET/POST /community/posts/:id/comments`, `PATCH/DELETE /community/comments/:id` | session | PATCH/DELETE: author only. |
| `POST /community/posts/:id/reactions`, `DELETE /community/posts/:id/reactions/:type` | session | Idempotent; `200 { reacted, likeCount }`. |
| `POST /community/reports`, `POST /reviews/:id/report` | session | 5/min, 20/day. |
| `GET/POST /feature-proposals`, `GET /feature-proposals/:id` | session | `?sort=top|new&status&page&pageSize<=30`. |
| `POST/DELETE /feature-proposals/:id/vote` | session | `200 { voted, voteCount }`; `409 VOTING_CLOSED`. |
| `GET /admin/moderation/overview` | admin | Counts only. |
| `GET /admin/reports?status=OPEN&targetType&page` | admin | Fixed page size 25, oldest first. Reported text, public names, `reportsOnThisItem`. No emails or account ids. |
| `GET /admin/reports/:id` | admin | Full text, reporter's public name, other reports, review edit history, moderation history for the item. |
| `POST /admin/reports/:id/decision` | admin | Body in the table above. |
| `POST /admin/moderation/:posts\|comments\|reviews\|proposals/:id/visibility` | admin | `{ hidden: boolean, reason 3-500 }`. |
| `GET /admin/proposals?status&needsReview&page`, `POST /admin/proposals/:id/status` | admin | See above. |
| `GET /admin/moderation/history?targetType&targetId&page` | admin | Only `content.*`, `report.*`, `proposal.*` audit rows; actor display name, never emails. |

Error codes (in the body next to the message): `BOOKING_NOT_REVIEWABLE, REVIEW_EXISTS, EDIT_WINDOW_CLOSED, REVIEW_NOT_EDITABLE, CONTENT_UNDER_MODERATION, CONTENT_DELETED, ALREADY_REPORTED, CANNOT_REPORT_OWN_CONTENT, VOTING_CLOSED, INVALID_TRANSITION, STALE_CONTENT, STALE_REPORT, STALE_PROPOSAL, POST_LIMIT, COMMENT_LIMIT, PROPOSAL_LIMIT, REPORT_LIMIT`.

## Data (migration `20261027000000_step9_reviews_community`)

Additive: 6 enums and 8 tables (`review`, `review_revision`, `community_post`, `post_comment`, `post_reaction`, `feature_proposal`, `feature_vote`, `content_report`); no existing table is altered or dropped; apply with `npx prisma migrate deploy` after reviewing the SQL and backing up. Database-level rules in the migration SQL: rating 1-5; text lengths; hidden content has a reason; a declined proposal has a response; a report has exactly one matching target and is `resolvedAt` iff closed. Unique: review per booking, reaction per (post, user, type), vote per (proposal, user), report per (reporter, target). Foreign keys to content and users are `RESTRICT` (nothing cascades away); reactions and votes cascade with their post/proposal/user. Account deletion does not exist yet; when it does, decide what happens to a user's content.

## Admin access and audit

* Every admin route is behind `@RequireAdmin()`; tests assert anonymous `401` and ordinary-user `403` on each, that role/`isAdmin` fields in body, query or headers change nothing, and that ids in the URL cannot widen access.
* Audit rows (`audit_log`): `report.review`, `report.resolve`, `report.dismiss`, `content.hide`, `content.restore`, `proposal.status`, each with the session user as actor, the target, and metadata `{from, to, reason, reportId, ...}`. The moderator's note is stored (it is staff-written and bounded to 500 characters); passwords, tokens, emails and identity documents never are. Ordinary users have no route that reads or writes audit rows.
* The moderation history screen shows only moderation actions, not other audit rows (e.g. payment metadata).

## Sentiment analysis: not built

Step 8's AI service exists, but sentiment on reviews would send customers' review text (and, for community content, other members' text) to an external model provider. There is no documented privacy basis, no redaction layer, no Bangla evaluation, and no real-provider verification of the Step 8 stack itself. A weak signal is not worth that risk, and the SRS marks it P2 and advisory (FR-REV-06/07). Left out; if added later it must be advisory only, labelled as an estimate, never change a rating or moderate anything, redact personal data first, and treat review/community text as untrusted input to the model.
Related: the AI assistant never reads community or review text (its knowledge base is curated files), which keeps FR-COMM-06 true.

## UI

`/community` (feed + composer + "mine"), `/community/[id]` (post, likes, comments, edit/delete, report), `/community/proposals` (submit, vote, filter, sort), the reviews block on `/workers/[slug]` (public, paginated, breakdown, report), the review panel on `/bookings/[id]`, and `/admin/moderation` (overview, reports queue with detail and explicit actions, proposals queue, history). Destructive or consequential actions open a confirmation dialog; moderation decisions require a note. The UI renders what the API returns and never infers eligibility or counts; the community, proposals and admin routes are `noindex`.

## Verification performed

* Backend: typecheck, lint, 125 unit tests, **489 integration tests on a real PostgreSQL** (66 new in `reviews`, `community`, `moderation`), build, `npm audit` (0), migration applied to an empty database and on top of Step 8, `prisma migrate diff` shows no drift.
* Mutation checks (break one line, expect a test to fail): 19 of 20 mutations were caught (skip the COMPLETED check, skip ownership, count hidden/non-completed reviews, no edit window, non-strict review body, report own content, reach hidden content, non-author-scoped edit, no reaction/vote duplicate guard, ignore closed voting, non-admin controller, no conflict-of-interest, skip transition checks, resurrect deleted content, drop the audit row, any proposal transition, content action without RESOLVE). The one survivor is an *equivalent* mutant: removing the early "review must be VISIBLE" check changes nothing because the conditional `UPDATE ... WHERE status = 'VISIBLE'` right after it enforces the same rule.
* Frontend: lint, typecheck, 158 tests (17 new), production build, `npm audit` (0).
* **Real Chrome** against a production build and the real backend on a scratch database (seeded through the HTTP API): 7 pages at 375, 430, 768, 1366 and 1440 px (35 combinations): no horizontal overflow and no axe-core violations; 8 interaction flows passed (post a review with a markup payload and see it rendered as text, public reviews with verified labels, like/comment/report, vote and withdraw, ordinary user refused the admin area, admin resolves-and-hides with a required note, others get "not found" on hidden content, the author sees the removed state). Screenshots were reviewed at 375 and 1440 px.
* **Not done:** a keyboard-only walkthrough and a screen-reader pass beyond axe; the Bangla layout was exercised with Bangla review text only; no load or large-data testing; the moderation console was exercised with a handful of rows (not pagination at scale).

## Known limitations

* No notification when content is hidden or a proposal is decided (no notification system exists).
* Offset pagination; very deep pages are slow on large tables (queues are small by design).
* The per-user caps and the in-memory throttler are per process; a shared store is needed for several instances.
* Two moderators acting at the same instant: the second gets a `409`, by design.
* An administrator cannot act on their own content, so a deployment with a single administrator cannot moderate that person's posts.
* Spam detection, profanity filtering, rate limits on reads, and CAPTCHA are not implemented.
* Bangla input is stored and rendered correctly (tested with Bangla text) but no language-specific moderation exists.
