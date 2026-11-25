import { expect, it, vi } from "vitest";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createObservationStore } from "../../dist/observations/client.js";
import { observationWriter } from "../../src/observations/collect.js";
const acquisition = {
  kind: "live" as const,
  depthPath: "environment.depth.belowSurface",
  settings: {},
};
it("flushes a partial live chunk when collection is aborted", async () => {
  const dir = mkdtempSync(join(tmpdir(), "observation-collect-"));
  const store = createObservationStore(join(dir, "observations.sqlite"));
  try {
    const writer = observationWriter(store, acquisition);
    const point = {
      timestamp: "2026-11-24T12:00:00.123456789Z",
      longitude: -80,
      latitude: 26,
      depth: 3,
    };
    writer.write(point);
    const closed = once(writer, "close");
    writer.destroy();
    await closed;
    const chunks = await store.query(
      Date.parse(point.timestamp),
      Date.parse(point.timestamp) + 1,
    );
    expect(chunks).toHaveLength(1);
    expect((await store.read(chunks[0].id))?.points).toEqual([point]);
  } finally {
    await store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
it("seals full chunks and applies stream backpressure", async () => {
  const dir = mkdtempSync(join(tmpdir(), "observation-collect-"));
  const store = createObservationStore(join(dir, "observations.sqlite"));
  try {
    const writer = observationWriter(store, acquisition);
    const point = {
      timestamp: "2026-11-24T12:00:00Z",
      longitude: -80,
      latitude: 26,
      depth: 3,
    };
    let backpressure = false;
    for (let i = 0; i < 1025; i++) {
      if (!writer.write({ ...point, depth: i })) {
        backpressure = true;
        await once(writer, "drain");
      }
    }
    writer.end();
    await once(writer, "close");
    expect(backpressure).toBe(true);
    const chunks = await store.query(
      Date.parse(point.timestamp),
      Date.parse(point.timestamp) + 1,
    );
    expect(chunks.map((c) => c.count)).toEqual([512, 512, 1]);
    expect((await store.read(chunks[2].id))?.points[0].depth).toBe(1024);
  } finally {
    await store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

it("collects original live observations independently and flushes on abort", async () => {
  const { collectObservations } =
    await import("../../dist/observations/collect.js");
  const { config } = await import("../helper.js");
  const dir = mkdtempSync(join(tmpdir(), "observation-live-")),
    file = join(dir, "observations.sqlite");
  const callbacks = new Map<string, (delta: unknown) => void>();
  const controller = new AbortController();
  const app = {
    debug() {},
    error() {},
    getSelfPath() {},
    subscriptionmanager: {
      subscribe(
        command: { subscribe: { path: string }[] },
        unsub: (() => void)[],
        _error: unknown,
        callback: (delta: unknown) => void,
      ) {
        const path = command.subscribe[0].path;
        callbacks.set(path, callback);
        unsub.push(() => callbacks.delete(path));
      },
    },
  };
  const recording = collectObservations(
    app as never,
    {
      ...config,
      path: "belowTransducer",
      sounder: { ...config.sounder, z: 2, source: "" },
      gnss: { ...config.gnss, source: "" },
    },
    file,
    controller.signal,
  );
  // Handle abort rejection immediately, even if a test assertion fails first.
  const stopped = recording.catch((error) => {
    if (error.name !== "AbortError") throw error;
  });
  try {
    await expect.poll(() => callbacks.size).toBe(2);
    const timestamp = "2026-11-24T12:00:00.123456789Z";
    for (const [path, value, source] of [
      [
        "navigation.position",
        { longitude: -80.123456789, latitude: 26.123456789 },
        "gps.actual",
      ],
      ["environment.depth.belowTransducer", 3.123456789, "sounder.actual"],
    ] as const)
      callbacks.get(path)!({
        updates: [{ timestamp, $source: source, values: [{ path, value }] }],
      });
    // Fill the writer and readable queues while the first FULL commit is pending.
    for (let i = 1; i < 600; i++)
      callbacks.get("environment.depth.belowTransducer")!({
        updates: [
          {
            timestamp,
            $source: "sounder.actual",
            values: [
              {
                path: "environment.depth.belowTransducer",
                value: 3.123456789 + i,
              },
            ],
          },
        ],
      });
    controller.abort();
    await stopped;
    expect(callbacks.size).toBe(0);
    const store = createObservationStore(file);
    try {
      const chunks = await store.query(
        Date.parse(timestamp),
        Date.parse(timestamp) + 1,
      );
      expect(chunks.map((c) => c.count)).toEqual([512, 88]);
      const saved = await store.read(chunks[0].id);
      expect(saved?.acquisition.kind).toBe("live");
      expect(saved?.points[0]).toMatchObject({
        timestamp,
        depth: 3.123456789,
        longitude: -80.123456789,
        depthSource: "sounder.actual",
        positionSource: "gps.actual",
      });
    } finally {
      await store.close();
    }
  } finally {
    controller.abort();
    await stopped;
    rmSync(dir, { recursive: true, force: true });
  }
});

it("seals sparse data on the timer and retries a transient commit without losing its batch", async () => {
  vi.useFakeTimers();
  const point = {
    timestamp: "2026-11-24T12:00:00Z",
    longitude: -80,
    latitude: 26,
    depth: 3,
  };
  const append = vi
    .fn()
    .mockRejectedValueOnce(new Error("database is locked"))
    .mockResolvedValue({ id: 1 });
  const committed = vi.fn();
  const writer = observationWriter({ append } as never, acquisition, committed);
  try {
    writer.write(point);
    await vi.advanceTimersByTimeAsync(10000);
    expect(append).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
    await expect.poll(() => append.mock.calls.length).toBe(2);
    expect(append.mock.calls[0]).toEqual(append.mock.calls[1]);
    expect(committed).toHaveBeenCalledTimes(1);
    writer.end();
    await once(writer, "close");
  } finally {
    writer.destroy();
    vi.useRealTimers();
  }
});
