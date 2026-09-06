# 0027 retire-connect-inbox — work order

lane:   FULL
branch: claude/muskan/work
stage:  spec ✅ → prototype ✅ → design ✅ → build (T01 ✅ → T02 ✅ → T03 ✅ → T04 ✅ → T05 ✅ → T06 next)

## Seed
Muskan, 2026-08-31, via `/triage`: "deletion of connection request page inside connect"

Scope is the decision locked the same session, before triage:
`docs/decisions/DECISIONS.md`, "2026-08-31 — Connection Request page retires; all four
request types settle in Discover's accept gate, no ticket/claim system for MVP." **Amended
2026-09-01** — same file, "Correction: Sella's detected deals were never an 'unconnected
send'" — the real scope is narrower and different: deals never go through an accept gate at
all (fixed at the source), pricing requests split on connection status, and only genuinely
unconnected pricing asks still need Discover's list. Read both entries; the PRD
(`docs/PRD/0027-retire-connect-inbox.md`) reflects the amended scope, not the original one.

## Triage — the YES answers
| # | | | evidence |
|---|---|---|---|
| 0 | broken / never worked as specified? | NO | deliberate retirement per a locked decision, not a regression |
| 1 | new screen or surface? | NO | `RequestsSection` (built 2026-07-23) and `/connect/inbox` both already exist |
| 2 | migration / RLS / RPC / auth? | NO | widens `companyRequests.ts`'s `.in("type", [...])` filter under existing RLS (`inbox_select`); accept-time branches to two existing RPCs (`acceptItem`, `claim_deal_ticket`), creates neither |
| 3 | concept not in CONTEXT.md? | **YES** | grepped `pending_inbox_item`, `RequestsSection`, `InboxView`, `claim_deal_ticket`, "connection request", "accept gate" — zero hits |
| 4 | changes what the product does? | **YES** | which request types Discover's accept gate covers, which RPC fires at accept time |
| 5 | file locked elsewhere? | NO | `ayush.md` offline since 2026-07-24; `muskan.md` fully released |
| 6 | more than one ticket? | **YES** | (a) extend `RequestsSection` for `pricelist_request` + `deal_card`, branching `acceptItem` vs `claim_deal_ticket` (`inbox.ts:287-290`); (b) retire `/connect/inbox`'s module (`InboxView`, `LensTabs`, `InboxList`, `InboxDetail`, `lenses.ts`, claim/assign) — explicitly gated on (a) shipping AND Sella's `deliver_deal` door moving off `/connect/inbox` writes |

**Lane: FULL.**

## Files so far
| stage  | wrote     |
|--------|-----------|
| triage | this file |
| spec   | `RESEARCH.md` (researcher prior-art sweep) |
| spec   | `docs/PRD/0027-retire-connect-inbox.md` |
| spec   | `docs/decisions/DECISIONS.md` — 2026-09-01 correction entry |
| spec   | `docs/architecture/CONTEXT.md` — "Accept gate" line added, then corrected |
| prototype | 3 row-label variants on live `/discover` (`?variant=`), thrown away after decision — see "For Muskan" |
| design | `RESEARCH.md` — `## Approaches (design)` section appended (Q1-Q6 + unenforced invariants) |
| design | `docs/architecture/adr/0009-retire-connect-inbox.md` — rev 2, after two checker rounds |
| design | `docs/architecture/adr/ADR-INDEX.md` — 0009's row |
| design | `TICKETS.md` — T01-T09 across four waves |

## Locked            (from ADR 0009, G3 approved 2026-09-03)

- **D1** — `confirm_detected_deal` stops cutting a deal ticket: delete `:182-185` of
  `20260827130000…`, **keep `:186`'s `end if;`**. Nothing replaces it. ⚠️ Dead-code deletion, not
  a live-bug fix — the branch is unreachable through every sanctioned route.
- **D2** — `requestProductPricing` branches on `is_connected_to_company`. Connected → a **new
  `SECURITY DEFINER` RPC** resolves-or-creates the c2c thread and posts a **person-voiced
  `message`** attributed to the asker, body = `buildPricingRequestNote(...)`. Grant contract
  (`REVOKE … FROM PUBLIC, anon` + `GRANT … TO authenticated`) and a parameter-free signature are
  both part of the contract, not build details.
