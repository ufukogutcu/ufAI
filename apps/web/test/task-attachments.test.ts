import assert from "node:assert/strict";
import { test } from "node:test";
import { sendTaskFiles } from "../src/task-attachments";
test("single Send carries ordered file bodies and exposes progress, errors and cancellation", async (t) => {
  const original = globalThis.XMLHttpRequest;
  let latest: any;
  class Xhr {
    upload: any = {};
    status = 0;
    response: any;
    onload: any;
    onerror: any;
    onabort: any;
    body: any;
    method = "";
    url = "";
    responseType = "";
    constructor() {
      latest = this;
    }
    open(method: string, url: string) {
      this.method = method;
      this.url = url;
    }
    send(body: any) {
      this.body = body;
    }
    abort() {
      this.onabort?.();
    }
  }
  globalThis.XMLHttpRequest = Xhr as any;
  t.after(() => {
    globalThis.XMLHttpRequest = original;
  });
  const files = [
    { id: "1", file: new File(["first"], "one.txt"), mode: "file" as const },
    {
      id: "2",
      file: new File(["second"], "two.png"),
      mode: "inspect" as const,
    },
  ];
  let progress = 0;
  const sent = sendTaskFiles<any>(
    "/agents/a/tasks",
    "Message",
    "same-request",
    { attachments: files, onProgress: (p) => (progress = p) },
  );
  assert.equal(latest.url, "/api/agents/a/tasks");
  assert.equal(latest.method, "POST");
  assert.deepEqual([...latest.body.keys()], ["message", "file0", "file1"]);
  assert.equal(
    JSON.parse(latest.body.get("message")).attachments[1].mode,
    "inspect",
  );
  assert.equal(await latest.body.get("file0").text(), "first");
  latest.upload.onprogress({ lengthComputable: true, loaded: 3, total: 4 });
  assert.equal(progress, 75);
  latest.status = 202;
  latest.response = { taskId: "task" };
  latest.onload();
  assert.deepEqual(await sent, { taskId: "task" });
  const fail = sendTaskFiles("/tasks/t/messages", "", "retry-request", {
    attachments: files,
  });
  latest.status = 413;
  latest.response = { error: "Too large" };
  latest.onload();
  await assert.rejects(() => fail, /Too large/);
  const controller = new AbortController(),
    cancel = sendTaskFiles("/tasks/t/messages", "", "retry-request", {
      attachments: files,
      signal: controller.signal,
    });
  controller.abort();
  await assert.rejects(() => cancel, /cancelled/);
});
