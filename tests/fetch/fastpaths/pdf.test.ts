// Unit tests for src/fetch/fastpaths/pdf.ts and readBoundedBytes. Extraction runs through the
// real unpdf/pdf.js against hand-built fixtures (tests/fixtures/pdf), so a
// change in how pdf.js reports text items shows up here, not in production.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  extractPdfText,
  hasPdfMagic,
  isPdfUrlPath,
  normalizePdfText,
  PDF_NO_TEXT_MESSAGE,
  PdfUnextractableError,
} from "../../../src/fetch/fastpaths/pdf.js";
import {
  BodyTooLargeError,
  readBoundedBytes,
} from "../../../src/fetch/utils.js";

const FIXTURES = join(__dirname, "..", "..", "fixtures", "pdf");
const HELLO_PDF = new Uint8Array(readFileSync(join(FIXTURES, "hello.pdf")));
const NO_TEXT_PDF = new Uint8Array(readFileSync(join(FIXTURES, "no-text.pdf")));
const URL = "https://example.com/docs/My%20Report.pdf";

// pdf.js may transfer (detach) the buffer it is given, so each call gets a copy.
const copy = (b: Uint8Array) => new Uint8Array(b);

describe("isPdfUrlPath", () => {
  it.each([
    ["https://example.com/a.pdf", true],
    ["https://example.com/A.PDF", true],
    ["https://example.com/a.pdf?download=1", true],
    ["https://example.com/pdf/1706.03762", false],
    ["https://example.com/a.pdf.html", false],
    ["https://example.com/?file=a.pdf", false],
  ])("%s → %s", (url, expected) => {
    expect(isPdfUrlPath(url)).toBe(expected);
  });
});

describe("hasPdfMagic", () => {
  it("finds the signature at the start", () => {
    expect(hasPdfMagic(HELLO_PDF)).toBe(true);
  });

  it("finds it after leading junk within the first 1 KB", () => {
    const junk = new TextEncoder().encode("\n\n  %PDF-1.7\n");
    expect(hasPdfMagic(junk)).toBe(true);
  });

  it("rejects HTML and empty bodies", () => {
    expect(hasPdfMagic(new TextEncoder().encode("<!doctype html>"))).toBe(
      false,
    );
    expect(hasPdfMagic(new Uint8Array(0))).toBe(false);
  });
});

describe("normalizePdfText", () => {
  it("collapses whitespace runs and blank-line runs", () => {
    expect(normalizePdfText("  a \t b  \n\n\n\nc  d ")).toBe("a b\n\nc d");
  });
});

describe("extractPdfText (real unpdf)", () => {
  it("returns the metadata title and page-marked text", async () => {
    const { title, text } = await extractPdfText(
      copy(HELLO_PDF),
      URL,
      40_000,
      50,
    );
    expect(title).toBe("Fixture Title");
    expect(text).toBe(
      "--- page 1 ---\n\nHello from page one.\nAttention is all you need.\n\n" +
        "--- page 2 ---\n\nSecond page text.",
    );
  });

  it("stops at the page cap and says so", async () => {
    const { text } = await extractPdfText(copy(HELLO_PDF), URL, 40_000, 1);
    expect(text).toContain("Hello from page one.");
    expect(text).not.toContain("Second page text.");
    expect(text).toContain("stopped after page 1 of 2 (PDF_MAX_PAGES)");
  });

  it("stops walking pages once the char budget is reached", async () => {
    const { text } = await extractPdfText(copy(HELLO_PDF), URL, 20, 50);
    expect(text.length).toBeLessThanOrEqual(20);
    expect(text).not.toContain("page 2");
  });

  it("falls back to the filename when there is no Title", async () => {
    // no-text.pdf has no Info dictionary, but it also has no text — so build
    // the title check on a text PDF by stripping its /Info reference.
    const src = new TextDecoder("latin1").decode(HELLO_PDF);
    const stripped = src.replace(/ \/Info \d+ 0 R/, "");
    const bytes = Uint8Array.from(stripped, (c) => c.charCodeAt(0));
    const { title } = await extractPdfText(bytes, URL, 40_000, 50);
    expect(title).toBe("My Report.pdf");
  });

  it("throws PdfUnextractableError for a PDF with no text layer", async () => {
    const err = await extractPdfText(copy(NO_TEXT_PDF), URL, 40_000, 50).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(PdfUnextractableError);
    expect((err as Error).message).toBe(PDF_NO_TEXT_MESSAGE);
  });

  it("propagates a parse failure as an ordinary error", async () => {
    const garbage = new TextEncoder().encode("%PDF-1.4\nnot really a pdf");
    const err = await extractPdfText(garbage, URL, 40_000, 50).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(PdfUnextractableError);
  });
});

describe("readBoundedBytes", () => {
  const streamOf = (...chunks: Uint8Array[]) =>
    new ReadableStream<Uint8Array>({
      start(c) {
        for (const ch of chunks) c.enqueue(ch);
        c.close();
      },
    });

  it("returns the exact bytes of a body under the cap", async () => {
    const res = new Response(HELLO_PDF);
    const out = await readBoundedBytes(res, 10_000);
    expect(Buffer.from(out).equals(Buffer.from(HELLO_PDF))).toBe(true);
  });

  it("is binary-safe — bytes that are not valid UTF-8 survive", async () => {
    const bin = new Uint8Array([0x25, 0xe2, 0xe3, 0xcf, 0xd3, 0xff, 0x00]);
    const out = await readBoundedBytes(new Response(bin), 100);
    expect([...out]).toEqual([...bin]);
  });

  it("refuses a declared Content-Length over the cap before reading", async () => {
    const res = new Response(streamOf(new Uint8Array(10)), {
      headers: { "content-length": "5000" },
    });
    await expect(readBoundedBytes(res, 100)).rejects.toBeInstanceOf(
      BodyTooLargeError,
    );
  });

  it("refuses a streamed body that exceeds the cap with no Content-Length", async () => {
    const res = new Response(
      streamOf(new Uint8Array(60), new Uint8Array(60), new Uint8Array(60)),
    );
    await expect(readBoundedBytes(res, 100)).rejects.toThrow(
      /exceeds 100 bytes/,
    );
  });

  it("yields an empty buffer for a body-less response", async () => {
    const out = await readBoundedBytes(new Response(null, { status: 204 }), 10);
    expect(out.byteLength).toBe(0);
  });
});
