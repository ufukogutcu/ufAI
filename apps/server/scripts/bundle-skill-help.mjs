import { mkdir, copyFile } from "node:fs/promises";
const destination = new URL("../dist/builtin-skills/", import.meta.url);
await mkdir(destination, { recursive: true });
await copyFile(
  new URL("../../../docs/platform.md", import.meta.url),
  new URL("platform.md", destination),
);
