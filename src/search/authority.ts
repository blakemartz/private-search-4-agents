// Authority prior for ranking: a small, explainable bonus added to the
// cross-encoder score so that, among results the reranker considers equally
// on-topic, the project's own documentation and operator-boosted domains come
// first.
//
// Why it is needed: the cross-encoder's scores are bimodal and saturate. For
// "python asyncio TaskGroup exception handling" six results scored 0.99–1.00
// and docs.python.org scored 0.93, so it ranked 7th behind dev.to,
// GeeksforGeeks and a Substack post. The scores say all of them are on topic;
// they say nothing about which one is the source.
//
// Deliberately crude and bounded: each signal is cheap to compute, visible in
// the URL, and capped, so it can reorder near-ties but cannot lift an
// off-topic page over an on-topic one (a 0.01 page gains at most 0.3).

import { urlMatchesDomain } from "../domains/rules.js";

const STOPWORDS = new Set([
  "the",
  "and",
  "for",
  "with",
  "how",
  "what",
  "why",
  "when",
  "does",
  "use",
  "using",
  "vs",
  "explained",
  "example",
  "examples",
  "difference",
  "between",
  "best",
  "guide",
  "tutorial",
  "error",
  "not",
  "working",
  "without",
  "from",
]);

/**
 * Protocol and format names are topics, not projects: a host built on one is a
 * vendor's brand. For "HTTP Cache-Control no-cache vs no-store" http.dev was
 * treated as the project and outranked MDN.
 */
const TOPIC_TERMS = new Set([
  "http",
  "https",
  "html",
  "css",
  "json",
  "xml",
  "yaml",
  "api",
  "rest",
  "web",
  "url",
  "sql",
  "tcp",
  "udp",
  "dns",
  "ssh",
  "tls",
  "ssl",
]);

/** Labels that carry no project identity. */
const GENERIC_LABELS = new Set([
  "www",
  "com",
  "org",
  "net",
  "io",
  "dev",
  "app",
  "co",
  "uk",
  "de",
  "docs",
  "doc",
  "developer",
  "developers",
  "blog",
  "wiki",
  "en",
  "api",
  "help",
  "support",
  "learn",
  "community",
  "forum",
  "forums",
  "users",
  "github",
]);

const DOCS_PATH =
  /\/(docs?|reference|manual|man|api|library|std|spec|handbook)(\/|$)/i;
const DOCS_HOST = /^(docs|doc|developer|developers|man|manual|wiki)\./i;
/**
 * A project's own forum is community Q&A, the same kind of source as Stack
 * Overflow, not its documentation. Without this, discuss.python.org outranked
 * docs.python.org for "python asyncio TaskGroup exception handling", because
 * both "named the project". Forums live on a host (discuss.python.org) or
 * under a path (linux.org/threads/...).
 */
const FORUM_HOST =
  /^(discuss|discourse|forum|forums|community|users|user|bbs|groups|lists)\./i;
const FORUM_PATH =
  /^\/(t|threads?|topics?|forums?|viewtopic(\.php)?|showthread(\.php)?|discussions?)(\/|$)/i;

export function isForumUrl(url: URL): boolean {
  return FORUM_HOST.test(url.hostname) || FORUM_PATH.test(url.pathname);
}

/** A documentation host by name: docs.*, developer.*, man.*, wiki.* and the like. */
export function isDocsHost(host: string): boolean {
  return DOCS_HOST.test(host);
}

/** A docs host or docs-shaped path, at least two segments deep (not an index page). */
export function isDeepDocsUrl(url: URL): boolean {
  const depth = url.pathname.split("/").filter(Boolean).length;
  return (
    depth >= 2 && (DOCS_HOST.test(url.hostname) || DOCS_PATH.test(url.pathname))
  );
}

export function queryTerms(query: string): string[] {
  return [
    ...new Set(
      query
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter(
          (t) => t.length >= 3 && !STOPWORDS.has(t) && !TOPIC_TERMS.has(t),
        ),
    ),
  ];
}

/**
 * Does the hostname name the project the query is about? `python` matches
 * docs.python.org, `postgres` matches postgresql.org (prefix, 5+ chars, at most
 * two left over or `lang`), `git` matches git-scm.com (hyphen-split label). Generic labels
 * never match. The leftover limit keeps a name from matching every brand built
 * on it: `linux` is not linuxiac.com, `postgres` is not postgrespro.com,
 * `redis` is not redisson.pro.
 */
export function hostNamesQueryTerm(host: string, terms: string[]): boolean {
  return labelsNameQueryTerm(host.toLowerCase().split("."), terms);
}

function labelsNameQueryTerm(raw: string[], terms: string[]): boolean {
  const labels = raw
    .flatMap((l) => [l, ...l.split("-")])
    .filter((l) => l.length >= 3 && !GENERIC_LABELS.has(l));
  return terms.some((t) =>
    labels.some(
      (l) =>
        l === t ||
        (t.length >= 5 && l.startsWith(t) && nameSuffix(l.slice(t.length))) ||
        (l.length >= 5 && t.startsWith(l) && nameSuffix(t.slice(l.length))),
    ),
  );
}

/** What may follow a project name in its domain: `postgres`+`ql`, `typescript`+`lang`. */
function nameSuffix(rest: string): boolean {
  return rest.length <= 2 || rest === "lang";
}

export interface AuthorityBreakdown {
  /** The host names the project, or a docs host does in its first path segment. Never a forum. */
  projectHost: boolean;
  docsShaped: boolean;
  boosted: boolean;
  /** Sum of the signals, before the weight is applied. 0..2 */
  total: number;
}

export function authority(
  query: string,
  url: string,
  boostList: string[],
): AuthorityBreakdown {
  let host = "";
  let path = "";
  let forum = false;
  try {
    const u = new URL(url);
    host = u.hostname;
    path = u.pathname;
    forum = isForumUrl(u);
  } catch {
    return { projectHost: false, docsShaped: false, boosted: false, total: 0 };
  }
  const terms = queryTerms(query);
  // Shared docs hosts carry the project in the first path segment instead:
  // docs.rs/tokio/..., developer.hashicorp.com/terraform/... A wiki puts its
  // page name after /title/ or /wiki/: wiki.archlinux.org/title/Systemd/User.
  const segments = path.split("/").filter(Boolean);
  const firstSegment = decodeSegment(
    (WIKI_PREFIX.has(segments[0]?.toLowerCase() ?? "")
      ? segments[1]
      : segments[0]) ?? "",
  );
  const projectHost =
    !forum &&
    (hostNamesQueryTerm(host, terms) ||
      (DOCS_HOST.test(host) &&
        labelsNameQueryTerm([firstSegment.toLowerCase()], terms)));
  const docsShaped = DOCS_HOST.test(host) || DOCS_PATH.test(path);
  const boosted = boostList.some((pat) => urlMatchesDomain(url, pat));
  // A boost is half the project's own name: the operator prefers a domain, but
  // that is weaker evidence than "this is the project's site". At equal weight
  // the boosted github.com and stackoverflow.com tied every docs page.
  const total =
    (projectHost ? 1 : 0) + (docsShaped ? 0.5 : 0) + (boosted ? 0.5 : 0);
  return { projectHost, docsShaped, boosted, total };
}

/** Path segments a wiki puts before the page name. */
const WIKI_PREFIX = new Set(["title", "wiki"]);

function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}
