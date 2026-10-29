// Local PDF text extraction — the fetch path's only PDF reader.
//
// No tier in the cascade extracts PDF text: Crawl4AI renders the PDF in a
// browser, finds no text nodes and misfires its anti-bot heuristic, and raw
// fetch reads bodies as UTF-8 text. Firecrawl v2 parsed PDFs natively, and was
// removed in this fork (docs/pi-web-access.md, "If PDFs come back", option 2).
// This replaces it with pdf.js via `unpdf`, in-process and keyless.
//
// Dispatched directly from fetchPage (like github), after the robots gate and
// assertResolvedPublic, and recorded through runTier as `pdf_local`.

import { getDocumentProxy } from "unpdf";
import { ChallengeDetectedError, detectChallenge } from "./challenge.js";
import {
  readBoundedBytes,
  safeFetch,
  type TierResult,
  USER_AGENT,
} from "./fetch-utils.js";

/**
 * A PDF that was fetched and parsed, but whose text cannot be extracted —
 * scanned/image-only, or encrypted with a user password. Unlike every other
 * failure here this is a definitive answer about the document, not about this
 * fetch, so fetchPage surfaces it instead of falling through to a cascade that
 * cannot do better.
 */
export class PdfUnextractableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PdfUnextractableError";
  }
}

export const PDF_NO_TEXT_MESSAGE =
  "PDF has no extractable text layer (scanned?)";
export const PDF_ENCRYPTED_MESSAGE =
  "PDF is password-protected; its text cannot be extracted";

// The spec allows the header anywhere in the first 1024 bytes, and real files
// do carry leading junk (a BOM, a stray newline from a CGI script).
const MAGIC_SEARCH_BYTES = 1024;
const MAX_REDIRECTS = 5;
// Whole-download budget, across redirect hops. Generous: a 20 MB PDF over a
// slow link is a legitimate fetch, and this path replaces a cascade that
// would have spent longer failing.
const DOWNLOAD_TIMEOUT_MS = 30_000;

export interface PdfLimits {
  maxBytes: number;
  maxPages: number;
}

/** Whether the URL's path names a PDF (`.pdf`, any case). Query is ignored. */
export function isPdfUrlPath(url: string): boolean {
  try {
    return /\.pdf$/i.test(new URL(url).pathname);
  } catch {
    // Reviewed (vikunja#687 class sweep): fetchPage has already parsed this
    // URL in assertPublicUrl; an unparseable one is simply not a PDF path.
    return false;
  }
}

/** Whether `bytes` carries the `%PDF-` signature within its first 1 KB. */
export function hasPdfMagic(bytes: Uint8Array): boolean {
  const end = Math.min(bytes.length, MAGIC_SEARCH_BYTES) - 5;
  for (let i = 0; i <= end; i++) {
    if (
      bytes[i] === 0x25 && // %
      bytes[i + 1] === 0x50 && // P
      bytes[i + 2] === 0x44 && // D
      bytes[i + 3] === 0x46 && // F
      bytes[i + 4] === 0x2d // -
    ) {
      return true;
    }
  }
  return false;
}

/**
 * GET a URL, following redirects by hand so every hop goes back through
 * safeFetch. `redirect: "follow"` would re-run the dispatcher's DNS guard on
 * each hop, but a Location naming a private IP *literal* never reaches a DNS
 * lookup — assertPublicUrl, which safeFetch applies per call, is what catches
 * that, so each hop has to be its own call.
 */
async function guardedGet(url: string, signal: AbortSignal): Promise<Response> {
  let current = url;
  for (let hop = 0; ; hop++) {
    const res = await safeFetch(current, {
      headers: {
        "User-Agent": USER_AGENT,
        Accept: "application/pdf,*/*;q=0.8",
      },
      redirect: "manual",
      signal,
    });
    if (res.status < 300 || res.status >= 400) return res;
    res.body?.cancel().catch(() => {});
    const location = res.headers.get("location");
    if (!location || hop >= MAX_REDIRECTS) {
      // Location deliberately omitted from the message (OE-02 parity with
      // raw.ts): a redirect to an internal address must not surface it.
      throw new Error(`PDF redirect not followed (${res.status})`);
    }
    current = new URL(location, current).toString();
  }
}

