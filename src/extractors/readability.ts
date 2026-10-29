import { Readability } from "@mozilla/readability";
import { JSDOM } from "jsdom";
import { htmlToMarkdown, nodeToMarkdown, proseLength } from "./markdown.js";

export interface ReadabilityResult {
  title?: string;
  /** Markdown built from Readability's cleaned article HTML. */
  text: string;
}

type ParsedArticle = {
  title?: string | null;
  content?: Node | string | null;
  textContent?: string | null;
};

/**
 * Markdown for a parsed Readability article. Readability's `textContent`
 * concatenates text nodes with no separators ("functions.To use the
 * promise-based APIs:import * as fs…"), so the structure has to come from the
 * cleaned `content` HTML. Falls back to `textContent` only if conversion
 * yields nothing.
 */
export function articleToMarkdown(
  article: ParsedArticle | null | undefined,
  url: string,
): string | null {
  if (!article) return null;
  const { content } = article;
  const md = !content
    ? ""
    : typeof content === "string"
      ? htmlToMarkdown(content, url)
      : nodeToMarkdown(content, url);
  if (md) return md;
  const plain = article.textContent?.trim();
  return plain ? plain : null;
}

/**
 * Readability options shared by every caller: keep classes so code-block
 * language hints (`language-js`, `lang-py`) survive into the cleaned HTML,
 * and hand back the cleaned element itself rather than serialized HTML —
 * re-parsing that string would cost a second JSDOM pass per page.
 */
export const READABILITY_OPTIONS = {
  keepClasses: true,
  serializer: (node: Node): Node => node,
};

export function runReadability(
  html: string,
  url: string,
): ReadabilityResult | null {
  try {
    const dom = new JSDOM(html, { url });
    const reader = new Readability(dom.window.document, READABILITY_OPTIONS);
    const article = reader.parse();
    if (!article?.textContent) return null;
    const text = articleToMarkdown(article, url);
    if (!text) return null;
    return {
      title: article.title ?? undefined,
      text,
    };
  } catch {
    // Reviewed (vikunja#687 class sweep): pure local parse over HTML already
    // in hand. Null means "could not extract an article", which is true.
    return null;
  }
}

const MIN_TEXT_CHARS = 500;

/**
 * Whether Readability's markdown should replace the tier's own markdown.
 * Both sides are markdown, so they are compared on prose length (link
 * targets and syntax stripped), not raw length: otherwise a nav-heavy
 * candidate wins on URL bytes and a structured one on fence/heading chars.
 */
export function preferReadability(
  readability: ReadabilityResult | null,
  current: { text: string },
): boolean {
  if (!readability) return false;
  const currentLen = proseLength(current.text);
  if (currentLen < MIN_TEXT_CHARS) return true;
  return proseLength(readability.text) > currentLen;
}
