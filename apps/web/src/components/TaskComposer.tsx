import { useEffect, useRef, useState, type FormEvent } from "react";
import { Paperclip, Send, X } from "lucide-react";
import { useAgents, useAgentStore, emptyList } from "../agent-store";
import { request, errorMessage } from "../api";
import { sendTaskFiles } from "../task-attachments";
import type { DraftAttachment } from "../task-attachments";
import type { MediaCapabilities } from "../../../server/src/contracts";
import styles from "./AgentPanel.module.scss";
import mediaStyles from "./Media.module.scss";
function DraftFile({
  item,
  busy,
  onChange,
  onRemove,
}: {
  item: DraftAttachment;
  busy: boolean;
  onChange: (id: string, mode: "inspect" | "file") => void;
  onRemove: (id: string) => void;
}) {
  return (
    <li className={mediaStyles.draftFile}>
      <div>
        <strong>{item.file.name}</strong>
        <span className={mediaStyles.meta}>
          {new Intl.NumberFormat().format(item.file.size)} bytes
        </span>
      </div>
      {item.file.type.startsWith("image/") && (
        <label className={mediaStyles.mode}>
          <span className={mediaStyles.visuallyHidden}>
            Use {item.file.name} as
          </span>
          <select
            value={item.mode}
            disabled={busy}
            onChange={(e) =>
              onChange(item.id, e.target.value as "inspect" | "file")
            }
          >
            <option value="inspect">Inspect image</option>
            <option value="file">File only</option>
          </select>
        </label>
      )}
      <button
        type="button"
        className="iconButton"
        aria-label={`Remove ${item.file.name}`}
        disabled={busy}
        onClick={() => onRemove(item.id)}
      >
        <X size={16} aria-hidden="true" />
      </button>
    </li>
  );
}
export function TaskComposer({
  agentId,
  taskId,
  onCreated,
  submissionPath,
  draftKey,
}: {
  agentId: string;
  taskId: string | null | "new";
  onCreated: (id: string) => void;
  submissionPath?: string;
  draftKey?: string;
}) {
  const store = useAgentStore(),
    key = draftKey ?? (taskId === "new" ? `new:${agentId}` : (taskId ?? `chat:${agentId}`));
  const value = useAgents((s) => s.drafts[key] ?? ""),
    files = useAgents((s) => s.fileDrafts[key] ?? emptyList);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [progress, setProgress] = useState(0),
    [caps, setCaps] = useState<MediaCapabilities | null>(null);
  const [limits, setLimits] = useState({
    maxFiles: 10,
    maxBytes: 256 * 1024 * 1024,
  });
  const input = useRef<HTMLInputElement>(null),
    controller = useRef<AbortController | null>(null),
    scope = useRef(key);
  useEffect(() => {
    scope.current = key;
    setError("");
    setBusy(false);
    return () => {
      scope.current = "";
      controller.current?.abort();
    };
  }, [key]);
  useEffect(() => {
    const c = new AbortController();
    setCaps(null);
    void request<{
      capabilities: MediaCapabilities;
      maxFiles: number;
      maxBytes: number;
    }>(`/agents/${agentId}/media-capabilities`, "GET", undefined, c.signal)
      .then((v) => {
        if (!c.signal.aborted) {
          setCaps(v.capabilities);
          setLimits({ maxFiles: v.maxFiles, maxBytes: v.maxBytes });
        }
      })
      .catch(() => {});
    return () => c.abort();
  }, [agentId, taskId]);
  function add(incoming: File[]) {
    if (busy) return;
    const next = [
      ...(store.getState().fileDrafts[key] ?? []),
      ...incoming.map((file) => ({
        id: crypto.randomUUID(),
        file,
        mode: file.type.startsWith("image/")
          ? ("inspect" as const)
          : ("file" as const),
      })),
    ];
    if (
      next.length > limits.maxFiles ||
      next.reduce((n, a) => n + a.file.size, 0) > limits.maxBytes
    ) {
      setError(
        `Attach at most ${limits.maxFiles} files and ${new Intl.NumberFormat().format(limits.maxBytes)} bytes combined.`,
      );
      return;
    }
    store.getState().setFileDraft(key, next);
    setError("");
  }
  function change(id: string, mode: "inspect" | "file") {
    setError("");
    store.getState().setFileDraft(
      key,
      files.map((f) => (f.id === id ? { ...f, mode } : f)),
    );
  }
  function remove(id: string) {
    setError("");
    store.getState().setFileDraft(
      key,
      files.filter((f) => f.id !== id),
    );
  }
  const incompatible =
    files.some((f) => f.mode === "inspect") && caps?.image !== "supported";
  async function submit(e: FormEvent) {
    e.preventDefault();
    if (busy || (!value.trim() && !files.length)) return;
    if (incompatible) {
      setError(
        "Image inspection is unavailable or unknown for this model. Set its image capability in Providers, or choose File only.",
      );
      return;
    }
    const signature = JSON.stringify([value, files.map((f) => [f.id, f.mode])]),
      requestId = store.getState().submissionId(key, signature),
      sentFiles = files;
    const c = new AbortController();
    controller.current = c;
    setBusy(true);
    setError("");
    setProgress(0);
    try {
      const fileOptions={attachments:files,signal:c.signal,onProgress:(p:number)=>{if(scope.current===key)setProgress(p);}};
      const override=submissionPath ? (files.length ? await sendTaskFiles<{taskId:string}>(submissionPath,value,requestId,fileOptions) : await request<{taskId:string}>(submissionPath,"POST",{content:value,requestId},c.signal)) : null;
      const id = submissionPath ? override!.taskId : await store.getState().submit(
        agentId,
        typeof taskId === "string" && taskId !== "new" ? taskId : null,
        value,
        requestId,
        taskId === "new",
        files.length
          ? {
              attachments: files,
              signal: c.signal,
              onProgress: (p) => {
                if (scope.current === key) setProgress(p);
              },
            }
          : undefined,
      );
      if (store.getState().drafts[key] === value)
        store.getState().setDraft(key, "");
      if (store.getState().fileDrafts[key] === sentFiles)
        store.getState().setFileDraft(key, []);
      if (scope.current === key && (taskId === "new" || submissionPath) && id) onCreated(id);
    } catch (err) {
      if (scope.current === key) setError(errorMessage(err));
    } finally {
      if (scope.current === key) setBusy(false);
      if (controller.current === c) controller.current = null;
    }
  }
  return (
    <form
      className={`${styles.composer} ${mediaStyles.composer}`}
      onSubmit={submit}
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes("Files"))
          e.preventDefault();
      }}
      onDrop={(e) => {
        if (e.dataTransfer.files.length) {
          e.preventDefault();
          add(Array.from(e.dataTransfer.files));
        }
      }}
    >
      <div className={mediaStyles.fields}>
        <label htmlFor={`compose-${key}`}>
          {taskId === null
            ? "Message this agent"
            : taskId === "new"
              ? "Describe a new task"
              : "Message this task"}
        </label>
        <textarea
          id={`compose-${key}`}
          name="message"
          rows={3}
          maxLength={12000}
          autoComplete="off"
          placeholder="What would you like help with?…"
          value={value}
          onChange={(e) => store.getState().setDraft(key, e.target.value)}
          onPaste={(e) => {
            const pasted = Array.from(e.clipboardData.files).filter((f) =>
              f.type.startsWith("image/"),
            );
            if (pasted.length) {
              e.preventDefault();
              add(pasted);
            }
          }}
          onKeyDown={(e) => {
            if (
              e.key === "Enter" &&
              !e.shiftKey &&
              !e.altKey &&
              !e.ctrlKey &&
              !e.metaKey
            ) {
              e.preventDefault();
              if (!e.nativeEvent.isComposing && e.keyCode !== 229 && !e.repeat)
                e.currentTarget.form?.requestSubmit();
            }
          }}
        />
        {!!files.length && (
          <ul className={mediaStyles.drafts}>
            {files.map((f) => (
              <DraftFile
                key={f.id}
                item={f}
                busy={busy}
                onChange={change}
                onRemove={remove}
              />
            ))}
          </ul>
        )}
        {incompatible && (
          <p className={mediaStyles.meta}>
            Image inspection is {caps?.image ?? "unknown"}. Choose File only or
            configure image support in Providers.
          </p>
        )}
        <>
            <input
              ref={input}
              className={mediaStyles.visuallyHidden}
              type="file"
              name="attachments"
              multiple
              tabIndex={-1}
              aria-label="Choose message attachments"
              disabled={busy}
              onChange={(e) => {
                add(Array.from(e.target.files ?? []));
                e.target.value = "";
              }}
            />
            <button
              type="button"
              className={`button ${mediaStyles.attach}`}
              disabled={busy}
              onClick={() => input.current?.click()}
            >
              <Paperclip size={15} aria-hidden="true" />
              Attach Files
            </button>
        </>
      </div>
      <div className={`${styles.actions} ${mediaStyles.footer}`}>
        <span>
          {busy && files.length
            ? `Sending files: ${progress}%${progress === 100 ? " · Saving…" : ""}`
            : "Shift + Enter for a new line"}
        </span>
        {busy && files.length ? (
          <button
            type="button"
            className="button"
            onClick={() => controller.current?.abort()}
          >
            Cancel Send
          </button>
        ) : null}
        <button
          className="button primary"
          disabled={busy || (!value.trim() && !files.length)}
        >
          <Send size={15} aria-hidden="true" />
          {busy ? "Sending…" : "Send"}
        </button>
      </div>
      {busy && files.length > 0 && (
        <progress
          className={mediaStyles.progress}
          max={100}
          value={progress}
          aria-label="Sending attachments"
        />
      )}
      {error && (
        <p role="alert" className={`errorBanner ${mediaStyles.error}`}>
          {error}
        </p>
      )}
    </form>
  );
}
