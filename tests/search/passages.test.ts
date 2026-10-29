import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/search/reranker.js", () => ({
  scorePassages: vi.fn().mockResolvedValue(null),
}));

import {
  chunkText,
  overlapScore,
  proseOf,
  selectPassages,
} from "../../src/search/passages.js";
import { scorePassages } from "../../src/search/reranker.js";

beforeEach(() => vi.clearAllMocks());

describe("chunkText", () => {
  it("packs short paragraphs together and records their offsets", () => {
    const text = "alpha para\n\nbeta para\n\ngamma para";
    expect(chunkText(text, 1000)).toEqual([
      { offset: 0, text: "alpha para\n\nbeta para\n\ngamma para" },
    ]);
  });

  it("starts a new chunk when the next paragraph would overflow", () => {
    const a = "a".repeat(60);
    const b = "b".repeat(60);
    const chunks = chunkText(`${a}\n\n${b}`, 100);
    expect(chunks).toEqual([
      { offset: 0, text: a },
      { offset: 62, text: b },
    ]);
  });

  it("splits one oversized paragraph, preferring a sentence break", () => {
    const text = `${"x".repeat(70)}. ${"y".repeat(70)}`;
    const chunks = chunkText(text, 100);
    expect(chunks[0].text).toBe(`${"x".repeat(70)}.`);
    expect(chunks[1].offset).toBeGreaterThan(70);
    expect(chunks.map((c) => c.text).join("")).toContain("y".repeat(70));
  });

  it("drops empty paragraphs", () => {
    expect(chunkText("\n\n   \n\nonly")).toEqual([{ offset: 7, text: "only" }]);
  });
});

describe("proseOf", () => {
  it("keeps link text and drops targets, titles, images and markers", () => {
    expect(
      proseOf(
        '## [§](https://d/x#c)Safety see [docs](https://a/b "t") ![alt](i.png) **bold**',
      ),
    ).toBe("Safety see docs alt bold");
  });

  it("handles a link target that itself contains parentheses", () => {
    expect(proseOf("[TOKIO](https://w/TOKIO_(album)) rest")).toBe("TOKIO rest");
  });
});

describe("overlapScore", () => {
  it("is the fraction of distinct query terms present", () => {
    expect(overlapScore("mutex lock safety", "the Mutex lock")).toBeCloseTo(
      2 / 3,
    );
    expect(overlapScore("", "anything")).toBe(0);
  });
});

describe("selectPassages", () => {
  const relevant = "Mutex lock is not cancellation safe. ".repeat(12);
  const filler = "Unrelated filler prose about gardening. ".repeat(12);
  const nav = Array.from(
    { length: 12 },
    (_, i) => `[Item ${i}](https://example.com/a/very/long/path/${i})`,
  ).join(" ");

  it("uses the reranker's scores when it answers", async () => {
    vi.mocked(scorePassages).mockResolvedValueOnce([0.1, 0.9]);
    const sel = await selectPassages("q", `${filler}\n\n${relevant}`, 1);
    expect(sel.scoredBy).toBe("reranker");
    expect(sel.passages[0].text).toContain("Mutex");
    expect(sel.passages[0].score).toBe(0.9);
  });

  it("falls back to term overlap, and says so", async () => {
    const sel = await selectPassages(
      "mutex cancellation",
      `${filler}\n\n${relevant}`,
      1,
    );
    expect(sel.scoredBy).toBe("overlap");
    expect(sel.passages[0].text).toContain("Mutex");
  });

  it("never offers a link-dominated chunk such as a nav menu", async () => {
    const sel = await selectPassages("item", `${nav}\n\n${relevant}`, 5);
    expect(sel.passages.every((p) => !p.text.startsWith("Item 0"))).toBe(true);
    expect(sel.chunkCount).toBe(1);
  });

  it("returns nothing for a page with no usable text", async () => {
    const sel = await selectPassages("q", "tiny", 3);
    expect(sel).toEqual({ passages: [], scoredBy: "overlap", chunkCount: 0 });
    expect(scorePassages).not.toHaveBeenCalled();
  });
});
