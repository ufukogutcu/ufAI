import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { act, createElement as h } from "react";
import { mountComponent } from "./component-helpers";
import type { AgentFileEntry } from "../../server/src/contracts";
const { AgentFiles, WorkspaceFolder } = await import("../src/components/AgentFiles");

function file(name: string, kind: AgentFileEntry["kind"] = "file"): AgentFileEntry {
  return { name, path: name, kind, size: 10, modifiedAt: null };
}
async function setup(t: TestContext, entries: AgentFileEntry[], root = "/managed/files", kind: "agent" | "workspace" = "agent") {
  let items = entries;
  const calls: { url: string; method: string; body: Record<string, unknown> }[] = [];
  let deletion: (() => Promise<Response>) | null = null;
  let listing: Promise<Response> | undefined;
  t.mock.method(globalThis, "fetch", async (input: string, init?: RequestInit) => {
    const url = new URL(String(input), "http://localhost"), body = JSON.parse(String(init?.body ?? "{}"));
    const method = init?.method ?? "GET";
    calls.push({ url: url.pathname + url.search, method, body });
    if (method === "DELETE") {
      const response = deletion ? await deletion() : new Response(null, { status: 204 });
      if (response.ok) items = items.filter(item => item.path !== body.path);
      return response;
    }
    if (url.pathname.endsWith("/locations")) return Response.json({ kind, ownerId: kind, path: root, state: "ready" });
    if (url.pathname.endsWith("/open")) return new Response(null, { status: 204 });
    if (listing) return listing;
    const path = url.searchParams.get("path") ?? "", offset = Number(url.searchParams.get("offset"));
    const current = items.filter(item => (item.path.includes("/") ? item.path.slice(0, item.path.lastIndexOf("/")) : "") === path);
    return Response.json({ path, total: current.length, items: current.slice(offset, offset + 100) });
  });
  const p = await mountComponent(t, kind === "agent" ? h(AgentFiles, { agentId: "agent" }) :
    h(WorkspaceFolder, { workspaceId: "workspace", onClose() {} }));
  const row = (name: string) => [...p.document.querySelectorAll<HTMLElement>("[data-file-entry]")].find(el => el.dataset.fileEntry === name)!;
  const menuItem = (label: string) => [...p.document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(el => el.textContent === label)!;
  const button = (label: string) => [...p.document.querySelectorAll<HTMLButtonElement>("button")].find(el => el.textContent === label)!;
  const open = async (name: string, key = "ContextMenu") => {
    await act(async () => row(name).focus());
    await p.key(row(name), key, key === "F10" ? { shiftKey: true } : {});
  };
  return { ...p, calls, row, menuItem, button, open,
    setDeletion: (action: () => Promise<Response>) => { deletion = action; },
    setListing: (response: Promise<Response>) => { listing = response; },
  };
}

test("Files opens row-specific menus by right-click and keyboard, preserves download links, and restricts unavailable entries", async t => {
  const p = await setup(t, [file("folder", "directory"), file("report.txt"), file("linked", "unavailable")]);
  await act(async () => { p.row("report.txt").dispatchEvent(new p.window.MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 100, clientY: 80 })); });
  const download = p.menuItem("Download");
  assert.match(download.getAttribute("href")!, /path=report.txt/);
  assert.equal(download.getAttribute("download"), "report.txt");
  assert.equal(p.document.querySelector('[role="tooltip"]'), null);
  await p.key(download, "Escape");
  assert.equal(p.document.activeElement, p.row("report.txt"));
  await p.open("folder", "F10");
  assert.ok(p.menuItem("Open"));
  await p.click(p.menuItem("Open in file manager"));
  assert.deepEqual(p.calls.find(call => call.url.endsWith("/open"))?.body, { path: "folder" });
  await p.open("linked");
  assert.deepEqual([...p.document.querySelectorAll('[role="menuitem"]')].map(el => el.textContent), ["Copy path", "Copy name"]);
  await p.key(p.menuItem("Copy name"), "Escape");
  await p.click(p.row("folder"));
  assert.ok(p.calls.some(call => call.url.includes("path=folder")));
});

test("Files copies the selected Windows path or name and provides the exact failed clipboard value", async t => {
  const p = await setup(t, [file("folder", "directory"), { ...file("report.txt"), path: "folder/report.txt" }], "C:\\managed\\files");
  const copied: string[] = [];
  let fail = false;
  Object.defineProperty(p.window.navigator, "clipboard", { value: { writeText: async (value: string) => {
    if (fail) throw new Error("Clipboard blocked");
    copied.push(value);
  } } });
  await p.open("folder"); await p.click(p.menuItem("Open"));
  await p.open("folder/report.txt"); await p.click(p.menuItem("Copy path"));
  assert.deepEqual(copied, ["C:\\managed\\files\\folder\\report.txt"]);
  await p.open("folder/report.txt"); await p.click(p.menuItem("Copy name"));
  assert.equal(copied[1], "report.txt");
  fail = true;
  await p.open("folder/report.txt"); await p.click(p.menuItem("Copy path"));
  assert.equal(p.document.querySelector("code")?.textContent, "C:\\managed\\files\\folder\\report.txt");
  assert.match(p.document.querySelector('[role="alert"]')?.textContent ?? "", /Copy is unavailable/);
});

