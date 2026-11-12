import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { ConnectionError } from "./model-providers.js";

export type CodexLauncher = (home: string) => ChildProcessWithoutNullStreams;
export type CodexCatalogLauncher = (
  home: string,
  bundled: boolean,
) => ChildProcessWithoutNullStreams;

const require = createRequire(import.meta.url);
function spawnCodex(home: string, args: string[]) {
  const targets: Record<string, string> = {
    "linux-x64": "x86_64-unknown-linux-musl",
    "linux-arm64": "aarch64-unknown-linux-musl",
    "darwin-x64": "x86_64-apple-darwin",
    "darwin-arm64": "aarch64-apple-darwin",
    "win32-x64": "x86_64-pc-windows-msvc",
    "win32-arm64": "aarch64-pc-windows-msvc",
  };
  const target = targets[`${process.platform}-${process.arch}`];
  if (!target)
    throw new ConnectionError(
      "Bundled Codex is unavailable on this platform.",
      503,
    );
  let binary: string;
  try {
    const root = dirname(
      require.resolve(
        `@openai/codex-${process.platform}-${process.arch}/package.json`,
      ),
    );
    binary = join(
      root, "vendor", target, "bin",
      process.platform === "win32" ? "codex.exe" : "codex",
    );
  } catch {
    throw new ConnectionError(
      "Bundled Codex is missing. Run npm ci with optional dependencies enabled.",
      503,
    );
  }
  const env = { ...process.env };
  for (const key of Object.keys(env))
    if (/^(CODEX_|OPENAI_)/.test(key)) delete env[key];
  env.CODEX_HOME = home;
  return spawn(
    binary,
    [
      ...args,
      "-c", 'cli_auth_credentials_store="file"',
      "-c", 'model_provider="openai"',
      "-c", 'forced_login_method="chatgpt"',
    ],
    { cwd: home, env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true },
  );
}

export const launchCodex: CodexLauncher = (home) =>
  spawnCodex(home, ["app-server", "--listen", "stdio://"]);

export const launchCodexCatalog: CodexCatalogLauncher = (home, bundled) =>
  spawnCodex(home, ["debug", "models", ...(bundled ? ["--bundled"] : [])]);
