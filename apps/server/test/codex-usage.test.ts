import assert from "node:assert/strict";
import { test } from "node:test";
import { normalizeCodexUsage } from "../src/codex-usage.js";

test("usage normalization preserves unknown values and strips private or malformed fields", () => {
  const snapshot = normalizeCodexUsage({ planType: "pro", email: "private" }, {
    rateLimits: { primary: { usedPercent: -1 }, secondary: { usedPercent: "15" }, credits: { balance: 999, hasCredits: true, unlimited: false }, accessToken: "private" },
    rateLimitResetCredits: { availableCount: 3, credits: [null, { id: "opaque", resetType: "new", status: "new", grantedAt: -1, expiresAt: null }, { id: "used", status: "redeemed", resetType: "codexRateLimits", grantedAt: 1700000000 }] },
  });
  assert.equal(snapshot.defaultLimit?.primary, null);
  assert.equal(snapshot.defaultLimit?.secondary, null);
  assert.equal(snapshot.defaultLimit?.credits?.balance, null);
  assert.equal(snapshot.resetCredits?.availableCount, 3);
  assert.equal(snapshot.resetCredits?.credits?.[0]?.status, "unknown");
  assert.equal(snapshot.resetCredits?.credits?.[0]?.grantedAt, null);
  assert.equal(snapshot.resetCredits?.credits?.[1]?.status, "redeemed");
  assert.equal(JSON.stringify(snapshot).includes("private"), false);
  assert.throws(() => normalizeCodexUsage({}, { rateLimits: [] }), /invalid usage/);
  assert.equal(normalizeCodexUsage({}, { rateLimits: {}, rateLimitResetCredits: { availableCount: 0, credits: [] } }).resetCredits?.credits?.length, 0);
});
