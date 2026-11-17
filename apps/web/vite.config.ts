import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import catalog from "@ufai/theme-catalog";
import { relayFavicon } from "./src/branding.ts";
import { fileURLToPath } from "node:url";
import { enforceChunkLimit, mermaidGrammarChunks } from "./build/mermaid-grammars.ts";

function defaultColors(mode: "light" | "dark") {
  return `:root{color-scheme:${mode};color:var(--text);background:var(--root-background);${Object.values(
    catalog.tokens,
  )
    .map((token) => `${token.cssVariable}:${token[mode]}`)
    .join(";")}}`;
}

export default defineConfig({
  resolve: {
    alias: [{ find: /^elkjs\/lib\/elk\.bundled\.js$/, replacement: fileURLToPath(new URL("./src/mermaid-elk.ts", import.meta.url)) }],
  },
  optimizeDeps: {
    // Keep the worker adapter in Vite's normal source pipeline, which handles ?url.
    exclude: ["elkjs/lib/elk.bundled.js"],
    include: ["elkjs/lib/elk-api.js"],
  },
  build: {
    rolldownOptions: {
      output: {
        codeSplitting: {
          groups: [
            { name: "preload", test: /vite\/preload-helper/ },
            { name: "react", test: /\/node_modules\/(?:react|react-dom|scheduler)\// },
            { name: "workspace-navigation", includeDependenciesRecursively: false, test: /\/src\/(?:pages\/Home|components\/WorkspaceTabs?|store)\.tsx?$/ },
            { name: "canvas", test: /\/node_modules\/@xyflow\// },
            { name: "syntax-highlighting", test: /\/node_modules\/(?:highlight\.js|lowlight|rehype-highlight)\// },
            { name: "mermaid-grammars", test: /^\0ufai:mermaid-grammars$/ },
          ],
        },
      },
    },
  },
  plugins: [
    react(),
    mermaidGrammarChunks(),
    enforceChunkLimit(),
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
      "/api": {
        target: `http://${process.env.HOST ?? "127.0.0.1"}:${process.env.PORT ?? 3000}`,
        // Keep Host aligned with the browser Origin for connection-route checks.
        changeOrigin: false,
        ws: true,
      },
    },
  },
});
