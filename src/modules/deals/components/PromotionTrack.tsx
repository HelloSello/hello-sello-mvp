"use client";

/**
 * The yellow promotion track (07-07, PROMO-01, D-21..D-26) - the seller's
 * bundle offer as an INDEPENDENT decision, separate from the negotiation diff.
 *
 * Rendering rules (locked decisions):
 *   - D-21: product rewards are REAL product-line changes (shown here as line text).
 *   - D-22: non-product rewards (free delivery) render in Extra Conditions, NOT here
 *     (CardFront reads `promotion.conditionDeltas` for that section).
 *   - D-23: ONE button, initially labeled "Promotion". Clicking it reveals the
 *     reward on the card, then the same button relabels to Accept / Decline.
 *   - D-24: NO AI-narrated sentence - only the pure structural reward, nothing written.
 *   - D-25: savings are ONE small line of text ("You saved 240 € on this deal"),
 *     pre-computed on canonical money by getPromotion - no big value bubble.
 *   - D-26 (load-bearing): this NEVER gates Sign. There is no Sign control here and
 *     accept/decline touch only the promotion - the DecisionBar Sign stays enabled
 *     throughout (the prototype's Sign-gating is deliberately NOT built).
 *
 * The accept/decline handlers reuse the 07-06 engine (`acceptPromotion` /
 * `declinePromotion`) with the DealPin busy/try-catch/re-read + `hs:deal-updated`
 * pattern. Only the BUYER resolves it; the seller sees a waiting state.
 */
import { useState } from "react";
import { Sparkles } from "lucide-react";
import { acceptPromotion, declinePromotion } from "../actions";
import { formatMoney } from "../lib/derive";
import type { PromotionView } from "../types";

function savingsLine(savings: number, currency: string): string | null {
  if (savings <= 0) return null;
  return `You saved ${formatMoney(savings, currency)} on this deal`;
}

export function PromotionTrack({
  promotion,
  dealCardId,
  dealStatus,
}: {
  promotion: PromotionView;
  dealCardId: string;
  /**
   * HEL-83: the card's own lifecycle status. A promotion may only be ACCEPTED
   * while the deal is still `negotiation` — accepting inserts real
   * `deal_line_item` rows, and doing that on a `done` deal makes its lines
   * disagree with the invoice already issued against it. DECLINE stays
   * available in every status on purpose: it changes nothing on the deal, and
   * gating it would strand a pending promotion behind two refusing buttons
   * with no way to clear it.
   *
   * The server is the real gate (`offer_promotion` / `accept_promotion`); this
   * prop only keeps the UI from offering an action that would be refused.
   */
  dealStatus: string;
}) {
  const [revealed, setRevealed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const savings = savingsLine(promotion.savings, promotion.currency);

  // HEL-83, mirroring `accept_promotion`'s server gate exactly. Kept as one
  // named constant rather than inlined so the rule reads once and there is no
  // second place to forget it.
  const canAccept = dealStatus === "negotiation";

  function refresh() {
    window.dispatchEvent(
      new CustomEvent("hs:deal-updated", { detail: { dealCardId } }),
    );
  }

  async function run(kind: "accept" | "decline") {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      if (kind === "accept") await acceptPromotion({ dealCardId });
      else await declinePromotion({ dealCardId });
      refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong.");
    } finally {
      setBusy(false);
    }
  }

  // the yellow band (D-21) - a soft amber wash with the promo left-rail, distinct
  // from the pink card body. `dc-promo-band` carries the wash + 3px yellow rail.
  const shell =
    "dc-promo-band overflow-hidden rounded-lg px-3 py-2.5 text-[12px] text-[color:var(--dc-promo-ink)]";

  const rewardLines =
    promotion.lineDeltas.length > 0 ? (
      <ul className="mb-1.5 flex flex-col gap-1">
        {promotion.lineDeltas.map((d, i) => (
          <li key={i} className="flex items-baseline justify-between gap-3">
            <span className="min-w-0 flex-1 truncate font-medium text-[color:var(--dc-promo)]">
              +{d.quantity} {d.unit} {d.productName}
            </span>
            <span className="shrink-0 font-mono text-[11px] text-[color:var(--dc-promo)]">
              {d.unitPrice === 0 ? "free" : `${formatMoney(d.unitPrice, d.currency)}/${d.unit}`}
            </span>
          </li>
        ))}
      </ul>
    ) : null;

  const header = (
    <div className="mb-1.5 flex items-center gap-1.5">
      <Sparkles className="h-3.5 w-3.5 text-[color:var(--dc-promo-strong)]" strokeWidth={2} />
      <span className="text-[9.5px] font-extrabold uppercase tracking-[0.15em] text-[color:var(--dc-promo)]">
        Promotion
      </span>
    </div>
  );

  // already resolved - show the settled state (still visible, D-23 tail).
  if (promotion.state === "accepted") {
    return (
      <div className={shell}>
        {header}
        {rewardLines}
        <p className="font-semibold text-[color:var(--dc-promo)]">Promotion accepted.</p>
        {savings && <p className="text-[11px] text-[color:var(--dc-promo)]">{savings}</p>}
      </div>
    );
  }
  if (promotion.state === "declined") {
    return (
      <div className={`${shell} dc-declined`}>
        {header}
        <p className="text-[color:var(--dc-ink-55)]">
          Promotion declined - the base deal stands.
        </p>
      </div>
    );
  }

  // pending: the seller waits; the buyer gets the one-button flow (D-23).
  if (promotion.iOffered) {
    return (
      <div className={shell}>
        {header}
        {rewardLines}
        {savings && <p className="text-[11px] text-[color:var(--dc-promo)]">{savings}</p>}
        <p className="mt-1 text-[11px] text-[color:var(--dc-ink-55)]">
          Waiting for the buyer to decide.
        </p>
      </div>
    );
  }

  return (
    <div className={shell}>
      {header}
      {/* D-23: the reward is shown once revealed; the button relabels below. */}
      {revealed && rewardLines}
      {revealed && savings && (
        <p className="mb-1.5 text-[11px] text-[color:var(--dc-promo)]">{savings}</p>
      )}
      {error && <p className="mb-1.5 text-[11px] text-danger">{error}</p>}

      {!revealed ? (
        <button
          type="button"
          onClick={() => setRevealed(true)}
          className="dc-btn-promo w-full rounded-full px-3 py-1.5 text-[12px] font-bold"
        >
          Promotion
        </button>
      ) : (
        <div className="flex items-center gap-2">
          <button
            type="button"
            disabled={busy}
            onClick={() => void run("decline")}
            className="flex-1 rounded-full border-[1.5px] border-[color:var(--dc-promo-strong)] px-3 py-1.5 text-[12px] font-medium text-[color:var(--dc-promo)] transition hover:bg-[var(--dc-promo-soft)] disabled:opacity-50"
          >
            Decline
          </button>
          {/* HEL-83: Accept is REMOVED, not disabled, once the deal has left
              negotiation — the server refuses it, so rendering it would be a
              dead button. Decline stays beside this so the buyer can always
              clear the pending row. */}
          {canAccept ? (
            <button
              type="button"
              disabled={busy}
              onClick={() => void run("accept")}
              className="dc-btn-promo flex-1 rounded-full px-3 py-1.5 text-[12px] font-bold disabled:opacity-50"
            >
              {busy ? "Working…" : "Accept"}
            </button>
          ) : (
            <p className="flex-1 text-[11px] leading-snug text-[color:var(--dc-ink-55)]">
              This deal has moved on — the promotion can no longer be accepted.
            </p>
          )}
        </div>
      )}
    </div>
  );
}
