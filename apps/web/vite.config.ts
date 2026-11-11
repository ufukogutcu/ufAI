import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import catalog from "@ufai/theme-catalog";
import { relayFavicon } from "./src/branding.ts";

function defaultColors(mode: "light" | "dark") {
  return `:root{color-scheme:${mode};color:var(--text);background:var(--root-background);${Object.values(
    catalog.tokens,
  )
    .map((token) => `${token.cssVariable}:${token[mode]}`)
    .join(";")}}`;
}

export default defineConfig({
  plugins: [
    react(),
    {
      name: "ufai-theme-defaults",
      transformIndexHtml() {
        return [
          {
            tag: "link",
            attrs: {
              id: "ufai-favicon",
              rel: "icon",
              type: "image/svg+xml",
              href: relayFavicon({
                "logo-text": catalog.tokens["logo-text"].light,
                "logo-secondary": catalog.tokens["logo-secondary"].light,
              }),
            },
            injectTo: "head",
          },
          {
            tag: "style",
            attrs: { id: "ufai-theme-defaults" },
            injectTo: "head-prepend",
            children: defaultColors("light"),
          },
        ];
      },
    },
  ],
  server: {
    host: "127.0.0.1",
    port: Number(process.env.WEB_PORT ?? 5173),
    strictPort: true,
    proxy: {
      "/api": `http://${process.env.HOST ?? "127.0.0.1"}:${process.env.PORT ?? 3000}`,
    },
  },
});
