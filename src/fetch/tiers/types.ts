import type { TierSlot } from "../../core/types.js";
import type { TierName } from "../../domains/db.js";
import type { FetchTuning, TierResult } from "../utils.js";

/**
 * A single fetch tier in the cascade.
 *
 * `slot` maps to the TierSlot used for skip decisions (tier2/3).
 * `name` is the full observability label (tier2_crawl4ai, etc.).
 * `fetch` returns null on miss/error; the runTier wrapper handles
 * observability recording. `tuning` carries optional CSS-selector hints that
 * tiers honor where they can and ignore otherwise.
 */
export interface Tier {
  name: TierName;
  slot: TierSlot;
  fetch(
    url: string,
    maxChars: number,
    preferFit?: boolean,
    tuning?: FetchTuning,
  ): Promise<TierResult | null>;
}
