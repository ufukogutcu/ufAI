export interface DiagramPalette {
  surface: string;
  text: string;
  border: string;
  line: string;
}
export type DiagramEngine = (source: string, palette: DiagramPalette, id: string, stageClass: string) => Promise<string>;

export function prepareDiagram(source: string) {
  if (source.length > 20000) throw new Error("Diagram is too large to preview. Its source is available below.");
  return source
    .replace(/^\s*---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, "")
    .replace(/%%\{[\s\S]*?\}%%/g, "");
}

/** One bounded queue per application; Mermaid's configuration and DOM work must not overlap. */
export function createMermaidService(stageClass: string, engine: DiagramEngine = async (...args) => {
  const { renderDiagram } = await import("./mermaid-engine");
  return renderDiagram(...args);
}) {
  let tail = Promise.resolve();
  let pending = 0;
  let sequence = 0;
  const instance = globalThis.crypto.randomUUID();
  return {
    render(source: string, palette: DiagramPalette, signal: AbortSignal): Promise<string> {
      if (signal.aborted) return Promise.reject(new Error("Diagram render cancelled."));
      if (pending >= 16) return Promise.reject(new Error("Too many diagrams to preview at once. Reopen this view to retry."));
      let prepared: string;
      try { prepared = prepareDiagram(source); }
      catch (error) { return Promise.reject(error); }
      pending++;
      const id = `diagram-${instance}-${++sequence}`;
      const result = tail.then(async () => {
        if (signal.aborted) throw new Error("Diagram render cancelled.");
        const svg = await engine(prepared, palette, id, stageClass);
        if (signal.aborted) throw new Error("Diagram render cancelled.");
        return svg;
      }).finally(() => { pending--; });
      tail = result.then(() => {}, () => {});
      return result;
    },
  };
}
