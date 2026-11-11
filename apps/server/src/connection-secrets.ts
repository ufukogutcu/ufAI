import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// Only the server receives the key. In-memory test databases never create local files.
export class ConnectionSecrets {
  private key?: Buffer;
  constructor(private directory: string | null) {}
  private getKey() {
    if (this.key) return this.key;
    if (!this.directory) return (this.key = randomBytes(32));
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    chmodSync(this.directory, 0o700);
    const path = join(this.directory, "connections.key");
    try {
      writeFileSync(path, randomBytes(32), { flag: "wx", mode: 0o600 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    chmodSync(path, 0o600);
    const key = readFileSync(path);
    if (key.length !== 32)
      throw new Error("Connection credential key is invalid.");
    return (this.key = key);
  }
  encrypt(value: string, connectionId: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.getKey(), iv);
    cipher.setAAD(Buffer.from(connectionId));
    const encrypted = Buffer.concat([
      cipher.update(value, "utf8"),
      cipher.final(),
    ]);
    return Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString(
      "base64",
    );
  }
  decrypt(value: string, connectionId: string): string {
    const data = Buffer.from(value, "base64");
    const cipher = createDecipheriv(
      "aes-256-gcm",
      this.getKey(),
      data.subarray(0, 12),
    );
    cipher.setAAD(Buffer.from(connectionId));
    cipher.setAuthTag(data.subarray(12, 28));
    return Buffer.concat([
      cipher.update(data.subarray(28)),
      cipher.final(),
    ]).toString("utf8");
  }
}
