/** Browser consumers import these contracts as types only. */
export interface BrowserTab { id: string; url: string; title: string }
export interface BrowserDownload {
  id: string; name: string; state: "downloading" | "ready" | "failed";
  path?: string; error?: string;
}
export interface BrowserState {
  enabled: boolean;
  status: "idle" | "starting" | "ready" | "error";
  error: string | null;
  tabs: BrowserTab[];
  activeTabId: string | null;
  controller: string | null;
  dialog: { type: string; message: string; defaultValue: string } | null;
  fileChooser: { multiple: boolean } | null;
  downloads: BrowserDownload[];
  viewport: { width: number; height: number };
}
export type BrowserAction =
  | { action: "navigate"; url: string }
  | { action: "back" | "forward" | "reload" | "newTab" }
  | { action: "selectTab" | "closeTab"; tabId: string }
  | { action: "click"; ref?: string; x?: number; y?: number; button?: "left" | "right"; clickCount?: number }
  | { action: "fill" | "select"; ref: string; text: string }
  | { action: "type" | "key"; text: string }
  | { action: "scroll"; x: number; y: number }
  | { action: "dialog"; accept: boolean; text?: string }
  | { action: "wait"; ms: number }
  | { action: "snapshot" | "screenshot" };
export type BrowserServerMessage =
  | { type: "hello"; viewerId: string }
  | { type: "state"; state: BrowserState }
  | { type: "frame"; data: string; width: number; height: number }
  | { type: "error"; error: string };
