#!/usr/bin/env node
// Agent-surface benchmark: does search find the authoritative page, do the
// passages it returns contain the answer, and what does that cost in latency
// and output size? Run against a live stack so tuning is measured, not guessed.
//
//   node scripts/bench.mjs                 # stdio: spawns build/src/index.js
//   node scripts/bench.mjs --url http://127.0.0.1:3001/mcp --token-env SEARXNG_MCP_AUTH_TOKEN
//   node scripts/bench.mjs --fresh         # bypass caches (cold numbers)
//   node scripts/bench.mjs --json out.json # also write per-case results
//   node scripts/bench.mjs --cases scripts/bench-holdout.json  # held-out set
//
// Env for stdio mode comes from the caller (e.g. `node --env-file=... scripts/bench.mjs`).

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// Each case: a question an agent would plausibly ask, the domain whose page is
// the authoritative answer, and phrases of which at least one appears in that
// answer. Phrases are matched case-insensitively against returned text.
export const CASES = [
  { q: "tokio select! cancellation safety", gold: "docs.rs", phrases: ["cancellation safe"] },
  { q: "valkey EVAL lua script atomic execution", gold: "valkey.io", phrases: ["atomic"] },
  { q: "python asyncio TaskGroup exception handling", gold: "docs.python.org", phrases: ["ExceptionGroup"] },
  { q: "postgres VACUUM FULL vs plain VACUUM locking", gold: "postgresql.org", phrases: ["ACCESS EXCLUSIVE", "exclusive lock"] },
  { q: "git rebase --onto usage", gold: "git-scm.com", phrases: ["--onto"] },
  { q: "systemd user service start at boot without login linger", gold: "freedesktop.org|wiki.archlinux.org", phrases: ["linger"] },
  { q: "rust Pin and Unpin explained", gold: "doc.rust-lang.org", phrases: ["Unpin"] },
  { q: "HTTP Cache-Control no-cache vs no-store difference", gold: "developer.mozilla.org", phrases: ["no-store"] },
  { q: "docker compose depends_on condition service_healthy", gold: "docs.docker.com", phrases: ["service_healthy"] },
  { q: "nginx proxy_pass trailing slash URI behavior", gold: "nginx.org|stackoverflow.com|serverfault.com", phrases: ["trailing slash", "proxy_pass"] },
];

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i === -1 ? fallback : process.argv[i + 1];
}
const has = (name) => process.argv.includes(name);

async function connect() {
  const client = new Client({ name: "bench", version: "0" });
  const url = arg("--url");
  if (url) {
    const token = process.env[arg("--token-env", "SEARXNG_MCP_AUTH_TOKEN")];
    await client.connect(
      new StreamableHTTPClientTransport(new URL(url), {
        requestInit: token
          ? { headers: { Authorization: `Bearer ${token}` } }
          : undefined,
      }),
    );
  } else {
    await client.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: [resolve(ROOT, "build/src/index.js")],
        env: process.env,
        stderr: "ignore",
      }),
    );
  }
  return client;
}

const goldRe = (gold) =>
  new RegExp(`^https?://([^/]*\\.)?(${gold.replace(/\./g, "\\.")})(/|$)`, "i");
const containsAny = (text, phrases) =>
  phrases.some((p) => text.toLowerCase().includes(p.toLowerCase()));

async function call(client, name, args) {
  const t0 = performance.now();
  const r = await client.callTool({ name, arguments: args });
  const ms = performance.now() - t0;
  const text = (r.content ?? []).map((c) => c.text ?? "").join("\n");
  return { ms, text, structured: r.structuredContent, isError: !!r.isError };
}

async function runCase(client, c, fresh) {
  const out = { q: c.q };
  const s = await call(client, "search", { query: c.q, max_results: 5, fresh });
  const urls = (s.structured?.results ?? []).map((r) => r.url);
  const rank = urls.findIndex((u) => goldRe(c.gold).test(u));
  out.search = { ms: s.ms, chars: s.text.length, goldRank: rank === -1 ? null : rank + 1 };

  const h = await call(client, "search", {
    query: c.q,
    max_results: 5,
    content: "highlights",
    fresh,
  });
  out.highlights = {
    ms: h.ms,
    chars: h.text.length,
    answerInOutput: containsAny(h.text, c.phrases),
  };

  // Semantic passages from the gold page, when search found one.
  const goldUrl = urls.find((u) => goldRe(c.gold).test(u));
  if (goldUrl) {
    const f = await call(client, "fetch_url", { url: goldUrl, query: c.q, fresh });
    out.fetchQuery = {
      ms: f.ms,
      chars: f.text.length,
      answerInOutput: !f.isError && containsAny(f.text, c.phrases),
      isError: f.isError,
    };
  }
  return out;
}

const pct = (n, d) => (d === 0 ? "n/a" : `${Math.round((100 * n) / d)}%`);
const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length === 0 ? 0 : s[Math.floor(s.length / 2)];
};

async function main() {
  const casesFile = arg("--cases");
  const cases = casesFile
    ? JSON.parse(readFileSync(resolve(casesFile), "utf8"))
    : CASES;
  const client = await connect();
  const fresh = has("--fresh");
  const { tools } = await client.listTools();
  const toolChars = tools.reduce((n, t) => n + JSON.stringify(t).length, 0);

  const results = [];
  for (const c of cases) {
    try {
      const r = await runCase(client, c, fresh);
      results.push(r);
      const g = r.search.goldRank ?? "-";
      console.log(
        `${String(g).padStart(2)}  hl:${r.highlights.answerInOutput ? "Y" : "n"}  fq:${r.fetchQuery ? (r.fetchQuery.answerInOutput ? "Y" : "n") : "-"}  ${Math.round(r.search.ms)}/${Math.round(r.highlights.ms)}ms  ${c.q}`,
      );
    } catch (err) {
      results.push({ q: c.q, error: String(err) });
      console.log(` E  ${c.q}: ${err}`);
    }
  }
  await client.close();

  const ok = results.filter((r) => !r.error);
  const found = ok.filter((r) => r.search.goldRank !== null);
  const fq = ok.filter((r) => r.fetchQuery);
  const summary = {
    cases: cases.length,
    errors: results.length - ok.length,
    tools_list_tokens: Math.round(toolChars / 4),
    gold_at_1: pct(ok.filter((r) => r.search.goldRank === 1).length, ok.length),
    gold_at_5: pct(found.length, ok.length),
    mrr: (
      ok.reduce((n, r) => n + (r.search.goldRank ? 1 / r.search.goldRank : 0), 0) /
      Math.max(ok.length, 1)
    ).toFixed(3),
    highlights_answer: pct(ok.filter((r) => r.highlights.answerInOutput).length, ok.length),
    fetch_query_answer: pct(fq.filter((r) => r.fetchQuery.answerInOutput).length, fq.length),
    median_ms: {
      search: Math.round(median(ok.map((r) => r.search.ms))),
      highlights: Math.round(median(ok.map((r) => r.highlights.ms))),
      fetch_query: Math.round(median(fq.map((r) => r.fetchQuery.ms))),
    },
    median_tokens: {
      search: Math.round(median(ok.map((r) => r.search.chars)) / 4),
      highlights: Math.round(median(ok.map((r) => r.highlights.chars)) / 4),
      fetch_query: Math.round(median(fq.map((r) => r.fetchQuery.chars)) / 4),
    },
  };
  console.log(JSON.stringify(summary, null, 2));
  const json = arg("--json");
  if (json) writeFileSync(json, JSON.stringify({ summary, results }, null, 2));
}

await main();
