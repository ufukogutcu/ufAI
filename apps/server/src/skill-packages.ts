import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { pipeline } from "node:stream/promises";
import { Transform } from "node:stream";
import { request as httpsRequest } from "node:https";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import * as yauzl from "yauzl";
import { parseDocument, stringify } from "yaml";
import { ConnectionError } from "./model-providers.js";
import { managedDirectory } from "./host-paths.js";
import type { SkillInput } from "./skill-types.js";

export const skillLimits = {
  download: 20 * 1024 * 1024,
  expanded: 64 * 1024 * 1024,
  file: 16 * 1024 * 1024,
  instructions: 32768,
  entries: 2000,
};
export const badSkill = (message: string, status = 400): never => {
  throw new ConnectionError(message, status);
};
export function skillPath(value: string) {
  if (
    !value ||
    value.length > 1024 ||
    /[\\\0:\x00-\x1f<>"|?*]/.test(value) ||
    value.startsWith("/") ||
    value
      .split("/")
      .some((p) => !p || p === "." || p === ".." || /[. ]$/.test(p)) ||
    value.split("/").length > 16
  )
    badSkill("Skill package contains an unsafe path.");
  return value;
}
export function parseSkill(text: string): SkillInput {
  if (Buffer.byteLength(text) > skillLimits.instructions)
    badSkill(
      "SKILL.md must be at most 32 KiB. Move longer content into references.",
      413,
    );
  const match = /^\uFEFF?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)([\s\S]*)$/.exec(
    text,
  );
  if (!match)
    badSkill("SKILL.md needs YAML frontmatter with a name and description.");
  let meta: Record<string, unknown>;
  try {
    const document = parseDocument(match![1]!, {
      schema: "core",
      uniqueKeys: true,
    });
    if (document.errors.length) throw document.errors[0];
    meta = document.toJS({ maxAliasCount: 0 });
  } catch {
    return badSkill(
      "SKILL.md has invalid YAML. Quote values containing colons and remove aliases.",
    );
  }
  if (!meta! || typeof meta !== "object" || Array.isArray(meta))
    badSkill("Skill metadata must be a mapping.");
  if (
    typeof meta!.name !== "string" ||
    !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(meta!.name) ||
    meta!.name.length > 64
  )
    badSkill(
      "Use a skill name of up to 64 lowercase letters, numbers and single hyphens.",
    );
  if (
    typeof meta!.description !== "string" ||
    !meta!.description.trim() ||
    meta!.description.length > 1024
  )
    badSkill(
      "Provide a nonempty skill description of at most 1,024 characters.",
    );
  const result: SkillInput = {
    name: meta!.name as string,
    description: (meta!.description as string).trim(),
    instructions: match![2]!.trim(),
  };
  const known = ["name", "description", "license", "compatibility", "allowed-tools", "metadata"];
  const foreign = Object.fromEntries(Object.entries(meta!).filter(([k]) => !known.includes(k)));
  if (Object.keys(foreign).some(k => ["__proto__", "constructor", "prototype"].includes(k))) badSkill("Invalid frontmatter key.");
  if (Object.keys(foreign).length) result.frontmatter = foreign;
  for (const key of ["license", "compatibility", "allowed-tools"] as const) {
    if (meta![key] !== undefined) {
      if (
        typeof meta![key] !== "string" ||
        (meta![key] as string).length > (key === "compatibility" ? 500 : 2000)
      )
        badSkill(`Invalid ${key} metadata.`);
      result[key] = meta![key] as string;
    }
  }
  if (meta!.metadata !== undefined) {
    if (meta!.metadata && typeof meta!.metadata === "object" && !Array.isArray(meta!.metadata)) {
      meta!.metadata = Object.fromEntries(Object.entries(meta!.metadata).map(([k,v]) => [k, typeof v === "object" && v !== null ? JSON.stringify(v) : v]));
    }
    if (
      !meta!.metadata ||
      typeof meta!.metadata !== "object" ||
      Array.isArray(meta!.metadata) ||
      Object.entries(meta!.metadata).length > 40 ||
      Object.entries(meta!.metadata).some(
        ([k, v]) =>
          ["__proto__", "constructor", "prototype"].includes(k) ||
          typeof v !== "string" ||
          v.length > 2000,
      )
    )
      badSkill(
        "Skill metadata must contain at most 40 string entries, each at most 2,000 characters.",
      );
    result.metadata = meta!.metadata as Record<string, string>;
  }
  return result;
}
export function skillDocument(input: SkillInput) {
  if (
    !input ||
    typeof input !== "object" ||
    typeof input.instructions !== "string"
  )
    badSkill("Provide skill metadata and Markdown instructions.");
  const { instructions, ...meta } = input;
  const allowed = [
    "name",
    "description",
    "license",
    "compatibility",
    "metadata",
    "allowed-tools",
    "frontmatter",
  ];
  if (Object.keys(meta).some((k) => !allowed.includes(k)))
    badSkill("Unknown skill metadata field.");
  for (const key of ["license", "compatibility", "allowed-tools"] as const)
    if (meta[key] === "") delete meta[key];
  const { frontmatter, ...supported } = meta;
  if (frontmatter && (typeof frontmatter !== "object" || Array.isArray(frontmatter) || Object.keys(frontmatter).some(k => ["__proto__", "constructor", "prototype"].includes(k)))) badSkill("Invalid preserved frontmatter.");
  const text = `---\n${stringify({ ...frontmatter, ...supported })}---\n\n${instructions.trim()}\n`;
  parseSkill(text);
  return text;
}
export async function readSkillFile(path: string, maximum = skillLimits.file) {
  await managedDirectory(dirname(path));
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size > maximum)
      badSkill(
        `Skill resource is not a regular file or exceeds ${Math.floor(maximum / 1024 / 1024)} MiB.`,
        413,
      );
    const bytes = Buffer.alloc(info.size);
    let offset = 0;
    while (offset < bytes.length) {
      const read = await file.read(
        bytes,
        offset,
        bytes.length - offset,
        offset,
      );
      if (!read.bytesRead)
        badSkill(
          "Skill resource changed while reading. Refresh and retry.",
          409,
        );
      offset += read.bytesRead;
    }
    const after = await file.stat();
    if (
      after.size !== info.size ||
      after.mtimeMs !== info.mtimeMs ||
      after.ctimeMs !== info.ctimeMs
    )
      badSkill("Skill resource changed while reading. Refresh and retry.", 409);
    return bytes;
  } finally {
    await file.close();
  }
}
export async function scanPackage(root: string, signal?: AbortSignal) {
  await managedDirectory(root);
  const files: { path: string; size: number; hash: string }[] = [];
  const hash = createHash("sha256");
  let document = "", triggerManifest: string | null = null;
  let bytes = 0,
    count = 0;
  async function walk(relative: string) {
    const folder = join(root, relative);
    const entries = await readdir(folder, { withFileTypes: true });
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      signal?.throwIfAborted();
      if (++count > skillLimits.entries)
        badSkill("Skill package contains more than 2,000 entries.", 413);
      const path = skillPath(
        relative ? `${relative}/${entry.name}` : entry.name,
      );
      const full = join(root, path);
      const stat = await lstat(full);
      if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile()))
        badSkill("Skill packages cannot contain links or special files.");
      if (stat.isDirectory()) {
        await walk(path);
        continue;
      }
      bytes += stat.size;
      if (bytes > skillLimits.expanded)
        badSkill("Skill package exceeds 64 MiB.", 413);
      const contents = await readSkillFile(full);
      if (path === "SKILL.md") document = contents.toString("utf8");
      if (path === "ufai.triggers.json") triggerManifest = contents.length <= 65536 ? contents.toString("utf8") : '{"invalid":"Trigger manifest exceeds 64 KiB."}';
      hash
        .update(path)
        .update("\0")
        .update(contents)
        .update("\0")
        .update(String(Number(Boolean(stat.mode & 0o111))));
      files.push({ path, size: contents.length, hash: createHash("sha256").update(contents).update(String(Number(Boolean(stat.mode & 0o111)))).digest("hex") });
    }
  }
  await walk("");
  const input = parseSkill(document);
  return { input, files, fingerprint: hash.digest("hex"), triggerManifest };
}
export async function copyPackage(
  source: string,
  target: string,
  signal?: AbortSignal,
) {
  const scanned = await scanPackage(source, signal);
  await managedDirectory(target, true);
  for (const entry of scanned.files) {
    signal?.throwIfAborted();
    const destination = join(target, entry.path);
    await managedDirectory(dirname(destination), true);
    const stat = await lstat(join(source, entry.path));
    await writeFile(
      destination,
      await readSkillFile(join(source, entry.path)),
      { flag: "wx", mode: stat.mode & 0o111 ? 0o755 : 0o644 },
    );
  }
  return scanPackage(target, signal);
}
export async function extractZip(
  path: string,
  target: string,
  signal?: AbortSignal,
) {
  await managedDirectory(target, true);
  const archive = await new Promise<yauzl.ZipFile>((res, rej) =>
    yauzl.open(
      path,
      { lazyEntries: true, validateEntrySizes: true, strictFileNames: true },
      (e, zip) => (e ? rej(e) : res(zip!)),
    ),
  );
  let count = 0,
    bytes = 0;
  const abort = () => archive.close();
  signal?.addEventListener("abort", abort, { once: true });
  try {
    await new Promise<void>((res, rej) => {
      let ended = false;
      archive.on("error", rej);
      archive.on("end", () => {
        ended = true;
        res();
      });
      archive.on("close", () => {
        if (!ended)
          rej(new ConnectionError("ZIP extraction was interrupted.", 409));
      });
      archive.on("entry", (entry: yauzl.Entry) => {
        void (async () => {
          signal?.throwIfAborted();
          if (++count > skillLimits.entries)
            badSkill("ZIP contains more than 2,000 entries.", 413);
          const directory = entry.fileName.endsWith("/");
          const relative = skillPath(
            directory ? entry.fileName.slice(0, -1) : entry.fileName,
          );
          const mode = entry.externalFileAttributes >>> 16;
          const kind = mode & 0o170000;
          if (
            entry.generalPurposeBitFlag & 1 ||
            (kind && kind !== 0o100000 && kind !== 0o040000)
          )
            badSkill(
              "Encrypted ZIPs, links and special files are unsupported.",
            );
          const destination = join(target, relative);
          if (directory) await managedDirectory(destination, true);
          else {
            bytes += entry.uncompressedSize;
            if (
              bytes > skillLimits.expanded ||
              entry.uncompressedSize > skillLimits.file
            )
              badSkill("ZIP exceeds the skill package size limits.", 413);
            await managedDirectory(dirname(destination), true);
            const stream = await new Promise<NodeJS.ReadableStream>(
              (resolveStream, rejectStream) =>
                archive.openReadStream(entry, (e, s) =>
                  e ? rejectStream(e) : resolveStream(s!),
                ),
            );
            const file = await open(
              destination,
              "wx",
              mode & 0o111 ? 0o755 : 0o644,
            );
            try {
              await pipeline(stream, file.createWriteStream(), { signal });
            } finally {
              await file.close();
            }
          }
          archive.readEntry();
        })().catch(rej);
      });
      archive.readEntry();
    });
  } finally {
    archive.close();
    signal?.removeEventListener("abort", abort);
  }
}
// Pin DNS resolution for every request, including redirects; skill imports only fetch public HTTPS.
function publicAddress(address: string) {
  if (isIP(address) === 4) {
    const [a, b] = address.split(".").map(Number) as [number, number];
    return (
      a !== 0 &&
      a !== 10 &&
      a !== 127 &&
      a < 224 &&
      !(a === 169 && b === 254) &&
      !(a === 172 && b >= 16 && b <= 31) &&
      !(a === 192 && (b === 168 || b === 0)) &&
      !(a === 100 && b >= 64 && b <= 127) &&
      !(a === 198 && (b === 18 || b === 19))
    );
  }
  return (
    isIP(address) === 6 &&
    /^[23][0-9a-f]{3}:/i.test(address) &&
    !address.toLowerCase().startsWith("2001:db8:")
  );
}
export async function downloadSkill(
  url: string,
  destination: string,
  signal?: AbortSignal,
  redirects = 0,
): Promise<string> {
  signal = AbortSignal.any([
    ...(signal ? [signal] : []),
    AbortSignal.timeout(30000),
  ]);
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return badSkill("Provide a public HTTPS skill URL.");
  }
  if (
    parsed!.protocol !== "https:" ||
    parsed!.username ||
    parsed!.password ||
    (parsed!.port && parsed!.port !== "443") ||
    parsed!.hash ||
    redirects > 5
  )
    badSkill(
      "Use a public HTTPS URL without credentials, custom ports or fragments.",
    );
  const host = parsed!.hostname.replace(/^\[|\]$/g, "");
  const addresses = isIP(host)
    ? [{ address: host, family: isIP(host) }]
    : await lookup(host, { all: true });
  if (!addresses.length || addresses.some((a) => !publicAddress(a.address)))
    badSkill("Skill downloads must use a public internet address.");
  const chosen = addresses[0]!;
  const response = await new Promise<import("node:http").IncomingMessage>(
    (res, rej) => {
      const request = httpsRequest(
        parsed!,
        {
          signal,
          headers: {
            "User-Agent": "ufAI-skills",
            Accept: "application/zip, text/plain, application/octet-stream",
          },
          lookup: ((
            _host: string,
            _options: unknown,
            done: (...args: unknown[]) => void,
          ) =>
            (_options as { all?: boolean })?.all
              ? done(null, [chosen])
              : done(
                  null,
                  chosen.address,
                  chosen.family,
                )) as import("node:net").LookupFunction,
        },
        res,
      );
      request.on("error", rej);
      request.setTimeout(30000, () =>
        request.destroy(new Error("Skill download timed out.")),
      );
      request.end();
    },
  );
  if (
    [301, 302, 303, 307, 308].includes(response.statusCode ?? 0) &&
    response.headers.location
  ) {
    response.destroy();
    return downloadSkill(
      new URL(response.headers.location, parsed!).href,
      destination,
      signal,
      redirects + 1,
    );
  }
  if (response.statusCode !== 200) {
    response.destroy();
    return badSkill(
      `Skill download failed (${response.statusCode}). Check the public URL.`,
      400,
    );
  }
  let size = 0;
  const limiter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      size += chunk.length;
      callback(
        size > skillLimits.download
          ? new ConnectionError("Skill download exceeds 20 MiB.", 413)
          : null,
        chunk,
      );
    },
  });
  const file = await open(destination, "wx");
  try {
    await pipeline(response, limiter, file.createWriteStream(), { signal });
  } finally {
    await file.close();
  }
  return parsed!.href;
}
export async function discoverSkills(root: string) {
  const found: string[] = [];
  let count = 0;
  async function walk(path: string, depth: number) {
    if (depth > 12) return;
    const entries = await readdir(path, { withFileTypes: true });
    if ((count += entries.length) > skillLimits.entries)
      badSkill(
        "Source contains more than 2,000 entries; use a specific skill folder or smaller ZIP.",
        413,
      );
    if (entries.some((e) => e.name === "SKILL.md" && e.isFile())) {
      found.push(path);
      return;
    }
    for (const entry of entries)
      if (
        entry.isDirectory() &&
        ![".git", "node_modules", "__MACOSX"].includes(entry.name)
      )
        await walk(join(path, entry.name), depth + 1);
  }
  await walk(root, 0);
  return found;
}
