# 0027-retire-connect-inbox — REVIEW.md

One file per slug (PIPELINE §8). Every finding attributed to its reviewer,
severity per the ladder in PIPELINE §10 — `blocking` is rungs 1-3 (leak ·
silent failure · won't run) only; rungs 4-5 (behavioural edge, contract/
wording) are `note`, never retried, surfaced at G4.

---

## T01 · `confirm_detected_deal` stops cutting a deal ticket

Diff: `supabase/migrations/20260903120000_confirm_detected_deal_drop_ticket_branch.sql`
(new), `supabase/tests/confirm_detected_deal_no_ticket_test.sql` (new),
`supabase/tests/run_confirm_detected_deal_no_ticket_test.sh` (new).

**Verdict: 0 blocking across all three reviewers. 8 notes, all rung 4-5.**
No builder retry triggered.

### Notes

1. **(code-review, `supabase/migrations/20260903120000_confirm_detected_deal_drop_ticket_branch.sql:13`)**
   The migration header's "unreachable through any sanctioned route" claim
   relies on Sella detection only ever landing on p2p threads — but that
   guarantee lives in the `sella_enqueue_detection` DB trigger, not in the
   `sella-detect` edge function itself, which applies no thread-type check on
   the `thread_id` it's handed. `security`'s note 2 independently confirmed
   the same fact and explicitly framed it not-blocking, since this diff only
   *deletes* a write (T01 makes the gap strictly no worse). Header wording
   should narrow to "the sanctioned **enqueue** path is p2p-only" rather than
   "detection is unreachable" — a wording fix, not a behavior fix.

2. **(critic, `supabase/tests/confirm_detected_deal_no_ticket_test.sql:150,155`)**
   The "receiving company" premise behind EARS 2 (Carla, GreenLeaf, must be
   the *receiving* side) is pinned only by comment/prose (the header's ⚠️ on
   vote order), not by a runtime assertion. Swapping the Alice/Bob vote order
   would leave the suite fully green while silently testing the wrong
   criterion (Carla would become a member of the *sending* company). Not
   blocking — the criterion is correctly exercised as built today — but a
   one-line assertion (`initiating_company_id = StonePharm`, right after
   `_card` is populated) would close the gap for good.

3. **(critic, `supabase/tests/confirm_detected_deal_no_ticket_test.sql:285-302`)**
   §D's idempotency check re-reads `chat_message.metadata` and counts
   workspaces, but never asserts the RPC's own return value
   (`deal_card_id`/`born_now`) on the already-born re-call. The strong half
   (no second birth) is covered; the caller-visible contract named by EARS 3
   (`born_deal_card_id`) is not directly asserted.

4. **(security, S6/record, `docs/deploy/cloud-migrations-pending.md:45-47`)**
   The ledger's "🔴 READ FIRST" block claims only `20260903090000`,
   `20260903100000`, `20260903110000` are pending — now stale, since
   `20260903120000` isn't listed and isn't yet committed to git either. Owed
   before `/ship`'s cloud push, not before this ticket closes.

5. **(security, S5/record, `20260903120000_…sql:14-16` vs `supabase/functions/sella-detect/index.ts:83-84`)**
   Same underlying fact as note 1 above, independently found. Direction is
   safe (this diff removes a write, adds no reachability) — recorded for the
   header wording fix, not blocking.

