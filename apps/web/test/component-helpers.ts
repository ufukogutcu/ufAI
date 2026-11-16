import { register } from "node:module";
import type { TestContext } from "node:test";
import { JSDOM } from "jsdom";
import { act, type ReactNode } from "react";

// Node exercises component behavior; Vite and catalog checks validate the real SCSS.
register(`data:text/javascript,${encodeURIComponent(`export async function load(url, context, next) {
  if (url.endsWith('.scss')) return { format: 'module', shortCircuit: true,
    source: 'export default new Proxy({}, {get: (_, key) => String(key)})' };
  return next(url, context);
}`)}`, import.meta.url);

export async function mountComponent(t: TestContext, element: ReactNode) {
  const dom = new JSDOM("<div id='root'></div>", { pretendToBeVisual: true, url: "http://localhost" });
  const win = dom.window;
  const values = {
    window: win, document: win.document, navigator: win.navigator, Node: win.Node,
    HTMLElement: win.HTMLElement, HTMLDialogElement: win.HTMLDialogElement, MutationObserver: win.MutationObserver,
    ResizeObserver: class { observe() {} disconnect() {} }, getComputedStyle: win.getComputedStyle.bind(win),
    requestAnimationFrame: win.requestAnimationFrame.bind(win), cancelAnimationFrame: win.cancelAnimationFrame.bind(win),
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const descriptors = Object.keys(values).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const);
  for (const [key, value] of Object.entries(values)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  Object.defineProperty(win.document.documentElement, "clientWidth", { configurable: true, value: 400 });
  Object.defineProperty(win.document.documentElement, "clientHeight", { configurable: true, value: 300 });
  win.matchMedia = (() => ({ matches: true, addEventListener() {}, removeEventListener() {} })) as unknown as typeof win.matchMedia;
  win.HTMLDialogElement.prototype.showModal = function () { this.setAttribute("open", ""); };
  win.HTMLDialogElement.prototype.close = function () { this.removeAttribute("open"); };
  // Initialize React DOM after the document exists so native input events work.
  const { createRoot } = await import("react-dom/client");
  const root = createRoot(win.document.getElementById("root")!);
  t.after(async () => {
    await act(async () => root.unmount());
    dom.window.close();
    for (const [key, descriptor] of descriptors) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  });
  await act(async () => root.render(element));
  return { window: win, document: win.document, root,
    key: async (target: Element, key: string, options: KeyboardEventInit = {}) => act(async () => {
      target.dispatchEvent(new win.KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...options }));
    }),
    click: async (target: Element) => act(async () => { (target as HTMLElement).click(); }),
  };
}
