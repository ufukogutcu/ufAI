import { ImagePreview } from "./MessageAttachments";
import { useEffect, useRef, useState } from "react";
import {
  Download,
  Folder,
  Square,
  Terminal as TerminalIcon,
} from "lucide-react";
import type {
  ArtifactVersion,
  OwnedProcess,
  ProcessOutput,
  Page,
} from "../../../server/src/contracts";
import { request, errorMessage } from "../api";
import { useSettings } from "../settings-store";
import { useAgents } from "../agent-store";
import { Dialog } from "./Dialog";
import styles from "./TaskTools.module.scss";
import type { Terminal } from "@xterm/xterm";

export function ArtifactCard({ version }: { version: ArtifactVersion }) {
  return (
    <div className={styles.file}>
      <div>
        <strong>{version.name}</strong>
        <ImagePreview version={version} />
        <span className={styles.meta}>
          {version.mediaType} · {new Intl.NumberFormat().format(version.size)}{" "}
          bytes · {version.state}
        </span>
        <span className={styles.meta}>
          Version {version.id.slice(0, 8)} ·{" "}
          {new Date(version.createdAt).toLocaleString()}
        </span>
        {!version.producerAgentId && (
          <span className={styles.meta}>Published by a deleted agent</span>
        )}
        {version.error && (
          <span role="status" className={styles.meta}>
            {version.error}
          </span>
        )}
      </div>
      {version.state === "ready" && (
        <a
          className="button"
          href={`/api/artifact-versions/${encodeURIComponent(version.id)}/content`}
          download={version.name}
        >
          <Download size={14} aria-hidden="true" />
          Download
        </a>
      )}
    </div>
  );
}
function TerminalSession({
  process: owned,
  onError,
}: {
  process: OwnedProcess;
  onError: (text: string) => void;
}) {
  const colors = useSettings((s) => s.snapshot.activeTheme.colors);
  const host = useRef<HTMLDivElement>(null),
    terminal = useRef<Terminal | null>(null),
    cursor = useRef(0),
    inputChain = useRef(Promise.resolve());
  const inputQueued = useRef(0);
  const [interactive, setInteractive] = useState(false),
    [plain, setPlain] = useState(false),
    [log, setLog] = useState(""),
    [trimmed, setTrimmed] = useState(false),
    [input, setInput] = useState("");
  const active = ["starting", "running"].includes(owned.state);
  useEffect(() => {
    let alive = true;
    let cleanup = () => {};
    if (!host.current || plain) return;
    void Promise.all([
      import("@xterm/xterm"),
      import("@xterm/addon-fit"),
      import("@xterm/xterm/css/xterm.css"),
    ])
      .then(([xterm, fit]) => {
        if (!alive || !host.current) return;
        const term = new xterm.Terminal({
            disableStdin: !interactive,
            convertEol: !owned.pty,
            scrollback: 1000,
            allowProposedApi: false,
            windowOptions: {},
            theme: {
              background: colors["terminal-background"],
              foreground: colors["terminal-foreground"],
              cursor: colors["terminal-cursor"],
              cursorAccent: colors["terminal-background"],
              selectionBackground: colors["terminal-selection"],
              selectionInactiveBackground: colors["terminal-selection"],
              black: colors["terminal-black"],
              red: colors["terminal-red"],
              green: colors["terminal-green"],
              yellow: colors["terminal-yellow"],
              blue: colors["terminal-blue"],
              magenta: colors["terminal-magenta"],
              cyan: colors["terminal-cyan"],
              white: colors["terminal-white"],
              brightBlack: colors["terminal-bright-black"],
              brightRed: colors["terminal-bright-red"],
              brightGreen: colors["terminal-bright-green"],
              brightYellow: colors["terminal-bright-yellow"],
              brightBlue: colors["terminal-bright-blue"],
              brightMagenta: colors["terminal-bright-magenta"],
              brightCyan: colors["terminal-bright-cyan"],
              brightWhite: colors["terminal-bright-white"],
            },
            fontSize: 13,
            screenReaderMode: true,
          }),
          sizer = new fit.FitAddon();
        terminal.current = term;
        term.loadAddon(sizer);
        term.open(host.current);
        for (const code of [0, 1, 2, 7, 8, 9, 52, 1337])
          term.parser.registerOscHandler(code, () => true);
        let resizeTimer: ReturnType<typeof setTimeout> | undefined;
        const resize = () => {
          clearTimeout(resizeTimer);
          resizeTimer = setTimeout(() => {
            if (!alive) return;
            sizer.fit();
            if (owned.pty && active)
              void request(`/processes/${owned.id}/resize`, "POST", {
                cols: Math.max(20, Math.min(500, term.cols)),
                rows: Math.max(5, Math.min(200, term.rows)),
              }).catch((e) => onError(errorMessage(e)));
          }, 100);
        };
        const observer = new ResizeObserver(resize);
        observer.observe(host.current);
        resize();
        cursor.current = 0;
        const listener = term.onData((data) => {
          if (!interactive) return;
          if (inputQueued.current + data.length > 16384) {
            onError("Terminal input is busy. Wait for queued input to finish.");
            return;
          }
          inputQueued.current += data.length;
          inputChain.current = inputChain.current
            .then(() =>
              request<void>(`/processes/${owned.id}/input`, "POST", { data }),
            )
            .catch((e) => onError(errorMessage(e)))
            .finally(() => {
              inputQueued.current = Math.max(
                0,
                inputQueued.current - data.length,
              );
            });
        });
        cleanup = () => {
          clearTimeout(resizeTimer);
          observer.disconnect();
          listener.dispose();
          term.dispose();
          terminal.current = null;
        };
      })
      .catch((e) => onError(errorMessage(e)));
    return () => {
      alive = false;
      cleanup();
    };
  }, [owned.id, owned.pty, interactive, plain, active, onError, colors]);
  useEffect(() => {
    let disposed = false,
      timer: ReturnType<typeof setTimeout> | undefined;
    const controller = new AbortController();
    cursor.current = 0;
    setLog("");
    setTrimmed(false);
    async function read() {
      try {
        if (
          document.visibilityState !== "hidden" &&
          (plain || terminal.current)
        ) {
          const out = await request<ProcessOutput>(
            `/processes/${owned.id}/output?cursor=${cursor.current}`,
            "GET",
            undefined,
            controller.signal,
          );
          if (disposed) return;
          if (out.truncated) {
            setTrimmed(true);
            terminal.current?.reset();
            setLog("");
          }
          const bytes = Uint8Array.from(atob(out.data), (c) => c.charCodeAt(0));
          terminal.current?.write(bytes);
          const text = new TextDecoder().decode(bytes);
          if (plain && text)
            setLog((old) =>
              (
                old +
                text
                  .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
                  .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "")
              ).slice(-65536),
            );
          cursor.current = out.next;
          if (out.next < out.end) {
            timer = setTimeout(read, 0);
            return;
          }
          if (!["starting", "running"].includes(out.state)) return;
        }
      } catch (e) {
        if (!disposed) onError(errorMessage(e));
      }
      if (!disposed) timer = setTimeout(read, 250);
    }
    void read();
    return () => {
      disposed = true;
      controller.abort();
      clearTimeout(timer);
    };
  }, [owned.id, active, plain, interactive, onError, colors]);
  async function send(data: string) {
    try {
      await request(`/processes/${owned.id}/input`, "POST", { data });
      setInput("");
    } catch (e) {
      onError(errorMessage(e));
    }
  }
  return (
    <>
      <div className={styles.controls}>
        <button
          className="textButton"
          aria-pressed={plain}
          onClick={() => setPlain((v) => !v)}
        >
          {plain ? "Terminal view" : "Text log"}
        </button>
        {active && (
          <>
            <button
              className="textButton"
              aria-pressed={interactive}
              onClick={() => setInteractive((v) => !v)}
            >
              {interactive ? "Disable input" : "Enable input"}
            </button>
            {owned.pty && (
              <button
                className="textButton"
                onClick={() => void send("\u0003")}
              >
                Ctrl+C
              </button>
            )}
          </>
        )}
      </div>
      {trimmed && <p role="status">Earlier output was trimmed.</p>}
      {plain ? (
        <pre className={styles.output} aria-label="Process text log">
          {log || "No output yet."}
        </pre>
      ) : (
        <div
          className={styles.terminal}
          ref={host}
          aria-label={`Terminal for ${owned.command}`}
        />
      )}
      {interactive && active && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void send(input + (owned.pty ? "\r" : "\n"));
          }}
        >
          <label>
            Send input
            <input
              className={styles.input}
              name="terminalInput"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              autoComplete="off"
              spellCheck={false}
            />
          </label>
          <button className="button" type="submit">
            Send input
          </button>
        </form>
      )}
    </>
  );
}
export function ProcessActivity({
  process: owned,
  onChange,
}: {
  process: OwnedProcess;
  onChange: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [error, setError] = useState("");
  const [stopping, setStopping] = useState(false);
  const outputButton = useRef<HTMLButtonElement>(null);
  const active = ["starting", "running"].includes(owned.state);
  async function stop() {
    setStopping(true);
    setError("");
    try {
      await request(`/processes/${owned.id}/stop`, "POST");
      onChange();
      outputButton.current?.focus();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setStopping(false);
    }
  }
  return (
    <>
      <code className={styles.command}>{owned.command}</code>
      <span className={styles.meta}>{owned.cwd}</span>
      <span className={styles.meta}>
        Process {owned.state}
        {owned.exitCode !== null ? ` · exit ${owned.exitCode}` : ""}
      </span>
      <div className={styles.controls}>
        <button
          ref={outputButton}
          type="button"
          className="textButton"
          aria-haspopup="dialog"
          onClick={() => setOpen(true)}
        >
          <TerminalIcon size={14} aria-hidden="true" />
          Output
        </button>
        {active && (
          <button
            type="button"
            className="textButton"
            disabled={stopping}
            onClick={() => void stop()}
          >
            <Square size={13} aria-hidden="true" />
            {stopping ? "Stopping…" : "Stop process"}
          </button>
        )}
      </div>
      {open && (
        <Dialog title="Process output" onClose={() => setOpen(false)}>
          <div className={styles.panel}>
            <code className={styles.command}>{owned.command}</code>
            <TerminalSession process={owned} onError={setError} />
            {active && (
              <button
                type="button"
                className="button"
                disabled={stopping}
                onClick={() => void stop()}
              >
                {stopping ? "Stopping…" : "Stop process"}
              </button>
            )}
            {error && (
              <p className="errorBanner" role="alert">
                {error}
              </p>
            )}
          </div>
        </Dialog>
      )}
      {error && !open && (
        <p className="errorBanner" role="alert">
          {error}
        </p>
      )}
    </>
  );
}
export function PublishedFiles({
  workspaceId,
  onClose,
}: {
  workspaceId: string;
  onClose: () => void;
}) {
  const [items, setItems] = useState<ArtifactVersion[]>([]),
    [total, setTotal] = useState(0),
    [error, setError] = useState(""),
    [offset, setOffset] = useState(0),
    [busy, setBusy] = useState(false),
    version = useAgents((s) => s.eventVersion);
  useEffect(() => {
    setOffset(0);
  }, [version]);
  useEffect(() => {
    const controller = new AbortController();
    setBusy(true);
    void request<Page<ArtifactVersion>>(
      `/workspaces/${workspaceId}/artifacts?limit=50&offset=${offset}`,
      "GET",
      undefined,
      controller.signal,
    )
      .then((p) => {
        if (controller.signal.aborted) return;
        setItems((old) =>
          [
            ...new Map([...old, ...p.items].map((v) => [v.id, v])).values(),
          ].sort(
            (a, b) =>
              b.createdAt.localeCompare(a.createdAt) ||
              a.id.localeCompare(b.id),
          ),
        );
        setTotal(p.total);
        setError("");
      })
      .catch((e) => {
        if (!controller.signal.aborted) setError(errorMessage(e));
      })
      .finally(() => {
        if (!controller.signal.aborted) setBusy(false);
      });
    return () => controller.abort();
  }, [workspaceId, offset, version]);
  return (
    <Dialog title="Published Files" onClose={onClose}>
      <div className={styles.panel}>
        <p>
          Published versions stay in this workspace when their agent is deleted.
        </p>
        <div className={styles.list}>
          {items.map((v) => (
            <ArtifactCard key={v.id} version={v} />
          ))}
        </div>
        {!items.length && !busy && (
          <p>
            <Folder size={16} aria-hidden="true" /> No published files yet.
          </p>
        )}
        {busy && <p role="status">Loading…</p>}
        {items.length < total && (
          <button
            className="button"
            disabled={busy}
            onClick={() => setOffset(items.length)}
          >
            Load more files
          </button>
        )}
        {error && (
          <p className="errorBanner" role="alert">
            {error}
          </p>
        )}
      </div>
    </Dialog>
  );
}
