import { lstat, mkdir } from "node:fs/promises";
import { dirname, join, parse, resolve } from "node:path";
import { ConnectionError } from "./model-providers.js";

// Managed storage must never resolve a symlinked ancestor, including during cleanup.
export async function managedDirectory(path: string, create = false) {
  const absolute = resolve(path),
    root = parse(absolute).root;
  let current = root;
  for (const part of absolute
    .slice(root.length)
    .split(/[\\/]/)
    .filter(Boolean)) {
    current = join(current, part);
    if (create)
      await mkdir(current).catch((e) => {
        if (e.code !== "EEXIST") throw e;
      });
    const stat = await lstat(current);
    if (!stat.isDirectory() || stat.isSymbolicLink())
      throw new ConnectionError(
        "Managed directory is unavailable or linked.",
        409,
      );
  }
  return absolute;
}
export async function managedFile(path: string) {
  await managedDirectory(dirname(path));
  const stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink())
    throw new ConnectionError("Managed file is unavailable or linked.", 409);
  return stat;
}
