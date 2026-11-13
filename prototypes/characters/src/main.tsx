import { CharacterMotionProvider } from "../../../apps/web/src/components/CharacterMotion";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import catalog from "@ufai/theme-catalog";
import Playground from "./Playground";
import "./base.scss";

// The standalone preview has no settings, workspace or provider connections.
const defaults = document.createElement("style");
defaults.textContent = `:root{${Object.values(catalog.tokens).map(token => `${token.cssVariable}:${token.light}`).join(";")}}`;
document.head.append(defaults);
createRoot(document.getElementById("root")!).render(<StrictMode><CharacterMotionProvider><Playground /></CharacterMotionProvider></StrictMode>);
