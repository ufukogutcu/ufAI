import { refreshOnFocus } from "./focus-refresh";

export function startUsagePolling(refresh: () => Promise<void>, intervalMs = 60000) {
  let running: Promise<void> | undefined;
  let stopped = false;
  const run = () => {
    if (stopped || document.visibilityState === "hidden") return Promise.resolve();
    if (!running) running = refresh().finally(() => { running = undefined; });
    return running;
  };
  void run();
  const cleanup = refreshOnFocus(run);
  const timer = setInterval(() => void run(), intervalMs);
  return () => { stopped = true; clearInterval(timer); cleanup(); };
}
