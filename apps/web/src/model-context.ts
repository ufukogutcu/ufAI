import { request, type ProviderModel } from "./api";

export function contextDifference(
  model: Pick<ProviderModel, "contextWindowOverride" | "discoveredContextWindow">,
) {
  const manual = model.contextWindowOverride;
  const automatic = model.discoveredContextWindow;
  return manual !== null && automatic !== null && manual !== automatic
    ? { manual, automatic }
    : null;
}

export function resetContextToAutomatic(model: Pick<ProviderModel, "connectionId" | "id">) {
  return request<ProviderModel>(
    `/connections/${encodeURIComponent(model.connectionId)}/models/${encodeURIComponent(model.id)}`,
    "PATCH",
    { contextWindowOverride: null },
  );
}