test("Files confirms deletion, retains failures for retry, blocks duplicate requests, and focuses the next row", async t => {
  const p = await setup(t, [file("folder", "directory"), file("next.txt")]);
  await p.open("folder"); await p.click(p.menuItem("Delete…"));
  assert.match(p.document.querySelector("dialog")?.textContent ?? "", /folder and all its contents/);
  assert.equal(p.document.activeElement, p.button("Cancel"));
  await p.click(p.button("Cancel"));
  assert.equal(p.calls.some(call => call.method === "DELETE"), false);
  assert.equal(p.document.activeElement, p.row("folder"));
  await p.open("folder"); await p.click(p.menuItem("Delete…"));
  p.setDeletion(async () => Response.json({ error: "Permission denied" }, { status: 403 }));
  await p.click(p.button("Delete permanently"));
  assert.match(p.document.querySelector('[role="alert"]')?.textContent ?? "", /Permission denied/);
  let finish!: (response: Response) => void;
  p.setDeletion(() => new Promise(resolve => { finish = resolve; }));
  await p.click(p.button("Delete permanently"));
  assert.equal(p.button("Cancel").disabled, true);
  await p.key(p.document.querySelector("dialog")!, "Escape");
  assert.ok(p.document.querySelector("dialog[open]"));
  await p.click(p.button("Deleting…"));
  assert.equal(p.calls.filter(call => call.method === "DELETE").length, 2);
  await act(async () => finish(new Response(null, { status: 204 })));
  assert.equal(p.document.querySelector("dialog"), null);
  assert.equal(p.row("folder"), undefined);
  assert.equal(p.document.activeElement, p.row("next.txt"));
  assert.deepEqual(p.calls.filter(call => call.method === "DELETE")[1]!.body, { path: "folder", expectedKind: "directory", confirmFilesDeletion: true });
});

test("Files recovers the previous page after deleting its final entry and dismisses menus on refresh", async t => {
  const p = await setup(t, Array.from({ length: 101 }, (_, i) => file(`file-${i}.txt`)));
  await p.click(p.button("Next"));
  await p.open("file-100.txt"); await p.click(p.menuItem("Delete…"));
  await p.click(p.button("Delete permanently"));
  assert.ok(p.row("file-0.txt"));
  assert.equal(p.document.activeElement, p.row("file-0.txt"));
  await p.open("file-0.txt");
  await act(async () => p.window.dispatchEvent(new p.window.Event("focus")));
  assert.equal(p.document.querySelector('[role="menu"]'), null);
});

test("Workspace Folder shares row actions and keeps the confirmation scoped to the workspace", async t => {
  const p = await setup(t, [file("shared.txt"), file("other.txt")], "/managed/shared", "workspace");
  assert.match(p.document.querySelector("dialog h2")?.textContent ?? "", /Workspace Folder/);
  assert.match(p.row("shared.txt").getAttribute("href")!, /^\/api\/workspaces\/workspace\/files\/download/);
  await p.open("shared.txt", "F10");
  const remove = p.menuItem("Delete…");
  assert.ok(remove.closest("dialog[open]"));
  await p.click(remove);
  assert.equal(p.document.querySelectorAll("dialog[open]").length, 2);
  assert.equal(p.document.activeElement, p.button("Cancel"));
  await p.click(p.button("Delete permanently"));
  assert.deepEqual(p.calls.filter(call => call.method === "DELETE").map(call => call.url), ["/api/workspaces/workspace/files"]);
  assert.equal(p.document.querySelectorAll("dialog[open]").length, 1);
  assert.equal(p.document.activeElement, p.row("other.txt"));
});

test("Workspace Folder refreshes a visible listing in place", async t => {
  const p = await setup(t, [file("shared.txt")], "/managed/shared", "workspace");
  const row = p.row("shared.txt");
  await act(async () => row.focus());

  let finish!: (response: Response) => void;
  p.setListing(new Promise(resolve => { finish = resolve; }));
  await act(async () => p.window.dispatchEvent(new p.window.Event("focus")));
  const dialog = p.document.querySelector("dialog[open]")!;
  assert.equal(dialog.querySelector('[aria-label="Refresh files"]')?.getAttribute("aria-busy"), "true");
  assert.doesNotMatch(dialog.textContent!, /Loading files/);
  assert.equal(p.row("shared.txt"), row);
  assert.equal(p.document.activeElement, row);

  await act(async () => finish(Response.json({ path: "", total: 2, items: [file("shared.txt"), file("new.txt")] })));
  assert.ok(p.row("new.txt"));
  assert.equal(p.document.activeElement, row);
});