6. **(security, S2/record, `docs/deploy/cloud-migrations-pending.md:311`)**
   After T01 ships, `deliver_deal` has zero callers anywhere in the database
   (confirmed via `pg_proc` census, not assumed). The existing ledger entry
   for `20260827140000` ("its one live caller, `confirm_detected_deal`,
   already gates...") goes stale the moment T01 lands. Useful context for T06
   (which drops `deliver_deal` outright) — not this ticket's job to fix.

7. **(security, S2, `20260903120000_…sql:87`, pre-existing, confirmed not worsened)**
   The NULL-blind participant guard on c2c threads (`v_pa`/`v_pb` both NULL →
   `IF` silently doesn't fire) is pre-existing, already documented in
   `PLAN-T01.md`, and confirmed via catalog census to be practically
   unreachable today (`msg_all`'s `WITH CHECK` blocks `authenticated` from
   planting a `deal_detected` message at all; zero such rows exist on any c2c
   thread; a rogue vote can't affect birth since it's keyed under the wrong
   company id; a company-less caller fails loudly). Out of scope for T01 —
   worth a `/track-doubt`, already flagged to Muskan at the design stage and
   again in this session's summary.

8. **(security, S7, `docs/muskan-build/0027-retire-connect-inbox/STATE.md:105-106`)**
   The RED-first run is recorded but its failure message isn't quoted
   verbatim. Minor — the checklist wants the offending assertion's message
   alongside the pass/fail record.

### Verification replay (backend-only ticket — no G4 human stop per PIPELINE §3)

- `plan-checker` round 1: REVISE (1 blocking, folded in) → not re-run, per skill.
- `test-writer` → RED suite confirmed against live code (independently
  verified by `critic` and `security` via manual trace, not just trusted).
- `builder` → green on first pass, 0/2 retries spent.
- `test-runner` → 62/64 SQL suites, 499/499 unit tests, `tsc` clean; 2 SQL
  fails + 6 eslint errors proven pre-existing via A/B worktree run, unrelated
  to T01. e2e skipped (backend-only, no e2e spec exercises this branch).
- `/code-review high`, `critic`, `security` → 0 blocking, 8 notes total (above).

**No visual diff** — migration only, nothing rendered. Step 9 (visual-verifier)
does not apply.

**Backend-only, no carve-out triggered** (PIPELINE §3 / SKILL.md step 10): no
outstanding builder rejection, no blocking security finding, no behavior
change outside written criteria. Closes on green tests + all three reviews,
no human G4 stop.

---

## T02 · Pricing ask to a connected company posts to chat

Diff: `supabase/migrations/20260903130000_request_product_pricing_c2c.sql`
(new — `request_product_pricing_c2c(uuid,uuid)`), `src/app/discover/actions.ts`
(modified — `requestProductPricing` branches), `src/app/discover/pricingRequest.ts`
(modified — one sync comment), `src/types/database.types.ts` (regenerated),
`src/app/discover/requestProductPricing.gate.test.ts` (modified — new cases),
`supabase/tests/request_product_pricing_c2c_test.sql` +
`run_request_product_pricing_c2c_test.sh` (new).

**Verdict: 1 blocking finding (security, rung 1 leak), fixed and independently
re-verified. 1 blocking-adjacent correctness fix (timestamp ordering) bundled
into the same round. 21 notes total across `plan-checker`, `critic`,
`/code-review`, and `security`'s two passes — all recorded below, none
retried.**

### Round trail

- `plan-checker` round 1: REVISE — 3 blocking (unqualified identifiers under
  `search_path=''`; a non-compiling TS snippet; a dup-guard scoped to
  person instead of company) + 6 notes. Folded into `PLAN-T02.md`.
- `test-writer` → RED suite + RED unit cases, confirmed against the
  not-yet-built design. Caught one design gap `plan-checker` missed: step 8/11's
  `created_at` ordering trap, matching `accept_connection_request`'s own
  documented precedent — folded into the plan before `builder` ran.
- `builder` round 1 → green on first pass (SQL suite, unit suite, `tsc`).
- `test-runner` round 1 → found one real regression: a new
  `@typescript-eslint/no-explicit-any` error in the ticket's own test file
  (A/B-proven new, not pre-existing) — `tests 1/2`. Also flagged
  `e2e/discover-shop.spec.ts` test #2 as a genuine, **untracked** planning
  gap (see "For Muskan" below) — not fixed here, e2e edits are outside
  T02's file list and T09's job.
- `builder` round 2 (tests) → eslint fix, confirmed clean.
- `/code-review high` + `critic` + `security`, parallel:
  - **security F1 — BLOCKING, rung 1 (leak).** The RPC's product lookup
    (step 6) checked only `company_id` + `deleted_at`, skipping
    `product_visible_to_caller` — the repo's declared single owner of "may
    this caller see this product." Proved exploitable: a connected caller
    holding a stale product id could get the RPC to post a withdrawn,
    unfiled, or deactivated-seller product's current name into the c2c
    thread. `critic` and `/code-review` independently found the same
    underlying gap but both rated it a note given the narrow blast radius
    they could establish without a live probe — security's concrete proof
    is what elevated it to blocking.
  - `/code-review` also flagged a real correctness gap (not independently
    rated blocking by security, but fixed in the same round): steps 8/11
    each called `clock_timestamp()` independently, and the migration's own
    header falsely claimed the ordering was "guaranteed" — `accept_connection_request`'s
    own cited precedent defends against exactly this coarse-clock tie with
    an explicit `+1ms` offset, which this RPC didn't use.
  - 21 notes total (below) — 0 additional blocking.
- `builder` round 3 (blocking-findings 1/2) → fixed both: added
  `and public.product_visible_to_caller(p_product_id)` to step 6 (called,
  not reimplemented); captured a single `v_now := clock_timestamp()` with
  an explicit `+1ms` offset on the second insert, matching
  `accept_connection_request`'s technique exactly; corrected the migration
  header's false ordering claim; rewrote two stale test-file comment blocks
  that described a pre-fix state. Amended the SQL suite's own fixture
  (added `location` to the test product) since the real visibility gate now
  correctly refuses an unfiled fixture — flagged as an explicit,
  ticket-directed deviation from "never edit test files," not silent
  non-compliance.
- `security` (re-check) → **fix confirmed against the live catalog**, not
  just the file: six hostile probes (expired/future visibility window,
  unfiled, deactivated/unverified/soft-deleted seller) all refused
  post-fix, all previously leaked pre-fix (reproduced read-only).
  Caller-identity resolution inside the `SECURITY DEFINER` body proven
  two-sided (not just assumed). Negative space checked — the
  `company_id = p_receiver_company_id` gate wasn't accidentally dropped
  fixing the visibility gate; `price_public`'s distinct raise still fires
  separately.
- `test-runner` (re-check) → full suite green, matches session baseline
  exactly (63/65 SQL — 2 pre-existing unrelated — 503/503 unit, `tsc`
  clean, eslint back to the 6/15 pre-existing baseline).

### Notes (rung 4-5, not retried)

1. **(plan-checker → resolved in-plan)** EARS 4's "ended" half of the
   suspended/ended criterion is asserted only for "suspended" in the SQL
   suite — behaviorally correct (`assert_relationship_writable` is
   status-agnostic, same code path), just not independently asserted for
   "ended". (critic, rung 5)
2. **(critic)** §C's dedup assertion uses a hardcoded count (`<> 1`), not a
   before/after delta — inconsistent with `supabase.md`'s own rule and safe
   only because seed data happens to put no `type='message'` rows on the
   c2c thread today. `request_product_pricing_c2c_test.sql:291-293`.
3. **(critic)** The `price_public` re-check inside the RPC is scope growth
   beyond TICKETS.md's literal T02 text — justified (plan-approved,
   defense-in-depth for a direct caller) but worth the ruling being on
   record rather than inferred.
4. **(critic)** The `connection_established` healing message
   (`20260903130000` step 8) copies `accept_connection_request`'s intro
   copy, but writes company names in the opposite order (asker-first vs.
   acceptor-first) — same pair, two orderings depending on which door
   minted the thread. A copy inconsistency, not a code bug — Muskan's call
   whether to unify it (would mean touching the Reused fence).
5. **(critic + code-review, converged)** The RPC's product lookup didn't
   re-check the full `product_visible_to_caller` door — **this is F1
   above, now fixed.** Recorded here because both reviewers independently
   found it before security proved it exploitable.
6. **(critic)** `buildPricingRequestNote`'s template (prefix/suffix/280-char
   clamp) is necessarily duplicated in SQL — `pricingRequest.ts` only
   carries a sync-marker comment on `PRODUCT_ID_KEY`, not on the other
   constants that also now have a second, hand-synced owner.
7. **(critic + security F4, converged, now fixed)** The SQL suite's own
   header comments described a pre-build risk state that no longer applied
   even before the round-3 fix — corrected as part of round 3.
8. **(critic)** I-M15 (the ADR's own promoted, "trivially machine-checkable"
   signature invariant for this exact RPC) isn't listed in TICKETS.md T02's
   ADR line, and ADR 0007:272's own sentence about
   `_resolve_or_create_c2c_thread`'s callers is now stale one level up from
   the comment this ticket fixed. Both are ticket/ADR bookkeeping gaps, not
   build gaps.
9. **(code-review)** `pending_inbox_item`'s own `WITH CHECK` never enforced
   "not already connected" — I-J2 is a TS-layer-only guarantee, same
   pre-existing, already-accepted shape as `createPairInboxItem`'s own
   documented "a direct PostgREST insert can still carry an arbitrary
   note/metadata" gap. Not introduced or worsened by T02.
10. **(code-review)** Minor TOCTOU: the relationship could transition
    unconnected→connected between `requestProductPricing`'s
    `is_connected_to_company` check and (on the unconnected arm)
    `createPairInboxItem`'s insert. Narrow window, worst case a stale
    ticket instead of a chat message.
11. **(code-review)** `revalidatePath` calls on the connected branch
    invalidate two Discover routes that render nothing this branch changes
    — copied from the unconnected branch without checking.
12. **(code-review)** `requestProductPricing` now creates its own Supabase
    client and, on the unconnected arm, `createPairInboxItem` creates a
    second independent one — could be passed through instead.
13. **(code-review)** `getDiscoverableShop` and `is_connected_to_company`
    are awaited sequentially though independent — could run via
    `Promise.all`.