- **D3** — filter widens to `["connect","connect_message","pricelist_request"]`. `deal_card`
  deliberately never added.
- **D4/D10** — prototype Variant C badge, on **every** row incl. person rows. New
  `src/app/discover/requestTypeMeta.ts` keyed on `DiscoverRequestKind`, **not** on
  `InboxRequestType`; owns no filtering.
- **D5** — backfill and drop are two separate migrations. Backfill sets `status = 'accepted'`
  (`'resolved'` is not a valid code) on `deal_card` + `pending` + `deleted_at is null` only.
- **D6** — `/connect/inbox` → permanent redirect to `/discover` in `next.config.ts`; folder still
  deleted.
- **D7** — the two SQL test files + runners deleted, **plus** the C9 block at
  `send_deal_c2c_announce_test.sql:391-412`.
- **D8** — rows stay product-blind at the query layer; the product name already rides in `note`.
- **D9** — box retitled "Connection requests" → "Requests".
- **D11** — `acceptItem`/`declineItem` return `Promise<void>`; `getInbox`/`getViewerContext`/
  `getAssignableMembers` deleted.

**Ordering is locked and not improvisable:** W1 → W3 → W4, W2 live before W4, D2's migration
before D2's app code. ADR §6 supersedes `PRD:61`, which states the reverse.

## Deferred — must NOT be built
- claim / assign / reassign / admin-reassign — MVP is one person per company per side
- Home's proposed deal-claim board (2026-07-23) — moot without multiple people per company
- `connect`/`connect_message` behaviour — untouched; genuine pre-relationship asks
- `accept_connection_request`'s body — reused as-is (it already accepts `pricelist_request`)
- multi-person-per-company visibility — Path B
- a single-RPC version of D2 — the fix if the read-then-write race ever bites, not now

## Attempts          three separate budgets — see PIPELINE.md §10

### T05 — Backfill: resolve every pending deal ticket
- Plan written: `PLAN-T05.md`. `plan-checker` round 1: REVISE (1 blocking —
  the EARS-3 fixture design didn't work: `create_deal_draft` births
  `'unsent'` not `'negotiation'`, creates no thread, needs an authenticated
  caller the plan told the builder to avoid — spot-verified against the
  RPC's live body, held, redesigned to plain INSERTs — plus 6 notes,
  including a false "no trigger" claim and a wrong grant-rejection
  rationale). All held and folded in.
- `test-writer` → wrote the SQL suite + runner (a DML-only migration has
  no function to call, so the suite inlines the migration's own UPDATE
  statement — a real, documented coupling, not a design flaw). Could not
  `chmod +x` the runner itself (no Bash tool); done manually.
- `builder` round 1 → green first pass. Byte-identity between the
  migration and the test's inlined copy confirmed via `diff` + matching
  MD5.
- `test-runner` round 1 → `tsc` clean, unit 514/514 (0 drift), eslint
  6/15 and SQL 2/66 both pre-existing/unrelated, `db reset` applies
  clean.
- `/code-review high` + `critic` + `security`, parallel → **security F1:
  BLOCKING, rung 2 (silent failure, S7)** — the suite couldn't actually
  prove `status = 'pending'` was load-bearing (the only non-`pending`
  fixture row was already `'accepted'`, a no-op target either way; a
  real `declineItem`-produced `'rejected'` row would have silently
  flipped back to `'accepted'` undetected). `critic` (0 blocking, 6
  notes) and `/code-review` (0 blocking on T05's own diff; 7 of its 8
  findings concerned pre-existing gaps or already-shipped T02 code, not
  T05) converged with `security` that the one shared fact all three
  reviewers touched — a misleading "Deal picked up" banner in Connect
  Inbox's History lens during the W3→W4 window — is a disclosed,
  non-blocking edge case. `blocking-findings 1/2`.
