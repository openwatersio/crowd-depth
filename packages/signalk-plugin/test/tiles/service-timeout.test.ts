import { EventEmitter } from "node:events";
import { beforeEach, expect, test, vi } from "vitest";
import { createDB } from "../../src/storage.js";
import { createCellStore } from "../../src/tiles/cells.js";
import { createTileService } from "../../src/tiles/service.js";

const control = vi.hoisted(() => ({
  reply: false,
  terminated: 0,
  holdExit: false,
  replies: [] as (() => void)[],
  exits: [] as (() => void)[],
}));
vi.mock("node:os", async (original) => ({
  ...(await original<typeof import("node:os")>()),
  availableParallelism: () => 2,
}));
vi.mock("node:worker_threads", () => ({
  Worker: class extends EventEmitter {
    unref() {}
    postMessage(message: { id?: number }) {
      if (message.id === undefined) return;
      const reply = () => this.emit("message", { id: message.id });
      if (control.reply) queueMicrotask(reply);
      else control.replies.push(reply);
    }
    terminate() {
      control.terminated++;
      return new Promise<number>((resolve) => {
        const exit = () => {
          this.emit("exit", 1);
          resolve(1);
        };
        if (control.holdExit) control.exits.push(exit);
        else queueMicrotask(exit);
      });
    }
  },
}));
beforeEach(() => {
  control.reply = control.holdExit = false;
  control.terminated = 0;
  control.replies.length = control.exits.length = 0;
});
const preview = { x: 0, y: 0, span: 1, passes: [], shoals: [], written: [] };

test("a stalled opening tile releases queued tiles and allows a later retry", async () => {
  vi.useFakeTimers();
  const db = createDB(":memory:");
  const service = createTileService(createCellStore(db), "/unused.sqlite");
  try {
    const first = service.get(15, 100, 100);
    const rejected = expect(first).rejects.toThrow(
      "no progress for 30 seconds",
    );
    const queued = service.get(15, 101, 100);
    await vi.advanceTimersByTimeAsync(0);
    control.reply = true;
    await vi.advanceTimersByTimeAsync(30_000);
    await rejected;
    await expect(queued).resolves.toBeUndefined();
    expect(control.terminated).toBe(1);
    await expect(service.get(15, 100, 100)).resolves.toBeUndefined();
  } finally {
    await service.close();
    db.close();
    vi.useRealTimers();
  }
});

test("a worker making progress can drain a queue lasting longer than thirty seconds", async () => {
  vi.useFakeTimers();
  const db = createDB(":memory:");
  const service = createTileService(createCellStore(db), "/unused.sqlite");
  try {
    const completed = Promise.all(
      Array.from({ length: 3 }, () => service.preview(preview)),
    );
    for (let i = 0; i < 3; i++) {
      await vi.advanceTimersByTimeAsync(20_000);
      control.replies.shift()!();
    }
    await expect(completed).resolves.toEqual([[], [], []]);
    expect(control.terminated).toBe(0);
  } finally {
    await service.close();
    db.close();
    vi.useRealTimers();
  }
});

test("shutdown waits for a timed-out worker's native call to release its file", async () => {
  vi.useFakeTimers();
  control.holdExit = true;
  const db = createDB(":memory:");
  const service = createTileService(createCellStore(db), "/unused.sqlite");
  try {
    const failures = [service.preview(preview), service.preview(preview)].map(
      (p) => expect(p).rejects.toThrow("no progress"),
    );
    await vi.advanceTimersByTimeAsync(30_000);
    await Promise.all(failures);
    let closed = false;
    const closing = service.close().then(() => {
      closed = true;
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(closed).toBe(false);
    control.exits.shift()!();
    await closing;
    expect(closed).toBe(true);
  } finally {
    control.holdExit = false;
    for (const exit of control.exits.splice(0)) exit();
    await service.close();
    db.close();
    vi.useRealTimers();
  }
});

test("a timed-out worker's late reply and exit cannot disturb its replacement", async () => {
  vi.useFakeTimers();
  control.holdExit = true;
  const db = createDB(":memory:");
  const service = createTileService(createCellStore(db), "/unused.sqlite");
  try {
    const failed = expect(service.preview(preview)).rejects.toThrow(
      "no progress",
    );
    await vi.advanceTimersByTimeAsync(30_000);
    await failed;
    const replacement = service.preview(preview);
    const survived = expect(replacement).resolves.toEqual([]);
    control.replies.shift()!();
    control.exits.shift()!();
    await vi.advanceTimersByTimeAsync(0);
    control.replies.shift()!();
    await survived;
  } finally {
    control.holdExit = false;
    for (const exit of control.exits.splice(0)) exit();
    await service.close();
    db.close();
    vi.useRealTimers();
  }
});

test("the watchdog restarts after a reply and catches a later stall", async () => {
  vi.useFakeTimers();
  const db = createDB(":memory:");
  const service = createTileService(createCellStore(db), "/unused.sqlite");
  try {
    const first = service.preview(preview);
    const second = expect(service.preview(preview)).rejects.toThrow(
      "no progress",
    );
    await vi.advanceTimersByTimeAsync(20_000);
    control.replies.shift()!();
    await first;
    await vi.advanceTimersByTimeAsync(29_999);
    expect(control.terminated).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    await second;
    expect(control.terminated).toBe(1);
  } finally {
    await service.close();
    db.close();
    vi.useRealTimers();
  }
});
