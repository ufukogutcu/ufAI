import { createHash } from "node:crypto";
import type { MultipartFile } from "@fastify/multipart";
import type { ArtifactOwner, ArtifactService } from "./artifact-service.js";
import { ConnectionError } from "./model-providers.js";

/** Shared byte validation for message and event multipart ingestion. */
export async function ingestUpload(
  artifacts: ArtifactService,
  owner: ArtifactOwner,
  part: MultipartFile,
  entry: { name: string; size: number; mode: string },
  ingestId: string,
  signal: AbortSignal,
  origin: "user_upload" | "event_upload",
  hashOnly = false,
) {
  const abort = () =>
    part.file.destroy(new ConnectionError("File transfer cancelled.", 409));
  signal.addEventListener("abort", abort, { once: true });
  try {
    if (hashOnly) {
      let size = 0;
      const hash = createHash("sha256");
      for await (const bytes of part.file) {
        signal.throwIfAborted();
        size += bytes.length;
        if (size > entry.size)
          throw new ConnectionError("File differs from the manifest.", 409);
        hash.update(bytes);
      }
      if (size !== entry.size || part.file.truncated)
        throw new ConnectionError("File transfer was incomplete.", 409);
      return {
        version: null,
        hash: {
          name: entry.name,
          size,
          sha256: hash.digest("hex"),
          mode: entry.mode,
        },
      };
    }
    const version = await artifacts.publish(
      owner,
      {
        stream: part.file,
        size: entry.size,
        name: entry.name,
        origin,
        ingestId,
      },
      signal,
    );
    if (part.file.truncated)
      throw new ConnectionError("File exceeds the upload limit.", 413);
    return {
      version,
      hash: {
        name: entry.name,
        size: version.size,
        sha256: version.sha256,
        mode: entry.mode,
      },
    };
  } finally {
    signal.removeEventListener("abort", abort);
  }
}
