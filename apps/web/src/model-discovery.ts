import { errorMessage, request, type DiscoveredModel } from "./api";
export interface ModelDiscoveryState {
  connectionId: string | null;
  status: "idle" | "loading" | "ready" | "error";
  models: DiscoveredModel[];
  error: string;
}
export const emptyDiscovery: ModelDiscoveryState = {
  connectionId: null,
  status: "idle",
  models: [],
  error: "",
};
// Each editor owns its loader. An old request can never publish into a newer selection.
export function createModelLoader(
  fetchModels = (id: string, signal: AbortSignal) =>
    request<{ items: DiscoveredModel[] }>(
      `/connections/${id}/models`,
      "GET",
      undefined,
      signal,
    ),
) {
  let generation = 0;
  let controller: AbortController | undefined;
  return {
    load(
      connectionId: string | null,
      publish: (state: ModelDiscoveryState) => void,
    ) {
      const current = ++generation;
      controller?.abort();
      controller = new AbortController();
      const signal = controller.signal;
      publish({
        ...emptyDiscovery,
        connectionId,
        status: connectionId ? "loading" : "idle",
      });
      if (connectionId)
        void fetchModels(connectionId, signal)
          .then(({ items }) => {
            if (current === generation && !signal.aborted)
              publish({
                connectionId,
                models: items,
                status: "ready",
                error: "",
              });
          })
          .catch((error) => {
            if (current === generation && !signal.aborted)
              publish({
                ...emptyDiscovery,
                connectionId,
                status: "error",
                error: errorMessage(error),
              });
          });
      return () => {
        if (current === generation) {
          generation++;
          controller?.abort();
        }
      };
    },
  };
}
