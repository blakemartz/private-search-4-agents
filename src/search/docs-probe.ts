// Recall for the project's own documentation.
//
// The ranking prior (authority.ts) can only promote a page that is in the
// pool, and often it is not: for "typescript satisfies operator vs type
// annotation" the engines returned eight blog posts plus typescriptlang.org's
// home and docs index, but not the 4.9 release notes that document the
// operator. The pool already names the project's domain, so one `site:` query
// for it fetches the page the engines skipped.
//
// Bounded: at most one extra SearXNG call per query, only when the pool names
// a project domain and holds no deep docs page from it, cached like any search,
// and best-effort (a failed probe returns the original pool).

import { DOCS_PROBE_ENABLED } from "../core/config.js";
import type { SearxResult } from "../core/types.js";
import {
  hostNamesQueryTerm,
  isDeepDocsUrl,
  isForumUrl,
  queryTerms,
} from "./authority.js";
import { searxSearch } from "./searxng.js";

/** Results kept from the probe; the rest of the pool is the original query's. */
const PROBE_RESULTS = 5;

/** Second-level labels under which the registrable domain is three labels deep. */
const SECOND_LEVEL = new Set(["co", "com", "org", "net", "gov", "ac", "edu"]);

export function registrableDomain(host: string): string {
  const labels = host.toLowerCase().replace(/\.$/, "").split(".");
  const n =
    labels.length >= 3 && SECOND_LEVEL.has(labels[labels.length - 2]) ? 3 : 2;
  return labels.slice(-n).join(".");
}

function parse(url: string): URL | null {
  try {
    return new URL(url);
  } catch {
    return null;
  }
}

const onDomain = (host: string, domain: string) =>
  host === domain || host.endsWith(`.${domain}`);

/**
 * The domain to probe: the first in pool order whose name is a query term
 * ("typescriptlang.org" for "typescript ..."), unless the pool already has a
 * page from it on the topic. Null when there is nothing to probe.
 *
 * "On the topic" is a deep docs page, or any page whose path names one of the
 * query's other terms: valkey.io/commands/eval for "valkey EVAL lua script".
 * The probe costs an engine call, and on an instance with one working engine
 * those are what run out.
 */
export function projectDomainToProbe(
  query: string,
  results: SearxResult[],
): string | null {
  const terms = queryTerms(query);
  const urls = results.map((r) => parse(r.url)).filter((u) => u !== null);
  for (const u of urls) {
    const domain = registrableDomain(u.hostname);
    if (!hostNamesQueryTerm(domain, terms)) continue;
    const topic = terms.filter((t) => !hostNamesQueryTerm(domain, [t]));
    const covered = urls.some(
      (v) =>
        onDomain(v.hostname, domain) &&
        (isDeepDocsUrl(v) || pathNamesTerm(v.pathname, topic)),
    );
    return covered ? null : domain;
  }
  return null;
}

function pathNamesTerm(path: string, terms: string[]): boolean {
  const words = new Set(path.toLowerCase().split(/[^a-z0-9]+/));
  return terms.some((t) => words.has(t));
}

export interface ProbeOptions {
  category: string;
  timeRange?: string;
  domainProfile?: string;
  language?: string;
  engines?: string;
  fresh?: boolean;
}

/** `results` plus up to PROBE_RESULTS new pages from the project's domain. */
export async function withProjectDocs(
  query: string,
  results: SearxResult[],
  opts: ProbeOptions,
): Promise<SearxResult[]> {
  if (!DOCS_PROBE_ENABLED || opts.category !== "general") return results;
  const domain = projectDomainToProbe(query, results);
  if (!domain) return results;
  try {
    const probe = await searxSearch(
      query,
      opts.category,
      PROBE_RESULTS,
      opts.timeRange,
      opts.domainProfile,
      false,
      opts.language,
      opts.engines,
      domain,
      opts.fresh,
    );
    const seen = new Set(results.map((r) => r.url));
    // Engines that ignore `site:` answer the bare query; their results are
    // not what was asked for, so only pages on the domain are kept. Its forum
    // threads are not what the probe is for either.
    const extra = probe.results
      .filter((r) => {
        const u = parse(r.url);
        return (
          u &&
          onDomain(u.hostname, domain) &&
          !isForumUrl(u) &&
          !seen.has(r.url)
        );
      })
      .slice(0, PROBE_RESULTS);
    return extra.length > 0 ? [...results, ...extra] : results;
  } catch {
    return results;
  }
}
