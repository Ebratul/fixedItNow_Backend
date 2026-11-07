# AI service-discovery assistant (Step 8)

The assistant lets a signed-in customer describe a need in English, Bangla or Banglish, turns it into search filters, and shows **professionals from the live directory**. It also answers questions about how FixedItNow works, from a small curated knowledge base, with sources.
It is a *discovery* assistant. It cannot book, cancel, pay, refund, or reveal anyone's private data, and it has no tool that could.

> **Core rule: the AI never supplies a marketplace fact.** Every worker name, price, experience figure, rating, verification badge and service area shown to the user is read from PostgreSQL by the main API *after* the AI answers. The AI contributes only an interpretation of the request and references (ids) that the database then confirms or drops.

## What is verified and what is not

| Capability | Status |
| --- | --- |
| Python FastAPI service (`rag_agent/`): pipeline, intent extraction, rule-based fallback, knowledge retrieval, safety checks | **Implemented and tested** (123 tests, offline) |
| NestJS side: `/ai/chat`, `/ai/status`, internal tool endpoints, per-user rate limit, database grounding | **Implemented and tested** (integration tests on real PostgreSQL) |
| Nest <-> Python over real HTTP, with a **fake** language model on a local socket | **Implemented and tested** (`backend/test/ai-contract.e2e-spec.ts`) |
| Frontend `/assistant` page | **Implemented and component-tested**; **not exercised in a real browser this step** |
| OpenRouter adapter against the **documented** API contract (request shape, error shapes, structured outputs) | **Implemented and tested against mocks / a local fake**. |
| **A real OpenRouter request, with a real key and a real model** | **NOT done.** No credentials existed. Which model supports strict `json_schema` on which provider endpoint is therefore **unverified**; see [Model configuration](#model-configuration). |
| **Quality of any real model's intent extraction** (English / Bangla / Banglish) | **NOT measured.** The offline evaluation scripts the model; only the rule-based cases measure extraction for real. `python -m evals.run_eval --live` exists to measure a real model; it was never run. |
| RAG over curated documents (lexical BM25) | **Implemented and tested.** No embeddings / vector store (see decisions). |
| LangChain / LangGraph | **Not used**, deliberately (see decisions). |
| Persisted AI conversations, feedback, LangSmith tracing | **Not implemented** (not needed; see privacy). |
| Bangla message wording | Written by the implementer, **needs native-speaker review**. |

## Architecture

```
Browser --> Next.js (/assistant) --/api/v1/ai/chat--> NestJS API ----(Bearer AI_SERVICE_TOKEN)----> AI service (FastAPI, rag_agent/)
 (cookie session)                                       |  session auth, Origin check,                  |  screen -> catalogue -> extract intent
                                                        |  per-user rate limit,                         |  -> merge -> route:
                                                        |  validate AI answer (strict Zod),             |       knowledge question -> retrieve -> answer
                                                        |  RE-READ workers from PostgreSQL              |       no service yet     -> clarify
                                                        |                                               |       else               -> search tool -> verify
                                                        v                                               |
                                                   PostgreSQL <---- GET /api/v1/internal/ai/{workers,categories}
                                                                      (Bearer APP_API_SERVICE_TOKEN, read-only)
                                                                                                        |
                                                                                  OpenRouter  <---------+  (server side only, optional)
```

* The **browser never reaches the AI service**. It is a private service; only the main API calls it.
* The **AI service has no database access.** Its only data source is two read-only HTTP endpoints on the main API.
* The two services authenticate each other with **two different secrets**, one per direction, so leaking one does not open the other direction.

### Decisions

| Question | Decision and reason |
| --- | --- |
| Separate Python service? | **Yes**, extending the reserved `rag_agent/` folder (SRS FR-AI-03). No Python existed before. |
| LangChain / LangGraph? | **No.** The flow is a fixed sequence with one decision point and no loops; the model never chooses tools, arguments or worker ids (code does). A graph runtime would add a dependency and indirection without adding capability, and the bounded tool budget (1 search + up to 3 relaxation probes) is a constant. Revisit if multi-step, model-driven tool use is ever wanted. |
| What does the model do? | Exactly two things: (1) turn a message into a **closed, validated** intent; (2) phrase a knowledge answer from retrieved passages. It does **not** pick workers, rank, price, or write the chat text for searches. |
| Who writes the chat text for a search? | **Code** (`app/messages.py`, English + Bangla templates) from verified counts. It cannot promise anything the data does not support. |
| Ranking | **Deterministic and in SQL.** Hard filters (service, area, budget, experience) are mandatory; order is the API's fixed sort (`experience` by default, `price_asc` if the user wants cheapest, `newest`). No LLM reranking. Ratings do not exist yet, so they are not a signal. |
| RAG / vector store? | **RAG yes, vectors no.** About 23 short curated passages. BM25 is deterministic, needs no new infrastructure, and is easy to test. pgvector would add a migration and an embedding provider for no measurable gain at this size. |
| Persist conversations? | **No.** The conversation state is just the *filters* (the intent), which the client holds and sends back; it is re-validated on every request. Nothing about a conversation is stored server-side. |
| Model fallback? | **None.** One configured model. If it fails, the service degrades to rule-based extraction ("simple mode"), which is labelled as such. |

## API

### `POST /api/v1/ai/chat` (session required; unsafe method, so the web `Origin` is required)
Throttled 30/min/IP and `AI_RATE_LIMIT_PER_MINUTE` per **user** (default 10).

Request (strict: unknown keys are `400`; there is no user-id or history field):
```jsonc
{
  "message": "I need a plumber in Sylhet",   // 1-1000 chars
  "intent": { "category": "plumbing", "location": "Sylhet", "maxBudgetBdt": 1500, "minExperienceYears": 3 }, // optional: filters from the previous turn
  "locale": "auto",                          // auto | en | bn
  "action": "message"                        // message | search
}
```
`action: "search"` means *the user edited filters in the UI* (removed a chip, picked a suggested option). The service re-runs the search for `intent` directly: **no model call and no free text is read**, so it is cheap and cannot be prompt-injected.

Response (`200`):
```jsonc
{
  "kind": "results",            // results | no_results | clarification | answer | out_of_scope | refused
  "message": "I found 3 professionals matching your filters. Showing the top 3, most experience first.",
  "language": "en",
  "intent": { "category": "plumbing", "location": "Sylhet" },
  "intentSources": { "category": "explicit", "location": "explicit" },   // explicit | inferred | carried
  "clarification": null,        // { field: "category"|"location", question, options[{value,label}], blocking }
  "recommendations": [          // worker facts come from PostgreSQL, not from the AI
    { "rank": 1, "matchedOn": ["CATEGORY", "LOCATION"], "worker": { /* the public card of GET /workers */ } }
  ],
  "total": 3,
  "relaxations": [],            // e.g. [{ "drop": "max_budget_bdt", "matchCount": 2 }] when nothing matched
  "answer": null,               // { text, grounded, sources: [{ id, title, url }] } for knowledge questions; url is site-relative only
  "notes": [],                  // AVAILABILITY_NOT_CHECKED | BOOKING_NOT_SUPPORTED | INTENT_INFERRED | SIMPLE_MODE | CONTACT_DETAILS_PRIVATE
  "mode": "llm"                 // llm | simple (rule-based) | direct (filters given)
}
```
Errors carry a stable `code`: `503 AI_NOT_CONFIGURED`, `429 AI_RATE_LIMITED` (+ `retryAfterSeconds`), `504 AI_TIMEOUT`, `502 AI_UNAVAILABLE`, plus the usual `400/401/403`. Bodies never contain URLs, tokens, stack traces or provider text.

### `GET /api/v1/ai/status` (public)
`{ "available": boolean }`. Nothing else.

### Internal tool endpoints (AI service only)
`GET /api/v1/internal/ai/workers` and `GET /api/v1/internal/ai/categories`. Public routes in the Nest sense (no user session) **protected only by `ServiceTokenGuard`**: bearer `APP_API_SERVICE_TOKEN`, constant-time comparison, `404` when the assistant is not configured, `401` otherwise. A user session alone is rejected, as is the other direction's secret. They are read-only (no other verb exists) and:
* reuse `WorkersService.search`, the same code and `ELIGIBLE_WORKER` rule as `GET /workers`, so unpublished, unverified and suspended profiles can never appear;
* validate arguments with the public `searchQuerySchema` (closed enums, bounds; no free SQL, table or column names);
* force page 1 and cap `pageSize` at 24;
* return only the public card projection (`cardSelect`): no email, user id, review notes, suspension data.

### AI service (`rag_agent/`, port 8000, **not** exposed to browsers)
`POST /v1/chat` (bearer `AI_SERVICE_TOKEN`; headers `X-Correlation-Id`, `X-Subject` = SHA-256 of the user id) takes the same body and returns the same response *without* the worker cards (only `{workerId, slug, rank, matchedOn}` references). `GET /health` returns `{status, llm: configured|not_configured, knowledgeChunks}`. Interactive API docs exist only when `APP_ENV=development`. Error body `{code, message}` with `INVALID_INPUT | UNAUTHORIZED | RATE_LIMITED | MARKETPLACE_UNAVAILABLE | BUSY | INTERNAL`.

## The pipeline (`rag_agent/app/pipeline.py`)

1. **Normalize** the text (NFC, control and bidi-override characters removed) and pick the reply language (Bengali script share >= 30% -> Bangla; Banglish replies in English).
2. **Screen** (`safety.py`): requests for another person's contact details or bookings, the system prompt or keys, or SQL/shell are **refused in code before any model or tool call**. "Book/cancel/pay for me" adds a `BOOKING_NOT_SUPPORTED` note.
3. **Catalogue**: active categories from the main API (cached 5 minutes; non-personal).
4. **Extract intent**: the model returns a strict JSON object (or, if it is not configured / fails, the rule-based extractor runs). The user's text is passed as a JSON string field, never spliced into instruction text.
5. **Sanitise**: unknown category slug, unknown division, out-of-range numbers are **discarded**, not searched. At most **two** model calls (one retry only for unparseable output); provider errors are never retried.
6. **Merge** with the intent from the previous turn: new values override, nothing is cleared by omission (the UI clears a filter by sending the intent without it).
7. **Route**: policy question -> retrieve + answer; no service -> blocking clarification with real categories as options; otherwise search.
8. **Search tool** (`marketplace.py`): validated `SearchCriteria` -> internal API. Then **every returned card is re-checked locally** (verified, category, area, price <= budget, experience >= minimum); violators are dropped. Missing location -> still searches, with an optional follow-up question if more matches exist than are shown.
9. **No match** -> up to 3 probe searches (drop budget / experience / area one at a time); only relaxations that really return results are offered, with their real counts.
10. **Respond** with code-written text. Availability is never asserted: a time preference only produces `AVAILABILITY_NOT_CHECKED`.

The main API then validates the response (strict Zod: unknown fields, unknown kinds and non-relative links are rejected as `502`) and **re-reads each recommended worker from PostgreSQL** with the public visibility rule *and* the stated filters (`WorkersService.findCardsByIds`). Unknown, hidden or non-matching ids are dropped; if that changes a result list, the AI's sentence ("I found 3...") is replaced by a neutral "results changed" message.

## Authorization and privacy boundaries

* The user is the **session user**. The request has no user field (strict schema) and the AI service receives only a one-way hash of the user id, for rate limiting.
* The assistant needs a login (the paid model is not offered anonymously). Logged-out visitors keep the normal search, which also remains the fallback when the assistant fails.
* The model sees: the current user message, the *filters* already chosen, and the public category list. It never sees other users' data, bookings, payments, emails, phone numbers, tokens, or any worker data (the search results are processed by code, not by the model).
* The only retrieved text the model sees is curated, public knowledge (`audience: public`).
* **Retention: nothing is stored.** No conversation, prompt or model output is persisted by this feature. There is no schema change in Step 8 (verified with `prisma migrate diff`). The browser keeps the transcript in memory until the page is closed or "Start over" is pressed.
* Logs: see [Observability](#observability).

## Prompt-injection and abuse defenses

Treat user text, retrieved passages and worker descriptions as untrusted. The defenses are structural, not wording:

| Threat | Enforced by (code, with a test) |
| --- | --- |
| Model invents or injects worker ids | The model is never asked for workers. Ids come only from the search tool; the main API re-reads them from the database; extra fields in the AI response are a `502` (`ai.e2e-spec.ts`, `eval: inj-model-obeys-injection`). |
| Model invents a category / area / number | Closed validation; invalid values are discarded (`eval: model-invents-values`). |
| Bypass worker eligibility | One `ELIGIBLE_WORKER` filter in SQL for search *and* for hydration; local re-verification in the pipeline (`eval: rogue-backend-ignores-filters`). |
| Arbitrary SQL / shell / table names | No such tool exists. Tool arguments are a frozen Pydantic model and the public Zod schema; requests that ask for it are refused before any model call. |
| Reveal prompts, keys, other users' data | Refused in code; prompts contain no secrets; nothing private is ever put into the model context. |
| Fake booking / payment / refund confirmation | The assistant has no booking or payment capability. Model-written text that claims an action ("I have refunded...") is rejected (`claims_action`). |
| Instructions inside retrieved documents | Passages are delimited data; the model has no tools to misuse; its output is limited to `{answerable, answer, source_ids}`, links/HTML are stripped, source ids must be among the retrieved ones, and a failed check falls back to quoting the passage. |
| Untrusted AI service response | Strict Zod schema; site-relative links only; ids re-validated against the database. |
| Cost abuse | Per-user limit (Nest) + per-subject limit and concurrency cap (AI service) + input/output limits; `action: "search"` costs no model call. |
| Cross-user context | Nothing server-side is shared; each call carries only that user's own filters (tested). |

The assistant also makes no medical, legal or safety claims: it only maps requests to the listed service categories, and anything else is `out_of_scope`.

## Model configuration

OpenRouter is used through a provider-neutral interface (`app/llm/base.py`); the adapter is `app/llm/openrouter.py`.

* Endpoint `POST {OPENROUTER_BASE_URL}/chat/completions`, `Authorization: Bearer <key>`, optional `HTTP-Referer` and `X-Title`. Body: `model`, `messages`, `max_tokens`, `temperature: 0`, `stream: false`.
* `OPENROUTER_RESPONSE_FORMAT`: `json_schema` (default; strict structured outputs), `json_object`, or `none` (prompt-only JSON). For the first two the request also carries `provider: { require_parameters: true }`, which OpenRouter documents as "route only to endpoints that support every parameter".
* **No model is hard-coded.** `OPENROUTER_MODEL` has no default; with no key or no model the service starts in simple mode and `/health` says `llm: not_configured`.
* OpenRouter documents that structured-output support is **per endpoint and can change**, and that some providers treat the schema as a hint. The code therefore never trusts the format: every reply is parsed and validated, once-retried, then abandoned for simple mode. **Before launch, choose a model whose OpenRouter page lists `structured_outputs`, and test it.** If it does not, set `OPENROUTER_RESPONSE_FORMAT=json_object` or `none`.
* Errors are reduced to categories (`timeout`, `rate_limited`, `auth`, `insufficient_credits`, `unsupported_feature`, `provider_error`, `empty_response`, `malformed_response`); the provider's message body is discarded because it can echo the prompt. HTTP 200 responses that carry a top-level `error` are handled. There is **no** fallback to another model.

## Knowledge base (RAG)

* Sources: `rag_agent/knowledge/*.md`, written from `docs/BOOKINGS.md`, `docs/PAYMENTS.md` and the code, restricted to what a customer may be told. Front matter: `audience: public` (anything else is **not indexed**), `id`, `title`, `url` (a site-relative route that exists), `updated`.
* "Ingestion" is loading these files at start-up. It is a pure function of the files: stable chunk ids (`<doc>#<heading>`), a content digest, nothing persisted, so repeating it cannot create duplicates and a changed or deleted file is reflected on the next start. `python -m app.knowledge` prints the manifest. Documents are validated (id, url pattern, unique ids, size).
* Retrieval: BM25 over heading-level chunks, top 3; a hit must cover >= 60% of the query's distinct terms, so an unrelated question returns **nothing** rather than the closest-looking passage. Nothing found -> the assistant says the help content does not establish an answer and links to Help/Contact; it never cites a source it did not retrieve.
* Limits: matching is lexical and English. A Bangla policy question works only when the model rewrites it into English keywords (`knowledge_query`); in simple mode a Bangla policy question is not answered. The corpus describes current behaviour (for example "no cancellation fee is defined") and must be updated when the product changes.
* Pre-existing inconsistency found, not changed: `frontend/src/lib/faqs.ts` still says bookings are "not available yet".

## Pinecone vector search (optional)

Keyword (BM25) retrieval stays, and Pinecone adds semantic retrieval next to it. Set `PINECONE_API_KEY` and `PINECONE_INDEX_HOST` in `rag_agent/.env` to turn it on; leave them empty and nothing changes.

* **Index (you create it once, in the Pinecone console):** an integrated-embedding index, model `multilingual-e5-large` (it covers Bangla), field map text -> `chunk_text`, cosine. Copy the index **host**. Pinecone embeds text itself on write and on search, so there is no embedding code, no second provider and no extra key.
* **Sync:** at start-up and after every admin "Sync now" (`POST /v1/knowledge/reload`), the service upserts every knowledge chunk (stable ids, batches of 96, text = title + heading + passage) into the namespace `PINECONE_NAMESPACE` and deletes ids that are no longer in the knowledge base. Re-running changes nothing. It touches only its own namespace.
* **Search:** the question goes to Pinecone, which returns **only ids and scores**. The passage shown to users and given to the language model is always the local, validated chunk, so the index cannot inject text, and unknown (stale) ids are dropped. Hits below `PINECONE_MIN_SCORE` are ignored; the vector ranking is fused (reciprocal rank fusion) with the keyword ranking, whose "must cover the question's terms" gate is unchanged. A question neither ranker finds relevant still gets "not established" with no citation.
* **Never a dependency:** if Pinecone is unreachable, slow (5 s limit), returns an error, or the index has not synced the current knowledge version, retrieval silently falls back to keyword-only. `GET /health` and `GET /v1/knowledge` show `vectorSearch: not_configured | synced | not_synced`; the per-request log line says `retrieval: hybrid | lexical | lexical_fallback`. The key never appears in logs, health or errors (a test checks).
* **What leaves your system:** the public knowledge text (audience `public` only) at sync time, and the user's knowledge question at search time (after the safety screen has refused private-data requests). No worker, booking or account data.
* **Limits:** in rule-based simple mode (no language model) a question is routed to the knowledge base only if keyword search recognises it, so a pure paraphrase reaches Pinecone only when the model is on. `PINECONE_MIN_SCORE=0.8` is an untested starting value. Pinecone is eventually consistent, so a chunk may take a few seconds to become searchable after a sync.
* **Not verified:** all tests use a mock Pinecone. No request has reached the real service. Run `python -m app.vector_store check` once with your key and check the scores before relying on it.

## Rate limits, cost and limits

| Control | Value |
| --- | --- |
| Message length | 1000 characters (Zod + Pydantic) |
| Request body to the AI service | 16 KB |
| Per user (API) | `AI_RATE_LIMIT_PER_MINUTE` (default 10); 30/min/IP on the route |
| Per subject (AI service) | same value; plus `AI_MAX_CONCURRENT_REQUESTS` (default 8) -> `503 BUSY` |
| Model output | `AI_MAX_OUTPUT_TOKENS` ceiling; extraction asks for at most 400 |
| Model calls per message | <= 2 for extraction (+ <= 2 for a knowledge answer); 0 for `action: "search"` and for refused messages |
| Search tool calls | 1, plus <= 3 probes only when nothing matched; page size <= 24 (default 5 shown) |
| Timeouts | each provider call `AI_REQUEST_TIMEOUT_SECONDS` (30 s); the AI service abandons a request after twice that; marketplace calls <= 15 s; the API waits twice the provider timeout + 10 s (a request makes at most two sequential provider calls) |

Cost drivers: one short model call per free-text message (the prompt contains the category list, ~300-500 tokens, plus the message) and a second only for knowledge questions. No prices are quoted here; they depend on the model chosen. In-memory limiters are per process: use a shared store if you run several instances.

## Observability

One JSON line per request from the AI service (`fixeditnow.ai`): `correlationId`, `outcome`, `kind`, `mode`, `provider`, `model`, `llmCalls`, `llmMs`, token counts (when the provider returns them), `llmError` category, `retrievalMs`, `toolCalls`, `toolFailures`, `validationFailures`, `screenFlags` (names only), `errorCategory`, `totalMs`. The main API logs `correlationId`, kind, mode, reference counts and duration. **Never logged:** message text, prompts, model output, filters, worker data, user ids, tokens or keys (a test asserts this). The correlation id travels API -> AI service in `X-Correlation-Id`.

Error categories: invalid input (`400`), unauthorized (`401`), rate limit (`429`), provider timeout (`504`), provider/marketplace failure (`502/503`, or degraded to simple mode), malformed model output (degraded), configuration missing (`503 AI_NOT_CONFIGURED`). When the model fails the user still gets real results (simple mode). When the AI service is down the UI offers a retry and a link to the normal search with the same filters.

## Environment variables

Main API (`backend/.env`): `AI_SERVICE_URL`, `AI_SERVICE_TOKEN` (secret), `APP_API_SERVICE_TOKEN` (secret), `AI_REQUEST_TIMEOUT_SECONDS` (30), `AI_RATE_LIMIT_PER_MINUTE` (10). All three of URL and both tokens, or none; tokens >= 32 characters and different; the API refuses to start otherwise.

AI service (`rag_agent/.env`; see `rag_agent/.env.example`): `APP_ENV` (default **production**: no API docs), `AI_HOST`, `AI_PORT`, `AI_SERVICE_TOKEN` (secret), `APP_API_SERVICE_TOKEN` (secret), `APP_API_BASE_URL`, `OPENROUTER_API_KEY` (secret), `OPENROUTER_BASE_URL` (https; plain http only for loopback outside production), `OPENROUTER_MODEL`, `OPENROUTER_RESPONSE_FORMAT`, `OPENROUTER_APP_URL`, `OPENROUTER_APP_TITLE`, `AI_REQUEST_TIMEOUT_SECONDS`, `AI_MAX_OUTPUT_TOKENS`, `AI_RATE_LIMIT_PER_MINUTE`, `AI_MAX_RESULTS`, `AI_MAX_CONCURRENT_REQUESTS`, `AI_KNOWLEDGE_DIR`, `AI_KNOWLEDGE_SOURCE` (`files` default, or `api` for administrator-managed documents; see [ADMIN.md](ADMIN.md)). Startup fails with a message that names the variable and the rule, never the value. Frontend: none (the browser only calls `/api/v1/ai/*`).

## Local development

```bash
# AI service (Python >= 3.12)
cd rag_agent
python3 -m venv .venv && .venv/bin/pip install -r requirements-dev.txt
cp .env.example .env   # set the two tokens (openssl rand -base64 48); OPENROUTER_* are optional
set -a; . ./.env; set +a; .venv/bin/python -m app          # http://127.0.0.1:8000

# main API: set AI_SERVICE_URL=http://127.0.0.1:8000 and the SAME two tokens in backend/.env, then restart it
# frontend: open http://localhost:3000/assistant (log in first)
```
Without `OPENROUTER_*` the assistant still works in *simple mode* (rule-based; labelled in the UI).

## Tests and evaluation

```bash
cd rag_agent && .venv/bin/pytest -q && .venv/bin/ruff check . && .venv/bin/mypy
cd rag_agent && .venv/bin/python -m evals.run_eval          # offline evaluation set (also run by pytest)
cd rag_agent && .venv/bin/python -m evals.run_eval --live   # real OpenRouter; needs credentials, spends money; never run so far
cd backend  && npm test && npm run test:e2e                 # includes test/ai.e2e-spec.ts and test/ai-contract.e2e-spec.ts
cd frontend && npm test
```
`ai-contract.e2e-spec.ts` starts the Python service from `rag_agent/.venv` and skips itself if that venv does not exist.

The evaluation set (`rag_agent/evals/cases.jsonl`, 40 cases) covers clear intent (English, Bangla), ambiguous intent, missing location, budget limits and follow-ups, contradictory filters, no match (with and without possible relaxations), out-of-scope, policy questions (grounded, unanswerable, irrelevant, forged citation), prompt injection and private-data requests, a model that obeys an injection, a backend that ignores filters, malformed model output, provider timeout / rate limit / unsupported format / empty reply, hallucinated values, a marketplace outage, and rule-based Bangla / Banglish / English extraction. **What it measures:** pipeline safety and grounding (deterministic assertions), and the rule-based extractor's accuracy. **What it does not:** a real model's accuracy. Observed results are recorded in the Step 8 final report and reproduced by the command above; they are not claims about production quality.

## Deployment

* Run the AI service as a **private** service (same network as the API; no public route). `rag_agent/Dockerfile` is provided (non-root user, health check); do not expose port 8000 publicly.
* Set the same two secrets on both services, from a secret manager. Rotate them independently.
* The Next.js rewrite and any proxy forward `/api/v1/*` to the API, which makes `/api/v1/internal/ai/*` reachable from the internet in principle; the token is the protection. **Block `/api/v1/internal/` at the reverse proxy / CDN** as defence in depth (it is only needed on the private network between the AI service and the API: point `APP_API_BASE_URL` at the API's private address).
* Use https for `OPENROUTER_BASE_URL`; keep `APP_ENV=production`.
* Rate-limit state is per process. With several API or AI instances, use a shared store.
* `LangSmith` tracing is intentionally absent; adding it needs redaction and retention rules first.

## Known limitations

* No real-provider or real-model verification (see the status table).
* Intent extraction for Bangla/Banglish depends on the chosen model; the rule-based fallback only knows the eight divisions, the seeded categories and simple budget/experience phrases.
* Knowledge answers are English-sourced; lexical retrieval misses paraphrases it has no keywords for.
* Availability is not searchable (no such filter exists), so "this weekend" is displayed but never applied.
* Ranking uses experience or starting price only; there are no ratings, distance or relevance signals yet.
* The client holds the conversation filters; a user can edit their own filters, which only changes their own search.
* No conversation history is kept across page loads, by design.
* The Bangla strings need native review; the page was not run in a real browser or checked with axe this step.
