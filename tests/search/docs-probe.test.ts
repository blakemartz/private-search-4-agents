import { beforeEach, describe, expect, it, vi } from "vitest";

const searxSearch = vi.fn();
vi.mock("../../src/search/searxng.js", () => ({
  searxSearch: (...a: unknown[]) => searxSearch(...a),
}));

const { projectDomainToProbe, registrableDomain, withProjectDocs } =
  await import("../../src/search/docs-probe.js");

const r = (url: string) => ({ url, title: url, content: "" });

describe("registrableDomain", () => {
  it.each([
    ["www.typescriptlang.org", "typescriptlang.org"],
    ["docs.python.org", "python.org"],
    ["redis.io", "redis.io"],
    ["docs.example.co.uk", "example.co.uk"],
  ])("%s → %s", (host, want) => {
    expect(registrableDomain(host)).toBe(want);
  });
});

describe("projectDomainToProbe", () => {
  const q = "typescript satisfies operator vs type annotation";

  it("picks the domain that names a query term", () => {
    expect(
      projectDomainToProbe(q, [
        r("https://medium.com/@a/typescript-satisfies"),
        r("https://www.typescriptlang.org/"),
        r("https://www.typescriptlang.org/docs/"),
      ]),
    ).toBe("typescriptlang.org");
  });

  it("skips the probe when the pool already has a deep docs page from it", () => {
    expect(
      projectDomainToProbe("python asyncio TaskGroup", [
        r("https://docs.python.org/3/library/asyncio-task.html"),
        r("https://www.python.org/"),
      ]),
    ).toBeNull();
  });

  it("skips the probe when a page from it names a topic term in its path", () => {
    expect(
      projectDomainToProbe("valkey EVAL lua script atomic execution", [
        r("https://valkey.io/commands/eval/"),
      ]),
    ).toBeNull();
    // The project's own name in the path does not count as the topic.
    expect(
      projectDomainToProbe("tokio select cancellation", [
        r("https://tokio.rs/tokio"),
      ]),
    ).toBe("tokio.rs");
  });

  it("is null when no domain names the project", () => {
    expect(
      projectDomainToProbe(q, [
        r("https://stackoverflow.com/questions/1"),
        r("https://github.com/microsoft/TypeScript"),
      ]),
    ).toBeNull();
  });

  const cc = "HTTP Cache-Control no-cache vs no-store difference";

  it("falls back to a docs host with no page on the topic, probing the host itself", () => {
    expect(
      projectDomainToProbe(cc, [
        r("https://stackoverflow.com/questions/7573354"),
        r("https://developer.mozilla.org/en-US/docs/Web/HTTP"),
      ]),
    ).toBe("developer.mozilla.org");
  });

  it("takes the docs host even when a name-matching domain covers the topic", () => {
    // cache-control.com "names" the query; its pages are not MDN's.
    expect(
      projectDomainToProbe(cc, [
        r("https://www.cache-control.com/no-cache-vs-no-store/"),
        r("https://developer.mozilla.org/en-US/docs/Web/HTTP"),
      ]),
    ).toBe("developer.mozilla.org");
  });

  it("skips a docs host that already has a page naming the topic", () => {
    expect(
      projectDomainToProbe(cc, [
        r("https://developer.mozilla.org/en-US/docs/Web/HTTP"),
        r(
          "https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/Cache-Control",
        ),
      ]),
    ).toBeNull();
  });

  it("does not fall back to the covered project's own docs host", () => {
    expect(
      projectDomainToProbe("python asyncio TaskGroup", [
        r("https://docs.python.org/3/library/asyncio-task.html"),
        r("https://docs.python.org/3/"),
      ]),
    ).toBeNull();
  });
});

describe("withProjectDocs", () => {
  const q = "redis SCAN vs KEYS production";
  const pool = [
    r("https://stackoverflow.com/questions/32603964/scan-vs-keys"),
    r("https://redis.io/"),
  ];

  beforeEach(() => {
    searxSearch.mockReset();
  });

  it("appends new pages on the probed domain, dropping off-domain and forum ones", async () => {
    searxSearch.mockResolvedValue({
      results: [
        r("https://redis.io/"),
        r("https://en.wikipedia.org/wiki/Redis"),
        r("https://redis.io/docs/latest/commands/scan/"),
        r("https://redis.io/forums/t/scan-question/1"),
      ],
      meta: {},
    });
    const out = await withProjectDocs(q, pool, { category: "general" });
    expect(out.map((x) => x.url)).toEqual([
      ...pool.map((x) => x.url),
      "https://redis.io/docs/latest/commands/scan/",
    ]);
    // The probe is the same query scoped to the domain.
    expect(searxSearch.mock.calls[0][0]).toBe(q);
    expect(searxSearch.mock.calls[0][8]).toBe("redis.io");
  });

  it("returns the pool unchanged when the probe fails", async () => {
    searxSearch.mockRejectedValue(new Error("down"));
    expect(await withProjectDocs(q, pool, { category: "general" })).toBe(pool);
  });

  it("does not probe outside the general category", async () => {
    expect(await withProjectDocs(q, pool, { category: "news" })).toBe(pool);
    expect(searxSearch).not.toHaveBeenCalled();
  });
});
