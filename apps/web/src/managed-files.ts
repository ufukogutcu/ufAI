import type { DeletionOperation } from "../../server/src/contracts";
import { request } from "./api";
export async function finishDeletion(operation: DeletionOperation) {
  // The server owns cleanup. This bounded polling only follows progress while the dialog is open.
  const deadline = Date.now() + 120_000;
  let value = operation;
  while (value.state !== "completed") {
    if (value.state === "failed")
      throw new Error(value.error ?? "File cleanup failed. Retry deletion.");
    if (Date.now() > deadline)
      throw new Error(
        "Cleanup is continuing on the server. Check deletion progress or retry later.",
      );
    await new Promise((r) => setTimeout(r, 250));
    value = await request<DeletionOperation>(`/deletions/${value.id}`);
  }
}
export async function deleteManaged(path: string) {
  await finishDeletion(
    await request<DeletionOperation>(path, "DELETE", {
      confirmFilesDeletion: true,
    }),
  );
}
