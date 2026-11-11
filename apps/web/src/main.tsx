import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { applyTheme, readInitialTheme } from "./themes";
import "@xyflow/react/dist/style.css";
import "./styles.scss";

const initialTheme = readInitialTheme();
applyTheme(initialTheme);

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App initialTheme={initialTheme} />
  </StrictMode>,
);