/** Collapse intra-line whitespace runs and excess blank lines. */
export function normalizePdfText(text: string): string {
  return text
    .split("\n")
    .map((line) => line.replace(/[ \t\f\v ]+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function titleFromUrl(url: string): string {
  try {
    const last = new URL(url).pathname.split("/").filter(Boolean).pop();
    if (!last) return url;
    try {
      return decodeURIComponent(last);
    } catch {
      // Reviewed (vikunja#687 class sweep): a malformed percent-escape in a
      // filename is cosmetic — show it as-is.
      return last;
    }
  } catch {
    // Reviewed (vikunja#687 class sweep): already validated upstream.
    return url;
  }
}

interface TextItemLike {
  str?: string;
  hasEOL?: boolean;
}

/**
 * Extract text from PDF bytes.
 *
 * CPU is bounded two ways: at most `maxPages` pages are walked, and walking
 * stops as soon as the accumulated text reaches `maxChars` (the fetch path's
 * store size — nothing past it would be kept anyway).
 *
 * Throws PdfUnextractableError for an encrypted or text-less document; any
 * other parse failure propagates as-is.
 */
export async function extractPdfText(
  bytes: Uint8Array,
  url: string,
  maxChars: number,
  maxPages: number,
): Promise<{ title: string; text: string }> {
  let pdf: Awaited<ReturnType<typeof getDocumentProxy>>;
  try {
    // This parses arbitrary remote files. The bundled pdf.js build has no
    // `new Function` font-compilation path at all (the CVE-2024-4367 vector;
    // `isEvalSupported` no longer exists to turn off), and font loading is
    // disabled because text extraction does not need glyphs.
    pdf = await getDocumentProxy(bytes, {
      disableFontFace: true,
      useSystemFonts: false,
      verbosity: 0,
    });
  } catch (err) {
    if (err instanceof Error && err.name === "PasswordException") {
      throw new PdfUnextractableError(PDF_ENCRYPTED_MESSAGE);
    }
    throw err;
  }

  try {
    let title = "";
    try {
      const meta = await pdf.getMetadata();
      const info = meta.info as Record<string, unknown> | undefined;
      const raw = info?.Title;
      if (typeof raw === "string") title = raw.trim();
    } catch {
      // Reviewed (vikunja#687 class sweep): metadata is optional decoration;
      // a malformed Info dictionary must not cost the caller the text.
    }

    const pageLimit = Math.min(pdf.numPages, Math.max(1, maxPages));
    const sections: string[] = [];
    let length = 0;
    let pagesRead = 0;
    let anyText = false;
    for (let n = 1; n <= pageLimit && length < maxChars; n++) {
      const page = await pdf.getPage(n);
      const content = await page.getTextContent();
      page.cleanup();
      pagesRead = n;
      let raw = "";
      for (const item of content.items as TextItemLike[]) {
        if (typeof item.str === "string") raw += item.str;
        if (item.hasEOL) raw += "\n";
      }
      const pageText = normalizePdfText(raw);
      if (pageText) anyText = true;
      const section = `--- page ${n} ---\n\n${pageText}`;
      sections.push(section);
      length += section.length + 2;
    }

    if (!anyText) throw new PdfUnextractableError(PDF_NO_TEXT_MESSAGE);

    let text = sections.join("\n\n");
    if (pagesRead < pdf.numPages && length < maxChars) {
      // Stopped by the page cap, not the char budget: say so, or a 300-page
      // report reads as a 50-page one.
      text += `\n\n--- stopped after page ${pagesRead} of ${pdf.numPages} (PDF_MAX_PAGES) ---`;
    }
    return {
      title: title || titleFromUrl(url),
      text: text.slice(0, maxChars),
    };
  } finally {
    // Releases the parsed document and its (in-process) worker state.
    await pdf.loadingTask.destroy().catch(() => {});
  }
}

/**
 * Fetch a URL believed to be a PDF and extract its text.
 *
 * Returns null when the body is not a PDF after all (no `%PDF-` signature —
 * typically an HTML landing page at a `.pdf` path), so runTier books a miss
 * and fetchPage falls through to the cascade. Throws on transport errors,
 * non-OK status, an oversize body, or a parse failure — also fall-through —
 * and PdfUnextractableError, which fetchPage surfaces.
 */
export async function pdfFetch(
  url: string,
  maxChars: number,
  limits: PdfLimits,
): Promise<TierResult | null> {
  const signal = AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS);
  const res = await guardedGet(url, signal);

  // A Cloudflare challenge in front of a PDF: book it as such so the solver
  // gate can fire later in the cascade, exactly as for an HTML page.
  const statusSignal = detectChallenge(res.status, res.headers, null);
  if (statusSignal) {
    res.body?.cancel().catch(() => {});
    throw new ChallengeDetectedError(statusSignal);
  }
  if (!res.ok) {
    res.body?.cancel().catch(() => {});
    throw new Error(`PDF fetch error: ${res.status} ${res.statusText}`);
  }

  const bytes = await readBoundedBytes(res, limits.maxBytes);
  if (!hasPdfMagic(bytes)) return null;

  const { title, text } = await extractPdfText(
    bytes,
    url,
    maxChars,
    limits.maxPages,
  );
  return { title, url, text };
}
