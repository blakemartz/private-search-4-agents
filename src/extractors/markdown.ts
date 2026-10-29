import { JSDOM } from "jsdom";
import TurndownService from "turndown";

// HTML → compact markdown for agent consumption. Used on Readability's
// cleaned `article.content` (and the raw tier's selector fallback) so the
// extracted text keeps block structure — headings, paragraphs, fenced code,
// lists, tables, absolute links — instead of the glued `textContent` stream.

// Languages that carry no information as a fence tag.
const NO_LANGUAGE = new Set([
  "",
  "plain",
  "text",
  "plaintext",
  "none",
  "nohighlight",
]);

function languageOf(el: Element | null): string {
  if (!el) return "";
  const attr = el.getAttribute("data-lang") ?? el.getAttribute("language");
  if (attr) return attr.trim();
  const m = /(?:^|\s)(?:language|lang)-([\w+#.-]+)/.exec(
    el.getAttribute("class") ?? "",
  );
  return m ? m[1] : "";
}

function fence(code: string, lang: string): string {
  const body = code.replace(/\n+$/, "");
  // A fence must be longer than any backtick run inside the block.
  const runs = body.match(/`{3,}/g) ?? [];
  const width = Math.max(3, ...runs.map((r) => r.length + 1));
  const tick = "`".repeat(width);
  const tag = NO_LANGUAGE.has(lang.toLowerCase()) ? "" : lang;
  return `\n\n${tick}${tag}\n${body}\n${tick}\n\n`;
}

function resolveHref(href: string, base: string): string | null {
  const trimmed = href.trim();
  if (!trimmed || trimmed.startsWith("#")) return null;
  try {
    const u = new URL(trimmed, base);
    if (
      u.protocol !== "http:" &&
      u.protocol !== "https:" &&
      u.protocol !== "mailto:"
    ) {
      return null;
    }
    // Same-page anchors (heading permalinks, TOC jumps) are cruft here.
    const page = new URL(base);
    if (
      u.hash &&
      u.origin === page.origin &&
      u.pathname === page.pathname &&
      u.search === page.search
    ) {
      return null;
    }
    return u.href;
  } catch {
    return null;
  }
}

function cellText(service: TurndownService, cell: Element): string {
  return service
    .turndown(cell as HTMLElement)
    .replace(/\s*\n+\s*/g, " ")
    .replace(/\|/g, "\\|")
    .trim();
}

function tableToMarkdown(service: TurndownService, table: Element): string {
  const rows = Array.from(table.querySelectorAll("tr")).filter(
    (tr) => tr.closest("table") === table,
  );
  if (rows.length === 0) return "";
  const grid = rows.map((tr) =>
    Array.from(tr.children)
      .filter((c) => c.tagName === "TD" || c.tagName === "TH")
      .map((c) => ({ el: c, text: cellText(service, c) })),
  );
  const simple =
    table.querySelector("table") === null &&
    grid.every((r) =>
      r.every(
        (c) =>
          (Number(c.el.getAttribute("colspan") ?? 1) || 1) === 1 &&
          (Number(c.el.getAttribute("rowspan") ?? 1) || 1) === 1,
      ),
    ) &&
    new Set(grid.map((r) => r.length)).size === 1 &&
    grid[0].length > 0;

  if (!simple) {
    // Irregular layout: one line per row rather than a misaligned grid.
    const lines = grid
      .map((r) =>
        r
          .map((c) => c.text)
          .filter(Boolean)
          .join(" | "),
      )
      .filter(Boolean);
    return `\n\n${lines.join("\n")}\n\n`;
  }

  const width = grid[0].length;
  const hasHeader = grid[0].every((c) => c.el.tagName === "TH");
  const header = hasHeader ? grid[0].map((c) => c.text) : Array(width).fill("");
  const body = hasHeader ? grid.slice(1) : grid;
  const line = (cells: string[]) => `| ${cells.join(" | ")} |`;
  const out = [
    line(header),
    line(Array(width).fill("---")),
    ...body.map((r) => line(r.map((c) => c.text))),
  ];
  return `\n\n${out.join("\n")}\n\n`;
}

function buildService(baseUrl: string): TurndownService {
  const service = new TurndownService({
    headingStyle: "atx",
    codeBlockStyle: "fenced",
    bulletListMarker: "-",
    emDelimiter: "_",
    hr: "---",
  });
  // Agents read this; backslash-escaping every `_` and `*` in prose
  // (identifiers like read_file, globs like *.ts) is noise, not safety.
  service.escape = (s: string) => s;

  service.remove([
    "script",
    "style",
    "noscript",
    "template",
    "iframe",
    "button",
    "input",
    "select",
    "textarea",
    "canvas",
  ]);
  // Not in turndown's HTML tag map, so it needs a predicate filter. (No
  // "form": ASP.NET-style pages wrap the whole body in one.)
  service.remove((node) => node.nodeName.toLowerCase() === "svg");

  service.addRule("preBlock", {
    filter: "pre",
    replacement: (_content, node) => {
      const pre = node as HTMLElement;
      // Some sites (nodejs docs) put several flavours of one example in a
      // single <pre> as sibling <code> elements next to a toolbar; emit each
      // code element as its own fence and drop the toolbar text.
      const codes = Array.from(pre.children).filter(
        (c) => c.tagName === "CODE",
      );
      if (codes.length === 0) {
        return fence(pre.textContent ?? "", languageOf(pre));
      }
      return codes
        .map((c) =>
          fence(c.textContent ?? "", languageOf(c) || languageOf(pre)),
        )
        .join("");
    },
  });

  service.addRule("image", {
    filter: "img",
    replacement: (_content, node) => {
      const alt = (node as HTMLElement).getAttribute("alt")?.trim();
      return alt ? alt : "";
    },
  });

  // Reference docs link every type mention (`<string>` → MDN) — on
  // nodejs.org/api/fs.html that is ~1,700 links and ~130 KB of repeated URLs.
  // Only the first link to a given target keeps its URL; later ones emit the
  // anchor text alone.
  const seenHrefs = new Set<string>();
  service.addRule("link", {
    filter: (node) => node.nodeName === "A",
    replacement: (content, node) => {
      const text = content.replace(/\s+/g, " ").trim();
      if (!text || text === "#" || text === "¶" || text === "§") return "";
      const href = resolveHref(
        (node as HTMLElement).getAttribute("href") ?? "",
        baseUrl,
      );
      if (!href || seenHrefs.has(href)) return text;
      seenHrefs.add(href);
      return `[${text}](${href})`;
    },
  });

  // Turndown's default pads markers to four columns ("-   item"); a single
  // space is equally valid markdown and cheaper on every list line.
  service.addRule("listItem", {
    filter: "li",
    replacement: (content, node) => {
      const li = node as HTMLElement;
      const parent = li.parentNode as HTMLElement | null;
      let prefix = "- ";
      if (parent?.nodeName === "OL") {
        const start = Number(parent.getAttribute("start")) || 1;
        prefix = `${start + Array.from(parent.children).indexOf(li)}. `;
      }
      const body = content
        .replace(/^\n+/, "")
        .replace(/\n+$/, "\n")
        .replace(/\n/gm, `\n${" ".repeat(prefix.length)}`);
      return prefix + body + (li.nextSibling && !/\n$/.test(body) ? "\n" : "");
    },
  });

  service.addRule("strikethrough", {
    filter: ["del", "s"],
    replacement: (content) => (content.trim() ? `~~${content}~~` : ""),
  });

  service.addRule("table", {
    filter: "table",
    replacement: (_content, node) =>
      tableToMarkdown(service, node as HTMLElement),
  });

  return service;
}

/** Collapse blank-line runs and trailing spaces outside fenced code blocks. */
export function compactMarkdown(md: string): string {
  const out: string[] = [];
  let fenceMarker: string | null = null;
  let blank = 0;
  for (const raw of md.split("\n")) {
    const opener = /^(`{3,}|~{3,})/.exec(raw);
    if (fenceMarker) {
      out.push(raw);
      if (opener && raw.trim() === fenceMarker) fenceMarker = null;
      continue;
    }
    if (opener) {
      fenceMarker = opener[1];
      blank = 0;
      out.push(raw);
      continue;
    }
    const line = raw.replace(/[ \t]+$/, "");
    if (line === "") {
      blank++;
      if (blank > 1) continue;
    } else {
      blank = 0;
    }
    out.push(line);
  }
  return out.join("\n").trim();
}

/**
 * Convert a DOM subtree to compact markdown. `baseUrl` resolves relative
 * links. Returns "" when the subtree holds no text. The node is cloned by
 * turndown, not mutated.
 */
export function nodeToMarkdown(node: Node, baseUrl: string): string {
  const service = buildService(baseUrl);
  return compactMarkdown(service.turndown(node as HTMLElement));
}

/** As {@link nodeToMarkdown}, for an HTML fragment string. */
export function htmlToMarkdown(html: string, baseUrl: string): string {
  const dom = new JSDOM(`<body>${html}</body>`, { url: baseUrl });
  return nodeToMarkdown(dom.window.document.body, baseUrl);
}

/**
 * Length of the prose a markdown string carries — link targets, fence lines
 * and heading/list/table punctuation removed. Lets two markdown candidates
 * from different extractors be compared on content rather than on how many
 * URLs and syntax characters each happens to emit.
 */
export function proseLength(md: string): number {
  return md
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/^(`{3,}|~{3,}).*$/gm, "")
    .replace(/^\s{0,3}(#{1,6}|>|[-*+]|\d+[.)])\s+/gm, "")
    .replace(/^\|?[\s:|-]+\|?$/gm, "")
    .replace(/[|*_`~]/g, "")
    .replace(/\s+/g, " ")
    .trim().length;
}
