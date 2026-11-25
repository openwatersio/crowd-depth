import { expect, it, vi } from "vitest";
import { Readable } from "node:stream";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Temporal } from "@js-temporal/polyfill";
import { createObservationStore } from "../../dist/observations/client.js";
import { importObservations } from "../../src/observations/import.js";
import { Timeframe, type BathymetrySource } from "../../src/types.js";
const context = {
  kind: "history-aggregate" as const,
  depthPath: "environment.depth.belowSurface",
  settings: {},
};
const start = Date.parse("2026-11-24T12:00:00Z");
const window = new Timeframe(
  Temporal.Instant.fromEpochMilliseconds(start),
  Temporal.Instant.fromEpochMilliseconds(start + 3600000),
);
const points = Array.from({ length: 600 }, (_, i) => ({
  timestamp: new Date(start + i * 1000).toISOString(),
  longitude: -80,
  latitude: 26,
  depth: i,
}));
const provider = (read: () => Readable | undefined): BathymetrySource => ({
  createObservationReader: read,
  createReader: () => undefined,
  getAvailableTimeframes: () => [],
});
async function fixture(
  run: (store: ReturnType<typeof createObservationStore>) => Promise<void>,
) {
  const dir = mkdtempSync(join(tmpdir(), "observation-import-"));
  const store = createObservationStore(join(dir, "observations.sqlite"));
  try {
    await run(store);
  } finally {
    await store.close();
    rmSync(dir, { recursive: true, force: true });
  }
}
it("publishes a complete import after preserving every batch", async () =>
  fixture(async (store) => {
    const received = [];
    for await (const point of importObservations(
      store,
      provider(() => Readable.from(points)),
      context,
      "source",
      window,
      new AbortController().signal,
    ))
      received.push(point);
    expect(received).toEqual(points);
    const receipt = await store.imported("source", start, start + 3600000);
    expect(receipt?.chunks).toHaveLength(2);
    expect((await store.read(receipt!.chunks[0]))?.points).toEqual(
      points.slice(0, 512),
    );
    expect((await store.read(receipt!.chunks[1]))?.points).toEqual(
      points.slice(512),
    );
  }));
it("cancelled imports retain acquired chunks but cannot claim completeness", async () =>
  fixture(async (store) => {
    const controller = new AbortController();
    const iterator = importObservations(
      store,
      provider(() => Readable.from(points)),
      context,
      "source",
      window,
      controller.signal,
    );
    expect((await iterator.next()).value).toEqual(points[0]);
    controller.abort();
    await expect(iterator.next()).rejects.toThrow();
    expect(
      await store.imported("source", start, start + 3600000),
    ).toBeUndefined();
    expect(
      (await store.query(start, start + 3600000)).map((c) => c.count),
    ).toEqual([512]);
    for await (const _point of importObservations(
      store,
      provider(() => Readable.from(points)),
      context,
      "source",
      window,
      new AbortController().signal,
    )) {
      /* retry to EOF */
    }
    expect(await store.query(start, start + 3600000)).toHaveLength(2);
    expect(
      (await store.imported("source", start, start + 3600000))?.chunks,
    ).toHaveLength(2);
  }));
it("records an explicit empty receipt, but no receipt for provider failure", async () =>
  fixture(async (store) => {
    for await (const _point of importObservations(
      store,
      provider(() => undefined),
      context,
      "empty",
      window,
      new AbortController().signal,
    )) {
      /* empty */
    }
    expect(
      (await store.imported("empty", start, start + 3600000))?.chunks,
    ).toEqual([]);
    const iterator = importObservations(
      store,
      provider(() => {
        throw Error("offline");
      }),
      context,
      "failed",
      window,
      new AbortController().signal,
    );
    await expect(iterator.next()).rejects.toThrow("offline");
    expect(
      await store.imported("failed", start, start + 3600000),
    ).toBeUndefined();
  }));

it("does not count consumer processing time against reader creation's timeout", async () =>
  fixture(async (store) => {
    const timeout = new AbortController();
    const spy = vi
      .spyOn(AbortSignal, "timeout")
      .mockReturnValueOnce(timeout.signal);
    try {
      const iterator = importObservations(
        store,
        provider(() => Readable.from(points)),
        context,
        "source",
        window,
        new AbortController().signal,
      );
      await iterator.next();
      timeout.abort();
      let count = 1;
      for await (const _point of iterator) count++;
      expect(count).toBe(600);
      expect(
        (await store.imported("source", start, start + 3600000))?.fresh,
      ).toBe(true);
    } finally {
      spy.mockRestore();
    }
  }));
