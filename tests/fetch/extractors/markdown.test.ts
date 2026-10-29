import { describe, expect, it } from "vitest";
import {
  compactMarkdown,
  htmlToMarkdown,
  proseLength,
} from "../../../src/fetch/extractors/markdown.js";
import {
  preferReadability,
  runReadability,
} from "../../../src/fetch/extractors/readability.js";

const BASE = "https://docs.example.com/api/fs.html";

describe("htmlToMarkdown", () => {
  it("emits ATX headings and separates paragraphs with a blank line", () => {
    const md = htmlToMarkdown(
      "<h2>File system</h2><p>First paragraph.</p><p>Second paragraph.</p><h3>Sub</h3>",
      BASE,
    );
    expect(md).toBe(
      "## File system\n\nFirst paragraph.\n\nSecond paragraph.\n\n### Sub",
    );
  });

  it("fences <pre> verbatim with the language from class=language-x", () => {
    const md = htmlToMarkdown(
      '<pre><code class="language-js">if (a) {\n\n  b();\n}</code></pre>',
      BASE,
    );
    expect(md).toBe("```js\nif (a) {\n\n  b();\n}\n```");
  });

  it("reads lang-x on the <pre> and drops no-information tags like plain", () => {
    expect(htmlToMarkdown('<pre class="lang-py">x = 1</pre>', BASE)).toBe(
      "```py\nx = 1\n```",
    );
    expect(
      htmlToMarkdown(
        '<pre><code data-lang="plain">&gt; PING</code></pre>',
        BASE,
      ),
    ).toBe("```\n> PING\n```");
  });

  it("widens the fence when the code itself contains a backtick fence", () => {
    const md = htmlToMarkdown("<pre>```\ninner\n```</pre>", BASE);
    expect(md).toBe("````\n```\ninner\n```\n````");
  });

  it("keeps inline code inline", () => {
    expect(
      htmlToMarkdown("<p>Call <code>fs.open()</code> first.</p>", BASE),
    ).toBe("Call `fs.open()` first.");
  });

  it("resolves relative links to absolute URLs against the page", () => {
    const md = htmlToMarkdown(
      '<p>See <a href="buffer.html#class-buffer">Buffer</a> and <a href="/guide/">the guide</a>.</p>',
      BASE,
    );
    expect(md).toBe(
      "See [Buffer](https://docs.example.com/api/buffer.html#class-buffer) and [the guide](https://docs.example.com/guide/).",
    );
  });

  it("strips empty links, permalink anchors and same-page jumps", () => {
    const md = htmlToMarkdown(
      '<h3>Promise example<a href="#promise-example">#</a></h3><p><a href="https://x.example/"></a>Jump to <a href="#top">top</a> or <a href="javascript:void(0)">run</a>.</p>',
      BASE,
    );
    expect(md).toBe("### Promise example\n\nJump to top or run.");
  });

  it("keeps the URL only on the first link to a given target", () => {
    const md = htmlToMarkdown(
      '<p><a href="https://mdn.example/string">&lt;string&gt;</a> or <a href="https://mdn.example/string">&lt;string&gt;</a></p>',
      BASE,
    );
    expect(md).toBe("[<string>](https://mdn.example/string) or <string>");
  });

  it("renders lists with compact markers", () => {
    const md = htmlToMarkdown(
      '<ul><li>one</li><li>two<ul><li>nested</li></ul></li></ul><ol start="3"><li>three</li><li>four</li></ol>',
      BASE,
    );
    expect(md).toBe("- one\n- two\n  - nested\n\n3. three\n4. four");
  });

  it("renders blockquotes", () => {
    expect(
      htmlToMarkdown("<blockquote><p>Quoted.</p></blockquote>", BASE),
    ).toBe("> Quoted.");
  });

  it("renders a simple table as GFM, escaping pipes in cells", () => {
    const md = htmlToMarkdown(
      "<table><thead><tr><th>Version</th><th>Changes</th></tr></thead><tbody>" +
        "<tr><td>v20.8.0</td><td>Deprecated <code>fs.F_OK</code>.</td></tr>" +
        "<tr><td>v6.3.0</td><td>a || b</td></tr></tbody></table>",
      BASE,
    );
    expect(md).toBe(
      "| Version | Changes |\n| --- | --- |\n| v20.8.0 | Deprecated `fs.F_OK`. |\n| v6.3.0 | a \\|\\| b |",
    );
  });

  it("falls back to one line per row for tables with spans", () => {
    const md = htmlToMarkdown(
      '<table><tr><th colspan="2">Head</th></tr><tr><td>a</td><td>b</td></tr></table>',
      BASE,
    );
    expect(md).toBe("Head\na | b");
  });

  it("drops images, keeping only alt text", () => {
    expect(
      htmlToMarkdown(
        '<p>Logo: <img src="/l.png" alt="Node.js logo"><img src="/spacer.gif"></p>',
        BASE,
      ),
    ).toBe("Logo: Node.js logo");
  });

  it("does not backslash-escape identifiers in prose", () => {
    expect(htmlToMarkdown("<p>Use read_file with *.ts globs.</p>", BASE)).toBe(
      "Use read_file with *.ts globs.",
    );
  });
});

