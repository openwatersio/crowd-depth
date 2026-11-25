import { ObservationDataError } from "./errors.js";
import { Worker } from "node:worker_threads";
import type { openObservationStore } from "./store.js";

type Store = ReturnType<typeof openObservationStore>;
type Operation = keyof Store;
export type Request = {
  [K in Operation]: {
    id: number;
    operation: K;
    args: Parameters<Store[K]>;
  };
}[Operation];

/** Compression, durable commits and raw reads never run on Signal K's event loop. */
export function createObservationStore(file: string) {
  const worker = new Worker(new URL("./worker.js", import.meta.url), {
    workerData: { file },
  });
  let next = 0,
    closing = false,
    failure: Error | undefined;
  const pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void }
  >();
  let resolveReady: () => void, rejectReady: (error: Error) => void;
  const ready = new Promise<void>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  // A caller may close before awaiting ready; failures are still returned to operations.
  void ready.catch(() => {});
  const fail = (error: Error) => {
    failure = error;
    rejectReady(error);
    for (const request of pending.values()) request.reject(error);
    pending.clear();
  };
  worker.on("message", (message) => {
    if (message.ready) {
      resolveReady();
      return;
    }
    if (message.id === -1 && message.error) fail(new Error(message.error));
    const request = pending.get(message.id);
    pending.delete(message.id);
    if (message.error)
      request?.reject(
        message.permanent
          ? new ObservationDataError(message.error)
          : new Error(message.error),
      );
    else request?.resolve(message.value);
  });
  worker.on("error", fail);
  const exited = new Promise<void>((resolve) =>
    worker.once("exit", (code) => {
      if (code !== 0 || !closing || pending.size)
        fail(new Error(`Observation worker exited (${code})`));
      resolve();
    }),
  );
  const request = async <K extends Operation>(
    operation: K,
    args: Parameters<Store[K]>,
  ) => {
    if (closing) throw new Error("Observation store is closing");
    if (failure) throw failure;
    // Bound the queue before waiting for initialization, including waiting callers.
    if (operation !== "closeMergedRead" && pending.size >= 16)
      throw new Error(
        "Observation store queue full; await writes before submitting more",
      );
    const id = next++;
    const result = new Promise<ReturnType<Store[K]>>((resolve, reject) => {
      pending.set(id, {
        resolve: (value) => resolve(value as ReturnType<Store[K]>),
        reject,
      });
    });
    void result.catch(() => {});
    try {
      await ready;
      if (failure) throw failure;
      worker.postMessage({ id, operation, args });
    } catch (error) {
      pending.delete(id);
      throw error;
    }
    return result;
  };
  let closed: Promise<void> | undefined;
  return {
    ready,
    openMergedRead: (...args: Parameters<Store["openMergedRead"]>) =>
      request("openMergedRead", args),
    readMergedPage: (...args: Parameters<Store["readMergedPage"]>) =>
      request("readMergedPage", args),
    closeMergedRead: (...args: Parameters<Store["closeMergedRead"]>) =>
      closing || failure
        ? Promise.resolve()
        : request("closeMergedRead", args).catch((error) => {
            // Worker shutdown releases all readers; cleanup must not mask the read's error.
            if (!closing && !failure) throw error;
          }),
    publishImport: (...args: Parameters<Store["publishImport"]>) =>
      request("publishImport", args),
    imported: (...args: Parameters<Store["imported"]>) =>
      request("imported", args),
    importedInView: (...args: Parameters<Store["importedInView"]>) =>
      request("importedInView", args),
    importedPageInView: (...args: Parameters<Store["importedPageInView"]>) =>
      request("importedPageInView", args),
    indexCapturedPage: () => request("indexCapturedPage", []),
    capturedPageInView: (...args: Parameters<Store["capturedPageInView"]>) =>
      request("capturedPageInView", args),
    append: (...args: Parameters<Store["append"]>) => request("append", args),
    query: (...args: Parameters<Store["query"]>) => request("query", args),
    readRange: (...args: Parameters<Store["readRange"]>) =>
      request("readRange", args),
    read: (...args: Parameters<Store["read"]>) => request("read", args),
    close() {
      if (closed) return closed;
      closing = true;
      closed = (async () => {
        try {
          await ready;
          // Previously admitted operations post first in ready's microtask order.
          worker.postMessage({ id: -1, operation: "close", args: [] });
        } catch {
          /* Initialization failure also terminates the worker. */
        }
        await exited;
        if (failure) throw failure;
      })();
      return closed;
    },
  };
}
