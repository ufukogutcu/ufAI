import { ConnectionError } from "./model-providers.js";

export const processYieldMinMs = 0;
export const processYieldMaxMs = 1000;
export const processYieldDefaultMs = 100;
export const processYieldGuidance =
  `Use a nonnegative safe integer in milliseconds. Effective range: ${processYieldMinMs}–${processYieldMaxMs} ms inclusive; default: ${processYieldDefaultMs} ms. Larger safe integers are capped at ${processYieldMaxMs} ms. This only waits before returning a process handle; it does not limit command runtime. Use process_wait to wait for completion.`;

export function normalizeProcessYieldMs(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < processYieldMinMs)
    throw new ConnectionError(`process_start.yieldMs: ${processYieldGuidance}`, 400);
  return Math.min(value, processYieldMaxMs);
}
