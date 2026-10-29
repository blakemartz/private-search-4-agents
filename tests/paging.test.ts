import { describe, expect, it } from "vitest";
import { findPassages, formatPassages, windowText } from "../src/paging.js";

const LIMIT = 40000;

describe("windowText", () => {
  it("returns a page that fits whole, with no footer", () => {
    expect(windowText("short", 0, 100, LIMIT)).toEqual({
      text: "short",
      footer: "",
    });
  });

  it("cuts to the budget and names the next offset", () => {
    const w = windowText("x".repeat(250), 0, 100, LIMIT);
    expect(w.text).toHaveLength(100);
    expect(w.footer).toBe("[chars 0–100 of 250 · continue with offset=100]");
  });

  it("marks the last window without a continuation", () => {
    const w = windowText("x".repeat(250), 200, 100, LIMIT);
    expect(w.text).toHaveLength(50);
    expect(w.footer).toBe("[chars 200–250 of 250]");
  });

  it("reports a store-capped page as a lower bound, even when shown whole", () => {
    const w = windowText("x".repeat(LIMIT), 0, LIMIT, LIMIT);
    expect(w.footer).toContain("of ≥40,000 (store limit)");
    expect(w.footer).toContain("use find");
  });

  it("says so when the offset is past the end", () => {
    const w = windowText("abc", 10, 100, LIMIT);
    expect(w.text).toBe("");
    expect(w.footer).toBe(
      "[offset 10 is past the end of the stored text (3 chars)]",
    );
  });

  it("clamps a negative offset to the start", () => {
    expect(windowText("abc", -5, 100, LIMIT).text).toBe("abc");
  });
});

describe("findPassages", () => {
  it("matches case-insensitively and reports the passage offset", () => {
    const text = `${"a".repeat(1000)}Needle${"b".repeat(1000)}`;
    const r = findPassages(text, "needle", { context: 10 });
    expect(r.matches).toBe(1);
    expect(r.passages).toEqual([
      { offset: 990, text: `${"a".repeat(10)}Needle${"b".repeat(10)}` },
    ]);
  });

  it("supports '|' alternatives", () => {
    const r = findPassages("one Q4_K_M two ... Q6_K three", "q4_k_m|Q6_K", {
      context: 0,
    });
    expect(r.matches).toBe(2);
  });

  it("merges overlapping windows into one passage", () => {
    const r = findPassages("foo bar foo", "foo", { context: 5 });
    expect(r.matches).toBe(2);
    expect(r.passages).toHaveLength(1);
  });

  it("caps the number of passages but still counts every match", () => {
    const text = Array.from({ length: 20 }, () => `hit${"-".repeat(50)}`).join(
      "",
    );
    const r = findPassages(text, "hit", { context: 5, maxPassages: 3 });
    expect(r.matches).toBe(20);
    expect(r.passages).toHaveLength(3);
  });

  it("returns nothing for an empty term list", () => {
    expect(findPassages("abc", " | ")).toEqual({ passages: [], matches: 0 });
  });
});

describe("formatPassages", () => {
  it("says when nothing matched", () => {
    expect(formatPassages("zz", { passages: [], matches: 0 }, 1234)).toBe(
      '[no matches for "zz" in 1,234 stored chars]',
    );
  });

  it("notes how many passages are shown when matches exceed them", () => {
    const out = formatPassages(
      "x",
      { passages: [{ offset: 5, text: "x" }], matches: 4 },
      100,
    );
    expect(out).toContain('[4 matches for "x" (showing 1 passage)]');
    expect(out).toContain("--- at offset 5 ---\nx");
  });
});