14. **(security, re-check N1)** The SQL suite doesn't RED-first-prove the
    `product_visible_to_caller` guard specifically — its own fixture
    product happens to pass visibility, so deleting the new guard line
    would leave the suite green. Real gap in test rigor, matches this
    project's own repeated pattern (S7's stated concern) — worth a
    follow-up cell, not blocking today since the shipped code is correct.
15. **(security, re-check N2)** `is_caller_verified()` checks the caller's
    company's `verification_status`/`deleted_at` but not `deactivated_at` —
    pre-existing (defined `20260617090000`, long before this ticket), and
    directly reinforces Muskan's own open T17 question
    ("what should `company.deactivated_at` mean?"). Not this ticket's gap.

### Untracked planning gap — not a T02 finding, needs a ruling

`test-runner`'s first pass found `e2e/discover-shop.spec.ts` test #2 ("a
CONNECTED buyer's ask lands as a pricelist_request") asserts the exact
behavior T02 deliberately retires — it will read red the next time the e2e
suite runs, and **it is not in T09's named scope**
(`e2e/inbox-accept.spec.ts`, `e2e/deal-lands-in-c2c-chat.spec.ts`,
`e2e/deal-c2c-create.spec.ts` only). `e2e/inbox-accept.spec.ts` has the same
root cause but *is* already in T09's scope, so that one's expected.
Deliberately not touched here — e2e edits aren't in T02's file list and
widening T09's scope (or opening a sibling ticket) is a design-doc decision,
not a build one. Needs your call before `/ship`.

### Verification replay (backend-only ticket — no G4 human stop per PIPELINE §3)

- `plan-checker`, `test-writer`, `builder` ×3, `test-runner` ×2, `/code-review`,
  `critic`, `security` ×2 — full trail above.
- `tests 1/2` (the eslint fix), `blocking-findings 1/2` (the leak + timestamp
  fix, bundled as one round) — both well within budget, no escalation
  triggered.
- **No visual diff** — RPC + server-action branch only, nothing rendered.
  Step 9 (visual-verifier) does not apply.

**Backend-only, no carve-out triggered**: the one builder-adjacent deviation
(editing the SQL suite's own fixture) was explicitly ticket-directed, not a
builder rejection needing adjudication. No behavior change outside written
criteria once the leak fix landed. Closes on green tests + all three reviews
+ independent re-verification, no human G4 stop.

---

## T03 · Discover's Requests list carries pricelist requests

Diff: `src/app/discover/companyRequests.ts` (modified — filter widen, new
`COMPANY_REQUEST_TYPES` export, `type` field, I-J4 comment),
`src/app/discover/companyRequests.test.ts` (modified),
`src/app/discover/sections/RequestsSection.test.tsx` (modified — one
literal, kept compiling), `supabase/tests/accept_connection_request_status_guard_test.sql`
(modified — one new assertion closing an I-M9 coverage gap, no
function/migration touched).

**Verdict: 0 blocking across `plan-checker`, `critic`, `/code-review`, and
`security`. 1 blocking + 5 notes at plan stage (folded into `PLAN-T03.md`),
7 notes at review stage — all recorded below, none retried.**

### Round trail

- `plan-checker` round 1: REVISE — 1 blocking (adding a required `type`
  field breaks two call sites the plan hadn't censused — a construction
  literal in `RequestsSection.test.tsx` and three input literals in
  `companyRequests.test.ts` — `tsc --noEmit` would not have passed) + 5
  notes (the I-M9 "already covered" citation was wrong — case D3/AC2 never
  actually asserted the c2c thread; the I-J4 comment's own draft
  miscounted the seeded codes as four instead of five; the filter itself
  had zero automated cover; "no UI render yet" was false; an unremarked
  duplicate type union). Spot-verified and folded in — including extending
  the *existing* `accept_connection_request_status_guard_test.sql` suite
  with a genuinely missing c2c-thread assertion (I-M9), rather than
  writing a new SQL suite T03 doesn't need.
- `test-writer` → RED (compile-breaking, as intended) on the two TS test
  files; the SQL suite addition was correctly framed as adding coverage of
  already-correct behavior, not proving a fix.
- `builder` → green on first pass. Single file touched
  (`companyRequests.ts`), exactly as planned.
- `test-runner` → full suite green, matches session baseline exactly
  (63/65 SQL, 506/506 unit, `tsc` clean, 6/15 eslint pre-existing). Caught
  and self-corrected a harness artifact (a suite needing its own
  transaction wrapping) before it could be misreported as a regression.
- `/code-review high` + `critic` + `security`, parallel → 0 blocking from
  all three. `/code-review` surfaced 8 findings, but on inspection every
  one is either already recorded under T01/T02 above (the `confirm_detected_deal`
  NULL-guard note, T02's I-J2/`requestActionError`/`revalidatePath`/
  `Promise.all`/hardcoded-template notes, the untracked `e2e/discover-shop.spec.ts`
  gap) or is T04's explicitly-deferred badge work (`RequestsSection.tsx`
  rendering a pricing ask with no distinguishing badge — correctly
  anticipated in `PLAN-T03.md`'s own corrected framing, not a T03 defect).
  Nothing new for T03 itself. `critic` and `security` both reviewed T03's
  actual diff and found 0 blocking, 5 + 2 notes respectively (below).

### Notes (rung 4-5, not retried)

1. **(critic)** The new `COMPANY_REQUEST_TYPES` unit test asserts the
   constant's contents directly but doesn't read the actual query — its
   own comment overclaims that a builder reverting the `.in(...)` call
   (while leaving the constant alone) would be caught. It wouldn't; the
   shipped code is correct, only the test's self-description overstates
   its own reach.
2. **(critic)** AC2 says the accept path "mints" the relationship, but the
   only test exercising it (D3/AC2) runs on a pair already connected
   earlier in the same transaction — an "adopt" path, not "mint". A
   `pricelist_request` accepted on a genuinely never-connected pair has no
   test anywhere in this repo. Pre-existing gap in `accept_connection_request`'s
   own coverage (predates T03), correctly left out of this ticket's scope
   per the plan.
3. **(critic)** The new c2c-thread assertion (I-M9) is weaker than its p2p
   sibling — it doesn't pin `relationship_id`, so it would technically
   pass if the RPC returned any live c2c thread id, not necessarily the
   accepted pair's own. Still genuinely non-vacuous (a NULL/dangling id
   fails it) and proves something the suite never checked before. One
   extra predicate would close the gap.
