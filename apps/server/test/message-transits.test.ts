import assert from "node:assert/strict";
import { test } from "node:test";
import { messageTravelDuration } from "../src/message-transits.js";

test("message travel duration scales with distance and stays within 0.6–2.4 seconds", () => {
  assert.equal(messageTravelDuration(0), 600);
  assert.equal(messageTravelDuration(100), 600);
  assert.equal(messageTravelDuration(500), 1000);
  assert.equal(messageTravelDuration(1000), 2000);
  assert.equal(messageTravelDuration(10000), 2400);
});
