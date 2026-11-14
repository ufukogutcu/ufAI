import type { Root as MarkdownRoot } from "mdast";
import type { Element, Root } from "hast";
import type { Construct, State } from "micromark-util-types";
import type {} from "micromark-extension-math";
import type {} from "remark-parse";
import type { Plugin, PluggableList } from "unified";
import { visit } from "unist-util-visit";
import { visitParents, SKIP } from "unist-util-visit-parents";
import { VFile } from "vfile";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import remarkBreaks from "remark-breaks";
import rehypeRaw from "rehype-raw";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
import rehypeSlug from "rehype-slug";
import rehypeKatex from "rehype-katex";
import rehypeHighlight from "rehype-highlight";

/** A tokenizer, rather than string replacement, keeps code and escaped delimiters intact. */
const bracketMath: Construct = {
  name: "bracketMath",
  tokenize(effects, ok, nok) {
    let closing = 0;
    return start;
    function start(code: number | null): State | undefined {
      effects.enter("mathText");
      effects.enter("mathTextSequence");
      effects.consume(code);
      return opening;
    }
    function data(code: number | null): State | undefined {
      if (code === null || code === 92) {
        effects.exit("mathTextData");
        return between(code);
      }
      effects.consume(code);
      return data;
    }
    function between(code: number | null): State | undefined {
      if (code === null) return nok(code);
      if (code === 92) {
        effects.enter("mathTextSequence");
        effects.consume(code);
        return possibleClose;
      }
      effects.enter("mathTextData");
      return data(code);
    }
    function opening(code: number | null): State | undefined {
      if (code !== 40 && code !== 91) return nok(code);
      closing = code === 40 ? 41 : 93;
      effects.consume(code);
      effects.exit("mathTextSequence");
      return between;
    }
    function possibleClose(code: number | null): State | undefined {
      if (code === closing) {
        effects.consume(code);
        effects.exit("mathTextSequence");
        effects.exit("mathText");
        return ok;
      }
      // A non-closing backslash is part of the expression, including doubled slashes.
      const token = effects.exit("mathTextSequence");
      token.type = "mathTextData";
      if (code === 92) {
        effects.enter("mathTextData");
        effects.consume(code);
        effects.exit("mathTextData");
        return between;
      }
      return between(code);
    }
  },
};

const remarkBracketMath: Plugin<[], MarkdownRoot> = function () {
  const data = this.data();
  (data.micromarkExtensions ??= []).push({ text: { 92: bracketMath } });
  return (tree, file) => {
    visit(tree, "inlineMath", (node) => {
      const start = node.position?.start.offset;
      if (start !== undefined && String(file).slice(start, start + 2) === "\\[") {
        node.data ??= {};
        node.data.hProperties = { className: ["language-math", "math-display"] };
      }
    });
  };
};

const callouts = new Set(["NOTE", "TIP", "IMPORTANT", "WARNING", "CAUTION"]);
const remarkCallouts: Plugin<[], MarkdownRoot> = () => (tree) => {
  visit(tree, "blockquote", (node) => {
    const paragraph = node.children[0];
    const text = paragraph?.type === "paragraph" ? paragraph.children[0] : undefined;
    if (text?.type !== "text") return;
    const match = /^\[!([A-Z]+)\](?:\r?\n|$)/.exec(text.value);
    if (!match || !callouts.has(match[1]!)) return;
    const label = match[1]!.toLowerCase();
    text.value = text.value.slice(match[0].length);
    node.data = { hProperties: { dataCallout: label } };
    node.children.unshift({
      type: "paragraph",
      children: [{ type: "strong", children: [{ type: "text", value: label[0]!.toUpperCase() + label.slice(1) }] }],
    });
  });
};

export const remarkPlugins: PluggableList = [remarkGfm, remarkMath, remarkBracketMath, remarkCallouts, remarkBreaks];

export function richTextPrefix(id: string) {
  return `rt-${Array.from(id, (c) => c.codePointAt(0)!.toString(16)).join("-")}-`;
}