- `builder` round 2 → added a 7th fixture row (`deal_card`/`rejected`)
  and an assertion it stays `rejected` — proved its own fix by
  temporarily breaking the predicate, watching the new assertion fail
  with a named error, then restoring it.
- `test-runner` (re-check) + `security` (re-check), parallel → both
  independently re-verified, neither trusting `builder`'s report.
  `security` went further than asked: hashed the migration file
  before/after (unchanged), rebuilt all three predicate-drop mutants
  itself and reproduced each exact failure message, then re-ran a full
  negative-space sweep of every reader of `pending_inbox_item` and
  confirmed none change their answer for any caller. **F1 CLOSED.** 3
  more low-severity notes surfaced during the re-check, none blocking.
- `tests 0/2` · `blocking-findings 1/2` — one fix round, well inside
  budget.
- ⚠️ **Three findings surfaced this round that are NOT T05's to fix, all
  need Muskan's ruling, none blocked this ticket:** a new info-disclosure
  angle in `confirm_detected_deal` (pre-existing, unchanged by this
  slug, alongside the already-known NULL-guard bypass); a genuine TOCTOU
  dedup race in T02's already-shipped `request_product_pricing_c2c`
  violating locked invariant I-M13 under concurrency; and
  `shares_connection_with_company` granting person-visibility with no
  `status`/`deleted_at` filter (pre-existing, unrelated to this slug).
  All three are `/track-doubt` candidates — full detail in `REVIEW.md`.

### T04 — Every request row shows a type badge; the box is retitled
- Plan written: `PLAN-T04.md`. `plan-checker` round 1: REVISE (3 blocking
  claimed, 2 held — a stale title string in `DiscoverShell.test.tsx` and
  two in `e2e/discover.spec.ts`, neither in TICKETS.md's file list, both
  folded in — plus 1 spot-verified FALSE: a claimed `TS2352` on
  `"connect_person" as DiscoverRequestKind` that this repo's own
  `tsc --strict` compiles clean, confirmed by bypassing the `rtk` hook,
  which had fabricated a fake clean pass with zero real diagnostics on
  the first, wrong attempt — not folded in). 5 notes, 4 held and folded
  in, 1 (row-density) named for the G4 look instead of fixed in code.
- `test-writer` → RED across 4 test files (new module import failure +
  string-absence failures), no source touched.
- `builder` → green first pass, 2 source files, 0 deviations, 0
  rejections.
