// Operator tools: clear_cache and domain_stats. Registered only with
// SEARXNG_MCP_ADMIN_TOOLS=true — see registerTools in index.ts.
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { cacheClear } from "../../core/cache.js";
import {
  getDomainRecord,
  TIER_SLOT_KEYS,
  type TierSlotKey,
} from "../../domains/db.js";
import {
  aggregateDomainStats,
  enumerateDomains,
  formatDomainAggregate,
  formatDomainRecord,
  summarizeDomainRecord,
} from "../../domains/stats.js";
import { instrumentTool } from "./instrument.js";

export async function handleClearCache({ target }: { target: string }) {
  return instrumentTool("clear_cache", async () => {
    let cleared = 0;
    if (target === "search" || target === "all") {
      cleared += await cacheClear("search:*");
    }
    if (target === "fetch" || target === "all") {
      cleared += await cacheClear("fetch:*");
    }
    if (target === "crawl" || target === "all") {
      cleared += await cacheClear("crawl:*");
    }
    return {
      content: [
        {
          type: "text" as const,
          text: `Cleared ${cleared} cache ${cleared === 1 ? "entry" : "entries"}.`,
        },
      ],
    };
  });
}

// ── domain_stats structured output ──────────────────────────────────────────
// Single Zod object covering both tool modes; the other mode's slot is null.
// The SDK validates returned `structuredContent` against this before it leaves
// the server and advertises the derived JSON Schema in tools/list.

const TierStatsOutputSchema = z.object({
  attempts: z.number(),
  ok: z.number(),
  fail: z.number(),
  success_rate: z.number().nullable(),
});

/**
 * The per-slot tier block, DERIVED from `TIER_SLOT_KEYS` rather than hand-listed.
 *
 * This is the fix for vikunja#637, and the derivation is the point of it. Both
 * payload builders (`aggregateDomainStats`, `summarizeDomainRecord`) already
 * emit their `tiers` object via `Object.fromEntries(TIER_SLOT_KEYS.map(...))`.
 * When this schema was a hand-written literal, the two lists were free to
 * diverge — and they did: v3.19.0 added a sixth slot (`solver`) to the constant
 * and the payload grew it, while the schema stayed at five. Zod emits
 * `additionalProperties: false`, so every `domain_stats` call on a
 * solver-enabled deployment failed structured-output validation outright.
 *
 * Deriving from the same constant makes that class of drift unrepresentable:
 * `TierSlotKey` is itself `(typeof TIER_SLOT_KEYS)[number]`, so the mapped type
 * below and the runtime keys have one source. Adding a slot to the constant
 * cannot leave this schema behind.
 *
 * Every slot is OPTIONAL, and that is deliberate rather than defensive. A slot
 * is only written once its tier has run: `tier4` requires `WAYBACK_ENABLED`,
 * `solver` requires `SOLVER_ENABLED`. Marking them required does not fix the
 * bug, it inverts which deployments it breaks — `tier4` carried this identical
 * defect latently for every deployment whose records predate Wayback.
 */
type AllTiersShape = {
  [K in TierSlotKey]: z.ZodOptional<typeof TierStatsOutputSchema>;
};

const AllTiersOutputSchema = z.object(
  Object.fromEntries(
    TIER_SLOT_KEYS.map((slot) => [slot, TierStatsOutputSchema.optional()]),
  ) as AllTiersShape,
);

const SingleDomainOutputSchema = z.object({
  domain: z.string(),
  first_seen: z.string(),
  last_fetch: z.string(),
  preferred_strategy: z.string().nullable(),
  tiers: AllTiersOutputSchema,
  capabilities: z.object({
    llms_full_txt: z.boolean(),
    robots_allows_us: z.boolean().nullable(),
    metadata_fetch_rate: z.number().nullable(),
    seen_in_search: z.number(),
  }),
});

const AggregateOutputSchema = z.object({
  // Declared, not just emitted: the SDK validates structuredContent against
  // this schema before it leaves the server, so a field missing here is a field
  // the caller never receives however faithfully the handler builds it.
  schema_version: z.number(),
  window: z.object({
    oldest_sample_ms: z.number().nullable(),
    elapsed_ms: z.number().nullable(),
    ttl_ceiling_ms: z.number(),
  }),
  domains_tracked: z.number(),
  seen_never_fetched: z.number(),
  tiers: AllTiersOutputSchema,
  failing_count: z.number(),
  top_failing: z.array(
    z.object({
      domain: z.string(),
      attempts: z.number(),
      ok: z.number(),
      success_rate: z.number(),
    }),
  ),
  truncated: z.boolean(),
});

