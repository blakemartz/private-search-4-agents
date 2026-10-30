import { beforeEach, describe, expect, it, vi } from "vitest";

const selectPassages = vi.fn();
vi.mock("../../src/search/passages.js", () => ({
  selectPassages: (...a: unknown[]) => selectPassages(...a),
}));

const { rescoreCandidates, rescoreFromPages } = await import(
  "../../src/search/passage-rescore.js"
);

const q = "tokio select! cancellation safety";
const r = (url: string, relevance?: number) => ({
  url,
  title: url,
  content: "",
  relevance,
});
const DOCS = "https://docs.rs/tokio/latest/tokio/macro.select.html";
const pool = () => [
  r("https://medium.com/@a/tokio-select-cancel-safety", 1.0),
  r("https://stackoverflow.com/questions/1/tokio-select", 0.999),
  r(DOCS, 0.021),
];
const passage = (score: number) => ({
  passages: [{ offset: 0, text: "Cancellation safety ...", score }],
  scoredBy: "reranker",
  chunkCount: 4,
});

beforeEach(() => {
  selectPassages.mockReset();
});

describe("rescoreCandidates", () => {
  it("takes low-snippet project pages, deepest first", () => {
    const got = rescoreCandidates(
      q,
      [
        r("https://tokio.rs/", 0.02),
        r("https://blog.example.com/tokio", 0.01),
        r(DOCS, 0.021),
        r("https://tokio.rs/tokio/tutorial/select", 0.9),
      ],
      [],
    ).map((x) => x.url);
    expect(got).toEqual([DOCS, "https://tokio.rs/"]);
  });

  it("skips results the reranker did not score", () => {
    expect(rescoreCandidates(q, [r(DOCS)], [])).toEqual([]);
  });
});

describe("rescoreFromPages", () => {
  it("lifts a docs page whose best passage beats its snippet", async () => {
    selectPassages.mockResolvedValue(passage(0.998));
    const fetchText = vi.fn().mockResolvedValue("page");
    const out = await rescoreFromPages(q, pool(), {
      fetchText,
      applyRecency: false,
    });
    expect(fetchText).toHaveBeenCalledWith(DOCS);
    expect(out[0].url).toBe(DOCS);
    expect(out[0].relevance).toBe(0.998);
  });

  it("never lowers a score", async () => {
    selectPassages.mockResolvedValue(passage(0.001));
    const out = await rescoreFromPages(q, pool(), {
      fetchText: async () => "page",
      applyRecency: false,
    });
    expect(out.find((x) => x.url === DOCS)?.relevance).toBe(0.021);
  });

  it("ignores term-overlap scores, which are on another scale", async () => {
    selectPassages.mockResolvedValue({ ...passage(5), scoredBy: "overlap" });
    const out = await rescoreFromPages(q, pool(), {
      fetchText: async () => "page",
      applyRecency: false,
    });
    expect(out.find((x) => x.url === DOCS)?.relevance).toBe(0.021);
  });

  it("does nothing when the project's page already leads", async () => {
    const fetchText = vi.fn();
    const ranked = [
      r("https://tokio.rs/tokio/tutorial/select", 0.9),
      ...pool(),
    ];
    const out = await rescoreFromPages(q, ranked, {
      fetchText,
      applyRecency: false,
    });
    expect(fetchText).not.toHaveBeenCalled();
    expect(out).toBe(ranked);
  });

  it("keeps the snippet score for a page that fails or misses the budget", async () => {
    const out = await rescoreFromPages(q, pool(), {
      fetchText: () => new Promise(() => {}),
      applyRecency: false,
      budgetMs: 10,
    });
    expect(out.find((x) => x.url === DOCS)?.relevance).toBe(0.021);

    const failed = await rescoreFromPages(q, pool(), {
      fetchText: async () => {
        throw new Error("blocked");
      },
      applyRecency: false,
    });
    expect(failed.find((x) => x.url === DOCS)?.relevance).toBe(0.021);
  });
});
