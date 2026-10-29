// Per-call instrumentation shared by every tool: a request id for log
// correlation, a span, and — for search — the NATS events and the latency
// histogram.
import { newRequestId, withRequestId } from "../../core/context.js";
import { events } from "../../core/events.js";
import { redactUrlCredentialsInText } from "../../core/log.js";
import {
  incCounter,
  recordHistogram,
  withSpan,
} from "../../core/observability.js";
import type { SearxResult } from "../../core/types.js";

export async function instrumentTool<T>(
  toolName: string,
  fn: () => Promise<T>,
): Promise<T> {
  return withRequestId(newRequestId(), () =>
    withSpan(`tool.${toolName}`, { "mcp.tool": toolName }, fn),
  );
}

interface SearchEventCtx {
  query: string;
  profile?: string;
  expand?: boolean;
  time_range?: string;
  num_results: number;
}

/**
 * The tools that share the `search` histogram. A named union rather than a
 * bare string keeps a typo out of the label set — a stray value would not fail
 * anything at runtime, it would quietly create a new series.
 */
type SearchToolName = "search";

async function withSearchEvents<T>(
  toolName: SearchToolName,
  ctx: SearchEventCtx,
  fn: () => Promise<{
    ranked: SearxResult[];
    result: T;
    rerankApplied: boolean;
  }>,
): Promise<T> {
  events.searchRequested(ctx);
  const t0 = Date.now();
  try {
    const { ranked, result, rerankApplied } = await fn();
    const latency_ms = Date.now() - t0;
    incCounter("search", {
      tool: toolName,
      profile: ctx.profile ?? "default",
      expand: ctx.expand ? "true" : "false",
    });
    recordHistogram("search", latency_ms / 1000, {
      tool: toolName,
      profile: ctx.profile ?? "default",
      outcome: "ok",
    });
    events.searchCompleted({
      result_count: ranked.length,
      latency_ms,
      sources: ranked.map((r) => new URL(r.url).hostname),
      rerank_applied: rerankApplied,
    });
    return result;
  } catch (err) {
    // Record latency on the failure path too. Previously only `errors_total`
    // was incremented here, so a search that failed after 40s and one that
    // failed instantly were indistinguishable in the metrics — which is
    // precisely the question asked of this histogram during the 300s stall.
    //
    // `outcome` keeps the two populations separable: folding error latencies
    // into the success distribution unlabelled would corrupt the p99 that the
    // histogram exists to report.
    recordHistogram("search", (Date.now() - t0) / 1000, {
      tool: toolName,
      profile: ctx.profile ?? "default",
      outcome: "error",
    });
    incCounter("errors", {
      tool: toolName,
      stage: "search",
      error_type: err instanceof Error ? err.name : "unknown",
    });
    // Scrubbed: this is a generic sink reached by errors from any source, and
    // it fires even on the single-instance path where the failover-specific
    // redaction above never runs.
    events.error({
      stage: "search",
      error_type: err instanceof Error ? err.name : "unknown",
      message: redactUrlCredentialsInText(
        err instanceof Error ? err.message : String(err),
      ),
    });
    throw err;
  }
}

/**
 * `instrumentTool` + `withSearchEvents` for the search tool, so the tool
 * name is written once per call site. Passing it separately to each would let
 * the span name and the metric label drift apart silently.
 *
 * NOTE: this does NOT make the histogram able to see a hang. Both the success
 * and failure recordings happen after `await fn()` settles, so a call that
 * never returns still records nothing at all. Closing that needs a watchdog
 * timer independent of the awaited promise, which is deliberately out of scope
 * here — see CHANGELOG.
 */
export async function instrumentSearchTool<T>(
  toolName: SearchToolName,
  ctx: SearchEventCtx,
  fn: () => Promise<{
    ranked: SearxResult[];
    result: T;
    rerankApplied: boolean;
  }>,
): Promise<T> {
  return instrumentTool(toolName, () => withSearchEvents(toolName, ctx, fn));
}