- `test-runner` → `tsc` clean, unit 514/514 (+8 exact, 0 drift), eslint
  6/15 and SQL 63/65 both independently A/B-proven pre-existing/unrelated
  (same baseline as T01-T03), e2e `discover.spec.ts` 4/4 green (the one
  file `builder` didn't run itself).
- `/code-review high` + `critic`, parallel (no `security` — no
  migration/RLS/RPC/auth/server-action/cross-company-read surface) → 0
  blocking, 8 notes (2 stale doc-comments left by the retitle, a
  `REQUEST_TYPE_BLURB` half of D4 that never got a home, a theoretical
  unreachable fallback edge case, a non-discriminating e2e assertion, and
  others — full list in `REVIEW.md`).
- **This ticket renders UI (a badge + a retitled box) — stopped at G4 per
  PIPELINE §3, did not auto-close.** `visual-verifier` staged 23 checks:
  17 match, 1 cannot-verify (the unreachable-from-a-browser fallback,
  covered only by a unit test), 5 deviate — none blocking. Two of those
  deviations **corrected the review record**: `critic`'s claim that the
  badge "never renders in a browser run" was wrong (Alice has 3 live
  seeded incoming requests, not 0 — the `e2e/discover.spec.ts` header
  comment describing her as request-less is stale), and `critic`'s
  row-density estimate (~24px, "4 rows become 3") was measured live and
  corrected to +13px, "3 rows either way." The other 3 deviations: two
  badges share one accent colour (not a spec breach, D4 names no
  colours), and a pre-existing page-shell clipping bug at 768px/390px
  **proven to be zero-width-contribution from the badge** (row min-content
  identical with/without it) — flagged for a possible `/track-doubt`,
  not fixed here.
- `tests 0/2` · `blocking-findings 0/2` — closed clean, no retries spent.
- **G4: Muskan reviewed the staged screenshots and passed.** The two
  side-questions raised at the gate (distinct accent colour for
  `connect_message`/`person`; whether the 768px/390px bug becomes a
  `/track-doubt`) were **not explicitly ruled on** — "pass" closed the
  ticket itself, both side-questions are still open, not decided either
  way.

### T03 — Discover's Requests list carries pricelist requests
- Plan written: `PLAN-T03.md`. `plan-checker` round 1: REVISE (1 blocking —
  a required `type` field would break `tsc` at two uncensused call sites —
  plus 5 notes, including a wrong I-M9 test citation). Folded in; extended
  the *existing* `accept_connection_request_status_guard_test.sql` suite
  with a genuinely missing c2c-thread assertion rather than writing new
  SQL.
- `builder` → green first pass, single file (`companyRequests.ts`).
- `test-runner` → full suite green, matches baseline exactly.
- `/code-review` + `critic` + `security` parallel → 0 blocking. All of
  `/code-review`'s 8 findings turned out to be re-discoveries of T01/T02
  notes already on record, or T04's explicitly-deferred badge work.
  `critic`/`security` found 7 notes on T03's own diff, none blocking.
- `tests 0/2` · `blocking-findings 0/2` — closed clean, no retries spent.

### T02 — pricing ask to a connected company posts to chat
- Plan written: `PLAN-T02.md`. `plan-checker` round 1: REVISE (3 blocking —
  unqualified identifiers under `search_path=''`, a non-compiling TS
  snippet, a dup-guard scoped to person instead of company — plus 6 notes).
  Spot-verified and folded in.
- `test-writer` → RED suite + unit cases; caught a `created_at`-ordering
  design gap before `builder` ran.
- `builder` round 1 → green first pass.
- `test-runner` round 1 → 1 new eslint error (this ticket's own test file),
  fixed round 2. `tests 1/2`. Also surfaced an untracked e2e planning gap
  (see REVIEW.md) — not fixed here, needs Muskan's ruling before `/ship`.
- `/code-review` + `critic` + `security` parallel → **security F1: BLOCKING,
  rung 1 leak** (RPC's product lookup skipped `product_visible_to_caller`,
  proved exploitable). Bundled with a `/code-review`-found timestamp-ordering
  correctness bug into one fix round. `blocking-findings 1/2`.
- `builder` round 3 → both fixed; `security` + `test-runner` independently
  re-verified against the live catalog — fix holds, full suite green.
- 21 notes total across all rounds, recorded in `REVIEW.md`, none retried.

### T01 — `confirm_detected_deal` stops cutting a deal ticket
- Plan written: `PLAN-T01.md`. `plan-checker` round 1 in progress.
- `tests 0/2` · `blocking-findings 0/2` · `G4 rounds 0`
- Base sync at build start: `origin/dev` fetched — confirmed its tree is
  byte-identical to the merge-base (a stale, no-op 2026-08-25 snapshot), so
  the required rebase was skipped as a no-op rather than forced through a
  spurious conflict in `DECISIONS.md`/`ARCHITECTURE-NOTES.md`. Working tree
  clean, `HEAD` unchanged.
- ⚠️ **`rtk` corrupted a `git status` read mid-build** — a bare `git status`
  (hook-rewritten to `rtk git status`) reported
  `supabase/migrations/20260903110000_promotion_status_gate.sql` as
  untracked with an unrecorded decision; `/usr/bin/git` (bypassing the hook)
  shows it's actually committed at `11e8769`, decision recorded
  `DECISIONS.md:2259`. False alarm, corrected. Reinforces **HEL-80** — the
  rtk collapse trap now confirmed to hit plain `git status`, not just the
  tools already listed there.
- `plan-checker` round 1 on `PLAN-T01.md`: REVISE — 1 blocking (a wrong
  `deal_member` assertion), 4 notes (stale RLS citation, unpinned vote
  order, unrecorded NULL-logic fixture dependency, the rtk-caused stale
  file status above). Spot-verified and folded in.
- `test-writer` wrote `confirm_detected_deal_no_ticket_test.sql` +
  runner — RED as expected against the live code.
- `builder` wrote `20260903120000_confirm_detected_deal_drop_ticket_branch.sql`
  — green on first pass, no retry needed. `tests 0/2` (no retries spent).
- `test-runner` independently confirmed: 62/64 SQL suites, 499/499 unit
  tests, `tsc` clean. The 2 SQL fails (`deal_line_item_insert_lockdown`,
  `deal_promotion_write_lockdown`) and 6 eslint errors are proven
  **pre-existing, unrelated to T01** via an A/B worktree run against
  committed `HEAD` (excludes T01's diff) — same failures reproduced.
  e2e (Playwright) skipped for this ticket: backend-only SQL change, no
  e2e spec exercises the deleted branch.
- ⚠️ **New debt surfaced, not caused by T01:** HEL-83's
  `20260903110000_promotion_status_gate.sql` (committed `11e8769` same
  session, immediately before T01's build started) added a
  `deal_card.status <> 'negotiation'` guard to the promotion RPCs. Two
  sibling suites' shared fixture (`deal_line_item_insert_lockdown_test.sql`,
  `deal_promotion_write_lockdown_test.sql` — both pick a card with no status
  filter, currently landing on a `confirmed` one) never got updated for that
  guard and now fail at setup, before their own assertions run. Not in
  `docs/agents/LEARNINGS.md` or CLAUDE.md's record-debt list yet — needs an
  L-number and a fixture fix, unrelated to this ticket or slug.

## Gate log
- 2026-09-02 — spec written (no gate — G1 merged into G3, PIPELINE §9a)
- 2026-09-03 — prototype decided (no gate): Variant C — type badge grouped above
  Accept/Decline — picked over inline-by-name (A) and eyebrow-above-name (B)
- 2026-09-03 — **G3 (spec + ADR, merged gate) — APPROVED.** ADR 0009 rev 2. Two checker
  rounds; round 1 raised 4 blockers (rungs 1/2/3/3), round 2 raised 2 NEW blockers (rungs 2/3).
  All six spot-verified against the repo, all six held, all folded in. ⚠️ **The loop did not
  converge** — round 2 still produced new rung 1-3 findings, so the 2-round budget closed
  without a clean round. A third round was offered and declined; recorded here because
  "approved" and "converged" are not the same state.
  Muskan also approved six spec amendments (FR1, AC1, AC4, PRD:60, PRD:61, FR6/FR9 scope)
  and three product rulings (product-blind rows, "Requests" title, badge every row), plus the
  message shape (person-voiced, from the asker).
- 2026-09-04 — **G4 T01 — auto (backend-only, no human stop, PIPELINE §3).**
  Migration + SQL suite green (`test-runner` independent confirmation: 62/64 SQL,
  499/499 unit, `tsc` clean — 2 SQL fails + eslint proven pre-existing/unrelated
  via A/B worktree). `/code-review high` + `critic` + `security` in parallel: 0
  blocking, 8 notes, all folded into `REVIEW.md`. No carve-out triggered (no
  outstanding rejection, no blocking security finding, no undocumented behavior
  change). `tests 0/2`, `blocking-findings 0/2` — closed clean, no retries spent.
  → stage advances to T02 (W1, parallel-safe with T01, no dependencies).
- 2026-09-04 — **G4 T02 — auto (backend-only, no human stop, PIPELINE §3).**
  `security` caught a real rung-1 leak (`product_visible_to_caller` skipped
  on the new RPC's product lookup) that `critic`/`code-review` had both
  independently spotted but under-rated — proved exploitable with live
  probes, fixed (called the owner predicate, not reimplemented), then
  independently re-verified against the live catalog by a fresh `security`
  pass. A `/code-review`-found timestamp-ordering bug (two bare
  `clock_timestamp()` calls, a false "guaranteed" claim in the header)
  fixed in the same round. `tests 1/2` (an eslint error test-runner caught),
  `blocking-findings 1/2` (the leak + timestamp fix, bundled) — both well
  inside budget. 21 notes total, `REVIEW.md`, none retried.
  ⚠️ **Untracked gap surfaced, needs your ruling before `/ship`:**
  `e2e/discover-shop.spec.ts` test #2 asserts the exact ticket-cutting
  behavior T02 retires and will read red the next e2e run — it is not in
  T09's named scope (`inbox-accept.spec.ts`, `deal-lands-in-c2c-chat.spec.ts`,
  `deal-c2c-create.spec.ts` only). Either widen T09 or open a sibling
  ticket; not fixed here since e2e edits aren't in T02's file list.
  → stage advances to T03 (W2, no dependencies, ships independently of W1).
- 2026-09-04 — **G4 T03 — auto (backend-only, no human stop, PIPELINE §3).**
  Single-file TS change (`companyRequests.ts`), plus a genuinely missing
  I-M9 assertion added to the existing `accept_connection_request` SQL
  suite (no function/migration touched). 0 blocking across all reviewers.
  `tests 0/2`, `blocking-findings 0/2` — closed clean.
  → stage advances to T04 (W2, depends on T03 for the `type` field — now
  live). T04 wires the badge that closes the "unbadged pricing ask" gap
  `/code-review` flagged this round (already anticipated, not a defect).
- 2026-09-04 — **G4 T04 — human, PASSED (this ticket renders, PIPELINE §3
  routes it to a stop, not an auto-close).** `plan-checker` round 1: 3
  blocking claimed, 2 held + folded in, 1 spot-verified FALSE and
  rejected (a claimed `tsc` error that the real compiler doesn't raise —
  caught the `rtk` hook fabricating a fake clean pass along the way).
  `test-runner`: `tsc` clean, unit 514/514 (+8 exact), eslint/SQL both
  A/B-proven pre-existing. `/code-review high` + `critic` → 0 blocking, 8
  notes. `visual-verifier` staged 23 checks (17 match, 1 cannot-verify, 5
  deviate, 0 blocking) and corrected two of `critic`'s own notes against
  live evidence (the "badge never renders" claim was wrong — Alice has 3
  seeded incoming requests; the row-density estimate was off by roughly
  half). Muskan reviewed the staged screenshots and passed. Two side
  questions raised at the gate (accent-colour distinction; whether the
  768px/390px pre-existing clipping bug becomes a `/track-doubt`) were
  **not ruled on at G4** — recorded as still open, not decided either
  way. `tests 0/2`, `blocking-findings 0/2` — closed clean, no retries
  spent. **Ruled 2026-09-06:** `connect_message`/`person` badges stay
  the same blue, no distinct accent — Muskan's call, no code change
  needed. The 768px/390px bug's `/track-doubt` question is still open.
  → stage advances to T05 (W3, depends on T01 — live).
- 2026-09-04 — **G4 T05 — auto (backend-only, no human stop, PIPELINE
  §3).** `plan-checker` round 1: 1 blocking (a broken EARS-3 fixture
  design), held, redesigned to plain INSERTs. `test-runner` round 1:
  green, no drift. `/code-review` + `critic` + `security` parallel:
  **security F1 — blocking, rung 2 (S7, the test couldn't prove
  `status = 'pending'` was load-bearing)** — fixed in one round (a 7th
  fixture row + a new assertion), independently re-verified by BOTH
  `test-runner` and `security` (which rebuilt all three predicate-drop
  mutants itself and reproduced each failure). No carve-out triggered —
  the one blocking finding was fixed and re-verified within the round,
  matching T02's own precedent for what "no carve-out" means; the one
  named behaviour change (`claim_deal_ticket` becoming unreachable) is
  the documented, intended end state (D5/I-M2), not undocumented.
  `tests 0/2`, `blocking-findings 1/2` — one round, inside budget. Three
  findings outside T05's own scope surfaced and are flagged for
  Muskan's ruling (see the T05 entry in `## Attempts` above /
  `REVIEW.md`), none blocking.
  → stage advances to T06 (W4, depends on T01 + T05 — both live. **The
  real I-M5 checkpoint — both counts, run for real against the target
  environment — is still owed before T06 starts**, per TICKETS.md's own
  instruction; it cannot be satisfied locally).

## For Muskan

**All five `/spec` questions are closed — see `Locked` above. What follows is what `/design`
found that you did not already know.**

- ⚠️ **The deals half of this slug fixes nothing users hit.** Two independent checker rounds
  established that `confirm_detected_deal`'s ticket branch is unreachable: detection only lands
  on `p2p` threads, and `chat_thread_p2p_has_both_people` (`20260607090003:132`) forces both
  person ids non-null there, so the counterparty is never unknown. **No deal ticket has ever been
  cut through a sanctioned route.** D1 is a dead-code deletion. The slug still earns its keep on
  the pricing half and on deleting the page — but do not expect a G5 walk to show a
  before/after on deals, because the before-state is not reachable.
- ⚠️ **Two of my own claims were wrong and were caught, not by me.** (a) I described
  `send_deal_c2c_announce_test.sql:405` backwards — it is about `deliver_deal`, asserts the
  insert *is* present, and will hard-error after the DROP; I inferred it from a grep line without
  opening the block. (b) I claimed `e2e/fixtures/two-company.ts` reaches `claim_deal_ticket`; it
  does not — I inherited that from research and never verified it. Both are recorded in ADR §9.
- ⚠️ **OQ1 was put to you on a false premise.** I said the row would show no product name. It
  already does — `buildPricingRequestNote` writes `Pricing request for "X".` into `note`, which
  is already selected and already rendered. Your ruling produced the right code; the reason I
  gave was inverted.
- **The checker loop did not converge** (round 2 still raised new rung 1-3 findings). You
  approved anyway and declined a third round. If a build ticket surfaces something ugly in D2's
  RPC or the backfill, that is the likeliest place it hides.
- **A parallel session's `20260903090000_msg_all_sender_attribution_gate.sql` is local-only** and
  will ride to production on 0027's first `db push`. Desirable, but it must be a decision, not a
  surprise — and a "roll back 0027" is not a rollback of only 0027.
- **Two things found in passing, not filed:** `supabase/functions/sella-detect/index.ts:91-96`
  does not filter `chat_thread.type`, so a direct POST could reach a detection path every
  sanctioned route gates to p2p. And `deal_workspace.visibility` is client-updatable under
  `ws_all`, so a party can flip a workspace to `private` and lock the counterparty out — after
  the DROP there is no recovery path. Both belong in `/track-doubt`.
- ✅ **Three more found during T05's build — filed 2026-09-06** to Linear team "Codebase
  Development Tickets" (not `/track-doubt`, which is scoped to LAYER-*.md product doubts and has
  no home for engineering findings tied to code files, not docs). (a)
  [HEL-89](https://linear.app/hellosello/issue/HEL-89) — `confirm_detected_deal`'s idempotent
  "already born" early-return (`20260903120000_…sql:79`) runs BEFORE the participant guard — any
  authenticated caller who obtains a `deal_detected` message id can read back its `deal_card_id`
  for a deal they have no relationship to. Distinct from the already-known NULL-guard bypass on
  the same function. Pre-existing, unchanged by anything in this slug. (b)
  [HEL-90](https://linear.app/hellosello/issue/HEL-90) — a genuine race in T02's
  `request_product_pricing_c2c` (already shipped, G4-approved): the dup-guard's
  `EXISTS`-then-`INSERT` has no unique constraint or lock between them, so a double-click or
  retried request can produce two identical chat messages — violates locked invariant I-M13 under
  concurrency, which T02's sequential SQL suite couldn't have caught. A real regression against a
  signed invariant, not just a note. (c) [HEL-91](https://linear.app/hellosello/issue/HEL-91) —
  `shares_connection_with_company` has no `status`/`deleted_at` filter on `pending_inbox_item` —
  a rejected or soft-deleted
  request appears to grant person-visibility permanently. Pre-existing, unrelated to this slug.
  Full detail on all three: `REVIEW.md`'s T05 section, notes 10/12/20.
