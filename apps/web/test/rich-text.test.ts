import assert from "node:assert/strict";
import { test } from "node:test";
import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkRehype from "remark-rehype";
import rehypeStringify from "rehype-stringify";
import { JSDOM } from "jsdom";
import { remarkPlugins, richTextRehypePlugins, richTextPrefix, safeRichTextUrl } from "../src/rich-text";
import { createMermaidService, prepareDiagram, type DiagramPalette } from "../src/mermaid-service";

function render(content: string, id = "message") {
  return String(unified().use(remarkParse).use(remarkPlugins)
    .use(remarkRehype, { allowDangerousHtml: true, clobberPrefix: "" })
    .use(richTextRehypePlugins(id)).use(rehypeStringify).processSync(content));
}
function document(content: string, id?: string) {
  return new JSDOM(render(content, id)).window.document;
}

test("renders headings, emphasis, paragraphs, breaks, nested lists, quotes and rules", () => {
  const doc = document("# Heading\n\n**Bold**, *italic*, ~~gone~~, `literal` and \\*escaped\\*.\nNext line\n\n1. First\n   - Nested\n2. Second\n\n> A quote\n\n---");
  for (const selector of ["h1", "strong", "em", "del", "code", "br", "ol li ul li", "blockquote", "hr"]) assert.ok(doc.querySelector(selector), selector);
  assert.match(doc.body.textContent!, /\*escaped\*/);
});

test("renders aligned tables, read-only tasks, callouts, reference and automatic links", () => {
  const doc = document("| Left | Right |\n| :--- | ---: |\n| A | B |\n\n- [x] Done\n- [ ] Next\n\n> [!WARNING]\n> Be careful.\n\n[Reference][ref] https://example.com person@example.com\n\n[ref]: https://example.org");
  assert.equal(doc.querySelector("th:last-child")?.getAttribute("align"), "right");
  assert.equal(doc.querySelectorAll('input[type="checkbox"][disabled]').length, 2);
  assert.ok(doc.querySelector('input[checked]'));
  assert.equal(doc.querySelector('blockquote[data-callout="warning"] strong')?.textContent, "Warning");
  assert.equal(doc.querySelectorAll("a").length, 3);
});

test("heading anchors and footnotes are isolated between messages, with matching references", () => {
  const source = "# Heading\n\n[Jump](#heading)\n\nA note[^a].\n\n[^a]: Footnote";
  const a = document(source, "one"), b = document(source, "two");
  assert.notEqual(a.querySelector("h1")?.id, b.querySelector("h1")?.id);
  for (const doc of [a, b]) {
    for (const link of doc.querySelectorAll('a[href^="#"]')) {
      const id = decodeURIComponent(link.getAttribute("href")!.slice(1));
      assert.ok(doc.getElementById(id), `Missing anchor ${id}`);
    }
    for (const node of doc.querySelectorAll("[aria-describedby]")) assert.ok(doc.getElementById(node.getAttribute("aria-describedby")!));
  }
  assert.notEqual(richTextPrefix("a-b"), richTextPrefix("ab"));
});

test("highlights known code and preserves exact source for Copy; unknown code stays readable", () => {
  const source = 'const message = "hello";\nconsole.log(message);';
  const doc = document('```js\n' + source + '\n```\n\n```unknown-language\n<a>raw</a>\n```\n\n    indented\n');
  assert.ok(doc.querySelector(".hljs-keyword"));
  assert.equal(doc.querySelector("pre")?.getAttribute("data-code"), source);
  assert.equal(doc.querySelector("pre")?.getAttribute("data-language"), "js");
  assert.match(doc.body.textContent!, /<a>raw<\/a>/);
  assert.match(doc.body.textContent!, /indented/);
});

test("renders dollar and bracket math, including multiline display and commands", () => {
  const doc = document(String.raw`Inline $x^2$ and \(\frac{1}{2}\).` + '\n\n' + String.raw`\[
\sum_{i=1}^{n} i
\]` + '\n\n$$\na+b\n$$');
  assert.equal(doc.querySelectorAll(".katex").length, 4);
  assert.equal(doc.querySelectorAll(".katex-display").length, 2);
  assert.ok(doc.querySelector("math"));
});

test("code and escaped math delimiters stay literal; malformed math keeps readable source", () => {
  const doc = document(String.raw`\$5 and \\(literal\\), \(unfinished` + '\n\n' + '`\\(x\\) $y$`\n\n```text\n\\[z\\]\n```\n\n$\\unknowncommand{x}$');
  assert.match(doc.body.textContent!, /\$5/);
  assert.match(doc.body.textContent!, /\\\(x\\\) \$y\$/);
  assert.ok(doc.querySelector(".math-fallback"));
  assert.equal(doc.querySelector(".math-fallback")!.textContent, String.raw`\unknowncommand{x}`);
  assert.equal(doc.querySelectorAll(".katex").length, 0);
});

