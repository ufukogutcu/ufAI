import ELK from "elkjs/lib/elk-api.js";
import workerUrl from "elkjs/lib/elk-worker.min.js?url";
import { createWorkerElk } from "./elk-layout";

// Use ELK's official prebuilt classic worker, served locally with a hashed asset URL.
export default createWorkerElk(ELK, () => new Worker(workerUrl));
