import { useEffect, useState } from "react";
import type {
  ArtifactVersion,
  ContentPart,
} from "../../../server/src/contracts";
import { request, errorMessage } from "../api";
import { Dialog } from "./Dialog";
import styles from "./Media.module.scss";
export function ImagePreview({ version }: { version: ArtifactVersion }) {
  const [open, setOpen] = useState(false),
    [failed, setFailed] = useState(false);
  if (
    !["image/png", "image/jpeg", "image/webp"].includes(version.mediaType) ||
    version.state !== "ready"
  )
    return null;
  const src = `/api/artifact-versions/${encodeURIComponent(version.id)}/preview`;
  return (
    <>
      {failed ? (
        <span className={styles.meta}>
          Preview unavailable; the original download may still be available.
        </span>
      ) : (
        <button
          type="button"
          className="textButton"
          aria-label={`Preview ${version.name}`}
          onClick={() => setOpen(true)}
        >
          <img
            className={styles.thumbnail}
            loading="lazy"
            width={160}
            height={100}
            src={src}
            alt={version.name}
            onError={() => setFailed(true)}
          />
        </button>
      )}
      {open && (
        <Dialog title={version.name} onClose={() => setOpen(false)}>
          <div className={styles.viewer}>
            <img
              className={styles.image}
              src={src}
              width={880}
              height={600}
              alt={version.name}
              onError={() => setFailed(true)}
            />
          </div>
          <a
            className="button"
            href={`/api/artifact-versions/${encodeURIComponent(version.id)}/content`}
            download={version.name}
          >
            Download Original
          </a>
        </Dialog>
      )}
    </>
  );
}
function Attachment({
  part,
}: {
  part: Extract<ContentPart, { type: "artifact" }>;
}) {
  const [version, setVersion] = useState<ArtifactVersion | null>(null),
    [error, setError] = useState("");
  useEffect(() => {
    const c = new AbortController();
    void request<ArtifactVersion>(
      `/artifact-versions/${encodeURIComponent(part.versionId)}`,
      "GET",
      undefined,
      c.signal,
    )
      .then((v) => {
        if (!c.signal.aborted) setVersion(v);
      })
      .catch((e) => {
        if (!c.signal.aborted) setError(errorMessage(e));
      });
    return () => c.abort();
  }, [part.versionId]);
  return (
    <li className={styles.card}>
      <div>
        <strong>{version?.name ?? part.name}</strong>
        <span className={styles.meta}>
          {version
            ? `${version.mediaType} · ${new Intl.NumberFormat().format(version.size)} bytes · ${version.state}`
            : "File attachment"}
          {part.mode === "file" ? " · File only" : ""}
        </span>
        {version && <ImagePreview version={version} />}
        <span className={styles.meta}>
          Version {part.versionId.slice(0, 8)}
        </span>
        {error && (
          <span role="status" className={styles.meta}>
            {error}
          </span>
        )}
      </div>
      {version?.state === "ready" && (
        <a
          className="button"
          href={`/api/artifact-versions/${encodeURIComponent(part.versionId)}/content`}
          download={part.name}
        >
          Download
        </a>
      )}
    </li>
  );
}
export function MessageAttachments({ parts }: { parts?: ContentPart[] }) {
  const files = parts?.filter(
    (p): p is Extract<ContentPart, { type: "artifact" }> =>
      p.type === "artifact",
  );
  if (!files?.length) return null;
  return (
    <ul className={styles.attachments} aria-label="Message attachments">
      {files.map((part, i) => (
        <Attachment key={`${part.versionId}:${i}`} part={part} />
      ))}
    </ul>
  );
}
