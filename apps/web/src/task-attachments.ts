import { RequestError } from "./api";
export interface DraftAttachment {
  id: string;
  file: File;
  mode: "inspect" | "file";
}
export interface FileSubmission {
  attachments: DraftAttachment[];
  signal?: AbortSignal;
  onProgress?: (percent: number) => void;
}
export function sendTaskFiles<T>(
  path: string,
  content: string,
  requestId: string,
  options: FileSubmission,
): Promise<T> {
  const form = new FormData();
  form.append(
    "message",
    JSON.stringify({
      content,
      requestId,
      attachments: options.attachments.map((a) => ({
        name: a.file.name,
        size: a.file.size,
        mode: a.mode,
      })),
    }),
  );
  options.attachments.forEach((a, i) =>
    form.append(`file${i}`, a.file, a.file.name),
  );
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    const abort = () => xhr.abort();
    const cleanup = () => options.signal?.removeEventListener("abort", abort);
    xhr.open("POST", `/api${path}`);
    xhr.responseType = "json";
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable)
        options.onProgress?.(Math.round((e.loaded / e.total) * 100));
    };
    xhr.onload = () => {
      cleanup();
      if (xhr.status >= 200 && xhr.status < 300) resolve(xhr.response);
      else
        reject(
          new RequestError(
            xhr.response?.error ??
              "Message could not be sent. Retry with the same files.",
            xhr.response?.fields,
            xhr.status,
          ),
        );
    };
    xhr.onerror = () => {
      cleanup();
      reject(
        new RequestError(
          "Cannot reach ufAI. Your message and files are still here to retry.",
        ),
      );
    };
    xhr.onabort = () => {
      cleanup();
      reject(
        new RequestError(
          "Sending cancelled. Your message and files remain available to retry.",
        ),
      );
    };
    options.signal?.addEventListener("abort", abort, { once: true });
    if (options.signal?.aborted) {
      cleanup();
      reject(new RequestError("Sending cancelled."));
      return;
    }
    xhr.send(form);
  });
}