// Exported solely so tests can validate real payloads against the *declared*
// contract rather than a restatement of it. A test that rebuilds the schema
// locally proves nothing — this is the object actually handed to registerTool.
export const DomainStatsOutputSchema = z.object({
  mode: z.enum(["single", "aggregate"]),
  hostname: z.string().nullable(),
  found: z.boolean(),
  record: SingleDomainOutputSchema.nullable(),
  aggregate: AggregateOutputSchema.nullable(),
  // Set when the corpus could not be read. Declared here deliberately: the SDK
  // validates structuredContent against this schema before it leaves the
  // server, so an undeclared field is one the caller never receives however
  // faithfully the handler sets it — and this is precisely the field a caller
  // needs to not read `domains_tracked: 0` as a measurement (vikunja#688).
  unavailable: z.string().nullable().optional(),
});

export async function handleDomainStats({ hostname }: { hostname?: string }) {
  return instrumentTool("domain_stats", async () => {
    if (hostname) {
      const record = await getDomainRecord(hostname);
      if (!record) {
        return {
          content: [
            {
              type: "text" as const,
              text: `No domain-db record for ${hostname}.`,
            },
          ],
          structuredContent: {
            mode: "single" as const,
            hostname,
            found: false,
            record: null,
            aggregate: null,
          },
        };
      }
      return {
        content: [{ type: "text" as const, text: formatDomainRecord(record) }],
        structuredContent: {
          mode: "single" as const,
          hostname,
          found: true,
          record: summarizeDomainRecord(record),
          aggregate: null,
        },
      };
    }

    // Aggregate mode — operator-triggered, bounded off-hot-path scan.
    const { records, truncated, unavailable } = await enumerateDomains();

    // "Could not read the database" and "the database is empty" produced the
    // same answer here, and the second is the one a reader believes. Research
    // hit exactly this while measuring for the plan that fixes it: a `0` that
    // was an auth failure. Say so instead of reporting a count (vikunja#688).
    if (unavailable) {
      return {
        content: [
          {
            type: "text" as const,
            text:
              `Could not read the domain database: ${unavailable}\n\n` +
              "This is not a report that the database is empty — no count was " +
              "obtained. Check the cache backend is reachable and that " +
              "VALKEY_URL's credentials are correct.",
          },
        ],
        structuredContent: {
          mode: "aggregate" as const,
          hostname: null,
          found: false,
          record: null,
          aggregate: null,
          unavailable,
        },
      };
    }

    const aggregate = aggregateDomainStats(records, truncated);
    return {
      content: [
        { type: "text" as const, text: formatDomainAggregate(aggregate) },
      ],
      structuredContent: {
        mode: "aggregate" as const,
        hostname: null,
        found: aggregate.domains_tracked > 0,
        record: null,
        aggregate,
      },
    };
  });
}

export function registerAdminTools(server: McpServer): void {
  server.registerTool(
    "clear_cache",
    {
      title: "Clear cache",
      description:
        "Purge cached search results (1h), fetched pages (24h) and/or crawl manifests.",
      inputSchema: {
        target: z
          .enum(["search", "fetch", "crawl", "all"])
          .default("all")
          .describe("Which cache (default all)"),
      },
    },
    handleClearCache,
  );

  server.registerTool(
    "domain_stats",
    {
      title: "Domain capability stats",
      description:
        "What the fetcher has learned about a host: per-tier success rates (tier2 crawl4ai, tier3 raw, tier4 wayback, github fast path, solver), llms.txt/robots presence, search appearances. Omit hostname for an aggregate. Read-only.",
      inputSchema: {
        hostname: z
          .string()
          .optional()
          .describe(
            "Hostname or URL, e.g. 'docs.python.org'; omit for aggregate",
          ),
      },
      outputSchema: DomainStatsOutputSchema,
    },
    handleDomainStats,
  );
}
