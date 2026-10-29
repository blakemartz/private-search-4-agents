// The MCP tool surface: three agent tools (search, fetch_url, crawl_site),
// two opt-in operator tools, and the server instructions sent at initialize.
// Each tool lives in its own module with its handler, schemas and
// registration; this file only wires them up.
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ADMIN_TOOLS_ENABLED } from "../../core/config.js";
import { registerAdminTools } from "./admin.js";
import { domainProfileSchema } from "./args.js";
import { registerCrawlSiteTool } from "./crawl-site.js";
import { registerFetchUrlTool } from "./fetch-url.js";
import { registerSearchTool } from "./search.js";

export {
  DomainStatsOutputSchema,
  handleClearCache,
  handleDomainStats,
} from "./admin.js";
export { BoolArg } from "./args.js";
export { handleCrawlSite } from "./crawl-site.js";
export { type FetchUrlArgs, handleFetchUrl } from "./fetch-url.js";
export {
  type ContentMode,
  filterDomains,
  handleSearch,
  mergeHits,
  type SearchArgs,
} from "./search.js";

export const SERVER_INSTRUCTIONS = [
  "Private web search: your own SearXNG instance, a local reranker, local page fetching and a local LLM. Nothing goes to a third-party search API.",
  'Typical flow: `search` (pass several phrasings as a `query` array for research questions; `content: "highlights"` returns the most relevant passages of each top page), then `fetch_url` the promising results (an array reads several at once; `query` returns the passages answering a question).',
  "`search` with `answer: true` adds a cited synthesis from a local model — check its citations; if it cannot be produced the response leads with a `--- summarization unavailable ---` marker and carries the pages instead.",
  "Long pages are windowed: follow the `offset=` hint in the footer to continue, or pass `find` for literal matches. Paging is served from cache; `fresh: true` bypasses it.",
  "`crawl_site` maps a docs site into a URL list; its pages are then cached for `fetch_url`.",
].join("\n");

export function registerTools(server: McpServer): void {
  // Built once per server so search and fetch_url advertise the same enum.
  const DomainProfileSchema = domainProfileSchema();
  registerSearchTool(server, DomainProfileSchema);
  registerFetchUrlTool(server, DomainProfileSchema);
  registerCrawlSiteTool(server);

  // Operator tools. Off by default: clear_cache wipes cache shared by every
  // agent on the box, and domain_stats is a diagnostic an agent mid-task has no
  // use for — together they were ~5k chars of schema in every agent's context.
  // The same data is available to operators through the config/stats MCP
  // resources and the dump-domain CLI.
  if (!ADMIN_TOOLS_ENABLED) return;
  registerAdminTools(server);
}
