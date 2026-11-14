import type { ELK, ELKConstructorArguments, ElkLayoutArguments, ElkNode } from "elkjs/lib/elk-api";

type ElkConstructor = new (options?: ELKConstructorArguments) => ELK;

/** Mermaid creates one ELK instance per layout. Release its worker on either outcome. */
export function createWorkerElk(Engine: ElkConstructor, makeWorker: () => Worker) {
  return class WorkerElk extends Engine {
    private readonly failure: Promise<never>;

    constructor(options: ELKConstructorArguments = {}) {
      let rejectFailure!: (error: Error) => void;
      const failure = new Promise<never>((_resolve, reject) => { rejectFailure = reject; });
      super({
        ...options,
        workerFactory: () => {
          const worker = makeWorker();
          worker.addEventListener("error", () => rejectFailure(new Error("Diagram layout worker could not run.")));
          worker.addEventListener("messageerror", () => rejectFailure(new Error("Diagram layout worker returned an unreadable result.")));
          return worker;
        },
      });
      this.failure = failure;
      // A startup failure can arrive before layout() attaches its race handler.
      void failure.catch(() => {});
    }

    override async layout<T extends ElkNode>(graph: T, options?: ElkLayoutArguments) {
      try {
        // Mermaid attaches drawing callbacks to its nodes. ELK needs only their JSON
        // graph data; retain the original objects on the UI thread for painting.
        const transferable = JSON.parse(JSON.stringify(graph)) as T;
        return await Promise.race([super.layout(transferable, options), this.failure]);
      } finally {
        this.terminateWorker();
      }
    }
  };
}
