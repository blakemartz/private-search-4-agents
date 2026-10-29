// crawl_site — map a site into a page manifest; the pages land in the fetch
// cache for follow-up fetch_url calls.
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { CRAWL_MAX_PAGES_DEFAULT } from "../../core/config.js";
import { events } from "../../core/events.js";
import { incCounter, recordHistogram } from "../../core/observability.js";
import { crawlSite, formatCrawlManifest } from "../../fetch/crawl.js";
import { BoolArg } from "./args.js";
import { instrumentTool } from "./instrument.js";

export async function handleCrawlSite({
  url,
  max_pages,
  same_domain_only,
  include_path,
  exclude_path,
}: {
  url: string;
  max_pages: number;
  same_domain_only: boolean;
  include_path?: string;
  exclude_path?: string;
}) {
  return instrumentTool("crawl_site", async () => {
    const t0 = Date.now();
    events.crawlRequested({ url, max_pages, same_domain_only });
    const manifest = await crawlSite(
      url,
      max_pages,
      same_domain_only,
      include_path,
      exclude_path,
    );
    const latency_ms = Date.now() - t0;
    events.crawlCompleted({
      url,
      strategy: manifest.strategy,
      page_count: manifest.page_count,
      latency_ms,
      cached: manifest.cached,
    });
    incCounter("crawl", {
      outcome: manifest.strategy === "error" ? "error" : "success",
    });
    recordHistogram("tool.crawl_site", latency_ms / 1000, {});
    return {
      content: [{ type: "text" as const, text: formatCrawlManifest(manifest) }],
    };
  });
}

export function registerCrawlSiteTool(server: McpServer): void {
  server.registerTool(
    "crawl_site",
    {
      title: "Crawl site",
      description:
        "Map a site (sitemap, else link-following if enabled) into a URL/title/snippet list; pages are cached for fetch_url. A start URL with a path stays under it; include_path '/' crawls the whole site.",
      inputSchema: {
        url: z.string().url().describe("Site root or docs URL"),
        max_pages: z.coerce
          .number()
          .int()
          .min(1)
          .max(100)
          .default(CRAWL_MAX_PAGES_DEFAULT)
          .describe(`Page cap (default ${CRAWL_MAX_PAGES_DEFAULT})`),
        same_domain_only: BoolArg.default(true).describe(
          "Stay on the start domain (default true)",
        ),
        include_path: z
          .string()
          .optional()
          .describe(
            "Only URLs under this path prefix; replaces the default scope",
          ),
        exclude_path: z
          .string()
          .optional()
          .describe("Skip URLs under this path prefix"),
      },
    },
    handleCrawlSite,
  );
}
