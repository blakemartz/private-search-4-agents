import { describe, expect, it } from "vitest";
import { authority, hostNamesQueryTerm, queryTerms } from "../src/authority.js";

describe("queryTerms", () => {
  it("lowercases, splits on punctuation and drops short words and stopwords", () => {
    expect(
      queryTerms("How to use Python asyncio.TaskGroup vs gather?"),
    ).toEqual(["python", "asyncio", "taskgroup", "gather"]);
  });
});

describe("hostNamesQueryTerm", () => {
  it.each([
    ["docs.python.org", ["python"], true],
    ["www.postgresql.org", ["postgres"], true],
    ["git-scm.com", ["git"], true],
    ["valkey.io", ["valkey"], true],
    // Generic labels carry no project identity.
    ["docs.github.com", ["docs"], false],
    ["dev.to", ["dev"], false],
    // Short prefixes do not count: "go" must not match "google".
    ["google.com", ["goo"], false],
    ["womanonrails.com", ["git", "rebase"], false],
  ])("%s with %j → %s", (host, terms, want) => {
    expect(hostNamesQueryTerm(host, terms)).toBe(want);
  });
});

describe("authority", () => {
  it("scores the project's own docs highest", () => {
    const docs = authority(
      "python asyncio TaskGroup",
      "https://docs.python.org/3/library/asyncio-task.html",
      [],
    );
    expect(docs).toEqual({
      projectHost: true,
      docsShaped: true,
      boosted: false,
      total: 1.5,
    });
    const blog = authority(
      "python asyncio TaskGroup",
      "https://bruceeckel.substack.com/p/python-311",
      [],
    );
    expect(blog.total).toBe(0);
  });

  it("recognises docs-shaped paths on any host", () => {
    expect(
      authority("x", "https://example.com/docs/guide", []).docsShaped,
    ).toBe(true);
    expect(authority("x", "https://example.com/blog/post", []).docsShaped).toBe(
      false,
    );
  });

  it("counts an operator boost", () => {
    const a = authority("q", "https://stackoverflow.com/questions/1", [
      "stackoverflow.com",
    ]);
    expect(a.boosted).toBe(true);
    expect(a.total).toBe(1);
  });

  it("is zero for an unparseable URL", () => {
    expect(authority("q", "not a url", []).total).toBe(0);
  });
});
