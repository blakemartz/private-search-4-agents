// Tests for the Phase-2 tier cascade refactor: Tier interface, getTiers(),
// and ALL_TIERS ordering. These tests complement the routing.test.ts suite
// (which covers computeTierSkips) by verifying the Tier objects and the
// getTiers helper that wires skips into an active tier list.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// These suites exercise the operator-override and stats passes, which are
// orthogonal to whether a tier is configured at all. Pin a fully-configured
// baseline so every pre-existing assertion keeps meaning what it meant before
// `not_configured` existed — CRAWL4AI_URL is unset in the test env, which would
// otherwise skip tier2 in every case here and hide what these cases check.
// The not_configured pass has its own cases, which drive this mock explicitly.
vi.mock("../../src/core/config.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/core/config.js")>()),
  tierConfigured: vi.fn(() => ({ tier2: true, tier3: true })),
}));

vi.mock("../../src/core/cache.js", () => ({
  cacheGet: vi.fn(),
  cacheSet: vi.fn(),
}));

vi.mock("../../src/domains/rules.js", () => ({
  getOperatorTierSkips: vi.fn(() => []),
}));

import { cacheGet } from "../../src/core/cache.js";
import type { DomainRecord } from "../../src/domains/db.js";
import { getOperatorTierSkips } from "../../src/domains/rules.js";
import { getTiers } from "../../src/fetch/routing.js";
import { ALL_TIERS, tier2, tier3 } from "../../src/fetch/tiers/index.js";

const cacheGetMock = vi.mocked(cacheGet);
const getOpSkipMock = vi.mocked(getOperatorTierSkips);

const NOW = Date.now();

function stat(attempts: number, ok: number, fail: number) {
  return { attempts, ok, fail, window_start_ms: NOW };
}

function record(overrides: Partial<DomainRecord>): DomainRecord {
  return {
    schema_version: 7,
    domain: "example.com",
    first_seen: "2026-05-01T00:00:00Z",
    last_fetch: "2026-05-01T00:00:00Z",
    capabilities: {},
    tier_stats_30d: {
      tier2: stat(0, 0, 0),
      tier3: stat(0, 0, 0),
      tier4: stat(0, 0, 0),
      github: stat(0, 0, 0),
      solver: stat(0, 0, 0),
    },
    ...overrides,
  };
}

describe("Tier objects", () => {
  it("tier2 has name=tier2_crawl4ai and slot=tier2", () => {
    expect(tier2.name).toBe("tier2_crawl4ai");
    expect(tier2.slot).toBe("tier2");
  });

  it("tier3 has name=tier3_rawfetch and slot=tier3", () => {
    expect(tier3.name).toBe("tier3_rawfetch");
    expect(tier3.slot).toBe("tier3");
  });

  it("ALL_TIERS contains tier2, tier3 in priority order — no tier1", () => {
    expect(ALL_TIERS).toHaveLength(2);
    expect(ALL_TIERS[0]).toBe(tier2);
    expect(ALL_TIERS[1]).toBe(tier3);
  });

  it("each Tier has a fetch function", () => {
    for (const tier of ALL_TIERS) {
      expect(typeof tier.fetch).toBe("function");
    }
  });
});

describe("getTiers — active tier list", () => {
  beforeEach(() => {
    cacheGetMock.mockReset();
    getOpSkipMock.mockReset();
    getOpSkipMock.mockReturnValue([]);
  });

  afterEach(() => vi.restoreAllMocks());

  it("returns every tier when no skips apply", async () => {
    cacheGetMock.mockResolvedValue(null);
    const { active, skipped } = await getTiers("https://example.com/p");
    expect(active).toHaveLength(2);
    expect(active.map((t) => t.slot)).toEqual(["tier2", "tier3"]);
    expect(skipped).toHaveLength(0);
  });

  it("excludes tier2 when success rate < 30% over >=10 attempts", async () => {
    cacheGetMock.mockResolvedValue(
      JSON.stringify(
        record({
          tier_stats_30d: {
            tier2: stat(20, 4, 16), // 20% success rate
            tier3: stat(0, 0, 0),
            tier4: stat(0, 0, 0),
            github: stat(0, 0, 0),
            solver: stat(0, 0, 0),
          },
        }),
      ),
    );
    const { active, skipped } = await getTiers("https://example.com/p");
    expect(active.map((t) => t.slot)).toEqual(["tier3"]);
    expect(skipped).toHaveLength(1);
    expect(skipped[0]).toEqual({ tier: "tier2", reason: "low_success_rate" });
  });

  it("excludes operator-override tiers from the active list", async () => {
    cacheGetMock.mockResolvedValue(null);
    getOpSkipMock.mockReturnValue(["tier3"]);
    const { active, skipped } = await getTiers("https://example.com/p");
    expect(active.map((t) => t.slot)).toEqual(["tier2"]);
    expect(skipped).toEqual([{ tier: "tier3", reason: "operator_override" }]);
  });

  it("returns empty active list when all tiers are skipped", async () => {
    cacheGetMock.mockResolvedValue(null);
    getOpSkipMock.mockReturnValue(["tier2", "tier3"]);
    const { active, skipped } = await getTiers("https://example.com/p");
    expect(active).toHaveLength(0);
    expect(skipped).toHaveLength(2);
  });

  it("preserves tier order in active list after partial skip", async () => {
    cacheGetMock.mockResolvedValue(
      JSON.stringify(
        record({
          tier_stats_30d: {
            tier2: stat(0, 0, 0),
            tier3: stat(20, 2, 18), // 10% success rate → skip
            tier4: stat(0, 0, 0),
            github: stat(0, 0, 0),
            solver: stat(0, 0, 0),
          },
        }),
      ),
    );
    const { active } = await getTiers("https://example.com/p");
    expect(active.map((t) => t.slot)).toEqual(["tier2"]);
  });

  it("skipped list carries both low_success_rate and operator_override reasons", async () => {
    cacheGetMock.mockResolvedValue(
      JSON.stringify(
        record({
          tier_stats_30d: {
            tier2: stat(20, 1, 19), // low success → skip
            tier3: stat(0, 0, 0),
            tier4: stat(0, 0, 0),
            github: stat(0, 0, 0),
            solver: stat(0, 0, 0),
          },
        }),
      ),
    );
    getOpSkipMock.mockReturnValue(["tier3"]); // operator override
    const { skipped } = await getTiers("https://example.com/p");
    const byTier = new Map(skipped.map((s) => [s.tier, s.reason]));
    expect(byTier.get("tier2")).toBe("low_success_rate");
    expect(byTier.get("tier3")).toBe("operator_override");
  });
});
