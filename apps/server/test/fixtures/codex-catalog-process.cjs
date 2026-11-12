// Raw catalog process double; never contacts a provider.
const fs = require("node:fs");
const path = require("node:path");
const [home, source, mode] = process.argv.slice(2);
if (mode === "hang") {
  process.on("SIGTERM", () => {});
  setInterval(() => {}, 1000);
} else if (mode === "exit") {
  process.stderr.write("PRIVATE-CATALOG-ERROR");
  process.exitCode = 1;
} else if (mode === "oversize") {
  process.stdout.write(Buffer.alloc(8 * 1024 * 1024 + 1, " "));
} else if (mode === "multibyte") {
  process.stdout.write("é".repeat(5 * 1024 * 1024));
} else if (mode === "malformed") {
  process.stdout.write("PRIVATE-INVALID-CATALOG");
} else {
  const file = path.join(home, `${source}-catalog.json`);
  process.stdout.write(fs.existsSync(file) ? fs.readFileSync(file) : '{"models":[]}');
}
