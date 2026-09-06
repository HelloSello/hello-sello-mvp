"use client";

/**
 * Deal card - FRONT, rebuilt as the 8-part living document (07-07, D-11..D-26).
 *
 * The card is no longer pure display: it is the visible centerpiece that consumes
 * everything the earlier waves built. The 8 parts (D-11), top -> bottom:
 *   1. TOOLBAR      - "Talk about this deal" (opens the group picker, D-05/D-29) +
 *                     a post-close reopen-ticket button (D-29). Fixed.
 *   2. LETTERHEAD   - deal number + date + a neutral status pill. Fixed. The
 *                     finished-deal skin is removed (D-17: the only closed cue is
 *                     the pencil -> lock in DealCard).
 *   3. PARTIES      - seller -> buyer. Fixed.
 *   4. PRODUCTS     - the product table; read-only rows or inline
 *                     row-edit when the card is in edit mode (D-16). A held change
 *                     renders as the on-card red/green diff (NegotiationDiff, D-18);
 *                     a promotion's reward lines render in the yellow track.
 *   5. EXTRA CONDS  - delivery / payment / free delivery + a Discounts section of
 *                     its OWN (D-13); fully SELLER-ONLY to edit. Non-product
 *                     promotion rewards render here (D-22).
 *   6. OPEN ITEMS   - the flat Things list (OpenItems, D-15). No stages.
 *   7. NOTES        - one per party; each edits only its own; blank never shown (D-14).
 *   8. DECISION     - Negotiate / Sign on a held change (DecisionBar, D-19/D-20), or
 *                     the "Send change" bar while editing.
 *
 * Per-part edit ownership (D-12/D-13/D-14): products jointly edit quantity/unit +
 * add-from-shop / swap / remove, but price + batch are SELLER-ONLY (buyer locked);
 * extra conditions are seller-only; notes are per-party. Money is ALWAYS the
 * canonical per-gram value (sumLineValue / lineValueOf) - never size x units x price.
 *
 * A completed inline edit reuses the existing engine VERBATIM (D-20): it calls
 * proposeDealChange with the required change reason (REAS-01); the OTHER side then
 * sees the diff + DecisionBar. No new RPC.
 */
import { useEffect, useRef, useState } from "react";
import {
  ArrowRight,
  Check,
  History,
  Lock,
  MessageSquarePlus,
  Pencil,
  Plus,
  Trash2,
  X,
} from "lucide-react";
import { averageMarginOf, formatMoney, lineValueOf, sumLineValue } from "../lib/derive";
import { paymentTermLabel } from "../lib/paymentTerms";
import { resolveTierPrice, type PriceTier } from "@/modules/catalog/index.client";
import { tierStateFor } from "../lib/tierHint";
import { createClient } from "@/shared/db/client";
import { getOwnCatalog, getPromotion } from "../supabase/reads";
import { proposeDealChange, updateDealDraft, withdrawDealChange } from "../actions";
import { resendAction } from "../lib/draftEdit";
import { pairDealDiff, proposedLinesTotal, proposedLineTotal } from "./NegotiationDiff";
import { DecisionBar } from "./DecisionBar";
import { NegotiationStrip } from "./NegotiationStrip";
import { PromotionTrack } from "./PromotionTrack";
import { OpenItems } from "./OpenItems";
import type {
  CardCreateInput,
  CatalogProduct,
  DealCardView,
  DraftLineInput,
  MemberView,
  PromotionView,
  ThingView,
} from "../types";

/** One editable product line while the card is in inline edit mode. */
interface EditLine {
  key: string;
  lineItemId: string | null;
  productId: string | null;
  productName: string;
  quantity: number;
  unit: string;
  /**
   * How many packs of this line (chj/07-08, FRONTEND-ONLY mock). Our backend has
   * no units count - the canonical value is per-gram (quantity x price, CARD-02).
   * `units` is a visual multiplier on that per-gram value; it starts at 1 so the
   * total matches real data on load, and the stepper just multiplies it in the UI.
   * It is NOT persisted (today's demo is frontend-only).
   */
  units: number;
  /**
   * The product's tier ladder + its base €/g (T07, ADR-0004 §4 decision B) -
   * FRONTEND-ONLY like `units`: they power the applied-rung chip + the
   * "qualifies" hint and NEVER enter the payload (toDraftLine stays untouched).
   * Seeded lines carry []/null; the edit view derives their ladder from the
   * fetched catalog at render instead.
   */
  tiers: PriceTier[];
  basePricePerGram: number | null;
  unitPrice: number | null;
  currency: string;
  cultivar: string | null;
  pzn: string | null;
  batchId: string | null;
  batchNumber: string | null;
  thcPercent: number | null;
  cbdPercent: number | null;
  ownInput: number | null;
}

/** A margin % for the card, or "—" when not computable yet. */
function marginLabel(pct: number | null): string {
  return pct == null ? "—" : `${(pct * 100).toFixed(1)}%`;
}

