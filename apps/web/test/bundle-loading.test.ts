import assert from "node:assert/strict";
import { test } from "node:test";
import ELK from "elkjs/lib/elk-api.js";
import { extractMermaidGrammars } from "../build/mermaid-grammars";
import { createWorkerElk } from "../src/elk-layout";

function moduleUrl(code: string) {
  return `data:text/javascript;base64,${Buffer.from(code).toString("base64")}`;
}

test("extracted Mermaid grammars preserve JSON escapes and the synchronous parser calls", async () => {
  const grammar = JSON.stringify({ $type: "Grammar", rules: [{ regex: "\\w+", label: 'A "quoted" value\nwith a newline' }] });
  const literal = JSON.stringify(grammar);
  const source = `
    function loadGrammarFromJson(text) { return JSON.parse(text); }
    export function read() { return [loadGrammarFromJson(${literal}), loadGrammarFromJson(\`${literal.slice(1, -1)}\`)]; }
  `;
  const extracted = extractMermaidGrammars(source)!;
  assert.equal(extracted.count, 2);
  const rewritten = extracted.code.replace('"ufai:mermaid-grammars"', JSON.stringify(moduleUrl(extracted.data)));
  const [original, split] = await Promise.all([import(moduleUrl(source)), import(moduleUrl(rewritten))]);
  assert.deepEqual(split.read(), original.read());
  assert.equal(split.read() instanceof Promise, false);
  const data = await import(moduleUrl(extracted.data));
  assert.equal(Object.isFrozen(data.default), true);
});

test("unrelated strings, dynamic grammar expressions and property calls are not rewritten", () => {
  assert.equal(extractMermaidGrammars('const text = "loadGrammarFromJson";'), null);
  assert.equal(extractMermaidGrammars('loadGrammarFromJson(variable);'), null);
  assert.equal(extractMermaidGrammars('loadGrammarFromJson(`{"$type":"Grammar","name":"${name}"}`);'), null);
  assert.equal(extractMermaidGrammars('object.loadGrammarFromJson(\'{"$type":"Grammar"}\');'), null);
  assert.equal(extractMermaidGrammars('loadGrammarFromJson(\'{"other":"value"}\');'), null);
});

class LayoutWorker extends EventTarget {
  onmessage: ((event: { data: unknown }) => void) | null = null;
  terminated = 0;
  requests: { cmd: string; graph?: unknown; layoutOptions?: unknown }[] = [];
  error: string | null = null;
  postMessage(message: { id: number; cmd: string; graph?: unknown }) {
    this.requests.push(structuredClone(message));
    queueMicrotask(() => this.onmessage?.({ data: message.cmd === "layout" && this.error
      ? { id: message.id, error: { message: this.error } }
      : { id: message.id, data: message.cmd === "layout" ? message.graph : true } }));
  }
  terminate() { this.terminated++; }
}

test("ELK uses its worker protocol, returns the result and terminates the worker", async () => {
  const worker = new LayoutWorker();
  const Engine = createWorkerElk(ELK, () => worker as unknown as Worker);
  const graph = { id: "root", children: [{ id: "node", width: 80, height: 30 }] };
  const result = await new Engine().layout(graph, { layoutOptions: { "elk.algorithm": "layered" } });
  assert.deepEqual(result, graph);
  assert.deepEqual(worker.requests.map((r) => r.cmd), ["register", "layout"]);
  assert.deepEqual(worker.requests[1]!.layoutOptions, { "elk.algorithm": "layered" });
  assert.equal(worker.terminated, 1);
});

test("ELK layout failures reject and release their worker", async () => {
  const worker = new LayoutWorker();
  worker.error = "Invalid graph";
  const Engine = createWorkerElk(ELK, () => worker as unknown as Worker);
  await assert.rejects(new Engine().layout({ id: "root" }), (error: unknown) => (error as Error).message === "Invalid graph");
  assert.equal(worker.terminated, 1);
});

test("Mermaid drawing callbacks stay on the UI thread while graph geometry crosses the worker boundary", async () => {
  const worker = new LayoutWorker();
  const Engine = createWorkerElk(ELK, () => worker as unknown as Worker);
  const intersect = () => ({ x: 1, y: 2 });
  const graph = { id: "root", children: [{ id: "node", width: 80, height: 30, intersect }] };
  const result = await new Engine().layout(graph);
  assert.equal(graph.children[0]!.intersect, intersect);
  assert.equal("intersect" in result.children![0]!, false);
  assert.equal(result.children![0]!.width, 80);
  assert.equal(worker.terminated, 1);
});

test("worker startup and message errors reject instead of leaving diagram rendering parked", async () => {
  for (const kind of ["error", "messageerror"]) {
    const worker = new LayoutWorker();
    const Engine = createWorkerElk(ELK, () => worker as unknown as Worker);
    const engine = new Engine();
    worker.dispatchEvent(new Event(kind));
    await assert.rejects(engine.layout({ id: "root" }), /Diagram layout worker/);
    assert.equal(worker.terminated, 1);
  }
});