4. **(critic)** The plan's own "RED-first" instruction for the new
   assertion is technically unperformable as literally written (a
   reverted/deleted assertion can't "fail") — the meaningful check is
   pointing the resolved id at a bogus uuid and confirming the raise
   fires, which wasn't independently re-confirmed this round.
5. **(critic)** `COMPANY_REQUEST_TYPES` is now a fourth near-duplicate
   type-membership list in this area of the codebase (alongside
   `PairInboxType`, `AcceptRequestType`, `InboxRequestType`) — the plan
   only reasoned about one of the other three. `AcceptRequestType` is the
   one that actually matters (it's what `acceptItem` casts into via an
   `as`, which `tsc` can't catch a drift on) — worth a sentence on record
   that keeping them separate is deliberate, not oversight.
6. **(security)** The query's own docblock still describes `inbox_select`
   as a two-disjunct policy; the live policy has a third
   (`receiver_person_id = auth.uid()`, added later). Harmless today (a
   CHECK constraint confines that disjunct away from the three widened
   types, confirmed via live probe), but understates the real floor to
   whoever reads this comment next instead of the catalog.
7. **(security)** The I-J4 comment grounds the `connect_person` exclusion
   in the column going nullable — true but not the actual enforcement
   mechanism, which is two named CHECK constraints
   (`inbox_connect_person_has_no_company`,
   `inbox_person_target_only_for_connect_person`). Citing them by name
   would be a stronger, more precise comment.

### Verification replay (backend-only ticket — no G4 human stop per PIPELINE §3)

- `plan-checker`, `test-writer`, `builder`, `test-runner`, `/code-review`,
  `critic`, `security` — full trail above. `tests 0/2`,
  `blocking-findings 0/2` — closed clean, no retries spent.
- **No visual diff shipped** — `RequestsSection.tsx` itself is untouched;
  the badge/retitle that would make this visible is T04's own diff, not
  this one's. Step 9 (visual-verifier) does not apply to T03's actual
  changes; T04 will need it.
- `security` independently confirmed the RLS floor (`inbox_select`) is
  type-agnostic and already released these rows before this ticket — the
  application-level filter widen exposes nothing new, live-probed against
  a third, uninvolved company (0 rows visible) and the legitimate receiver
  (correct 2-row result, `connect_person` correctly absent).

**Backend-only, no carve-out triggered**: no outstanding rejection, no
blocking finding from any reviewer, no behavior change outside written
criteria. Closes on green tests + all three reviews, no human G4 stop.

---

## T04 · Every request row shows a type badge; the box is retitled

Diff: `src/app/discover/requestTypeMeta.ts` (new — `DiscoverRequestKind`,
`RequestTypeBadge`, `requestTypeBadge()`), `src/app/discover/requestTypeMeta.test.ts`
(new), `src/app/discover/sections/RequestsSection.tsx` (modified — badge +
retitle), `src/app/discover/sections/RequestsSection.test.tsx` (modified),
`src/app/discover/DiscoverShell.test.tsx` (modified — one literal, `plan-checker`
B1), `e2e/discover.spec.ts` (modified — two literals, `plan-checker` B2).

**Verdict: 0 blocking across `/code-review` and `critic` (no `security` — no
migration/RLS/RPC/auth/server-action/cross-company-read surface). 3 blocking
+ 5 notes at plan stage (1 of the 3 spot-verified FALSE and rejected, 2 held
and folded into `PLAN-T04.md`), 8 notes at review stage — all recorded below,
none retried.**

### Round trail

- `plan-checker` round 1: REVISE — 3 blocking + 5 notes.
  - **B1 (rung 3, held):** `DiscoverShell.test.tsx:26` hardcodes
    `'Connection requests'`, outside T04's stated file list — D9's retitle
    turns it red. Folded in as Plan File 5.
  - **B2 (rung 3, held):** `e2e/discover.spec.ts:43,53` hardcode the same
    string in two Playwright assertions, owned by neither T04 nor T09.
    Folded in as Plan File 6.
  - **B3 (rung 3, claimed, spot-verified FALSE):** claimed
    `"connect_person" as DiscoverRequestKind` raises `TS2352`, requiring
    `as unknown as` first. Disproved by running this repo's own
    `tsc --strict` directly (bypassing the `rtk` hook, which fabricated a
    clean pass with zero real diagnostics on the first, wrong attempt) —
    the cast compiles clean; TypeScript widens a literal source expression
    to its base type (`string`) before the assertion-overlap check, so two
    disjoint string-literal types are comparable where two disjoint
    primitive types (the control case, `5 as string`) are not. Not folded
    in. `critic` independently re-derived the same mechanism during review
    and confirmed the rejection (see Notes below) — two independent checks
    now agree B3 was wrong.
  - N1 (missing `RequestTypeBadge` import in the plan's own snippet), N2
    (I-M11 asserted only in prose, not machine-checked), N4 (render
    assertions are page-wide substrings, not row-bound), N5 (a factual
    slip describing `InboxRequestType` as DB-sourced rather than a
    deliberate subset) — all held, folded into the plan. N3 (row-height/
    density change from the taller badged row) — named, routed to the G4
    human look rather than fixed in code.
- `test-writer` → RED across 4 test files: import-resolution failure for
  the not-yet-built module, and string-absence failures for the retitle/
  badge assertions everywhere else. Touched no source file.
- `builder` → green on first pass. Two source files, exactly as planned,
  zero deviations, zero rejections.
- `test-runner` → full suite: `tsc` clean, unit 514/514 (+8 new cases
  exactly, 0 drift elsewhere), eslint 6/15 pre-existing (byte-identical
  A/B against the T03 tip), SQL 63/65 pre-existing (same 2 fails already
  recorded at T01, unrelated — T04 touches no `supabase/` file, confirmed
  via `git status`), `e2e/discover.spec.ts` 4/4 green (run twice for
  stability) — the one file `builder` didn't run itself.
- `/code-review high` + `critic`, parallel → 0 blocking from either.
  `/code-review` independently re-verified `tsc` clean and 11/11 on the
  three unit files it could reach, confirmed no other `<RequestsSection>`
  consumer and no other file besides the two `plan-checker` already found
  referencing the retired title string. `critic` walked all three EARS
  criteria against the shipped code line-by-line (below) and confirmed
  the Reused fence intact.

### Notes (rung 4-5, not retried)

1. **(code-review, `src/app/discover/sections/RequestsSection.tsx:5`)**
   The top-of-file docblock still calls this the "Connection requests"
   box after this same diff renames the rendered title to "Requests" (D9)
   a few dozen lines below — self-contradicting comment.
2. **(code-review, `src/app/discover/sections/RequestsSection.test.tsx:2`)**
   Same shape: the docblock still says 'One "Connection requests" box'
   while the test's own assertion three lines below now expects
   "Requests".
3. **(critic, scope note, no action)** `DiscoverShell.test.tsx` and
   `e2e/discover.spec.ts` are outside TICKETS.md T04's stated file list —
   both are the `plan-checker` B1/B2 findings, both one-word title-string
   swaps, both fall under ADR §9's "scope may grow to keep the shipped
   system correct." Recorded so the growth is visible at the gate, not
   absorbed silently.
4. **(critic, `src/modules/connect/lib/inbox-display.ts:63-68` vs
   `src/app/discover/requestTypeMeta.ts`)** ADR 0009:142 says
   `REQUEST_TYPE_META`/`REQUEST_TYPE_BLURB` both "move" to the new file;
   only the META half shipped. `REQUEST_TYPE_BLURB`'s one consumer
   (`InboxRow.tsx:32`) is deleted by T07, so it dies unreplaced — a
   `connect` row with a null `note` shows name + badge and no descriptive
   line, where the retiring inbox showed "Wants to connect." Not blocking
   (T04's EARS never mention a blurb), but either D4's wording is stale or
   a one-line product call is owed before T07 removes the option.
5. **(critic, `e2e/discover.spec.ts:43`)** Playwright's `name` matcher is
   a case-insensitive substring match, and after the swap "Requests" is a
   substring of the OLD title "Connection requests" too — so this
   assertion would now pass on either title. The change was still
   required (the literal-equality-adjacent old string fails outright
   pre-swap), but the browser-level cover for D9 is nominal; the two unit
   assertions are what actually pin it. `exact: true` would restore
   discrimination.
6. **(critic, `src/app/discover/requestTypeMeta.ts:1-19`)** The fallback
   has a theoretical prototype-chain hole in the exact mechanism AC2
   names: `requestTypeBadge('constructor' as DiscoverRequestKind)`
   returns the inherited `Object`, not `undefined`, so `?? FALLBACK_BADGE`
   never fires and `<Icon />` throws "Element type is invalid" — same
   crash class the criterion cites, via a different door. Unreachable
   today (`inbox_request_type` seeds no such value, and
   `companyRequests.ts`'s `.in("type", COMPANY_REQUEST_TYPES)` gates the
   query besides). `Object.hasOwn(...)` would close it; rung 4, not
   promoted to blocking.
7. **(critic, no file — coverage gap)** D4's *visual* half ("stacked above
   Accept/Decline") has zero automated cover. `renderToStaticMarkup` sees
   the label text, never DOM position; the seeded e2e account
   (`alice@greenleaf.test`) has no incoming requests, so the badge never
   renders in a browser run either. Variant C's placement rests entirely
   on the G4 human look below.
8. **(critic, `src/app/discover/sections/SectionCard.tsx:28`)** Confirms
   plan-stage N3: the duo is pinned to `md:h-[320px]` with internal
   scroll, and the badge adds roughly 24px per row, so roughly 3 rows are
   visible before scrolling instead of roughly 4. No test breaks (the
   equal-height e2e assertion is fixed-height, row-count-indifferent) —
   exactly why it needs the human look rather than a green suite.

### Verification replay

- `plan-checker` round 1: REVISE (3 blocking claimed, 2 held + folded, 1
  spot-verified false and rejected) → not re-run, per skill (one round).
- `test-writer` → RED confirmed (import-resolution + string-absence, both
  genuine pre-build failures, not vacuous).
- `builder` → green, first pass, 0/2 retries spent, 0 deviations, 0
  rejections.
- `test-runner` → `tsc` clean; unit 514/514 (+8 exact); eslint 6/15 and
  SQL 63/65 both independently A/B-proven pre-existing/unrelated; e2e
  4/4. `tests 0/2`.
- `/code-review high` + `critic`, parallel → 0 blocking, 8 notes (above).
  `blocking-findings 0/2` — closed clean, no retries spent.

**This diff renders** (a badge and a title, on a page a person looks at) —
per PIPELINE §3 / SKILL.md step 10, this stops at G4 for Muskan's own look,
not an auto-close. `visual-verifier` next.

---

## T05 · Backfill: resolve every pending deal ticket

Diff: `supabase/migrations/20260904090000_pending_inbox_item_deal_card_backfill.sql`
(new — DML-only, one `UPDATE`), `supabase/tests/pending_inbox_item_deal_card_backfill_test.sql`
(new), `supabase/tests/run_pending_inbox_item_deal_card_backfill_test.sh` (new).

**Verdict: 1 blocking finding (security, rung 2, S7 — the test doesn't prove
`status = 'pending'` is load-bearing), fixed in one round and independently
re-verified. 0 blocking from `/code-review` or `critic`. 6 + 4 + 8 notes
across the three reviewers — recorded below, most are re-discoveries or
findings about already-shipped tickets, not new T05 gaps.**

### Round trail

- `plan-checker` round 1: REVISE — 1 blocking (the EARS-3 fixture design
  didn't work: `create_deal_draft` births `'unsent'` not `'negotiation'`,
  creates no thread, needs an authenticated caller the plan told the
  builder to avoid — spot-verified against the RPC's live body, held,
  redesigned to plain INSERTs) + 6 notes (a false "no trigger" claim — one
  exists, built via `format()` in a loop, invisible to a literal grep; a
  wrong grant-rejection rationale — the real reason to avoid
  `SET LOCAL ROLE authenticated` is RLS silently narrowing rows, not a
  permission error; missing NOT NULL columns in the fixture spec; an
  undernamed `claim_deal_ticket` behaviour change; a `deal_card_id` wiring
  gap weakening the EARS-3 assertion; a stale ticket-count in TICKETS.md's
  own Ready table). All held, folded into `PLAN-T05.md`.
- `test-writer` → wrote the SQL suite + runner. Could not `chmod +x` the
  runner (no Bash tool available to it) — done manually before `builder`
  ran.
- `builder` round 1 → green first pass. Byte-identity between the
  migration's UPDATE and the test's inlined copy confirmed via `diff` +
  matching MD5 checksums (the coupling the plan explicitly calls out for
  a DML-only migration with nothing else to call).
- `test-runner` round 1 → `tsc` clean, unit 514/514 (0 drift, this ticket
  touches no TypeScript), eslint 6/15 and SQL 2/66 both independently
  confirmed pre-existing/unrelated (same baseline as T01-T04),
  `supabase db reset` applies clean with the new migration correctly at
  the tail. New suite independently re-run, not just trusted from
  `builder`'s report — green.
- `/code-review high` + `critic` + `security`, parallel:
  - **security F1 — BLOCKING, rung 2 (silent failure, S7).** The suite's
    own header claims all three WHERE predicates are independently
    provable by "dropping any one … would flip a different row and fail
    a specific cell" — false for `status = 'pending'`. The only non-
    `pending` fixture row is already `'accepted'` (a no-op target either
    way), so dropping that predicate flips zero visible values and every
    cell still passes. Not hypothetical: `declineItem`
    (`src/modules/connect/supabase/inbox.ts:352-356`) produces real
    `deal_card` rows at `status = 'rejected'` with no type filter — an
    unguarded WHERE clause would silently flip a declined ticket back to
    `accepted` in production, undetected by this suite. `critic` and
    `/code-review` did not independently find this; `security`'s own S7
    checklist item (proven RED-first) is what surfaced it.
  - `critic` → 0 blocking, 6 notes (below) — independently censused
    every other consumer of the precondition this migration deletes
    (not just `claim_deal_ticket`, which the plan already named) and
    confirmed nothing else is affected; confirmed the byte-identity
    claim itself by re-diffing.
  - `/code-review high` → 0 blocking specific to T05's own diff. 8
    findings total, but only one (the misleading History-lens banner)
    concerns T05's diff at all — and `security` (F4) and `critic` (N6)
    had already independently found and rated the same fact non-blocking
    (a disclosed, self-resolving W3→W4 window artifact). The other 7
    are pre-existing gaps in `confirm_detected_deal` (unchanged by any
    ticket in this slug — already on record from T01's own review, see
    below), a deliberate ADR-locked design choice in T04's
    `requestTypeMeta.ts` mistaken for duplication, and efficiency/process
    notes about already-shipped T02 code or the plan's own disclosed
    manual checkpoint. None are T05 regressions.
- `builder` round 2 (blocking-findings 1/2) → added fixture row 7
  (`deal_card`/`rejected`/`NULL`) and an assertion it stays `rejected`
  after the UPDATE, per security's exact fix suggestion. Proved its own
  fix by temporarily stripping `status = 'pending'` from the test's
  embedded UPDATE copy, confirming the new cell fails
  (`row 7 … expected to stay rejected, found accepted`), then restoring
  the original text.
- `test-runner` (re-check) → independently reproduced: full suite green,
  same 2 pre-existing SQL fails (unrelated, confirmed via file-diff —
  neither touched by this ticket), unit 514/514, `tsc` clean, `db reset`
  applies clean. Did not trust `builder`'s report — read the test file
  directly to confirm row 7 and the new cell are really present, then
  ran the suite itself.
- `security` (re-check) → **F1 CLOSED, independently re-verified from
  first principles, not on builder's word.** Hashed the migration file
  before/after (unchanged, `sha256` identical throughout the fix loop);
  confirmed the byte-identity invariant still holds (migration and test's
  embedded copy hash identically); re-ran the three-predicate removal
  simulation against the now-seven-row fixture — each drop now moves a
  row a specific §A cell pins; then went further than asked and
  **rebuilt all three predicate-drop mutants itself** in a scratch
  transaction, reproducing the exact failure for each (including
  `builder`'s claimed message for `status`, verbatim) before restoring
  and leaving the DB clean. Re-ran the full negative-space sweep too
  (every reader of `pending_inbox_item` — `inbox_select`,
  `list_discoverable_companies/people`, `shares_connection_with_company`,
  `can_see_person`) and confirmed none of them change their answer for
  any caller as a result of this backfill.

### Notes (rung 4-5, not retried)

1. **(critic)** The suite's own header (`:61-68` pre-fix) claimed "EXPECTED
   TO BE RED right now: the migration file does not exist yet" — false on
   both counts even before the fix; there is no function to call, so the
   suite was never RED-against-old-code the way T01-T04's were. A
   `test-writer` leftover, matches L-045's shape.
2. **(critic)** The `claim_deal_ticket`-unreachable consequence is named in
   `PLAN-T05.md` but not in the migration's own header — a DBA reading
   just the migration wouldn't learn it.
3. **(critic)** §A/§C assert proxies of the EARS wording rather than the
   literal criteria (row-by-row status instead of AC1's count query; a
   `chat_message` row instead of AC3's "chat thread"; a column subset
   rather than genuinely every column) — equivalent given this fixture,
   provable by construction, but the wording overclaims "byte-identical."
4. **(critic, rung 4)** `pending_inbox_item` is in the realtime
   publication — the backfill broadcasts one UPDATE per touched row to
   every connected client. RLS-scoped, no leak; practical impact ~0 since
   production is expected to hold 0 such rows (ADR §1).
5. **(critic)** Five `GRANT SELECT ON _t TO authenticated` statements in a
   suite that deliberately never switches role — dead, copied from the
   sibling suite where the switch is real, quietly contradicts the
   header's own emphatic note.
6. **(critic, rung 5)** A backfilled row would show a misleading "Deal
   picked up" banner in `/connect/inbox`'s History lens for the W3→W4
   window — only reachable before T07 deletes the page, and (per the
   ADR) on rows that were never cut through a sanctioned route to begin
   with. A wording artifact, not live work. **Converges with security F4
   and code-review's finding 3 below — three reviewers, same fact, same
   non-blocking rating.**
7. **(security, S7, rung 5)** The header's "one each of the three OTHER
   live `inbox_request_type` codes" is wrong — the catalog seeds five
   codes total, not four; `connect_person` is the uncounted one. No
   practical risk (exact-equality predicate on a `NOT NULL` column), but
   the sentence is untrue as written.
8. **(security, S2, rung 5)** Same dead-grant observation as critic's
   note 5, independently found.
9. **(security, S4, rung 4)** Confirms critic's note 6/code-review's
   finding 3 — the History-lens banner is real but not a leak
   (RLS-scoped, viewer already entitled to see the row) and
   `claim_deal_ticket` stays unreachable exactly as the plan predicted
   (verified directly against `InboxDetail.tsx`'s render branches, not
   assumed).
10. **(code-review, `confirm_detected_deal_drop_ticket_branch.sql:79`,
    pre-existing, NOT T05's — flagged for the record)** The idempotent
    "already born" early-return runs BEFORE the participant guard, so
    any authenticated caller who obtains a `deal_detected` message id
    can read back its `deal_card_id` for a deal they have no
    relationship to — a distinct info-disclosure angle from the
    already-documented NULL-guard bypass (T01 REVIEW.md notes 1/5/7).
    Unchanged by T01's diff (which only deletes the trailing `else`
    branch) or by anything in this slug. **Not fixed here — out of
    T05's scope. Filed as [HEL-89](https://linear.app/hellosello/issue/HEL-89)
    (Codebase Development Tickets), 2026-09-06.**
11. **(code-review, same file:87, pre-existing, already on record)**
    Re-discovery of the NULL-blind participant guard already documented
    in T01's REVIEW.md notes 1/5/7 and STATE.md's "For Muskan" section.
    Nothing new.
12. **(code-review, `20260903130000_request_product_pricing_c2c.sql:190`,
    concerns already-shipped T02, NOT T05 — flagged for the record, not
    fixed here)** A TOCTOU gap in the dedup guard: step 9's `EXISTS`
    check and step 11's `INSERT` have no unique constraint or lock
    between them, so two near-simultaneous calls (a double-click, a
    retried request) can both pass the check and both insert — violating
    I-M13's locked invariant ("the same ask twice … does not produce a
    second chat message") under concurrency, which T02's sequential SQL
    suite would not have caught. **Genuinely new, not a re-discovery —
    T02 is already merged and G4-approved, so this isn't T05's fix to
    make. Filed as [HEL-90](https://linear.app/hellosello/issue/HEL-90)
    (Codebase Development Tickets), 2026-09-06.**
13. **(code-review, `src/app/discover/requestTypeMeta.ts:7`, already
    decided, not a gap)** Flagged as duplicating
    `inbox-display.ts`'s `REQUEST_TYPE_META` instead of reusing it. This
    was a deliberate ADR decision (D4/I-M11, `PLAN-T04.md`): importing
    from `inbox-display.ts` would couple the new badge map to
    `COMPANY_INBOX_TYPES`, which derives a query filter from that map's
    keys — exactly the coupling I-M11 exists to prevent. `inbox-display.ts`
    is also deleted outright in T07, making "reuse it" actively wrong
    advice. Re-discovery of an already-ruled-on tradeoff.
14. **(code-review, `20260903130000_...sql:130`, concerns already-shipped
    T02, efficiency only)** Expensive validation (relationship lookup,
    liveness, visibility) runs before the cheap dedup check, so a repeat
    ask pays full validation cost before short-circuiting. Not fixed
    here — T02's own ticket, already closed.
15. **(code-review, `PLAN-T05.md:222`, process note, not a code defect)**
    Observes the real I-M5 checkpoint (run for real against the target
    environment before T06/T07 start) has no automated enforcement.
    Already disclosed identically in the plan and the migration header —
    reinforcement, not a new finding.
16. **(code-review, `src/app/discover/actions.ts:170`, concerns
    already-shipped T02, efficiency only)** `is_connected_to_company`'s
    underlying predicate is evaluated up to three times across one
    `requestProductPricing` call. Related to T02 REVIEW note 13
    (sequential awaits, not `Promise.all`) but a distinct angle. Not
    fixed here.
17. **(security, re-check N1, rung 5)** The suite's header still says
    fixture rows 4-6 cover "the three OTHER live `inbox_request_type`
    codes" — there are four others (`connect_person` uncounted), and it
    's live (seeded on `db reset`, written by
    `src/app/discover/personActions.ts:57`). Not a real gap — `type` is
    still proven red by rows 4-6, and §B's delta happens to cover the
    seeded `connect_person` row — but adding a real row 8 isn't a
    one-line tuple (`connect_person` forces a different column shape:
    `receiver_company_id NULL`, `receiver_person_id NOT NULL`, per three
    separate CHECK constraints). Cheapest correct fix is the wording.
18. **(security, re-check N2, rung 5)** The "EXPECTED TO BE RED right
    now" header line is stale post-fix too (same underlying issue as
    critic's note 1) — the suite runs its own embedded UPDATE copy, so
    it was never genuinely RED against the migration's absence.
19. **(security, re-check N3, rung 4)** The migration↔test byte-identity
    coupling is enforced only by a comment, not the runner — if a future
    edit changes the migration's predicate without updating the test's
    embedded copy, the suite stays green and the drift is silent.
    Verified identical today; this is about future drift, not a present
    gap. Cheap to harden (hash the migration's UPDATE block against the
    test's in the runner script) — not done here, rung 4, named for the
    record.
20. **(security, re-check, out-of-diff, not a T05 finding)**
    `shares_connection_with_company` matches any `pending_inbox_item`
    row with no `status` and no `deleted_at` filter — a rejected or
    soft-deleted request appears to grant person-visibility permanently.
    Pre-existing, untouched by this ticket, unaffected by the backfill
    either way (T05 doesn't change which rows exist, only `deal_card`
    rows' status, and this predicate doesn't filter on `type` either).
    **Filed as [HEL-91](https://linear.app/hellosello/issue/HEL-91)
    (Codebase Development Tickets), 2026-09-06.**

### Verification replay (backend-only ticket — no G4 human stop per PIPELINE §3)

- `plan-checker`, `test-writer`, `builder` ×2, `test-runner` ×2,
  `/code-review`, `critic`, `security` ×2 — full trail above.
- `tests 0/2` (no test-runner-caught regression, only the security-caught
  test-rigor gap), `blocking-findings 1/2` — well inside budget.
- **No visual diff** — DML-only migration, nothing rendered. Step 9
  (visual-verifier) does not apply.
- **Carve-out check (PIPELINE §3 / SKILL.md step 10):** no outstanding
  builder rejection. The one blocking security finding was fixed AND
  independently re-verified by `security` itself before this ticket
  closed — matching T02's own precedent (a blocking finding that gets
  fixed-and-reverified within the ticket's own round does not leave
  anything "outstanding," so the carve-out does not trigger). The one
  named behaviour change (`claim_deal_ticket` becoming unreachable) is
  documented as the intended, written-into-the-plan end state (D5/I-M2),
  not an undocumented one. **No carve-out triggered — closes on green
  tests + all three reviews + independent re-verification, no human G4
  stop.**

**Three findings surfaced during this round that were NOT T05's to fix — all
filed 2026-09-06 to Linear team "Codebase Development Tickets" (not
`/track-doubt`, which is scoped to LAYER-*.md product doubts; these are
engineering findings with no product-doc home):** (a)
[HEL-89](https://linear.app/hellosello/issue/HEL-89) — the
`confirm_detected_deal` info-disclosure angle, alongside the already-known
NULL-guard bypass; (b) [HEL-90](https://linear.app/hellosello/issue/HEL-90) —
the TOCTOU dedup race in T02's already-shipped `request_product_pricing_c2c`,
violating locked invariant I-M13 under concurrency; (c)
[HEL-91](https://linear.app/hellosello/issue/HEL-91) —
`shares_connection_with_company` granting person-visibility with no
`status`/`deleted_at` filter. See notes 10, 12, and 20 above for full detail.

### G4 visual staging (`visual-verifier`) — evidence for Muskan's look

**⚠️ There is no prototype file to diff against.** `STATE.md` records that the
row-label variants were driven live on `/discover?variant=` and thrown away
after the decision, so every row below is staged against the **written** spec:
ADR 0009 D4 / D9 / D10 / I-M16 and TICKETS.md T04's three EARS lines. Where a
row says `deviates`, it deviates from that prose (or from a claim made earlier
in this same file), never from an image.

**How the page was reached.** Fresh `supabase db reset` (local stack, migration
tip `20260903130000`, `.env.local` → `127.0.0.1:54321`), `next dev` on
`localhost:3000`, signed in as the seeded `alice@greenleaf.test` through the
repo's own `e2e/fixtures/two-company.ts:loginAs`, real page, real data, no
isolated component render.

**On the data.** `e2e/discover.spec.ts`'s header comment claiming Alice has "NO
incoming requests" is **stale** — seed §5f and §7c give her three live pending
rows (`connect` from Eva/Bavaria, `connect_message` from David/NordCanna,
`connect_person` from Clara). The fourth kind is **not** seeded: a
`pricelist_request` was added as a local-only fixture row whose columns mirror
`createPairInboxItem` exactly (`note` = `buildPricingRequestNote(product.name)`,
`metadata` = `{"product_id": …}`, sender Eva/Bavaria — unconnected to GreenLeaf,
which is the arm that still cuts a ticket after T02). **It was inserted by SQL,
not produced by a live `requestProductPricing` call** — so this staging proves
the *badge*, not T02's write path. All four `DiscoverRequestKind` values were on
screen together.

Screenshots: `docs/muskan-build/0027-retire-connect-inbox/g4/`.

#### Acceptance criteria (TICKETS.md T04 EARS)

| # | Spec line | Verdict | Evidence / what differs |
|---|---|---|---|
| 1 | "When any request row renders, the system shall display a type badge for it." | **match** | All four rows badged, none blank. `g4/02-desktop-requests-box-default.png`, `g4/03-…-scrolled-bottom.png` |
| 2 | "When a row of an unrecognised type is encountered, the system shall not throw — no badge lookup may return `undefined`." | **cannot-verify** | Not reachable from a browser: `companyRequests.ts` gates the query with `.in("type", COMPANY_REQUEST_TYPES)` and person rows are hard-coded `kind="person"`, so no out-of-union value can arrive on this surface. Covered only by `requestTypeMeta.test.ts`'s cast case. `critic` note 6's `'constructor'` door is likewise unreachable live. |
| 3 | "When the Requests box renders, its title shall read 'Requests'." | **match** | `<h2>` exact text `Requests`, not "Connection requests" — populated `g4/02`, empty `g4/14-empty-state-1440.png` |

#### Prototype differentiators — the things Variant C won on (ADR D4 / D9 / D10 / I-M16)

| # | Spec line | Verdict | Evidence / what differs |
|---|---|---|---|
| 4 | D4 — badge **stacked above** Accept/Decline | **match** | Badge bottom `322` vs Actions top `328` (6px gap) on every row, held at 390 / 640 / 768 / 820 / 1024 / 1280 / 1440. `g4/05-desktop-badge-column-zoom.png` |
| 5 | D4 — "grouped with the **decision** rather than the identity" | **match** | Badge right edge `796` = Accept right edge `796`; badge left `683` sits right of the name column's right edge `624`. It is in the button column, not beside the avatar. |
| 6 | D10 — **every** row badged, person rows included | **match** | Clara Vogt (the `connect_person` row) carries "Person". `g4/03` |
| 7 | `connect` → "Connection" | **match** | `g4/03`, `g4/05` |
| 8 | `connect_message` → "Message" | **match** | `g4/02`, `g4/05` |
| 9 | I-M16 — `pricelist_request` → literal "Pricelist request" | **match** | Top row of `g4/02`, rendered in a browser (not just `renderToStaticMarkup`) |
| 10 | person row → "Person" | **match** | `g4/03` |
| 11 | A distinct icon per kind | **match** | `lucide-receipt-text` / `lucide-link-2` / `lucide-message-square` / `lucide-user`, all rendered at `h-3 w-3`. `g4/05` |
| 12 | A distinct accent per kind | **deviates** | `connect_message` and `person` are **both** `text-info` — two of the four badges are the same blue. Not a spec breach (D4 names no colours), but the colour carries no information for those two; label + icon do all the work. `g4/05` vs the "Person" pill in `g4/03` |

#### States

| # | State | Verdict | Evidence / what differs |
|---|---|---|---|
| 13 | Default | **match** | `g4/02`, page context `g4/01-desktop-1440-page.png` |
| 14 | Hover — Accept, then Decline | **match** | Accept darkens to `brand-deep`, Decline tints; badge and its spacing unaffected. `g4/04-desktop-hover-accept.png`, `g4/12-hover-decline.png` |
| 15 | Filled — all four kinds at once | **match** | Two rows from the same sender (Bavaria) are told apart **only** by the badge — "Pricelist request" vs "Connection". `g4/02` |
| 16 | Error | **match** | Row soft-deleted out from under the client, then Accept clicked: `This request is no longer available.` renders above the list, count falls 4→3, badges intact. `g4/13-error-state.png` |
| 17 | Empty | **match** | "Requests · 0 · No pending requests." — the retitle holds in the empty branch too. `g4/14` |
| 18 | Narrow width | **deviates** | See fit check rows 22-23. |

#### Fit check — the component inside its real container

| # | Constraint | Verdict | Evidence / what differs |
|---|---|---|---|
| 19 | `SectionCard` `fill` → `md:h-[320px]` with internal scroll | **match** | Body `clientHeight 267` / `scrollHeight 341`; scrolls cleanly to the Person row, no clipped badge, no overlapping text. `g4/03` |
| 20 | Row density (`critic` note 8: "roughly 3 rows instead of roughly 4") | **deviates — from the note, not the spec** | Measured with the badges hidden via injected CSS on the same live page: rows go **69px → 82px, i.e. +13px, not ~24px**, and the count of **fully visible rows is 3 either way**. What actually changed is how much of the 4th row peeks above the fold: **60px → 21px**. Baseline shot: `g4/11-baseline-badge-hidden-1440.png`. Nothing looks broken. |
| 21 | No clipping / overflow at desktop widths | **match** | 820 / 1024 / 1280 / 1440: `document.scrollWidth` equals the viewport, card `scrollWidth` equals `clientWidth`, no badge crosses the card edge. `g4/09-fit-1024-page.png`, `g4/10-fit-1024-requests-box.png` |
| 22 | 768px — exactly the `md` breakpoint | **deviates (pre-existing, T04 contributes 0px)** | The duo goes two-column while the shell sidebar is still expanded: card is **231px** wide against a row min-content of **246px**, so `overflow-hidden` cuts the Accept button and the badge labels. **Proven not caused by the badge:** the row's min-content is `246px` *both* with and without the badge, and the right column is `160px` (the Decline+Accept pair) at every width while the widest badge is `113px` — the badge never sets the row's minimum. `g4/06-md-768-requests-box.png` |
| 23 | 390px mobile | **deviates (pre-existing, T04 contributes 0px)** | The shell's sidebar does not collapse; the whole page overflows (`document.scrollWidth 591` vs a 390 viewport) and the Requests card is squeezed to **122px**, clipping name, note, badge and both buttons alike. Same zero-contribution proof as row 22. Below `md` the card is auto-height (395px) and all four rows render with **no** internal scroll — `g4/10-fit-640-requests-box.png` is what the mobile card is *meant* to look like. `g4/07-narrow-390-page.png`, `g4/08-narrow-390-requests-box.png` |

**Two things this walk corrects in the record above.** (a) `critic` note 8's
`~24px` / "4 rows becomes 3" is off — it is `+13px` and "3 rows either way, with
a thinner sliver of the 4th". (b) `critic` note 7 says the badge "never renders
in a browser run" because Alice has no incoming requests; she has three seeded
ones, and with a fourth staged all four badges have now been seen in Chromium.

**Staged, not judged.** No verdict is passed here. Rows 12, 18, 20, 22 and 23
are what G4 exists to put in front of Muskan; rows 22 and 23 in particular are
page-shell behaviour that predates this ticket and may belong in a separate
doubt rather than in T04.
