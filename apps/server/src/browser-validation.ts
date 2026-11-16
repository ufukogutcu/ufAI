import { ConnectionError } from "./model-providers.js";
import type { BrowserAction } from "./browser-types.js";
function invalid(): never { throw new ConnectionError("Invalid browser action.", 400); }
export function browserAction(value: unknown): BrowserAction {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid();
  const a = value as Record<string, unknown>;
  const string = (key: string, max = 16000) => typeof a[key] === "string" && (a[key] as string).length <= max && !(a[key] as string).includes("\0");
  const integer = (key: string, min: number, max: number) => Number.isSafeInteger(a[key]) && Number(a[key]) >= min && Number(a[key]) <= max;
  const fields: Record<string, string[]> = {
    navigate: ["url"], back: [], forward: [], reload: [], newTab: [], selectTab: ["tabId"], closeTab: ["tabId"],
    click: ["ref", "x", "y", "button", "clickCount"], fill: ["ref", "text"], select: ["ref", "text"], type: ["text"], key: ["text"],
    scroll: ["x", "y"], wait: ["ms"], dialog: ["accept", "text"], snapshot: [], screenshot: [],
  };
  if (typeof a.action !== "string" || !Object.hasOwn(fields, a.action) || Object.keys(a).some(k => k !== "action" && !fields[a.action as string]!.includes(k))) invalid();
  if (a.action === "navigate" && (!string("url", 4096) || !a.url)) invalid();
  if (["selectTab", "closeTab"].includes(a.action) && (!string("tabId", 100) || !a.tabId)) invalid();
  if (["fill", "select"].includes(a.action) && (!string("ref", 100) || !a.ref || !string("text"))) invalid();
  if (["type", "key"].includes(a.action) && !string("text")) invalid();
  if (a.action === "scroll" && (!integer("x", -10000, 10000) || !integer("y", -10000, 10000))) invalid();
  if (a.action === "wait" && !integer("ms", 0, 10000)) invalid();
  if (a.action === "dialog" && (typeof a.accept !== "boolean" || (a.text !== undefined && !string("text")))) invalid();
  if (a.action === "click") {
    if (a.ref !== undefined ? !string("ref", 100) || !a.ref : !integer("x", 0, 1280) || !integer("y", 0, 800)) invalid();
    if (a.button !== undefined && !["left", "right"].includes(String(a.button))) invalid();
    if (a.clickCount !== undefined && !integer("clickCount", 1, 2)) invalid();
  }
  return a as unknown as BrowserAction;
}
