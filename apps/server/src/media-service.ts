import { imageSize } from "image-size";
import type { ArtifactService } from "./artifact-service.js";
import type { MediaCapabilities, ProviderModel } from "./contracts.js";
import { ConnectionError } from "./model-providers.js";

export interface MediaReference {
  versionId: string;
  name: string;
  mediaType: string;
  size: number;
}
export interface NativeMedia extends MediaReference {
  data: string;
  width?: number;
  height?: number;
}
export function effectiveMedia(
  provider: string,
  model?: ProviderModel,
): MediaCapabilities {
  const effective = model?.mediaSettings?.effective ?? {
    image: "unknown",
    pdf: "unknown",
  };
  return {
    limits:
      provider === "anthropic"
        ? { maxImageBytes: 7_500_000, maxTotalBytes: 22_000_000 }
        : provider === "google"
          ? {
              maxTotalBytes: 13_000_000,
              imageTypes: ["image/png", "image/jpeg", "image/webp"],
            }
          : {},
    image: effective.image,
    pdf: [
      "openai",
      "anthropic",
      "google",
      "xai",
      "openrouter",
      "openai-compatible",
    ].includes(provider)
      ? effective.pdf
      : "unsupported",
  };
}
export function imageMetadata(bytes: Buffer) {
  try {
    const result = imageSize(bytes.subarray(0, 1024 * 1024));
    if (
      !result.width ||
      !result.height ||
      result.width > 32768 ||
      result.height > 32768 ||
      result.width * result.height > 40_000_000 ||
      !["png", "jpg", "webp", "gif"].includes(result.type!)
    )
      throw new Error();
    return { width: result.width, height: result.height };
  } catch {
    throw new ConnectionError(
      "Image format or dimensions are invalid or exceed the inspection limits. Attach it as File only instead.",
      409,
    );
  }
}
export class MediaService {
  private preparing = 0;
  constructor(readonly artifacts: ArtifactService) {}
  reference(
    id: string,
    workspaceId: string,
    ingestId?: string,
  ): MediaReference {
    const v = this.artifacts.get(id);
    if (v.workspaceId !== workspaceId)
      throw new ConnectionError("Artifact is outside this workspace.", 403);
    if (
      (v as { ingestId?: string }).ingestId &&
      (v as { ingestId?: string }).ingestId !== ingestId
    )
      throw new ConnectionError("File transfer has not been committed.", 409);
    if (v.state !== "ready")
      throw new ConnectionError("Attachment bytes are unavailable.", 409);
    return {
      versionId: v.id,
      name: v.name,
      mediaType: v.mediaType,
      size: v.size,
    };
  }
  async resolve(
    ref: MediaReference,
    workspaceId: string,
    capabilities: MediaCapabilities,
    ingestId?: string,
  ): Promise<NativeMedia> {
    const kind = ref.mediaType.startsWith("image/")
      ? "image"
      : ref.mediaType === "application/pdf"
        ? "pdf"
        : null;
    if (!kind)
      throw new ConnectionError(
        "This format has no native media input in ufAI.",
        409,
      );
    if (capabilities[kind] !== "supported")
      throw new ConnectionError(
        `Native ${kind} input is ${capabilities[kind]} for this model and adapter.`,
        409,
      );
    if (
      kind === "image" &&
      capabilities.limits?.imageTypes &&
      !capabilities.limits.imageTypes.includes(ref.mediaType)
    )
      throw new ConnectionError(
        "This image format is unsupported by the native adapter.",
        409,
      );
    if (
      kind === "image" &&
      ref.size > (capabilities.limits?.maxImageBytes ?? 20 * 1024 * 1024)
    )
      throw new ConnectionError(
        "Image exceeds this Provider's native input limit.",
        413,
      );
    const { version, bytes } = await this.artifacts.bytes(
      ref.versionId,
      workspaceId,
      20 * 1024 * 1024,
      ingestId,
    );
    return {
      ...ref,
      mediaType: version.mediaType,
      data: bytes.toString("base64"),
      ...(kind === "image" ? imageMetadata(bytes) : {}),
    };
  }
  async prepare(
    refs: MediaReference[],
    workspaceId: string,
    caps: MediaCapabilities,
    ingestId?: string,
  ) {
    if (
      refs.length > 10 ||
      refs.reduce((n, r) => n + r.size, 0) >
        (caps.limits?.maxTotalBytes ?? 32 * 1024 * 1024)
    )
      throw new ConnectionError(
        "Native media request exceeds the item or Provider byte limit. ufAI permits at most ten items and 32 MiB.",
        413,
      );
    if (this.preparing >= 2)
      throw new ConnectionError(
        "Native media preparation is busy. Retry shortly.",
        429,
      );
    this.preparing++;
    try {
      const result: NativeMedia[] = [];
      for (const ref of refs)
        result.push(await this.resolve(ref, workspaceId, caps, ingestId));
      return result;
    } finally {
      this.preparing--;
    }
  }
}
