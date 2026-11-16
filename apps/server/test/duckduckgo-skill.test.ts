import assert from "node:assert/strict";
import { test } from "node:test";
import { duckDuckGoSkill } from "../src/duckduckgo-skill.js";

// Execute the example agents actually receive, with only the external request stubbed.
const example = JSON.parse(duckDuckGoSkill.instructions.match(/```json\n([\s\S]*?)\n```/)![1]!);
const prefix = "node --input-type=module -e '";
assert.ok(example.command.startsWith(prefix) && example.command.endsWith("'"));
const script = example.command.slice(prefix.length, -1);
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const run = new AsyncFunction("fetch", "process", "console", script);

async function request(fetch: (...args: any[]) => Promise<unknown>, query = "Python") {
  const output: string[] = [], errors: string[] = [];
  const process = { env: { UFAI_DDG_QUERY: query }, exitCode: 0 };
  await run(fetch, process, {
    log: (text: string) => output.push(text), error: (text: string) => errors.push(text),
  });
  return { output, errors, exitCode: process.exitCode };
}

test("request example encodes queries, retains nested topics and sources, and bounds output", async () => {
  const query = "space & symbols ' \" ` $(false)\n!bang";
  let calls = 0;
  const result = await request(async (url: URL, options: RequestInit) => {
    calls++;
    assert.equal(url.origin + url.pathname, "https://api.duckduckgo.com/");
    assert.equal(url.searchParams.get("q"), query);
    for (const [key, value] of Object.entries({ format: "json", no_html: "1", no_redirect: "1", t: "ufai" }))
      assert.equal(url.searchParams.get(key), value);
    assert.equal(options.redirect, "error");
    assert.ok(options.signal instanceof AbortSignal);
    return { ok: true, json: async () => ({
      Heading: "x".repeat(10000), Answer: "x".repeat(10000),
      AbstractText: "Summary", AbstractSource: "Wikipedia", AbstractURL: "https://example.com/topic",
      Definition: "Definition", DefinitionURL: "https://example.com/definition",
      RelatedTopics: [{ Name: "Group", Topics: [{ Name: "Nested", Topics: Array.from({ length: 100 }, () => ({
        Text: "x".repeat(10000), FirstURL: "https://example.com/related",
      })) }] }],
      Results: Array.from({ length: 100 }, () => ({ Text: "x".repeat(10000), FirstURL: "https://example.com/link" })),
      Redirect: "https://example.com/redirect",
    }) };
  }, query);
  assert.equal(calls, 1);
  assert.equal(result.exitCode, 0);
  assert.deepEqual(result.errors, []);
  assert.equal(result.output.length, 1);
  assert.ok(Buffer.byteLength(result.output[0]!) < 24576);
  const data = JSON.parse(result.output[0]!);
  assert.equal(data.abstractURL, "https://example.com/topic");
  assert.equal(data.definitionURL, "https://example.com/definition");
  assert.equal(data.relatedTopics.length, 10);
  assert.equal(data.relatedTopics[0].text.length, 400);
  assert.equal(data.links.length, 5);
  assert.equal(data.empty, false);
  assert.equal(new URL(data.duckDuckGoURL).searchParams.get("q"), query);
});

test("request example distinguishes empty answers from HTTP, network and JSON failures without retries", async () => {
  const empty = await request(async () => ({ ok: true, json: async () => ({ RelatedTopics: [] }) }));
  assert.equal(empty.exitCode, 0);
  assert.equal(JSON.parse(empty.output[0]!).empty, true);
  for (const fetch of [
    async () => ({ ok: false, status: 429 }),
    async () => { throw new Error("Connection reset"); },
    async () => { throw new DOMException("Timed out", "TimeoutError"); },
    async () => ({ ok: true, json: async () => { throw new SyntaxError("Invalid JSON"); } }),
    async () => ({ ok: true, json: async () => null }),
  ]) {
    let calls = 0;
    const result = await request(async () => { calls++; return fetch(); });
    assert.equal(calls, 1);
    assert.equal(result.exitCode, 1);
    assert.deepEqual(result.output, []);
    assert.equal(result.errors.length, 1);
  }
});

test("request example rejects an empty query before making a request", async () => {
  await assert.rejects(request(async () => { assert.fail("must not fetch"); }, "  "), /Set UFAI_DDG_QUERY/);
});
