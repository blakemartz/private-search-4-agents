// ── schemas ─────────────────────────────────────────────────────────────────
//
// Descriptions are budgeted. Every word here is paid for in every agent's
// context on every turn, so each says what changes the caller's decision and
// nothing else. The rationale lives in the code comments, not the schema.
//
// The argument schemas and helpers more than one tool uses. Schemas only one
// tool takes live beside that tool.
import { z } from "zod";
import { getProfileNames } from "../../domains/rules.js";

/** A string-or-array argument as a list of trimmed, non-empty strings. */
export function toList(v: string | string[] | undefined): string[] {
  if (v === undefined) return [];
  return (Array.isArray(v) ? v : [v]).map((s) => s.trim()).filter(Boolean);
}

/** The message of a rejected fetch, for a per-page "Could not fetch" line. */
export const reasonOf = (s: PromiseRejectedResult) =>
  s.reason instanceof Error ? s.reason.message : String(s.reason);

/**
 * Advertised as an enum so an agent can see the valid names. Read once at
 * registration: a profile added to domains.json later still works when named,
 * it just is not advertised until the next session.
 */
export function domainProfileSchema() {
  const names = getProfileNames();
  const base =
    names.length > 0
      ? z.enum(names as [string, ...string[]])
      : z.string().max(0);
  return base
    .optional()
    .describe("Domain profile: boosts and blocks a set of sites");
}

/**
 * A boolean parameter that also accepts "true"/"false" strings, for clients
 * that stringify arguments. NOT z.coerce.boolean(): that is Boolean(value),
 * under which the string "false" is true — an agent asking for fresh: "false"
 * would get the cache bypassed, and answer: "false" a 60-second synthesis.
 */
export const BoolArg = z.preprocess(
  (v) => (v === "true" ? true : v === "false" ? false : v),
  z.boolean(),
);

export const FreshSchema = BoolArg.optional().describe(
  "Bypass the cache for this call (search 1h, pages 24h)",
);
