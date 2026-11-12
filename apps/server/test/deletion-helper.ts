import type { FastifyInstance } from "fastify";
import { setTimeout as delay } from "node:timers/promises";
import assert from "node:assert/strict";
export async function deleteOwner(app: FastifyInstance, url: string) {
  const response = await app.inject({
    method: "DELETE",
    url,
    payload: { confirmFilesDeletion: true },
  });
  if (response.statusCode === 202) {
    for (let i = 0; i < 200; i++) {
      const operation = (
        await app.inject(`/api/deletions/${response.json().id}`)
      ).json();
      if (operation.state === "completed") return response;
      assert.notEqual(operation.state, "failed", operation.error);
      await delay(5);
    }
    assert.fail("Deletion did not complete");
  }
  return response;
}
