// A visibility change and focus commonly arrive together. Share one refresh.
export function refreshOnFocus(refresh: () => Promise<void>) {
  let running: Promise<void> | undefined;
  let disposed = false;
  function handleFocus() {
    if (disposed || document.visibilityState === "hidden" || running) return;
    running = refresh().finally(() => {
      running = undefined;
    });
  }
  window.addEventListener("focus", handleFocus);
  document.addEventListener("visibilitychange", handleFocus);
  return () => {
    disposed = true;
    window.removeEventListener("focus", handleFocus);
    document.removeEventListener("visibilitychange", handleFocus);
  };
}