function dateLabel(iso: string | null): string {
  if (!iso) return "—";
  return new Intl.DateTimeFormat("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  }).format(new Date(iso));
}

function initialsOf(name: string): string {
  return name
    .split(/\s+/)
    .map((w) => w[0])
    .slice(0, 2)
    .join("")
    .toUpperCase();
}

/** Seed the editable line set from the card's current lines + my per-line inputs. */
function seedLines(data: DealCardView): EditLine[] {
  const marginByLineId = new Map(data.lineMargins.map((m) => [m.lineItemId, m.ownInput]));
  return data.lineItems.map((li) => ({
    key: li.id,
    lineItemId: li.id,
    productId: li.productId,
    productName: li.productName,
    quantity: li.quantity,
    unit: li.unit,
    units: 1,
    tiers: [],
    basePricePerGram: null,
    unitPrice: li.unitPrice,
    currency: li.currency,
    cultivar: li.cultivar,
    pzn: li.pzn,
    batchId: li.batchId,
    batchNumber: li.batchNumber,
    thcPercent: li.thcPercent,
    cbdPercent: li.cbdPercent,
    ownInput: marginByLineId.get(li.id) ?? null,
  }));
}

/**
 * Seed the editable set from the viewer's OWN held draft (C3 data-loss fix).
 *
 * When a PROPOSER re-opens the card to edit their own held change, the working
 * copy must start from what they PROPOSED, not the committed base version - else
 * editing one line and re-sending drops the other lines they had proposed. The
 * held `ProposalLineView` carries the SHARED shape only (name/qty/unit/price +
 * productId); batch, measured THC/CBD and the private margin are carried across
 * from the matching base line by product key (held drafts never see them).
 */
function seedLinesFromHeld(base: DealCardView): EditLine[] {
  const held = base.pendingChange;
  if (!held) return seedLines(base);
  const baseByKey = new Map(
    base.lineItems.map((li) => [li.productId ?? li.productName, li]),
  );
  const marginByLineId = new Map(base.lineMargins.map((m) => [m.lineItemId, m.ownInput]));
  return held.lines.map((hl, i) => {
    const match = baseByKey.get(hl.productId ?? hl.name);
    return {
      key: match?.id ?? `held-${i}`,
      lineItemId: match?.id ?? null,
      productId: hl.productId,
      productName: hl.name,
      quantity: hl.quantity,
      unit: hl.unit,
      units: 1,
      tiers: [],
      basePricePerGram: null,
      unitPrice: hl.unitPrice,
      currency: hl.currency,
      cultivar: match?.cultivar ?? null,
      pzn: match?.pzn ?? null,
      batchId: match?.batchId ?? null,
      batchNumber: match?.batchNumber ?? null,
      thcPercent: match?.thcPercent ?? null,
      cbdPercent: match?.cbdPercent ?? null,
      ownInput: match ? marginByLineId.get(match.id) ?? null : null,
    };
  });
}

/** One line's total: the canonical per-gram value x the (mock) pack count. */
function lineTotalOf(l: EditLine): number | null {
  if (l.unitPrice == null) return null;
  return lineValueOf(l.quantity, l.unit, l.unitPrice) * Math.max(1, l.units);
}

/** EditLine -> DraftLineInput: the ONE payload mapping shared by birth (Save
 *  draft / auto-save-on-close, D-13) and negotiation changes. `units` is a
 *  frontend-only mock and never enters the payload. */
function toDraftLine(l: EditLine): DraftLineInput {
  return {
    productId: l.productId,
    lineItemId: l.lineItemId ?? undefined,
    productName: l.productName,
    quantity: l.quantity,
    unit: l.unit,
    unitPrice: l.unitPrice,
    currency: l.currency,
    cultivar: l.cultivar,
    pzn: l.pzn,
    thcPercent: l.thcPercent,
    cbdPercent: l.cbdPercent,
    batchId: l.batchId,
    batchNumber: l.batchNumber,
    ownInput: l.ownInput,
  };
}

/* FRONTEND-ONLY mock option lists (chj/07-08) - the edit dropdowns for batch +
   unit size. No backend yet; the current value is always merged in so it stays
   selectable. Ported from the chat-flipdoc prototype. */
const MOCK_BATCHES = ["24-098", "24-117", "24-201", "25-034", "25-112"];
const MOCK_SIZES = [100, 250, 500, 1000];
/** the current value merged into the option list, sorted, de-duped. */
function withCurrent(options: number[], current: number): number[] {
  return Array.from(new Set([...options, current])).sort((a, b) => a - b);
}

/** The edit-preview total: sum of the per-line totals (unpriced lines excluded). */
function editTotalOf(lines: EditLine[]): number | null {
  const priced = lines.filter((l) => l.unitPrice != null);
  if (priced.length === 0) return null;
  return priced.reduce((sum, l) => sum + (lineTotalOf(l) ?? 0), 0);
}

/** One conditional note row (prototype `.note`). Renders nothing when the text is
 *  empty/blank (D-14) - a blank note is never shown to the other side. */
function Note({ company, text }: { company: string; text: string | null }) {
  if (!text || !text.trim()) return null;
  return (
    <div
      className="mt-2 rounded-[8px_14px_14px_8px] border border-[color:var(--dc-hairline)] px-4 py-2.5 first:mt-0"
      style={{ borderLeft: "3px solid var(--dc-pink)", background: "rgba(122,18,48,0.035)" }}
    >
      <div className="mb-1 flex items-center gap-1.5">
        <span className="grid h-[16px] w-[16px] shrink-0 place-items-center rounded-full bg-[color:var(--dc-pink)] text-[8px] font-bold text-white">
          {initialsOf(company)}
        </span>
        <span className="text-[9.5px] font-bold uppercase tracking-[0.14em] text-[color:var(--dc-ink-38)]">
          Note - {company}
        </span>
      </div>
      <div className="text-[13px] leading-relaxed text-[color:var(--dc-ink-70)]">{text}</div>
    </div>
  );
}

/** A hairline-divided section on the paper slip: one top divider + vertical rhythm. */
function Sec({ children }: { children: React.ReactNode }) {
  return <div className="border-t border-[color:var(--dc-hairline)] py-3">{children}</div>;
}

/** The torn top edge of the paper slip (prototype `.tear`). */
function TearTop() {
  return (
    <svg className="dc-tear" viewBox="0 0 160 10" preserveAspectRatio="none" aria-hidden="true">
      <path
        fill="#FFFFFF"
        d="M0 10 L5 3 L10 10 L15 1.5 L20 10 L25 4 L30 10 L35 2 L40 10 L45 5 L50 10 L55 2.5 L60 10 L65 1 L70 10 L75 3.5 L80 10 L85 2 L90 10 L95 4.5 L100 10 L105 1.5 L110 10 L115 3 L120 10 L125 5 L130 10 L135 2 L140 10 L145 3.5 L150 10 L155 1 L160 10 Z"
      />
    </svg>
  );
}

/** The torn bottom edge of the paper slip (prototype `.tear`, bottom fill). */
function TearBottom() {
  return (
    <svg className="dc-tear" viewBox="0 0 160 10" preserveAspectRatio="none" aria-hidden="true">
      <path
        fill="#FFF9FA"
        d="M0 0 L5 7 L10 0 L15 8.5 L20 0 L25 6 L30 0 L35 8 L40 0 L45 5 L50 0 L55 7.5 L60 0 L65 9 L70 0 L75 6.5 L80 0 L85 8 L90 0 L95 5.5 L100 0 L105 8.5 L110 0 L115 7 L120 0 L125 5 L130 0 L135 8 L140 0 L145 6.5 L150 0 L155 9 L160 0 Z"
      />
    </svg>
  );
}

export function CardFront({
  data,
  things = [],
  workspaceId,
  editMode = false,
  onActivity,
  onClose,
  people = [],
  viewerPersonId,
  viewerCompanyId,
  createMode = false,
  onCreate,
  onCloseCreate,
  registerCloseRequest,
  onExitEdit,
  registerExitRequest,
}: {
  data: DealCardView;
  /** the flat Open Items list (D-15); wired from the panel host / 07-08. */
  things?: ThingView[];
  /** the deal_workspace_id - lets Open Items inline-add (createThing). */
  workspaceId?: string | null;
  /** both companies' deal members - Open Items' assignable people (@mention/assign). */
  people?: MemberView[];
  /** the viewer's person id - marks "You" + enables assigning in Open Items. */
  viewerPersonId?: string | null;
  /** the viewer's company id - Open Items' private ownership + filter. */
  viewerCompanyId?: string | null;
  /** whether the whole card is in inline row-edit mode (D-16); owned by DealCard. */
  editMode?: boolean;
  /** flip to the Signals & Logs back face - the title-bar "Activity" control.
   *  Owned by DealCard (which holds the flip state); the pill hides when absent. */
  onActivity?: () => void;
  /** close the whole card panel - the title-bar X (from the panel host). Absent =
   *  no X (e.g. the workspace/inline mounts that have no panel to close). */
  onClose?: () => void;
  /**
   * CREATE MODE (chj/07-08, reshaped Phase-12 D-12/D-13): the card is a NOT-yet-
   * born draft. Edit mode is forced on, the id-bound sections (promotion / Things
   * to do / margin) are hidden, and the footer becomes "Save draft" instead of
   * "Send change". Pressing it hands the assembled draft up via `onCreate`; the
   * host runs `createDeal` (birth only - NO delivery) and keeps the born 'unsent'
   * card open, where the DecisionBar owns the one "Send deal" button. This
   * replaced the old CreateDealForm.
   */
  createMode?: boolean;
  onCreate?: (input: CardCreateInput) => Promise<void>;
  /**
   * CREATE MODE close (D-13): called INSTEAD of onClose when the user dismisses
   * the not-yet-born draft (X / Cancel). Hands up the assembled draft when the
   * form has content (the host births it silently - never lose work), or null
   * when the card is empty (discard - the locked C5 rule). Absent -> plain onClose.
   */
  onCloseCreate?: (input: CardCreateInput | null) => void;
  /**
   * CREATE MODE: the card registers its D-13 close rule here so the HOST can
   * route its own dismiss doors (Escape, opening another card) through the same
   * content-check - mirrors registerExitRequest's ref pattern.
   */
  registerCloseRequest?: (fn: () => void) => void;
  /** leave edit mode - called after a successful "Send changes" so the diff shows.
   *  Owned by DealCard (which holds editMode). */
  onExitEdit?: () => void;
  /**
   * DealCard registers its header-✓ here (2026-07-22): the ✓ must SEND unsent
   * edits (doSendChange fromExit) instead of silently discarding them — the
   * card owns the send logic, the shell owns the button.
   */
  registerExitRequest?: (fn: () => void) => void;
}) {
  const { card, sellerName, buyerName, lineItems, lineMargins, viewerSide, myNote, theirNote } = data;
  const cardId = card.id;
  const isSeller = viewerSide === "seller";

  const meta = (card.metadata ?? {}) as Record<string, unknown>;
  const freeDeliveryStored = meta.free_delivery === true;
  const hsNumber =
    card.hs_deal_number ?? `HS-${card.id.replace(/-/g, "").slice(-4).toUpperCase()}`;

  const myCompanyName = isSeller ? sellerName : buyerName;
  const theirCompanyName = isSeller ? buyerName : sellerName;
  const avgMargin = averageMarginOf(lineMargins.map((m) => m.marginPercent));

  /* ---- promotion (independent yellow track, D-21/D-26) ---- */
  const [promotion, setPromotion] = useState<PromotionView | null>(null);
  useEffect(() => {
    if (createMode) return; // no born card yet - nothing to load / listen for
    let alive = true;
    const load = () => {
      void getPromotion(cardId)
        .then((p) => {
          if (alive) setPromotion(p);
        })
        .catch(() => {});
    };
    load();
    const onUpdated = (e: Event) => {
      const id = (e as CustomEvent<{ dealCardId?: string }>).detail?.dealCardId;
      if (!id || id === cardId) load();
    };
    window.addEventListener("hs:deal-updated", onUpdated);
    return () => {
      alive = false;
      window.removeEventListener("hs:deal-updated", onUpdated);
    };
  }, [cardId, createMode]);

  /* ---- inline edit state (D-16), seeded the moment edit mode turns on ---- */
  const [lines, setLines] = useState<EditLine[]>([]);
  // which product row is expanded for editing (per-row edit, chj/07-08); null = none.
  const [editRowKey, setEditRowKey] = useState<string | null>(null);
  const [editFreeDelivery, setEditFreeDelivery] = useState(false);
  const [editDueDate, setEditDueDate] = useState("");
  // deal expiry (chj/07-08, FRONTEND-ONLY mock - no backend field yet).
  const [editExpiry, setEditExpiry] = useState("");
  const [editPaymentCode, setEditPaymentCode] = useState("");
  const [editNote, setEditNote] = useState("");
  const [sendBusy, setSendBusy] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);

  // Seed the working copy from the SERVER card (chj/07-08) - the "adjust state when
  // a prop changes" render pattern (no effect, no ref). The card renders from this
  // local copy in both read and edit; the read view mirrors the server, and edits
  // are staged here until the ✓ commits them via proposeDealChange.
  //
  // Reseed key = a signature of the SERVER data (status + held-change id + line
  // shape), NOT just the card id, so the read view follows the server after a
  // change commits or is declined. Gated on `!editMode` so a live edit (or a
  // realtime change mid-edit) never clobbers what the user is typing; create mode
  // seeds once (its empty draft never changes server-side).
  // C3: the sig folds in the held draft's LINE SHAPE (not just version+summary),
  // so a proposer's re-proposed change (same summary, changed quantities/price)
  // still re-seeds the working copy from the fresh held draft on re-entry.
  const changeSig = data.pendingChange
    ? `${data.pendingChange.baseVersion}:${data.pendingChange.summary}:` +
      data.pendingChange.lines
        .map((l) => `${l.productId ?? l.name}:${l.quantity}:${l.unit}:${l.unitPrice}`)
        .join(",")
    : "";
  const dataSig = createMode
    ? "new"
    : `${cardId}|${card.status}|${changeSig}|` +
      lineItems
        .map((li) => `${li.productId ?? li.productName}:${li.quantity}:${li.unit}:${li.unitPrice}`)
        .join(",");
  const [seededFor, setSeededFor] = useState<string | null>(null);
  if (seededFor !== dataSig && (createMode || !editMode)) {
    setSeededFor(dataSig);
    // C3: a proposer editing their OWN held change seeds from the held draft, so
    // re-editing one line keeps the other lines they proposed (see seedLinesFromHeld).
    setLines(data.pendingChange?.iProposed ? seedLinesFromHeld(data) : seedLines(data));
    setEditRowKey(null);
    setEditFreeDelivery(freeDeliveryStored);
    setEditDueDate(card.delivery_date_target ? card.delivery_date_target.slice(0, 10) : "");
    setEditExpiry(typeof meta.deal_expiry === "string" ? meta.deal_expiry : "");
    setEditPaymentCode(card.payment_terms_code ?? "");
    setEditNote(myNote ?? "");
    setSendError(null);
  }

  /* ---- catalogue for add-from-shop / swap (seller-only, D-12) ---- */
  const [catalog, setCatalog] = useState<CatalogProduct[]>([]);
  useEffect(() => {
    if (!editMode || !isSeller) return;
    let alive = true;
    void getOwnCatalog()
      .then((c) => {
        if (alive) setCatalog(c);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [editMode, isSeller]);

  function updateLine(key: string, patch: Partial<EditLine>) {
    setLines((cur) => cur.map((l) => (l.key === key ? { ...l, ...patch } : l)));
  }
  // step the (mock) pack count, floored at 1.
  function bumpUnits(key: string, delta: number) {
    setLines((cur) =>
      cur.map((l) => (l.key === key ? { ...l, units: Math.max(1, l.units + delta) } : l)),
    );
  }
  function removeLine(key: string) {
    setLines((cur) => cur.filter((l) => l.key !== key));
    setEditRowKey((k) => (k === key ? null : k));
  }
  function lineFromCatalog(p: CatalogProduct): EditLine {
    // T07 (EARS 1): a catalog add lands already priced at its seed quantity -
    // one pack at units = 1, resolved against the product's tier ladder.
    const seedQty = p.packSizeGrams ?? 1;
    return {
      key: crypto.randomUUID(),
      lineItemId: null,
      productId: p.id,
      productName: p.name,
      quantity: seedQty,
      unit: p.unit,
      units: 1,
      tiers: p.tiers,
      basePricePerGram: p.unitPrice,
      unitPrice:
        resolveTierPrice(p.unitPrice, p.tiers, seedQty, p.unit).pricePerGram ??
        p.unitPrice,
      currency: p.currency,
      cultivar: p.cultivar,
      pzn: p.pzn,
      batchId: null,
      batchNumber: null,
      thcPercent: p.thcPercent,
      cbdPercent: p.cbdPercent,
      ownInput: null,
    };
  }
  function addFromCatalog(productId: string) {
    const p = catalog.find((c) => c.id === productId);
    if (p) {
      const line = lineFromCatalog(p);
      setLines((cur) => [...cur, line]);
      setEditRowKey(line.key); // a fresh product lands straight in row-edit
    }
  }
  // D-12: swapping a product resets the line's other values (remove-old + add-new
  // fresh) - a NEW line with no carried lineItemId / private input.
  function swapProduct(key: string, productId: string) {
    const p = catalog.find((c) => c.id === productId);
    if (!p) return;
    setLines((cur) => cur.map((l) => (l.key === key ? { ...lineFromCatalog(p), key } : l)));
  }

  // CREATE MODE (chj/07-08, D-13): "Save draft" on a not-yet-born draft. Same
  // line mapping as doSendChange, but it hands the draft UP via onCreate (the
  // host runs createDeal + keeps the born 'unsent' card open) instead of
  // proposeDealChange. Birth only - no delivery; sending is the born card's
  // DecisionBar "Send deal" button (D-12). No change reason - a first draft is
  // not a negotiation.
  // the assembled CardCreateInput from the working form state - used by the
  // Save-draft button AND the auto-save-on-close path (D-13).
  function assembleCreateInput(): CardCreateInput {
    return {
      lines: lines.map(toDraftLine),
      freeDelivery: editFreeDelivery,
      dueDate: editDueDate || null,
      paymentTermsCode: editPaymentCode || null,
      note: editNote || null,
    };
  }

  // D-13 'has content': anything the birth would PERSIST - at least one line
  // item, a note, a due date, payment terms, or free delivery flipped on. The
  // expiry field is a frontend-only mock (never persisted) and does NOT count -
  // birthing on it alone would save an empty card.
  const hasCreateContent =
    lines.length > 0 ||
    !!(editNote && editNote.trim()) ||
    !!editDueDate ||
    !!editPaymentCode ||
    editFreeDelivery;

  // D-13 close rule (create mode): closing WITH content hands the draft up for a
  // silent auto-birth (never lose work); an EMPTY card discards (locked C5 rule).
  // The host owns the actual birth + panel close via onCloseCreate.
  function requestCloseCreate() {
    if (!onCloseCreate) {
      onClose?.();
      return;
    }
    onCloseCreate(hasCreateContent ? assembleCreateInput() : null);
  }

  // hand the HOST the same close rule for its own dismiss doors (Escape /
  // opening another card) - a fresh closure every render so it always sees the
  // latest form state, mirroring registerExitRequest below.
  useEffect(() => {
    if (createMode) registerCloseRequest?.(() => requestCloseCreate());
  });

  async function onSendCreate() {
    if (sendBusy || !onCreate || lines.length === 0) return;
    setSendBusy(true);
    setSendError(null);
    try {
      await onCreate(assembleCreateInput());
      // the host swaps this create panel for the born 'unsent' card on success.
    } catch (e) {
      setSendError(e instanceof Error ? e.message : "Could not create the deal.");
    } finally {
      setSendBusy(false);
    }
  }

  // COMMIT AN EDIT (chj/07-08): if the SHARED payload actually changed vs the
  // server, stage it as a negotiation change via proposeDealChange (auto reason -
  // no permission modal, matching the direct-edit intent). The OTHER side then
  // sees the red/green diff + DecisionBar. Reached two ways (2026-07-22 — this
  // restores the header-✓ intent that had drifted into a silent discard):
  //   - the footer "Send changes" button (fromExit absent): a no-op shows the
  //     "Nothing to send yet" hint, so the button never fails silently;
  //   - the header ✓ via registerExitRequest (fromExit): a no-op simply leaves
  //     edit mode; a real change is SENT (never dropped) — on failure the card
  //     STAYS in edit mode with the error, so unsent work is never lost.
  // CR-02: after update_deal_draft DELETE+reinserts the draft's lines, its ON
  // DELETE CASCADE drops the per-line margin rows (deal_line_item_private). Re-
  // write the viewer's OWN per-line margin exactly as createDeal re-writes it
  // after birth: read the new line ids back (sort_order = input index) and upsert
  // by (deal_line_item_id, company_id). Owner-only RLS (dli_private_all)
  // authorizes the browser client to write its OWN company's rows; the company is
  // the viewer's own side (never shared input), so no seller/buyer leak.
  async function rewriteDraftLinePrivate() {
    if (!lines.some((l) => l.ownInput != null)) return;
    const companyId = viewerCompanyId ?? (isSeller ? data.sellerCompanyId : null);
    if (!companyId) return;
    const supabase = createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return;
    const { data: bornLines } = await supabase
      .from("deal_line_item")
      .select("id, sort_order")
      .eq("deal_card_id", cardId)
      .eq("version", card.version);
    const idBySort = new Map((bornLines ?? []).map((r) => [r.sort_order, r.id]));
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i];
      if (l.ownInput == null) continue;
      const lineId = idBySort.get(i);
      if (!lineId) continue;
      await supabase.from("deal_line_item_private").upsert(
        {
          deal_line_item_id: lineId,
          company_id: companyId,
          seller_margin: isSeller ? l.ownInput : null,
          buyer_metric: isSeller ? null : l.ownInput,
          created_by: user.id,
        },
        { onConflict: "deal_line_item_id,company_id" },
      );
    }
  }

  async function doSendChange(opts?: { fromExit?: boolean; linesOverride?: EditLine[] }) {
    // T07: the tier hint applies a price and sends in ONE click - setLines has
    // not re-rendered yet, so the click passes the fresh copy as linesOverride
    // (the stale-state trap). Every `lines` read below goes through `effective`;
    // rewriteDraftLinePrivate deliberately stays on `lines` (it reads index +
    // ownInput only, both identical across the override).
    const effective = opts?.linesOverride ?? lines;
    if (createMode || cardId === "new" || sendBusy || effective.length === 0) return;

    // Which commit path this Send takes (Region C, draftEdit): an 'unsent' draft
    // edits IN PLACE (updateDealDraft); a live deal with no held change proposes;
    // my OWN held change is REPLACED (withdraw + re-propose); the OTHER side's
    // held change BLOCKS editing.
    const path = resendAction(
      card.status,
      data.pendingChange,
      data.pendingChange?.iProposed ?? false,
    );

    // BLOCKED: the other side holds the change - the proposer cannot edit it.
    // (canProposerEdit already hides the pencil across mounts; this is the
    // belt-and-braces half in case a stale mount reaches here.)
    if (path === "blocked") {
      setSendError(
        "The other side proposed this change - you cannot edit it. Sign, Negotiate, or wait.",
      );
      return;
    }

    // change detection vs the server card. `units` is a frontend-only mock and never
    // enters the payload, so a units-only bump correctly does NOT propose.
    const norm = (s: string | null) => (s && s.trim() ? s.trim() : null);
    const shape = (key: string, q: number, u: string, p: number | null) =>
      `${key}|${q}|${u}|${p ?? ""}`;
    const workingLines = effective
      .map((l) => shape(l.productId ?? l.productName.toLowerCase().trim(), l.quantity, l.unit, l.unitPrice))
      .sort()
      .join(",");
    const serverLines = lineItems
      .map((li) => shape(li.productId ?? li.productName.toLowerCase().trim(), li.quantity, li.unit, li.unitPrice))
      .sort()
      .join(",");
    const workingTerms = [editFreeDelivery, norm(editDueDate), norm(editPaymentCode), norm(editNote)].join("|");
    const serverTerms = [
      freeDeliveryStored,
      card.delivery_date_target ? card.delivery_date_target.slice(0, 10) : null,
      norm(card.payment_terms_code ?? null),
      norm(myNote ?? null),
    ].join("|");
    if (workingLines === serverLines && workingTerms === serverTerms) {
      if (opts?.fromExit) {
        // exiting with nothing changed - a plain, safe close of edit mode
        onExitEdit?.();
        return;
      }
      // nothing SHARED changed - the most common cause is a units-only bump (a local
      // preview). Tell the user rather than failing silently.
      setSendError(
        "Nothing to send yet - the pack count is a local preview. Change the unit size, price or a condition first.",
      );
      return;
    }

    // the propose/replace payload - the SAME shared shape create/edit hand off
    // (lines + the 4 terms + the auto reason). update_deal_draft takes the same
    // shape minus the reason (a draft edit is not a negotiation).
    const proposePayload = {
      dealCardId: cardId,
      lines: effective.map(toDraftLine),
      freeDelivery: editFreeDelivery,
      dueDate: editDueDate || null,
      paymentTermsCode: editPaymentCode || null,
      note: editNote || null,
      reason: "Updated the deal on the card",
    };

    setSendBusy(true);
    setSendError(null);
    try {
      if (path === "draft-update") {
        // CR-02: edit the private 'unsent' draft in place, then re-write the
        // per-line margin the RPC's CASCADE dropped.
        await updateDealDraft({
          dealCardId: cardId,
          lines: proposePayload.lines,
          freeDelivery: proposePayload.freeDelivery,
          dueDate: proposePayload.dueDate,
          paymentTermsCode: proposePayload.paymentTermsCode,
          note: proposePayload.note,
        });
        await rewriteDraftLinePrivate();
      } else if (path === "replace") {
        // my OWN held change: withdraw it, then re-propose the working copy
        // (Negotiate never discards - the proposer takes their own change back
        // explicitly). On a HALF-failure (withdraw ok, propose fails) the old
        // proposal is gone, so ask for a re-send rather than losing it silently.
        await withdrawDealChange({ dealCardId: cardId });
        try {
          await proposeDealChange(proposePayload);
        } catch {
          setSendError("Your previous proposal was withdrawn - please re-send.");
          return;
        }
      } else {
        // "propose" - stage a new held change (the existing path, verbatim).
        await proposeDealChange(proposePayload);
      }
      window.dispatchEvent(
        new CustomEvent("hs:deal-updated", { detail: { dealCardId: cardId } }),
      );
      // leave edit mode so the read view + red/green diff show (the send succeeded).
      onExitEdit?.();
    } catch (e) {
      setSendError(e instanceof Error ? e.message : "Could not send the change.");
    } finally {
      setSendBusy(false);
    }
  }

  // When edit mode turns OFF, drop any UNSENT local edits so the read view always
  // matches the server (= exactly what the other side sees). Sending is an explicit
  // "Send changes" button (below); resetting seededFor re-runs the render-time reseed
  // from the server card. This runs whether the user sent (already reseeds from the
  // fresh data) or abandoned the edit.
  const prevEditRef = useRef(editMode);
  useEffect(() => {
    const was = prevEditRef.current;
    prevEditRef.current = editMode;
    if (was && !editMode) setSeededFor(null);
  }, [editMode]);

  // hand the shell's header-✓ the send-then-exit behaviour (fresh closure every
  // render so it always sees the latest edit state; a ref write is cheap).
  useEffect(() => {
    registerExitRequest?.(() => void doSendChange({ fromExit: true }));
  });

  /* ---- toolbar actions ---- */
  function onTalkAboutDeal() {
    // opens the messaging GroupPicker in deal mode (07-05) - window-event contract
    // keeps deals <-> messaging acyclic.
    window.dispatchEvent(new CustomEvent("hs:new-group", { detail: { dealCardId: cardId } }));
  }

  // CARD-01: the deal value is SUMMED live from the (working-copy) priced lines x
  // the mock pack count - reflects edits directly. null = no priced line -> "—".
  const editTotal = editTotalOf(lines);
  const valueNet = editTotal == null ? "—" : formatMoney(editTotal, card.currency);
  const canEditConditions = isSeller; // D-13: extra conditions are seller-only
  const conditionRewards = promotion?.conditionDeltas ?? [];

  return (
    <div className="dealcard flex h-full w-full max-w-full flex-col">
      {/* ---- 1 · TITLE BAR - frosted control strip. The flip + edit/lock circles
             (DealCard) float into the pl-12 / pr-12 gutters, so they read as the
             left-most and right-most controls of this bar. First flex child of the
             D1 shell, so it stays PINNED while the paper scrolls. ---- */}
      <div className="dc-titlebar flex items-center gap-2 py-2.5 pl-12 pr-12">
        {/* close the panel - lives ON the title bar now (no separate strip above),
            so the X shares this line instead of costing its own row. In create
            mode it routes through the D-13 close rule (auto-save with content,
            discard when empty) instead of a plain close. */}
        {onClose && (
          <button
            type="button"
            onClick={createMode ? requestCloseCreate : onClose}
            aria-label="Close deal card"
            title="Close"
            className="dc-tb-btn grid h-[30px] w-[30px] shrink-0 place-items-center rounded-full"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        )}
        {/* pre-birth (create mode) the deal has no real id yet — a group chat
            can't attach to it and there are no logs, so both toolbar actions
            only render once the card is born */}
        {!createMode && (
          <button
            type="button"
            onClick={onTalkAboutDeal}
            className="dc-tb-pill inline-flex min-w-0 items-center gap-1.5 rounded-full px-3 py-1.5 text-[12px] font-semibold"
          >
            <MessageSquarePlus className="h-3.5 w-3.5 shrink-0" />
            <span className="truncate">Talk about this deal</span>
          </button>
        )}
        {!createMode && onActivity && (
          <button
            type="button"
            onClick={onActivity}
            title="Activity — signals & logs"
            aria-label="Activity"
            className="dc-tb-btn grid h-[30px] w-[30px] shrink-0 place-items-center rounded-full"
          >
            <History className="h-3.5 w-3.5" />
          </button>
        )}
        <div className="flex-1" />
        {/* reopen moved to the single bottom decision bar ("Open a ticket", chj/07-08) */}
      </div>

      {/* ---- SCROLL REGION (D1, Wave 1): the ONLY scrolling part of the card.
             It holds the torn paper slip; the titlebar above and the decision
             zone below are flex siblings, so they stay pinned. ---- */}
      <div className="min-h-0 flex-1 overflow-y-auto">
      {/* B1: the "In negotiation" strip pins to the TOP of the scroll region while
             a change is held on a live deal (renders null otherwise). */}
      <NegotiationStrip status={card.status} hasHeldChange={!!data.pendingChange} />
      {/* ---- The torn white paper slip: it holds parts 2–7 (the deal facts). ---- */}
      <div className="dc-paper-wrap mx-3.5 mb-4 mt-3">
        <TearTop />
        <div className="dc-paper px-5 pb-4">
          {/* ---- 2 · MASTHEAD (fixed; finished-deal skin removed, D-17) ---- */}
          <header className="flex flex-wrap items-start justify-between gap-x-3 gap-y-1 pb-2 pt-3.5">
            <div className="dc-wordmark text-[16px] leading-tight">He//oSe//o</div>
            <div className="text-right">
              <div className="truncate font-mono text-[10.5px] tracking-wide text-[color:var(--dc-ink-70)]">
                {hsNumber}
              </div>
              <div className="mt-0.5 flex items-center justify-end gap-1.5 text-[10px] text-[color:var(--dc-ink-55)]">
                <span>{dateLabel(card.created_at)}</span>
              </div>
            </div>
          </header>
          <div className="dc-double-rule" />

          {/* ---- 3 · PARTIES (fixed) - seller pinned to the LEFT end, buyer to the
                 RIGHT end of the paper, arrow between, so the two sides read as
                 clearly opposite ends (feedback: two different ends). ---- */}
          <div className="flex items-baseline justify-between gap-3 py-3">
            <div className="flex min-w-0 items-baseline gap-1.5">
              <span className="shrink-0 text-[9px] font-bold uppercase tracking-[0.16em] text-[color:var(--dc-ink-38)]">
                Seller
              </span>
              <span className="truncate text-[13.5px] font-bold text-[color:var(--dc-ink)]">
                {sellerName}
              </span>
              {isSeller && (
                <span className="shrink-0 text-[11px] font-semibold text-[color:var(--dc-pink)]">
                  · You
                </span>
              )}
            </div>
            <ArrowRight
              className="h-3.5 w-3.5 shrink-0 self-center text-[color:var(--dc-pink)]"
              strokeWidth={2.2}
            />
            <div className="flex min-w-0 items-baseline justify-end gap-1.5 text-right">
              <span className="shrink-0 text-[9px] font-bold uppercase tracking-[0.16em] text-[color:var(--dc-ink-38)]">
                Buyer
              </span>
              <span className="truncate text-[13.5px] font-bold text-[color:var(--dc-ink)]">
                {buyerName}
              </span>
              {viewerSide === "buyer" && (
                <span className="shrink-0 text-[11px] font-semibold text-[color:var(--dc-pink)]">
                  · You
                </span>
              )}
            </div>
          </div>

          {/* ---- 4 · PRODUCTS ---- */}
          <section className="border-t border-[color:var(--dc-hairline)] pb-1 pt-2">
            <div className="flex flex-col gap-2">
                {/* ONE table for read + edit (chj/07-08). In edit mode every row gets
                    an Edit + Delete button and the open row (editRowKey) turns editable
                    with a checkmark; edits apply DIRECTLY (no send, no permission).
                    Role-gated: the buyer edits unit size + units only; batch + price
                    stay locked. */}
                <div className="overflow-x-auto">
                  <table className="w-full border-collapse text-[11px]">
                    <thead>
                      <tr className="text-[8.5px] font-bold uppercase tracking-[0.08em] text-[color:var(--dc-ink-38)]">
                        <th className="py-1 pr-1 text-left font-bold">Product</th>
                        <th className="py-1 pr-1 text-left font-bold">Batch</th>
                        <th className="py-1 pr-1 text-right font-bold">Unit size</th>
                        <th className="py-1 pr-1 text-right font-bold">Units</th>
                        <th className="py-1 pr-1 text-right font-bold">Price</th>
                        <th className="py-1 pr-1 text-right font-bold">Total</th>
                        {editMode && <th className="py-1" />}
                      </tr>
                    </thead>
                    <tbody>
                      {/* HELD CHANGE (read mode): the diff renders as a REDLINE
                          inside this table — struck red old row above the green
                          new row with a CHANGE tag (the chat-flipdoc prototype
                          pattern) — never as a separate boxed section. */}
                      {!editMode && data.pendingChange
                        ? pairDealDiff(lineItems, data.pendingChange.lines).flatMap((d) => {
                            const oldRow =
                              d.kind === "changed" || d.kind === "removed" ? (
                                <tr
                                  key={`${d.key}-old`}
                                  className="dc-row-old border-t border-ink/10 align-middle dc-text-red line-through"
                                >
                                  <td className="py-1.5 pr-1 font-semibold">{d.cur.productName}</td>
                                  <td className="py-1.5 pr-1 tabular-nums">{d.cur.batchNumber ?? "—"}</td>
                                  <td className="py-1.5 pr-1 text-right tabular-nums">
                                    {d.cur.quantity} {d.cur.unit}
                                  </td>
                                  <td className="py-1.5 pr-1 text-right tabular-nums">1</td>
                                  <td className="py-1.5 pr-1 text-right tabular-nums">
                                    {d.cur.unitPrice != null
                                      ? `${formatMoney(d.cur.unitPrice, d.cur.currency)}/${d.cur.unit}`
                                      : "—"}
                                  </td>
                                  <td className="py-1.5 pr-1 text-right font-mono tabular-nums">
                                    {d.cur.unitPrice != null
                                      ? formatMoney(lineValueOf(d.cur.quantity, d.cur.unit, d.cur.unitPrice) ?? 0, d.cur.currency)
                                      : "—"}
                                  </td>
                                </tr>
                              ) : null;
                            const next = d.kind === "changed" || d.kind === "added" || d.kind === "same" ? d.next : null;
                            const newTotal = next ? proposedLineTotal(next) : null;
                            const newRow =
                              next && d.kind !== "same" ? (
                                <tr
                                  key={`${d.key}-new`}
                                  className="dc-row-new border-t border-ink/10 align-middle font-semibold dc-text-green"
                                >
                                  <td className="py-1.5 pr-1">
                                    {next.name}
                                    <span className="dc-badge-change ml-2 inline-block rounded-md px-1.5 py-0.5 align-[1px] text-[8px] font-extrabold uppercase">
                                      CHANGE
                                    </span>
                                  </td>
                                  <td className="py-1.5 pr-1 tabular-nums">
                                    {(d.kind === "changed" ? d.cur.batchNumber : null) ?? "—"}
                                  </td>
                                  <td className="py-1.5 pr-1 text-right tabular-nums">
                                    {next.quantity} {next.unit}
                                  </td>
                                  <td className="py-1.5 pr-1 text-right tabular-nums">1</td>
                                  <td className="py-1.5 pr-1 text-right tabular-nums">
                                    {next.unitPrice != null
                                      ? `${formatMoney(next.unitPrice, next.currency)}/${next.unit}`
                                      : "—"}
                                  </td>
                                  <td className="py-1.5 pr-1 text-right font-mono tabular-nums">
                                    {newTotal == null ? "—" : formatMoney(newTotal, next.currency)}
                                  </td>
                                </tr>
                              ) : null;
                            const sameRow =
                              d.kind === "same" ? (
                                <tr key={d.key} className="border-t border-ink/10 align-middle">
                                  <td className="py-1.5 pr-1 font-semibold text-ink">{d.cur.productName}</td>
                                  <td className="py-1.5 pr-1 tabular-nums text-ink/70">
                                    {d.cur.batchNumber ?? "—"}
                                  </td>
                                  <td className="py-1.5 pr-1 text-right tabular-nums text-ink/80">
                                    {d.cur.quantity} {d.cur.unit}
                                  </td>
                                  <td className="py-1.5 pr-1 text-right tabular-nums text-ink/80">1</td>
                                  <td className="py-1.5 pr-1 text-right tabular-nums text-ink/80">
                                    {d.cur.unitPrice != null
                                      ? `${formatMoney(d.cur.unitPrice, d.cur.currency)}/${d.cur.unit}`
                                      : "—"}
                                  </td>
                                  <td className="py-1.5 pr-1 text-right font-mono tabular-nums">
                                    {d.cur.unitPrice != null
                                      ? formatMoney(lineValueOf(d.cur.quantity, d.cur.unit, d.cur.unitPrice) ?? 0, d.cur.currency)
                                      : "—"}
                                  </td>
                                </tr>
                              ) : null;
                            return [oldRow, newRow, sameRow].filter(Boolean);
                          })
                        : lines.map((l) => {
                        const total = lineTotalOf(l);
                        const totalLabel = total == null ? "—" : formatMoney(total, l.currency);
                        const priceLabel =
                          l.unitPrice != null
                            ? `${formatMoney(l.unitPrice, l.currency)}/${l.unit}`
                            : "—";
                        // T07: live tier state, derived at RENDER (never stored,
                        // never touching unitPrice - seeded prices are the
                        // snapshot; only an explicit user action reprices).
                        // Seeded lines carry no ladder, so fall back to the
                        // catalog (fetched only when editMode && isSeller -
                        // buyer + read mode get no chip/hint, silently).
                        const cat =
                          editMode && isSeller
                            ? catalog.find((c) => c.id === l.productId)
                            : undefined;
                        const tierLadder = l.tiers.length > 0 ? l.tiers : cat?.tiers ?? [];
                        const tierBase = l.basePricePerGram ?? cat?.unitPrice ?? null;
                        const tierState =
                          tierBase != null && tierLadder.length > 0
                            ? tierStateFor(tierBase, tierLadder, l.unitPrice, l.quantity, l.unit, l.units)
                            : null;
                        // the applied-rung chip (seller edit view, open + closed
                        // rows - each render site guards isSeller, D-12): only an
                        // ON-LADDER price gets one - a negotiated off-ladder
                        // price shows no chip (never a "base price" mislabel).
                        const tierChip =
                          tierState?.matchesLadder ? (
                            tierState.appliedMin != null ? (
                              <span className="dc-badge-change ml-1.5 inline-block rounded-md px-1.5 py-0.5 text-[8px] font-extrabold">
                                from {tierState.appliedMin}g applied
                              </span>
                            ) : (
                              <span className="ml-1.5 inline-block rounded-md px-1.5 py-0.5 text-[8px] font-bold text-ink/45 ring-1 ring-black/10">
                                base price
                              </span>
                            )
                          ) : null;
                        if (editMode && editRowKey === l.key) {
                          /* ---- the OPEN, editable row ---- */
                          return (
                            <tr key={l.key} className="border-t border-ink/10 align-middle">
                              <td className="py-1.5 pr-1 font-semibold text-ink">
                                {isSeller && catalog.length > 0 ? (
                                  <select
                                    value={l.productId ?? ""}
                                    onChange={(e) => swapProduct(l.key, e.target.value)}
                                    className="min-w-0 max-w-[92px] rounded-md bg-white px-1 py-1 text-[11px] font-semibold text-ink ring-1 ring-black/10 focus:outline-none focus:ring-2 focus:ring-brand/30"
                                  >
                                    <option value={l.productId ?? ""}>{l.productName}</option>
                                    {catalog
                                      .filter((c) => c.id !== l.productId)
                                      .map((c) => (
                                        <option key={c.id} value={c.id}>
                                          {c.name}
                                        </option>
                                      ))}
                                  </select>
                                ) : (
                                  <span className="block max-w-[92px] truncate">{l.productName}</span>
                                )}
                              </td>
                              {/* batch: SELLER picks from the shop's lots (mock); BUYER locked */}
                              <td className="py-1.5 pr-1">
                                {isSeller ? (
                                  <select
                                    value={l.batchNumber ?? ""}
                                    onChange={(e) =>
                                      updateLine(l.key, { batchNumber: e.target.value || null })
                                    }
                                    className="rounded-md bg-white px-1 py-1 tabular-nums ring-1 ring-black/10 focus:outline-none focus:ring-2 focus:ring-brand/30"
                                  >
                                    <option value="">—</option>
                                    {Array.from(
                                      new Set([
                                        ...(l.batchNumber ? [l.batchNumber] : []),
                                        ...MOCK_BATCHES,
                                      ]),
                                    ).map((b) => (
                                      <option key={b} value={b}>
                                        {b}
                                      </option>
                                    ))}
                                  </select>
                                ) : (
                                  <span className="inline-flex items-center gap-1 tabular-nums text-ink/55">
                                    {l.batchNumber ?? "—"}
                                    <Lock className="h-3 w-3" />
                                  </span>
                                )}
                              </td>
                              {/* unit size: ONE dropdown of pack sizes (both sides edit) */}
                              <td className="py-1.5 pr-1 text-right">
                                <select
                                  value={l.quantity}
                                  onChange={(e) =>
                                    updateLine(l.key, { quantity: Number(e.target.value) })
                                  }
                                  className="rounded-md bg-white px-1 py-1 text-right tabular-nums ring-1 ring-black/10 focus:outline-none focus:ring-2 focus:ring-brand/30"
                                >
                                  {withCurrent(MOCK_SIZES, l.quantity).map((s) => (
                                    <option key={s} value={s}>
                                      {s} g
                                    </option>
                                  ))}
                                </select>
                              </td>
                              {/* units: stepper (both sides edit) */}
                              <td className="py-1.5 pr-1 text-right">
                                <span className="inline-flex items-center gap-1">
                                  <button
                                    type="button"
                                    onClick={() => bumpUnits(l.key, -1)}
                                    aria-label="Fewer units"
                                    className="grid h-4 w-4 place-items-center rounded-full bg-brand-soft/40 text-[11px] font-bold text-brand-deep transition hover:bg-brand-soft"
                                  >
                                    −
                                  </button>
                                  <b className="w-4 text-center tabular-nums">{l.units}</b>
                                  <button
                                    type="button"
                                    onClick={() => bumpUnits(l.key, 1)}
                                    aria-label="More units"
                                    className="grid h-4 w-4 place-items-center rounded-full bg-brand-soft/40 text-[11px] font-bold text-brand-deep transition hover:bg-brand-soft"
                                  >
                                    +
                                  </button>
                                </span>
                              </td>
                              {/* price: SELLER edits; BUYER locked */}
                              <td className="py-1.5 pr-1 text-right">
                                {isSeller ? (
                                  <>
                                    <span className="inline-flex items-center gap-0.5">
                                      <input
                                        type="number"
                                        min={0}
                                        step="0.01"
                                        value={l.unitPrice ?? ""}
                                        placeholder="0"
                                        onChange={(e) =>
                                          updateLine(l.key, {
                                            unitPrice:
                                              e.target.value === "" ? null : Number(e.target.value),
                                          })
                                        }
                                        className="w-12 rounded-md bg-white px-1 py-1 text-right tabular-nums ring-1 ring-black/10 focus:outline-none focus:ring-2 focus:ring-brand/30"
                                      />
                                      <span className="text-ink/45">€/{l.unit}</span>
                                    </span>
                                    {tierChip}
                                    {/* T07 tier hint (EARS 2): apply-and-send in ONE
                                        click, riding the existing propose/accept
                                        funnel via doSendChange - never a direct
                                        write. Gated on units === 1: `units` never
                                        enters the payload, so a bulk-resolved
                                        price would misprice a single-pack line. */}
                                    {l.units === 1 && tierState?.suggestedPricePerGram != null && (
                                      <button
                                        type="button"
                                        aria-label="Apply tier price"
                                        disabled={data.pendingChange != null}
                                        title={
                                          data.pendingChange != null
                                            ? "A change is already pending"
                                            : undefined
                                        }
                                        onClick={() => {
                                          const suggested = tierState.suggestedPricePerGram;
                                          const next = lines.map((x) =>
                                            x.key === l.key ? { ...x, unitPrice: suggested } : x,
                                          );
                                          setLines(next);
                                          void doSendChange({ linesOverride: next });
                                        }}
                                        className="mt-1 inline-flex items-center rounded-full bg-[color:var(--dc-green-soft)] px-2 py-0.5 text-[10px] font-bold dc-text-green ring-1 ring-[color:var(--dc-green)]/30 transition hover:bg-[color:var(--dc-green)]/20 disabled:cursor-not-allowed disabled:opacity-50"
                                      >
                                        Qualifies for {formatMoney(tierState.suggestedPricePerGram, l.currency)}/g — apply
                                      </button>
                                    )}
                                  </>
                                ) : (
                                  <span className="inline-flex items-center gap-1 tabular-nums text-ink/55">
                                    <Lock className="h-3 w-3" />
                                    {priceLabel}
                                  </span>
                                )}
                              </td>
                              <td className="py-1.5 pr-1 text-right font-mono tabular-nums">
                                {totalLabel}
                              </td>
                              <td className="py-1.5 text-right">
                                <button
                                  type="button"
                                  onClick={() => setEditRowKey(null)}
                                  title="Done with this row"
                                  aria-label="Done editing this line"
                                  className="grid h-6 w-6 place-items-center rounded-md text-brand-deep ring-1 ring-black/10 transition hover:bg-brand-soft/40"
                                >
                                  <Check className="h-3.5 w-3.5" />
                                </button>
                              </td>
                            </tr>
                          );
                        }
                        /* ---- a READ row: values (+ Edit / Delete only in edit mode) ---- */
                        return (
                          <tr key={l.key} className="border-t border-ink/10 align-middle">
                            <td className="py-1.5 pr-1 font-semibold text-ink">{l.productName}</td>
                            <td className="py-1.5 pr-1 tabular-nums text-ink/70">
                              {l.batchNumber ?? "—"}
                            </td>
                            <td className="py-1.5 pr-1 text-right tabular-nums text-ink/80">
                              {l.quantity} {l.unit}
                            </td>
                            <td className="py-1.5 pr-1 text-right tabular-nums text-ink/80">
                              {l.units}
                            </td>
                            <td className="py-1.5 pr-1 text-right tabular-nums text-ink/80">
                              {priceLabel}
                              {isSeller && tierChip}
                            </td>
                            <td className="py-1.5 pr-1 text-right font-mono tabular-nums">
                              {totalLabel}
                            </td>
                            {editMode && (
                              <td className="py-1.5 pl-1">
                                <div className="flex items-center justify-end gap-1">
                                  <button
                                    type="button"
                                    onClick={() => setEditRowKey(l.key)}
                                    title="Edit this line"
                                    aria-label="Edit this line"
                                    className="grid h-6 w-6 place-items-center rounded-md text-ink/45 ring-1 ring-black/10 transition hover:bg-black/5 hover:text-ink"
                                  >
                                    <Pencil className="h-3.5 w-3.5" />
                                  </button>
                                  <button
                                    type="button"
                                    onClick={() => removeLine(l.key)}
                                    title="Remove this product"
                                    aria-label="Remove this product"
                                    className="grid h-6 w-6 place-items-center rounded-md text-ink/45 ring-1 ring-black/10 transition hover:bg-black/5 hover:text-danger"
                                  >
                                    <Trash2 className="h-3.5 w-3.5" />
                                  </button>
                                </div>
                              </td>
                            )}
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>

                {/* add product - role-labeled (chj/07-08). Seller pulls from their own
                    shop (real catalogue); the buyer sees the seller's shared shop, a
                    frontend-only placeholder for today. */}
                {editMode &&
                  (isSeller ? (
                    catalog.length > 0 && (
                      <div className="flex items-center gap-2">
                        <Plus className="h-3.5 w-3.5 text-brand-deep" />
                        <select
                          value=""
                          onChange={(e) => e.target.value && addFromCatalog(e.target.value)}
                          className="flex-1 rounded-md bg-white px-2 py-1 text-[12px] text-ink/70 ring-1 ring-black/10 focus:outline-none focus:ring-2 focus:ring-brand/30"
                        >
                          <option value="">+ Add product from your shop…</option>
                          {catalog.map((c) => (
                            <option key={c.id} value={c.id}>
                              {c.name}
                            </option>
                          ))}
                        </select>
                      </div>
                    )
                  ) : (
                    <button
                      type="button"
                      disabled
                      title="Coming soon"
                      className="flex w-full items-center justify-center gap-1.5 rounded-lg border border-dashed border-brand/40 px-3 py-2 text-[12px] font-semibold text-brand-deep opacity-60"
                    >
                      <Plus className="h-3.5 w-3.5" /> Add product from the seller&apos;s shop (shared with you)
                    </button>
                  ))}
              </div>

            {/* the yellow promotion track (D-21..D-26) - never gates Sign */}
            {!editMode && promotion && (
              <div className="mt-3">
                <PromotionTrack promotion={promotion} dealCardId={cardId} dealStatus={card.status} />
              </div>
            )}

            {/* total net (CARD-01 live sum). With a HELD change it redlines like
                the prototype's totalrow: struck old · delta pill · big green new. */}
            {!editMode &&
              (() => {
                const held = data.pendingChange;
                const curTotal = held ? sumLineValue(lineItems) : null;
                const newTotal = held ? proposedLinesTotal(held.lines) : null;
                const delta = curTotal != null && newTotal != null ? newTotal - curTotal : null;
                return (
                  <div className="mt-3 flex items-baseline gap-3">
                    <span className="text-[10px] font-bold uppercase tracking-[0.16em] text-[color:var(--dc-ink-38)]">
                      Total net
                    </span>
                    {held ? (
                      <span className="ml-auto flex items-baseline gap-2.5">
                        {curTotal != null && delta !== 0 && (
                          <span className="font-mono text-[13px] line-through dc-text-red">
                            {formatMoney(curTotal, held.currency)}
                          </span>
                        )}
                        {delta != null && delta !== 0 && (
                          <span className="rounded-full bg-[color:var(--dc-green-soft)] px-2.5 py-0.5 font-mono text-[11px] font-bold text-ink ring-1 ring-[color:var(--dc-green)]/30">
                            {delta < 0 ? "−" : "+"}
                            {formatMoney(Math.abs(delta), held.currency)}
                          </span>
                        )}
                        <span className="text-[22px] font-extrabold leading-none tabular-nums tracking-tight dc-text-green">
                          {newTotal == null ? "—" : formatMoney(newTotal, held.currency)}
                        </span>
                      </span>
                    ) : (
                      <span className="ml-auto text-[22px] font-extrabold leading-none tabular-nums tracking-tight text-[color:var(--dc-ink)]">
                        {valueNet}
                      </span>
                    )}
                  </div>
                );
              })()}
          </section>

      {/* ---- 5 · EXTRA CONDITIONS (seller-only, Discounts its OWN section, D-13) ---- */}
      <Sec>
        <div className="mb-2 flex items-center gap-1.5">
          <span className="text-[10px] font-bold uppercase tracking-[0.16em] text-[color:var(--dc-ink-38)]">
            Extra conditions
          </span>
          {!canEditConditions && <Lock className="h-3 w-3 text-[color:var(--dc-ink-38)]" />}
        </div>
        {editMode && canEditConditions ? (
          <>
            <div className="grid grid-cols-3 gap-2 text-[12px]">
              <label className="flex flex-col gap-1">
                <span className="text-[10px] uppercase tracking-wide text-ink/45">Payment</span>
                <input
                  type="text"
                  value={editPaymentCode}
                  placeholder="e.g. net30"
                  onChange={(e) => setEditPaymentCode(e.target.value)}
                  className="rounded-md bg-white px-2 py-1 ring-1 ring-black/10 focus:outline-none focus:ring-2 focus:ring-brand/30"
                />
              </label>
              {/* deal expiry - FRONTEND-ONLY mock for today (chj/07-08) */}
              <label className="flex flex-col gap-1">
                <span className="text-[10px] uppercase tracking-wide text-ink/45">Deal expiry</span>
                <input
                  type="date"
                  value={editExpiry}
                  onChange={(e) => setEditExpiry(e.target.value)}
                  className="rounded-md bg-white px-2 py-1 ring-1 ring-black/10 focus:outline-none focus:ring-2 focus:ring-brand/30"
                />
              </label>
              <div className="flex flex-col gap-1">
                <span className="text-[10px] uppercase tracking-wide text-ink/45">Delivery</span>
                <label className="inline-flex items-center gap-1.5">
                  <input
                    type="checkbox"
                    checked={editFreeDelivery}
                    onChange={(e) => setEditFreeDelivery(e.target.checked)}
                    className="h-4 w-4 accent-brand"
                  />
                  <span className="text-[12px]">Free delivery</span>
                </label>
                {!editFreeDelivery && (
                  <input
                    type="date"
                    value={editDueDate}
                    onChange={(e) => setEditDueDate(e.target.value)}
                    className="rounded-md bg-white px-2 py-1 ring-1 ring-black/10 focus:outline-none focus:ring-2 focus:ring-brand/30"
                  />
                )}
              </div>
            </div>
            {/* discount + bundle: grayed for now (chj/07-08); wired in a later step */}
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <button
                type="button"
                disabled
                title="Coming soon"
                className="cursor-not-allowed rounded-full border border-dashed border-ink/25 px-3 py-1.5 text-[11px] font-semibold text-ink/40"
              >
                + Discount
              </button>
              <button
                type="button"
                disabled
                title="Coming soon"
                className="cursor-not-allowed rounded-full border border-dashed border-ink/25 px-3 py-1.5 text-[11px] font-semibold text-ink/40"
              >
                + Bundle deal
              </button>
            </div>
          </>
        ) : (
          <div className="grid grid-cols-3 gap-2">
            {/* read view from the working copy (chj/07-08) so seller edits stick */}
            <div className="dc-term rounded-2xl px-3 py-2.5">
              <div className="text-[9px] font-bold uppercase tracking-[0.13em] text-[color:var(--dc-ink-38)]">
                Payment
              </div>
              <div className="mt-0.5 text-[12.5px] font-semibold text-[color:var(--dc-ink)]">
                {editPaymentCode ? paymentTermLabel(editPaymentCode) : "—"}
              </div>
            </div>
            <div className="dc-term rounded-2xl px-3 py-2.5">
              <div className="text-[9px] font-bold uppercase tracking-[0.13em] text-[color:var(--dc-ink-38)]">
                Deal expiry
              </div>
              <div className="mt-0.5 text-[12.5px] font-semibold tabular-nums text-[color:var(--dc-ink)]">
                {editExpiry ? dateLabel(editExpiry) : "—"}
              </div>
            </div>
            <div className="dc-term rounded-2xl px-3 py-2.5">
              <div className="text-[9px] font-bold uppercase tracking-[0.13em] text-[color:var(--dc-ink-38)]">
                Delivery
              </div>
              <div className="mt-0.5 text-[12.5px] font-semibold tabular-nums text-[color:var(--dc-ink)]">
                {editFreeDelivery
                  ? "Free delivery"
                  : editDueDate
                    ? dateLabel(editDueDate)
                    : "—"}
              </div>
            </div>
          </div>
        )}

        {/* Discounts - its OWN labeled section (D-13); promotion non-product rewards
            render here, not in the product table (D-22). */}
        <div className="mt-3 border-t border-[color:var(--dc-hairline)] pt-2.5">
          <div className="mb-1 text-[9px] font-bold uppercase tracking-[0.16em] text-[color:var(--dc-ink-38)]">
            Discounts
          </div>
          {conditionRewards.length > 0 ? (
            <ul className="flex flex-col gap-0.5">
              {conditionRewards.map((c, i) => (
                <li key={i} className="text-[12px] font-semibold text-[color:var(--dc-promo)]">
                  {c.label}
                </li>
              ))}
            </ul>
          ) : (
            <div className="text-[12px] text-[color:var(--dc-ink-38)]">None</div>
          )}
        </div>
      </Sec>

      {/* ---- owner margin (private, "only you" - prototype .private-box) ----
             hidden ONLY in create mode: the margin rolls up from born line-private
             rows that do not exist yet. A born 'unsent' draft passes this gate
             (D-17) - the private rows exist from birth, no extra plumbing. */}
      {!createMode && (
        <Sec>
          <div className="dc-private flex items-center gap-2 rounded-2xl px-3 py-2.5 text-[12px]">
            <Lock className="h-[13px] w-[13px] text-[color:var(--dc-pink-deep)]" />
            <span className="text-[color:var(--dc-ink-55)]">Your avg. margin</span>
            <span className="ml-auto font-bold tabular-nums text-[color:var(--dc-pink-deep)]">
              {marginLabel(avgMargin)}
            </span>
            <span className="text-[9px] font-bold uppercase tracking-[0.12em] text-[color:var(--dc-maroon)]">
              Only you
            </span>
          </div>
        </Sec>
      )}

      {/* ---- 6 · "Things to do" (the user-facing name; the component stays
             OpenItems - flat, D-15) ---- hidden ONLY in create mode: the list
             lives on the deal_workspace that is born WITH the card, so a born
             'unsent' draft passes this gate too (D-17) - things created here
             default private and stay invisible to the counterparty until Send
             (RLS draft privacy). */}
      {!createMode && (
        <Sec>
          <OpenItems
            things={things}
            workspaceId={workspaceId}
            people={people}
            viewerPersonId={viewerPersonId}
            viewerCompanyId={viewerCompanyId ?? (isSeller ? data.sellerCompanyId : null)}
          />
        </Sec>
      )}

      {/* ---- 7 · NOTES (per-party, D-14) ---- */}
      {editMode ? (
        <Sec>
          <div className="mb-1 text-[10px] font-bold uppercase tracking-[0.16em] text-[color:var(--dc-ink-38)]">
            Your note
          </div>
          <textarea
            value={editNote}
            onChange={(e) => setEditNote(e.target.value)}
            rows={2}
            placeholder="A note the other side will see on your behalf…"
            className="w-full resize-none rounded-lg bg-white px-3 py-2 text-[12px] text-[color:var(--dc-ink)] ring-1 ring-black/5 placeholder:text-[color:var(--dc-ink-38)] focus:outline-none focus:ring-2 focus:ring-brand/30"
          />
          {/* the other side's note stays read-only; blank never shown (D-14) */}
          <Note company={theirCompanyName} text={theirNote} />
        </Sec>
      ) : (
        ((theirNote && theirNote.trim()) || (editNote && editNote.trim())) && (
          <Sec>
            <Note company={theirCompanyName} text={theirNote} />
            {/* own note from the working copy (chj/07-08) so the edit sticks */}
            <Note company={myCompanyName} text={editNote} />
          </Sec>
        )
      )}

        </div>
        <TearBottom />
      </div>
      {/* ---- /paper slip ---- */}
      </div>
      {/* ---- /scroll region (D1) ---- */}

      {/* ---- 8 · DECISION - the footer sitting on the glass, below the paper.
             A flex sibling AFTER the scroll region, so it stays PINNED (D1).
             It only appears when there is something to act on: a proposed change
             to send (edit mode) or a held change to Negotiate / Sign. ---- */}
      {editMode ? (
        createMode ? (
          /* CREATE MODE footer (chj/07-08, D-13): a brand-new draft is not a
             negotiation, so there is no change-reason box. "Save draft" hands the
             draft up + the host births it via createDeal - a private 'unsent'
             card; the born card's DecisionBar owns "Send deal" (D-12). */
          <div className="dc-decision px-4 pb-3.5 pt-3">
            <div className="mb-1 text-[10px] font-bold uppercase tracking-[0.16em] text-[color:var(--dc-ink-38)]">
              Save this draft
            </div>
            <p className="mb-2 text-[11px] text-[color:var(--dc-ink-55)]">
              Add your products, conditions and a note. Saving keeps it as a private
              draft - you send it from the card once it is ready.
            </p>
            {sendError && <p className="mt-1 text-[11px] text-danger">{sendError}</p>}
            <div className="mt-2 flex items-center justify-end gap-2">
              {/* Cancel = a close door too (D-13): with content it silently saves
                  the draft, empty it discards - never a lost card. */}
              <button
                type="button"
                onClick={requestCloseCreate}
                className="rounded-full px-3 py-1.5 text-[12px] font-semibold text-[color:var(--dc-ink-55)] ring-1 ring-black/10 transition hover:bg-black/5"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={sendBusy || lines.length === 0}
                onClick={() => void onSendCreate()}
                className="rounded-full bg-[color:var(--dc-pink)] px-4 py-1.5 text-[12px] font-bold text-white transition hover:bg-[color:var(--dc-pink-deep)] disabled:opacity-50"
              >
                {sendBusy ? "Saving…" : "Save draft"}
              </button>
            </div>
          </div>
        ) : (
          /* EDIT MODE, existing deal (chj/07-08): ONE explicit "Send changes" button.
             No reason box, no permission step - a single click stages the edits as a
             negotiation change; the other side then sees a red/green diff to sign.
             (Pinned by the flex shell since D1, Wave 1 - always on screen; the
             header ✓ sending unsent edits stays as belt-and-braces.) */
          <div className="dc-decision px-4 pb-3.5 pt-3">
            {sendError && <p className="mb-2 text-[11px] font-medium text-danger">{sendError}</p>}
            <button
              type="button"
              disabled={sendBusy}
              onClick={() => void doSendChange()}
              className="w-full rounded-full bg-[color:var(--dc-pink)] px-4 py-2.5 text-[13px] font-bold text-white transition hover:bg-[color:var(--dc-pink-deep)] disabled:opacity-50"
            >
              {sendBusy ? "Sending…" : `Send changes to ${theirCompanyName}`}
            </button>
            <p className="mt-1.5 text-center text-[10.5px] text-[color:var(--dc-ink-38)]">
              The other side sees a red/green diff and signs. Pack count is a preview only.
            </p>
          </div>
        )
      ) : (
        /* READ MODE (chj/07-08): the single bottom decision bar owns the whole
           lifecycle - Sign / Negotiate / Decline (draft), Upload invoice (seller,
           signed), Open a ticket (done). It decides what to show from the status. */
        <DecisionBar data={data} workspaceId={workspaceId} />
      )}
    </div>
  );
}
