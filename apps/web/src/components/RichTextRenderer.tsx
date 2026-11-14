import {
  createContext, useContext, useEffect, useMemo, useState, type MouseEvent,
} from "react";
import Markdown, { type Components } from "react-markdown";
import { DiagramContext } from "./RichTextContext";
import { remarkPlugins, richTextRehypePlugins, safeRichTextUrl } from "../rich-text";
import "katex/dist/katex.min.css";
import styles from "./RichText.module.scss";

export function CopyCode({ source }: { source: string }) {
  const [feedback, setFeedback] = useState({ source: "", status: "" });
  async function copy() {
    try {
      await navigator.clipboard.writeText(source);
      setFeedback({ source, status: "Copied" });
    } catch {
      setFeedback({ source, status: "Copy failed; select and copy the code." });
    }
  }
  return <span className={styles.copy}>
    <button type="button" className="textButton" onClick={() => void copy()} aria-label="Copy code">Copy</button>
    <span role="status" className={styles.feedback}>{feedback.source === source ? feedback.status : ""}</span>
  </span>;
}

function InlineImage({ src, alt, title }: { src?: string; alt?: string; title?: string }) {
  const [failed, setFailed] = useState(false);
  if (!src || failed) return <span className={styles.imageFailure}>Image unavailable{alt ? `: ${alt}` : ""}</span>;
  return <img src={src} alt={alt ?? ""} title={title} width={640} height={360} loading="lazy" decoding="async" referrerPolicy="no-referrer" className={styles.image} onError={() => setFailed(true)} />;
}

function Diagram({ source, streaming }: { source: string; streaming: boolean }) {
  const context = useContext(DiagramContext);
  const [result, setResult] = useState<{ url?: string; error?: string }>({});
  useEffect(() => {
    if (streaming || !context) return;
    const controller = new AbortController();
    let url: string | undefined;
    setResult({});
    void context.service.render(source, context.palette, controller.signal).then((svg) => {
      if (controller.signal.aborted) return;
      url = URL.createObjectURL(new Blob([svg], { type: "image/svg+xml" }));
      setResult({ url });
    }).catch((error: unknown) => {
      if (!controller.signal.aborted) setResult({ error: error instanceof Error ? error.message : "Diagram preview unavailable." });
    });
    return () => { controller.abort(); if (url) URL.revokeObjectURL(url); };
  }, [context, source, streaming]);
  return <div className={styles.diagram}>
    <div className={styles.codeHeader}><span>Mermaid diagram</span><CopyCode source={source} /></div>
    {!streaming && result.url && <div className={styles.scroll} tabIndex={0} role="region" aria-label="Diagram preview">
      {/* SVG is an isolated image, never injected into the application's DOM. */}
      <img src={result.url} alt="Mermaid diagram; its text description is available in Diagram source below." className={styles.diagramImage} />
    </div>}
    {!streaming && !result.url && <p role="status" className={styles.feedback}>{result.error ? `Diagram preview unavailable: ${result.error}` : context ? "Rendering diagram…" : "Diagram preview unavailable."}</p>}
    {streaming || !result.url ? <pre tabIndex={0} className={styles.source}><code>{source}</code></pre> :
      <details><summary>Diagram source</summary><pre tabIndex={0} className={styles.source}><code>{source}</code></pre></details>}
  </div>;
}

function followLocalLink(event: MouseEvent<HTMLAnchorElement>) {
  const href = event.currentTarget.getAttribute("href");
  if (!href?.startsWith("#")) return;
  event.preventDefault();
  let id: string;
  try { id = decodeURIComponent(href.slice(1)); } catch { return; }
  const target = document.getElementById(id);
  if (!target || !event.currentTarget.closest("[data-rich-text]")?.contains(target)) return;
  target.tabIndex = -1;
  target.focus({ preventScroll: true });
  target.scrollIntoView({ block: "nearest" });
}

const remarkRehypeOptions = { clobberPrefix: "" };

const StreamingContext = createContext(false);
const components: Components = {
    a({ href, children, title, node: _node, ...props }) {
      const safe = href ? safeRichTextUrl(href, "href") : undefined;
      if (!safe) return <span>{children}</span>;
      return <a {...props} href={safe} title={title} target={safe.startsWith("#") || safe.startsWith("mailto:") ? undefined : "_blank"} rel="noopener noreferrer" onClick={followLocalLink}>{children}</a>;
    },
    img({ src, alt, title }) {
      const safe = typeof src === "string" ? safeRichTextUrl(src, "src") : undefined;
      return <InlineImage key={safe} src={safe} alt={alt} title={title} />;
    },
    input({ checked }) {
      return <input type="checkbox" checked={!!checked} disabled aria-label={checked ? "Completed item" : "Incomplete item"} />;
    },
    span({ node: _node, className, children, ...props }) {
      const displayMath = className?.split(" ").includes("katex-display");
      return <span {...props} className={className} tabIndex={displayMath ? 0 : undefined} role={displayMath ? "region" : undefined} aria-label={displayMath ? "Equation" : undefined}>{children}</span>;
    },
    table({ children }) {
      return <div className={styles.scroll} tabIndex={0} role="region" aria-label="Table"><table>{children}</table></div>;
    },
    pre: function MarkdownCodeBlock({ node, children }) {
      const streaming = useContext(StreamingContext);
      const source = String(node?.properties.dataCode ?? "");
      const language = String(node?.properties.dataLanguage ?? "");
      if (language.toLowerCase() === "mermaid") return <Diagram source={source} streaming={streaming} />;
      return <div className={styles.codeBlock}>
        <div className={styles.codeHeader}><span>{language || "Code"}</span><CopyCode source={source} /></div>
        <pre tabIndex={0} aria-label={`${language || "Plain text"} code`}>{children}</pre>
      </div>;
    },
};

export default function RichTextRenderer({ content, instanceId, streaming = false }: {
  content: string;
  instanceId: string;
  streaming?: boolean;
}) {
  const rehypePlugins = useMemo(() => richTextRehypePlugins(instanceId), [instanceId]);

  return <div className={styles.content} data-rich-text={instanceId}>
    <StreamingContext.Provider value={streaming}><Markdown remarkPlugins={remarkPlugins} remarkRehypeOptions={remarkRehypeOptions} rehypePlugins={rehypePlugins} components={components}>{content}</Markdown></StreamingContext.Provider>
  </div>;
}