describe("compactMarkdown", () => {
  it("collapses blank-line runs outside fences but not inside them", () => {
    expect(compactMarkdown("a\n\n\n\nb\n```\nx\n\n\n\ny\n```\n\n\nc  ")).toBe(
      "a\n\nb\n```\nx\n\n\n\ny\n```\n\nc",
    );
  });
});

describe("proseLength", () => {
  it("ignores link targets and markdown syntax", () => {
    expect(
      proseLength("## Title\n\n[text](https://very.long.example/path)"),
    ).toBe("Title text".length);
  });
});

// Regression: nodejs.org/api/fs.html. Readability's textContent glued this into
// "functions.To use the promise-based APIs:import * as fs from
// 'node:fs/promises';\nconst fs = …\njavascriptTo use the callback…" — no
// block boundaries, and the code toolbar's "javascript" label fused onto the
// next sentence.
describe("runReadability on a nodejs-docs-shaped page", () => {
  const filler =
    "<p>All file system operations have synchronous, callback, and promise-based forms, and are accessible using both CommonJS syntax and ES6 Modules (ESM).</p>".repeat(
      6,
    );
  const html = `<!doctype html><html><head><title>File system | Node.js Documentation</title></head><body>
    <nav><a href="index.html">Index</a> <a href="all.html">View on single page</a></nav>
    <main><article>
      <section><h3>Promise example<a class="mark" href="#promise-example">#</a></h3>
      <p>The <code>node:fs</code> module enables interacting with the file system in a
way modeled on standard POSIX functions.</p><p>To use the promise-based APIs:</p><pre class="shiki"><input class="js-flavor-toggle" type="checkbox"><code class="language-mjs mjs" language="mjs">import * as fs from 'node:fs/promises';
</code><code class="cjs language-cjs" language="cjs">const fs = require('node:fs/promises');
</code><div class="code-toolbar">javascript<button class="copy-button">copy</button></div></pre><p>To use the callback and sync APIs:</p>
      ${filler}
      <p>Paths may be a <a href="url.html#the-whatwg-url-api">&lt;URL&gt;</a>.</p>
      </section>
    </article></main></body></html>`;

  it("keeps headings, paragraph breaks, separate fences and absolute links", () => {
    const result = runReadability(html, "https://nodejs.org/api/fs.html");
    expect(result).not.toBeNull();
    const md = result?.text ?? "";
    expect(md).toContain("### Promise example\n\nThe `node:fs` module");
    expect(md).toContain(
      "way modeled on standard POSIX functions.\n\nTo use the promise-based APIs:\n\n```mjs\nimport * as fs from 'node:fs/promises';\n```\n\n```cjs\nconst fs = require('node:fs/promises');\n```\n\nTo use the callback and sync APIs:\n\nAll file system operations",
    );
    expect(md).toContain(
      "[<URL>](https://nodejs.org/api/url.html#the-whatwg-url-api)",
    );
    expect(md).not.toMatch(/javascript|copy|\[#\]/);
    expect(md).not.toMatch(/\.To use|APIs:import/);
    expect(md).not.toMatch(/\n{3,}/);
    expect(md).not.toMatch(/\(ESM\)\.\n(?!\n)/);
  });
});

describe("preferReadability on markdown candidates", () => {
  it("does not let a link-heavy baseline win on URL bytes alone", () => {
    const body = "Readable prose sentence about the topic. ".repeat(30);
    const navHeavy = `${"[Home](https://example.com/a/very/long/navigation/path/that/repeats) ".repeat(40)}${body.slice(0, 600)}`;
    expect(navHeavy.length).toBeGreaterThan(body.length);
    expect(preferReadability({ text: body }, { text: navHeavy })).toBe(true);
  });
});
