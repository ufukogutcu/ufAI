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
export function TaskTools({ taskId }: { taskId: string }) {
  const snapshot = useAgents((s) => s.toolData[taskId]),
    load = useAgents((s) => s.loadToolData),
    loadMore = useAgents((s) => s.loadMoreToolData),
    version = useAgents((s) => s.eventVersion);
  const [error, setError] = useState(""),
    [open, setOpen] = useState<string | null>(null);
  const [stopping, setStopping] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    const timer = setTimeout(() => {
      void load(taskId).catch((e) => {
        if (alive) setError(errorMessage(e));
      });
    }, 150);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [taskId, load, version]);
  const processes = snapshot?.processes ?? [],
    artifacts = snapshot?.artifacts ?? [],
    activity = snapshot?.activity ?? [];
  async function stop(id: string) {
    if (stopping) return;
    setStopping(id);
    setError("");
    try {
      await request(`/processes/${id}/stop`, "POST");
      await load(taskId);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setStopping(null);
    }
  }
  return (
    <section className={styles.section} aria-label="Tools, processes and files">
      <details>
        <summary>Tool activity · {snapshot?.activityTotal ?? 0}</summary>
        <div className={styles.list}>
          {activity.map((item) => (
            <details key={item.id}>
              <summary>
                {item.kind.replaceAll("_", " ")} ·{" "}
                {new Date(item.createdAt).toLocaleTimeString()}
              </summary>
              <pre className={styles.output}>{item.content}</pre>
            </details>
          ))}
          {activity.length < (snapshot?.activityTotal ?? 0) && (
            <button
              className="textButton"
              onClick={() =>
                void load(taskId, true).catch((e) => setError(errorMessage(e)))
              }
            >
              Load earlier activity
            </button>
          )}
        </div>
      </details>
      {processes.length > 0 && (
        <>
          <h4>Processes</h4>
          {processes.length < (snapshot?.processTotal ?? 0) && (
            <button
              className="textButton"
              onClick={() =>
                void loadMore(taskId, "processes").catch((e) =>
                  setError(errorMessage(e)),
                )
              }
            >
              Load more processes
            </button>
          )}
          <div className={styles.list}>
            {processes.map((p) => (
              <div className={styles.process} key={p.id}>
                <code className={styles.command}>{p.command}</code>
                <span className={styles.meta}>{p.cwd}</span>
                <span className={styles.meta}>
                  {p.pty ? "PTY · " : ""}
                  {p.state}
                  {p.exitCode !== null ? ` · exit ${p.exitCode}` : ""}
                </span>
                <div className={styles.controls}>
                  <button
                    className="textButton"
                    aria-haspopup="dialog"
                    aria-expanded={open === p.id}
                    onClick={() => setOpen(open === p.id ? null : p.id)}
                  >
                    <TerminalIcon size={14} aria-hidden="true" />
                    Output
                  </button>
                  {["starting", "running"].includes(p.state) && (
                    <button
                      className="textButton"
                      disabled={stopping !== null}
                      onClick={() => void stop(p.id)}
                    >
                      <Square size={13} aria-hidden="true" />
                      {stopping === p.id ? "Stopping…" : "Stop process"}
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
        </>
      )}
      {artifacts.length > 0 && (
        <>
          <h4>Published files</h4>
          {artifacts.length < (snapshot?.artifactTotal ?? 0) && (
            <button
              className="textButton"
              onClick={() =>
                void loadMore(taskId, "artifacts").catch((e) =>
                  setError(errorMessage(e)),
                )
              }
            >
              Load more files
            </button>
          )}
          <div className={styles.list}>
            {artifacts.map((v) => (
              <ArtifactCard key={v.id} version={v} />
            ))}
          </div>
        </>
      )}
      {open && processes.find((p) => p.id === open) && (
        <Dialog title="Process output" onClose={() => setOpen(null)}>
          <div className={styles.panel}>
            <code className={styles.command}>
              {processes.find((p) => p.id === open)!.command}
            </code>
            <span className={styles.meta}>
              {processes.find((p) => p.id === open)!.state}
            </span>
            <TerminalSession
              key={open}
              process={processes.find((p) => p.id === open)!}
              onError={setError}
            />
            {["starting", "running"].includes(
              processes.find((p) => p.id === open)!.state,
            ) && (
              <button className="button" disabled={stopping !== null} onClick={() => void stop(open)}>
                {stopping === open ? "Stopping…" : "Stop process"}
              </button>
            )}
            {error && (
              <p role="alert" className="errorBanner">
                {error}
              </p>
            )}
          </div>
        </Dialog>
      )}
      {error && (
        <p className="errorBanner" role="alert">
          {error}
          <button
            className="textButton"
            onClick={() => {
              setError("");
              void load(taskId).catch((e) => setError(errorMessage(e)));
            }}
          >
            Retry
          </button>
        </p>
      )}
    </section>
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
