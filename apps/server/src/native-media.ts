import type { ConnectionProvider } from "./contracts.js";
import type {
  TaskRequest,
  TaskMessage,
  ToolResult,
} from "./execution-types.js";
import type { NativeMedia, MediaReference } from "./media-service.js";
import { ConnectionError } from "./model-providers.js";
export async function nativeExchange(
  r: TaskRequest,
  provider: ConnectionProvider,
  steps: any[],
  uploadPdf?: (m: NativeMedia) => Promise<string>,
) {
  const references: MediaReference[] = [
    ...r.messages.flatMap((m) => m.media ?? []),
    ...steps.flatMap((s) =>
      s.results.flatMap((v: any) => v.result.media ?? []),
    ),
  ];
  const media = references.length ? await r.resolveMedia?.(references) : [];
  if (references.length && !media)
    throw new ConnectionError("Native media resolution is unavailable.", 409);
  const map = new Map(media?.map((m) => [m.versionId, m]));
  const ids = new Map<string, string>();
  if (provider === "xai")
    for (const m of media ?? [])
      if (m.mediaType === "application/pdf") {
        if (!uploadPdf)
          throw new ConnectionError("Native PDF upload is unavailable.", 409);
        ids.set(m.versionId, await uploadPdf(m));
      }
  const parts = (refs: MediaReference[] = []): any[] =>
    refs.flatMap<any>((ref) => {
      const m = map.get(ref.versionId);
      if (!m) throw new ConnectionError("Media could not be resolved.", 409);
      const image = m.mediaType.startsWith("image/"),
        url = `data:${m.mediaType};base64,${m.data}`;
      if (provider === "anthropic")
        return [
          {
            type: image ? "image" : "document",
            source: { type: "base64", media_type: m.mediaType, data: m.data },
          },
        ];
      if (provider === "google")
        return [{ inlineData: { mimeType: m.mediaType, data: m.data } }];
      if (provider === "openai" || provider === "xai")
        return [
          image
            ? { type: "input_image", image_url: url }
            : provider === "xai"
              ? { type: "input_file", file_id: ids.get(m.versionId) }
              : { type: "input_file", filename: m.name, file_data: url },
        ];
      if (provider === "ollama") return [m.data];
      return [
        image
          ? { type: "image_url", image_url: { url } }
          : { type: "file", file: { filename: m.name, file_data: url } },
      ];
    });
  const text = (value: string) =>
    provider === "google"
      ? { text: value }
      : {
          type:
            provider === "openai" || provider === "xai" ? "input_text" : "text",
          text: value,
        };
  const message = (m: TaskMessage): any => {
    if (provider === "google")
      return {
        role: m.role === "assistant" ? "model" : "user",
        parts: [{ text: m.content }, ...parts(m.media)],
      };
    if (!m.media?.length) return { role: m.role, content: m.content };
    if (provider === "ollama")
      return { role: m.role, content: m.content, images: parts(m.media) };
    return { role: m.role, content: [text(m.content), ...parts(m.media)] };
  };
  const after = (
    results: { call: { id: string }; result: ToolResult }[],
  ): any[] => {
    const refs = results.flatMap((v) => v.result.media ?? []);
    if (!refs.length) return [];
    return [
      message({
        role: "user",
        content: JSON.stringify({
          toolMedia: results
            .filter((v) => v.result.media?.length)
            .map((v) => ({
              callId: v.call.id,
              versions: v.result.media?.map((m) => m.versionId),
            })),
        }),
        media: refs,
      }),
    ];
  };
  return {
    messages: r.messages.map(message),
    parts,
    after,
    text,
    hasPdf: (media ?? []).some((m) => m.mediaType === "application/pdf"),
  };
}
