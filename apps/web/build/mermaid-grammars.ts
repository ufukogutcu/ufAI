import { parse } from "acorn";
import { simple } from "acorn-walk";
import type { Plugin } from "vite";

const virtualId = "\0ufai:mermaid-grammars";

/** Split the upstream parser's embedded grammar data without changing its synchronous API. */
export function extractMermaidGrammars(code: string) {
  const source = parse(code, { ecmaVersion: "latest", sourceType: "module" });
  const literals: { start: number; end: number; raw: string }[] = [];
  simple(source, { CallExpression(node) {
    if (node.callee.type === "Identifier" && node.callee.name === "loadGrammarFromJson") {
      const argument = node.arguments[0];
      const value = argument?.type === "Literal" ? argument.value : argument?.type === "TemplateLiteral" && !argument.expressions.length ? argument.quasis[0]?.value.cooked : null;
      if (argument && typeof value === "string" && value.startsWith('{"$type":"Grammar"')) {
        literals.push({ start: argument.start, end: argument.end, raw: code.slice(argument.start, argument.end) });
      }
    }
  } });
  if (!literals.length) return null;
  let transformed = code;
  for (let index = literals.length - 1; index >= 0; index--) {
    const literal = literals[index]!;
    transformed = transformed.slice(0, literal.start) + `__ufaiMermaidGrammars[${index}]` + transformed.slice(literal.end);
  }
  return {
    code: `import __ufaiMermaidGrammars from "${virtualId.slice(1)}";\n${transformed}`,
    // Freeze the collection so cross-module constant inlining cannot duplicate its strings.
    data: `export default Object.freeze([${literals.map((literal) => literal.raw).join(",\n")}]);`,
    count: literals.length,
  };
}

export function mermaidGrammarChunks(): Plugin {
  let data = "";
  let dataModule: string | undefined;
  return {
    name: "ufai-mermaid-grammar-chunks",
    apply: "build",
    resolveId(id) { if (id === virtualId.slice(1)) return virtualId; },
    load(id) { if (id === virtualId) return data; },
    transform(code, id) {
      if (!id.includes("/@mermaid-js/parser/") || !id.endsWith(".mjs") || !code.includes("loadGrammarFromJson")) return;
      const result = extractMermaidGrammars(code);
      if (!result) return;
      if (dataModule && dataModule !== id) this.error("Mermaid grammar data appeared in multiple modules; review the upstream parser bundle.");
      dataModule = id;
      data = result.data;
      return { code: result.code, map: null };
    },
  };
}

/** Keep Vite's configured warning threshold enforceable when vendor packages change. */
export function enforceChunkLimit(): Plugin {
  let limit = 500000;
  return {
    name: "ufai-chunk-limit",
    apply: "build",
    configResolved(config) { limit = config.build.chunkSizeWarningLimit * 1000; },
    generateBundle(_options, bundle) {
      const oversized = Object.values(bundle).filter((item) => item.type === "chunk" && Buffer.byteLength(item.code) > limit);
      if (oversized.length) this.error(`JavaScript chunks exceed the ${limit / 1000} kB limit: ${oversized.map((item) => item.fileName).join(", ")}`);
    },
  };
}
