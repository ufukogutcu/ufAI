import type { TestContext } from "node:test";
import { createApp } from "../../server/src/app.js";
import type { SettingsResponse } from "../../server/src/contracts.js";
import { createSettingsStore } from "../src/settings-store.js";
import { defaultThemes } from "../src/themes.js";

export function initialSettings(): SettingsResponse {
  return {
    settings: {
      activeThemeId: "light-mode",
      activeWorkspaceId: null,
      sidebarExpanded: false,
      characterAnimationsPaused: false,
    },
    activeTheme: defaultThemes[0]!,
    activeWorkspace: null,
  };
}
export async function connectedSetup(t: TestContext) {
  const app = createApp({ databasePath: ":memory:", serveStatic: false });
  t.after(() => app.close());
  t.mock.method(
    globalThis,
    "fetch",
    async (url: string, init?: RequestInit) => {
      const result = await app.inject({
        method: (init?.method ?? "GET") as "GET" | "POST" | "PATCH" | "DELETE",
        url,
        headers: init?.headers as Record<string, string>,
        payload: init?.body as string | undefined,
      });
      return new Response(result.statusCode === 204 ? null : result.body, {
        status: result.statusCode,
        headers: { "Content-Type": "application/json" },
      });
    },
  );
  const initial = (await app.inject("/api/settings")).json<SettingsResponse>();
  return { app, settings: createSettingsStore(initial), initial };
}
