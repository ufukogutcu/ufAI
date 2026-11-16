import { useCallback, useEffect, useRef, useState, type FormEvent, type KeyboardEvent, type ClipboardEvent, type PointerEvent, type CSSProperties } from "react";
import { ArrowLeft, ArrowRight, RotateCw, Plus, X, Maximize2, Minimize2, Hand, Play } from "lucide-react";
import type { BrowserAction, BrowserState, BrowserServerMessage } from "../../../server/src/browser-types";
import { request, errorMessage } from "../api";
import { Dialog } from "./Dialog";
import styles from "./AgentBrowser.module.scss";

export function AgentBrowser({ agentId, onDisabled }: { agentId: string; onDisabled: () => void }) {
  const [state, setState] = useState<BrowserState | null>(null);
  const [viewerId, setViewerId] = useState("");
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState("");
  const [address, setAddress] = useState("");
  const [prompt, setPrompt] = useState("");
  const [expanded, setExpanded] = useState(false);
  const [zoom, setZoom] = useState("fit");
  const [attempt, setAttempt] = useState(0);
  const [uploading, setUploading] = useState(false);
  const [hasFrame, setHasFrame] = useState(false);
  const [pageInput, setPageInput] = useState(false);
  const socket = useRef<WebSocket | null>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const image = useRef<HTMLImageElement | null>(null);
  const lastFrame = useRef<string | null>(null);
  const loadingFrame = useRef(false);
  const addressInput = useRef<HTMLInputElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const uploadAbort = useRef<AbortController | null>(null);
  const pointer = useRef<{ x: number; y: number; pointerType: string } | null>(null);
  const wheelDelta = useRef({ x: 0, y: 0 });
  const wheelTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const control = connected && !!viewerId && state?.controller === viewerId;
  const ready = connected && state?.status === "ready";
  const activeUrl = state?.tabs.find(t => t.id === state.activeTabId)?.url ?? "";
  useEffect(() => { setAddress(activeUrl === "about:blank" ? "" : activeUrl); }, [activeUrl]);
  useEffect(() => { setPrompt(state?.dialog?.defaultValue ?? ""); }, [state?.dialog?.defaultValue, state?.dialog?.message]);

  const drawFrame = useCallback(function draw() {
    if (loadingFrame.current || !lastFrame.current) return;
    loadingFrame.current = true;
    const frame = lastFrame.current; lastFrame.current = null;
    const next = new Image(); image.current = next;
    next.onload = () => {
      const target = canvas.current;
      if (target) { target.getContext("2d")?.drawImage(next, 0, 0, target.width, target.height); setHasFrame(true); }
      loadingFrame.current = false;
      draw();
    };
    next.onerror = () => { loadingFrame.current = false; draw(); };
    next.src = `data:image/jpeg;base64,${frame}`;
  }, []);
  // Expanding moves the viewer into a dialog without replacing its browser connection.
  useEffect(() => { if (image.current?.complete) canvas.current?.getContext("2d")?.drawImage(image.current, 0, 0, 1280, 800); setPageInput(false); }, [expanded]);

  useEffect(() => {
    let disposed = false;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let current: WebSocket | undefined;
    const startAbort = new AbortController();
    function connect() {
      if (disposed || document.visibilityState === "hidden") return;
      setConnected(false); setViewerId("");
      const url = new URL(`/api/agents/${encodeURIComponent(agentId)}/browser/stream`, window.location.href);
      url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
      current = new WebSocket(url); socket.current = current;
      current.onopen = () => { if (!disposed) { setConnected(true); setError(""); } };
      current.onmessage = event => {
        if (disposed) return;
        const message = JSON.parse(event.data) as BrowserServerMessage;
        if (message.type === "hello") setViewerId(message.viewerId);
        else if (message.type === "state") { setState(message.state); if (!message.state.enabled) onDisabled(); }
        else if (message.type === "error") setError(message.error);
        else if (message.type === "frame") { lastFrame.current = message.data; drawFrame(); }
      };
      current.onclose = event => {
        if (disposed) return;
        setConnected(false); setViewerId(""); setPageInput(false);
        if (event.code === 4003) { onDisabled(); return; }
        if (document.visibilityState !== "hidden") retry = setTimeout(connect, 1500);
      };
    }
    async function start() {
      try {
        const snapshot = await request<BrowserState>(`/agents/${encodeURIComponent(agentId)}/browser/start`, "POST", undefined, startAbort.signal);
        if (!disposed) { setState(snapshot); connect(); }
      } catch (failure) { if (!disposed) setError(errorMessage(failure)); }
    }
    function visibility() {
      clearTimeout(retry);
      if (document.visibilityState === "hidden") { current?.close(); uploadAbort.current?.abort(); }
      else if (!current || current.readyState >= WebSocket.CLOSING) void start();
    }
    document.addEventListener("visibilitychange", visibility);
    void start();
    return () => {
      disposed = true; startAbort.abort(); clearTimeout(retry); current?.close(); socket.current = null;
      uploadAbort.current?.abort(); document.removeEventListener("visibilitychange", visibility);
      if (wheelTimer.current) clearTimeout(wheelTimer.current);
      lastFrame.current = null;
      if (image.current) { image.current.onload = null; image.current.onerror = null; }
      loadingFrame.current = false;
    };
  }, [agentId, attempt, drawFrame, onDisabled]);

  const send = useCallback((action: BrowserAction) => {
    if (socket.current?.readyState !== WebSocket.OPEN) { setError("Browser is reconnecting. Try again when connected."); return; }
    setError(""); socket.current.send(JSON.stringify({ type: "action", action }));
  }, []);
  function changeControl() {
    setError(""); setPageInput(false);
    socket.current?.send(JSON.stringify({ type: "control", take: !control }));
  }
  function navigate(event: FormEvent) {
    event.preventDefault();
    const value = address.trim();
    if (value) send({ action: "navigate", url: /^[a-z][a-z\d+.-]*:/i.test(value) ? value : `https://${value}` });
  }
  function key(event: KeyboardEvent<HTMLCanvasElement>) {
    if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); setPageInput(false); addressInput.current?.focus(); return; }
    if (!control || event.nativeEvent.isComposing) return;
    // Let native paste reach onPaste; text input uses a real textarea for IME and mobile keyboards.
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "v") return;
    event.preventDefault(); event.stopPropagation();
    if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) send({ action: "type", text: event.key });
    else if (!["Control", "Shift", "Alt", "Meta"].includes(event.key)) {
      const name = event.key === " " ? "Space" : event.key;
      send({ action: "key", text: `${event.ctrlKey ? "Control+" : ""}${event.metaKey ? "Meta+" : ""}${event.altKey ? "Alt+" : ""}${event.shiftKey ? "Shift+" : ""}${name}` });
    }
  }
  function paste(event: ClipboardEvent) {
    if (!control) return;
    const text = event.clipboardData.getData("text");
    if (text) { event.preventDefault(); send({ action: "type", text }); }
  }
  function point(event: PointerEvent<HTMLCanvasElement>) {
    const bounds = event.currentTarget.getBoundingClientRect();
    return { x: Math.round((event.clientX - bounds.left) / bounds.width * 1280), y: Math.round((event.clientY - bounds.top) / bounds.height * 800) };
  }
  function pointerDown(event: PointerEvent<HTMLCanvasElement>) {
    if (!control) return;
    pointer.current = { ...point(event), pointerType: event.pointerType };
    event.currentTarget.setPointerCapture(event.pointerId); event.currentTarget.focus(); setPageInput(true);
  }
  function pointerUp(event: PointerEvent<HTMLCanvasElement>) {
    const first = pointer.current; pointer.current = null;
    if (!control || !first) return;
    const current = point(event);
    const dx = first.x - current.x, dy = first.y - current.y;
    if (first.pointerType === "touch" && Math.abs(dx) + Math.abs(dy) > 12) { if (zoom === "fit") send({ action: "scroll", x: dx, y: dy }); }
    else send({ action: "click", ...current, button: event.button === 2 ? "right" : "left" });
  }
  const bindCanvas = useCallback((element: HTMLCanvasElement | null) => {
    canvas.current = element;
    if (element && image.current?.complete && image.current.naturalWidth) element.getContext("2d")?.drawImage(image.current, 0, 0, 1280, 800);
  }, []);
  useEffect(() => {
    const target = canvas.current; if (!target) return;
    function wheel(event: WheelEvent) {
      if (!control || zoom !== "fit") return;
      event.preventDefault();
      wheelDelta.current.x += event.deltaX * (event.deltaMode === 1 ? 16 : 1);
      wheelDelta.current.y += event.deltaY * (event.deltaMode === 1 ? 16 : 1);
      if (!wheelTimer.current) wheelTimer.current = setTimeout(() => {
        wheelTimer.current = null;
        send({ action: "scroll", x: Math.round(Math.max(-10000, Math.min(10000, wheelDelta.current.x))), y: Math.round(Math.max(-10000, Math.min(10000, wheelDelta.current.y))) });
        wheelDelta.current = { x: 0, y: 0 };
      }, 60);
    }
    target.addEventListener("wheel", wheel, { passive: false });
    return () => target.removeEventListener("wheel", wheel);
  }, [control, expanded, zoom, send]);
  async function upload(files: FileList | null) {
    if (!files?.length) return;
    const form = new FormData(); for (const file of files) form.append("files", file);
    setUploading(true); setError(""); uploadAbort.current = new AbortController();
    try {
      const response = await fetch(`/api/agents/${encodeURIComponent(agentId)}/browser/uploads?viewerId=${encodeURIComponent(viewerId)}`, { method: "POST", body: form, signal: uploadAbort.current.signal });
      if (!response.ok) throw new Error((await response.json()).error ?? "Upload failed.");
    } catch (failure) { if (!uploadAbort.current.signal.aborted) setError(errorMessage(failure)); }
    finally { setUploading(false); if (fileInput.current) fileInput.current.value = ""; }
  }
  function toggleExpanded() { setExpanded(value => !value); }
  const content = <section className={styles.browser} aria-label="Agent browser">
    <div className={styles.websiteTabs} aria-label="Website tabs">
      {state?.tabs.map(t => <div key={t.id} className={styles.websiteTab}>
        <button type="button" disabled={!control} aria-current={t.id === state.activeTabId ? "page" : undefined} title={t.url} onClick={() => send({ action: "selectTab", tabId: t.id })}>{t.title || (t.url === "about:blank" ? "New tab" : t.url)}</button>
        <button type="button" className="iconButton" disabled={!control} aria-label={`Close ${t.title || "tab"}`} onClick={() => send({ action: "closeTab", tabId: t.id })}><X size={14} aria-hidden /></button>
      </div>)}
      <button type="button" className="iconButton" disabled={!control} aria-label="New browser tab" onClick={() => send({ action: "newTab" })}><Plus size={16} aria-hidden /></button>
    </div>
    <form className={styles.navigation} onSubmit={navigate}>
      <button type="button" className="iconButton" disabled={!control} aria-label="Browser back" onClick={() => send({ action: "back" })}><ArrowLeft size={16} aria-hidden /></button>
      <button type="button" className="iconButton" disabled={!control} aria-label="Browser forward" onClick={() => send({ action: "forward" })}><ArrowRight size={16} aria-hidden /></button>
      <button type="button" className="iconButton" disabled={!control} aria-label="Reload browser page" onClick={() => send({ action: "reload" })}><RotateCw size={16} aria-hidden /></button>
      <input ref={addressInput} name="browserAddress" aria-label="Website address" autoComplete="off" spellCheck={false} value={address} readOnly={!control} placeholder="https://example.com…" onChange={e => setAddress(e.target.value)} />
      <button type="submit" className="button secondary" disabled={!control}>Go</button>
    </form>
    <div className={styles.controls}>
      <span role="status">{!connected ? "Connecting…" : control ? "You have control" : state?.controller ? "Another viewer has control" : "Agent has control"}</span>
      <button type="button" className="button secondary" disabled={!ready || (!!state?.controller && !control)} onClick={changeControl}>{control ? <Play size={14} aria-hidden /> : <Hand size={14} aria-hidden />}{control ? "Hand back" : "Take control"}</button>
      <label className={styles.zoom}>View<select aria-label="Browser view zoom" value={zoom} onChange={event => setZoom(event.target.value)}><option value="fit">Fit</option><option value="1">100%</option><option value="1.5">150%</option></select></label>
      <button type="button" className="iconButton" aria-label={expanded ? "Collapse browser" : "Expand browser"} onClick={toggleExpanded}>{expanded ? <Minimize2 size={16} aria-hidden /> : <Maximize2 size={16} aria-hidden />}</button>
    </div>
    {(error || state?.error) && <p className="errorBanner" role="alert">{error || state?.error} <button type="button" className="textButton" onClick={() => { setError(""); setAttempt(n => n + 1); }}>Retry browser</button></p>}
    {state?.dialog && <div className={styles.websiteDialog} role="group" aria-label="Website dialog">
      <p>{state.dialog.message}</p>
      {state.dialog.type === "prompt" && <input aria-label="Website dialog response" value={prompt} onChange={e => setPrompt(e.target.value)} disabled={!control} />}
      <button type="button" className="button secondary" disabled={!control} onClick={() => send({ action: "dialog", accept: false })}>Dismiss</button>
      <button type="button" className="button" disabled={!control} onClick={() => send({ action: "dialog", accept: true, text: prompt })}>OK</button>
    </div>}
    {state?.fileChooser && <div className={styles.fileChooser}>
      <label>Choose website upload<input ref={fileInput} type="file" multiple={state.fileChooser.multiple} disabled={!control || uploading} onChange={e => void upload(e.target.files)} /></label>
      {uploading && <span role="status">Uploading…</span>}
    </div>}
    <div className={styles.page} data-zoomed={zoom !== "fit" || undefined} style={{ "--browser-view-width": zoom === "fit" ? "100%" : `${1280 * Number(zoom)}px` } as CSSProperties}>
      {!hasFrame && <p role="status">{state?.status === "ready" ? "Waiting for browser view…" : "Starting browser…"}</p>}
      <canvas ref={bindCanvas} className={control ? styles.interactive : undefined} width={1280} height={800} tabIndex={control ? 0 : -1} aria-label="Live browser page. Take control to interact. Press Escape to leave page input." onKeyDown={key} onPaste={paste} onPointerDown={pointerDown} onPointerUp={pointerUp} onPointerCancel={() => { pointer.current = null; }} onContextMenu={e => e.preventDefault()} />
    </div>
    {control && <div className={styles.textEntry}>
      <label>Type into page<textarea aria-label="Type into browser page" placeholder="Text for the focused website field…" rows={1} onChange={e => { const text = e.target.value; if (!(e.nativeEvent as InputEvent).isComposing && text) { send({ action: "type", text }); e.target.value = ""; } }} onCompositionEnd={e => { if (e.currentTarget.value) send({ action: "type", text: e.currentTarget.value }); e.currentTarget.value = ""; }} /></label>
      <button type="button" className="button secondary" onClick={() => send({ action: "key", text: "Tab" })}>Tab</button>
      <button type="button" className="button secondary" onClick={() => send({ action: "key", text: "Enter" })}>Enter</button>
      <button type="button" className="button secondary" onClick={() => send({ action: "scroll", x: 0, y: 600 })}>Scroll down</button>
    </div>}
    {pageInput && control && <p className={styles.help}>Page input active · Escape returns to the address field.</p>}
    {zoom !== "fit" && <p className={styles.help}>Scroll to move the view. Use the page controls or keyboard to scroll the website.</p>}
    {!!state?.downloads.length && <details className={styles.downloads}><summary>Downloads ({state.downloads.length})</summary>
      <ul>{state.downloads.map(d => <li key={d.id}>{d.state === "ready" && d.path ? <a href={`/api/agents/${encodeURIComponent(agentId)}/files/download?path=${encodeURIComponent(d.path)}`} download>{d.name}</a> : <span>{d.name} — {d.state === "downloading" ? "Downloading…" : d.error || "Failed"}</span>}</li>)}</ul>
    </details>}
  </section>;
  return expanded ? <Dialog title="Browser" className={styles.expandedDialog} contentClassName={styles.expanded} onClose={() => setExpanded(false)} initialFocusSelector="button">{content}</Dialog> : content;
}
