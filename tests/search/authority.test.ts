import { describe, expect, it } from "vitest";
import {
  authority,
  hostNamesQueryTerm,
  queryTerms,
} from "../../src/search/authority.js";

describe("queryTerms", () => {
  it("lowercases, splits on punctuation and drops short words and stopwords", () => {
    expect(
      queryTerms("How to use Python asyncio.TaskGroup vs gather?"),
    ).toEqual(["python", "asyncio", "taskgroup", "gather"]);
  });

  it("drops protocol and format names, which are topics, not projects", () => {
    expect(queryTerms("HTTP Cache-Control no-store")).toEqual([
      "cache",
      "control",
      "store",
    ]);
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
    ["www.typescriptlang.org", ["typescript"], true],
    // A brand built on the name is not the project.
    ["linuxiac.com", ["linux"], false],
    ["postgrespro.com", ["postgres"], false],
    ["redisson.pro", ["redis"], false],
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

  it.each([
    [
      "tokio spawn_blocking",
      "https://docs.rs/tokio/latest/tokio/task/fn.spawn_blocking.html",
    ],
    [
      "terraform for_each",
      "https://developer.hashicorp.com/terraform/language/meta-arguments/for_each",
    ],
    ["systemd user service", "https://wiki.archlinux.org/title/Systemd/User"],
    ["systemd user service", "https://wiki.gentoo.org/wiki/Systemd"],
  ])("finds the project in a docs host's first path segment: %s", (q, url) => {
    expect(authority(q, url, []).projectHost).toBe(true);
  });

  it("does not take the project from a later segment or a non-docs host", () => {
    expect(
      authority(
        "terraform count",
        "https://docs.cloudposse.com/learn/terraform-in-depth/count",
        [],
      ).projectHost,
    ).toBe(false);
    expect(
      authority("tokio spawn", "https://example.com/tokio/spawn", [])
        .projectHost,
    ).toBe(false);
  });

  it("does not count the project's forum as the project", () => {
    for (const url of [
      "https://discuss.python.org/t/asyncio-tasks/23806",
      "https://users.rust-lang.org/t/tokio-spawn/63571",
      "https://bbs.archlinux.org/viewtopic.php?id=1",
      "https://www.linux.org/threads/kernel-6-17.66436/",
    ]) {
      expect(authority("python rust archlinux", url, []).projectHost).toBe(
        false,
      );
    }
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
    expect(a.total).toBe(0.5);
  });

  it("is zero for an unparseable URL", () => {
    expect(authority("q", "not a url", []).total).toBe(0);
  });
});
