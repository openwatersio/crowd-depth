import type { DatabaseSync } from "node:sqlite";
import type { Observation } from "./history-preview.js";
import { cellAt } from "./geometry.js";

export function createPreviewWriter(db: DatabaseSync, generation: string) {
  const meta = db.prepare(
    "SELECT value FROM preview_meta WHERE key='generation'",
  );
  const current = () => meta.get()?.value === generation;
  const insert =
    db.prepare(`INSERT INTO preview_cells VALUES(?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(py,px) DO UPDATE SET lon=excluded.lon, lat=excluded.lat,
      depth=excluded.depth, time=excluded.time, source=excluded.source
    WHERE excluded.time > preview_cells.time OR (excluded.time = preview_cells.time AND
      (excluded.lon != preview_cells.lon OR excluded.lat != preview_cells.lat OR
       excluded.depth != preview_cells.depth OR excluded.source != preview_cells.source))`);
  const complete = db.prepare(
    "INSERT OR IGNORE INTO preview_windows VALUES(?, ?, ?)",
  );
  return (source: string, points: Observation[], window?: [number, number]) => {
    // A high-rate stationary batch needs one durable update per cell, not one
    // spatial-index rewrite per sample. Raw history remains untouched.
    const latest = new Map<string, Observation & { py: number; px: number }>();
    for (const point of points) {
      const cell = cellAt(point.lon, point.lat);
      const key = `${cell.py}/${cell.px}`;
      if (point.time >= (latest.get(key)?.time ?? -Infinity))
        latest.set(key, { ...point, ...cell });
    }
    db.exec("BEGIN IMMEDIATE");
    try {
      if (current()) {
        // History's paired 1s buckets replace local preview for the settled interval.
        if (source === "history" && window)
          db.prepare(
            "DELETE FROM preview_cells WHERE source='local' AND time>=? AND time<?",
          ).run(...window);
        for (const s of latest.values())
          insert.run(s.py, s.px, s.lon, s.lat, s.depth, s.time, source);
        if (window) complete.run(source, ...window);
      }
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
  };
}

import { Worker } from "node:worker_threads";
/** One writer per preview store; callers await acknowledgements for backpressure. */
export function createPreviewWriteThread(file: string, generation: string) {
  const worker = new Worker(
    new URL("./preview-write-worker.js", import.meta.url),
    { workerData: { file, generation } },
  );
  const pending = new Map<
    number,
    { resolve: () => void; reject: (error: Error) => void }
  >();
  let id = 0,
    failure: Error | undefined;
  const fail = (error: Error) => {
    failure = error;
    for (const p of pending.values()) p.reject(error);
    pending.clear();
  };
  worker.on("message", ({ id, error }: { id: number; error?: string }) => {
    const p = pending.get(id);
    pending.delete(id);
    if (error) p?.reject(new Error(error));
    else p?.resolve();
  });
  worker.on("error", (error) =>
    fail(error instanceof Error ? error : new Error(String(error))),
  );
  worker.on("exit", (code) =>
    fail(new Error(`Preview writer exited: ${code}`)),
  );
  return {
    write(source: string, points: Observation[], window?: [number, number]) {
      if (failure) return Promise.reject(failure);
      return new Promise<void>((resolve, reject) => {
        const next = id++;
        pending.set(next, { resolve, reject });
        worker.postMessage({ id: next, source, points, window });
      });
    },
    close() {
      fail(new Error("Preview writer closed"));
      return worker.terminate();
    },
  };
}