/** No script/data/file URLs; image requests cannot target arbitrary local API routes. */
export function safeRichTextUrl(value: string, key: string): string | undefined {
  const url = value.trim();
  if (!url || /[\u0000-\u0020\u007f\\]/.test(url)) return undefined;
  if (key === "href" && url.startsWith("#")) return url;
  if (url.startsWith("//")) return `https:${url}`;
  if (/^https?:\/\//i.test(url)) return url;
  if (key === "href" && /^mailto:/i.test(url)) return url;
  if (/^[\w+.-]+:/.test(url)) return undefined;
  if (key === "src") {
    return /^\/api\/artifact-versions\/[^/?#]+\/preview$/.test(url) ? url : undefined;
  }
  return url;
}

function textContent(node: Element): string {
  return node.children.map((child) => child.type === "text" ? child.value : child.type === "element" ? textContent(child) : "").join("");
}

/** Save exact code before highlighters split it into spans, and bound expensive transforms. */
const rehypePrepare: Plugin<[], Root> = () => (tree) => {
  visit(tree, "element", (node, _index, parent) => {
    const classes = node.properties.className;
    if (node.tagName !== "code") return;
    const source = textContent(node);
    if (parent?.type === "element" && parent.tagName === "pre") {
      parent.properties.dataCode = source.endsWith("\n") ? source.slice(0, -1) : source;
      parent.properties.dataLanguage = Array.isArray(classes)
        ? String(classes.find((value) => String(value).startsWith("language-")) ?? "").slice(9)
        : "";
    }
    const math = Array.isArray(classes) && classes.some((c) => ["language-math", "math-inline", "math-display"].includes(String(c)));
    if (source.length > (math ? 12000 : 100000)) node.properties.className = ["no-highlight"];
  });
};

const rehypeLocalLinks: Plugin<[string], Root> = (prefix) => (tree) => {
  visit(tree, "element", (node) => {
    for (const key of ["href", "src"] as const) {
      if (typeof node.properties[key] === "string") {
        const safe = safeRichTextUrl(node.properties[key], key);
        if (safe) node.properties[key] = safe;
        else delete node.properties[key];
      }
    }
    if (typeof node.properties.href === "string" && node.properties.href.startsWith("#")) {
      node.properties.href = `#${prefix}${node.properties.href.slice(1)}`;
    }
  });
};

/** KaTeX's recovery can partially rewrite invalid expressions; keep their complete source instead. */
const rehypeCheckedMath: Plugin<[], Root> = () => {
  const render = rehypeKatex({ trust: false, strict: "ignore", maxExpand: 1000, maxSize: 20, errorColor: "currentColor" });
  return (tree) => {
    visitParents(tree, "element", (node, parents) => {
      const classes = node.properties.className;
      if (node.tagName !== "code" || !Array.isArray(classes) || !classes.some((c) => ["language-math", "math-inline", "math-display"].includes(String(c)))) return;
      let scope = node;
      let parent = parents.at(-1)!;
      if (parent.type === "element" && parent.tagName === "pre") {
        scope = parent;
        parent = parents.at(-2)!;
      }
      const source = textContent(node);
      const fragment: Root = { type: "root", children: [scope] };
      const file = new VFile();
      render(fragment, file);
      if (file.messages.length) {
        const fallback: Element = { type: "element", tagName: "code", properties: { className: ["math-fallback"], title: "Equation could not be rendered; original source shown." }, children: [{ type: "text", value: source }] };
        fragment.children = [scope === node ? fallback : { type: "element", tagName: "pre", properties: { dataCode: source, dataLanguage: "math" }, children: [fallback] }];
      }
      parent.children.splice(parent.children.indexOf(scope), 1, ...fragment.children as Element[]);
      return SKIP;
    });
  };
};

export function richTextRehypePlugins(id: string): PluggableList {
  const prefix = richTextPrefix(id);
  return [
    rehypeRaw,
    rehypeSlug,
    [rehypeSanitize, {
      ...defaultSchema,
      clobberPrefix: prefix,
      tagNames: ["a", "blockquote", "br", "code", "del", "details", "div", "em", "h1", "h2", "h3", "h4", "h5", "h6", "hr", "img", "input", "kbd", "li", "mark", "ol", "p", "pre", "section", "span", "strong", "sub", "summary", "sup", "table", "tbody", "td", "th", "thead", "tr", "ul"],
      attributes: {
        ...defaultSchema.attributes,
        blockquote: ["dataCallout"],
        code: [["className", /^language-/, "math-inline", "math-display"]],
        input: [["type", "checkbox"], ["disabled", true], "checked"],
        details: ["open"],
      },
    }],
    rehypePrepare,
    rehypeCheckedMath,
    [rehypeHighlight, { detect: false, ignoreMissing: true, plainText: ["mermaid", "math"] }],
    [rehypeLocalLinks, prefix],
  ];
}