test("safe HTML formatting survives while active content and author styles are removed", () => {
  const doc = document('<details open><summary>More</summary><p><kbd>Ctrl</kbd><br><sup>2</sup><sub>n</sub><mark>Marked</mark></p></details>\n\n<script>alert(1)</script><iframe src="https://example.com"></iframe><form><input type="text"></form><svg onload="alert(1)"></svg>\n\n<p style="color:red" onclick="alert(1)">Safe</p>');
  for (const selector of ["details[open]", "summary", "kbd", "br", "sup", "sub", "mark"]) assert.ok(doc.querySelector(selector), selector);
  assert.equal(doc.querySelector("script, iframe, form, svg, [onclick], [onload], [style]"), null);
});

test("unsafe URLs and local API image targets are blocked; web and artifact images remain", () => {
  const doc = document('[bad](javascript:alert%281%29) ![bad](data:image/png;base64,AA) ![local](/api/settings)\n\n![web](https://example.com/picture.png) ![artifact](/api/artifact-versions/version/preview)');
  assert.equal(doc.querySelector("a[href]"), null);
  const sources = Array.from(doc.querySelectorAll("img[src]"), (img) => img.getAttribute("src"));
  assert.deepEqual(sources, ["https://example.com/picture.png", "/api/artifact-versions/version/preview"]);
  for (const value of ["javascript:alert(1)", "java\nscript:bad", "file:///etc/passwd", "data:text/html,test", "\\\\host\\x"]) assert.equal(safeRichTextUrl(value, "href"), undefined);
  assert.equal(safeRichTextUrl("mailto:person@example.com", "href"), "mailto:person@example.com");
});

test("untrusted math cannot fetch images or expose HTML and expensive inputs retain their source", () => {
  const doc = document(String.raw`$\includegraphics{https://example.com/x}$ $\htmlClass{evil}{x}$` + '\n\n```math\n' + 'x'.repeat(12001) + '\n```\n\n```js\n' + 'a'.repeat(100001) + '\n```');
  assert.equal(doc.querySelector("img, .evil"), null);
  assert.equal(doc.querySelectorAll(".no-highlight").length, 2);
});

test("incomplete streaming fragments and malformed markup can be reparsed without changing source", () => {
  const source = '# Heading\n\n**unfinished\n\n| A | B |\n| --- | --- |\n| x |\n\n```mermaid\ngraph TD\n A-->';
  for (let length = 1; length <= source.length; length++) assert.doesNotThrow(() => render(source.slice(0, length)));
  assert.equal(document(source).querySelector("pre")?.getAttribute("data-language"), "mermaid");
});

const palette: DiagramPalette = { surface: "surface", text: "text", border: "border", line: "line" };
test("diagram source configuration is ignored and oversized diagrams are rejected", () => {
  assert.equal(prepareDiagram('---\nconfig:\n  securityLevel: loose\n---\n%%{init: {"theme":"dark"}}%%\ngraph TD; A-->B').trim(), "graph TD; A-->B");
  assert.throws(() => prepareDiagram("x".repeat(20001)), /too large/);
});

test("diagram service serializes renders and rejects obsolete or cancelled results", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const calls: string[] = [];
  const service = createMermaidService("stage", async (source) => { calls.push(source); if (source === "first") await gate; return source; });
  const firstController = new AbortController(), secondController = new AbortController();
  const first = service.render("first", palette, firstController.signal);
  const rejected = assert.rejects(first, /cancelled/);
  const second = service.render("second", palette, secondController.signal);
  await Promise.resolve();
  assert.deepEqual(calls, ["first"]);
  firstController.abort(); release();
  await rejected;
  assert.equal(await second, "second");
  secondController.abort();
  await assert.rejects(service.render("third", palette, secondController.signal), /cancelled/);
  assert.deepEqual(calls, ["first", "second"]);
});

test("diagram failures do not poison later renders and queue growth is bounded", async () => {
  const service = createMermaidService("stage", async (source) => { if (source === "bad") throw new Error("parse error"); return source; });
  const signal = new AbortController().signal;
  await assert.rejects(service.render("bad", palette, signal), /parse error/);
  assert.equal(await service.render("good", palette, signal), "good");
  const queued = Array.from({ length: 16 }, () => service.render("queued", palette, signal));
  await assert.rejects(service.render("overflow", palette, signal), /Too many/);
  await Promise.all(queued);
});
