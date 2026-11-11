import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { applyTheme, defaultThemes } from "./themes";
import { request, errorMessage } from "./api";
import type { SettingsResponse } from "../../server/src/contracts";
import "@xyflow/react/dist/style.css";
import "./styles.scss";

applyTheme(defaultThemes[0]!);

function Startup() {
  const [initial, setInitial] = useState<SettingsResponse | null>(null);
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let cancelled = false;
    void request<SettingsResponse>("/settings")
      .then((snapshot) => {
        if (cancelled) return;
        applyTheme(snapshot.activeTheme);
        setInitial(snapshot);
      })
      .catch((error: unknown) => {
        if (!cancelled) setError(errorMessage(error));
      });
    return () => {
      cancelled = true;
    };
  }, [attempt]);
  function handleRetry() {
    setError("");
    setAttempt((value) => value + 1);
  }
  if (initial) return <App initial={initial} />;
  return (
    <div className="centerState">
      {error ? (
        <>
          <p role="alert">{error}</p>
          <button className="button primary" onClick={handleRetry}>
            Retry
          </button>
        </>
      ) : (
        <p role="status">Loading your setup…</p>
      )}
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Startup />
  </StrictMode>,
);
