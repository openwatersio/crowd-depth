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
it("does not mark an empty metadata-failed acquisition full", async () =>
  fixture(async (store) => {
    for await (const _point of importObservations(
      store,
      provider(() =>
        Object.assign(Readable.from([]), { metadataIncomplete: true }),
      ),
      context,
      "empty-incomplete",
      window,
      new AbortController().signal,
    )) {
    }
    expect(
      await store.imported("empty-incomplete", start, start + 3600000),
    ).toMatchObject({ stage: "partial", chunks: [] });
  }));

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

it("records acquisition time rather than a slow consumer's completion time", async () =>
  fixture(async (store) => {
    const acquired = start + 3600000 + 1000;
    const now = vi.spyOn(Date, "now").mockReturnValue(acquired);
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
      now.mockReturnValue(acquired + 600000);
      for await (const _ of iterator) {
        /* finish after the provider settling horizon */
      }
      expect(
        (await store.imported("source", start, start + 3600000))!.recorded,
      ).toBe(acquired);
    } finally {
      now.mockRestore();
    }
  }));

it("bounds provider requests, preserves inclusive boundaries once, and keeps one hourly receipt", async () =>
  fixture(async (store) => {
    const spans: Timeframe[] = [];
    const source: BathymetrySource = {
      ...provider(() => undefined),
      observationRequestMilliseconds: 300000,
      createObservationReader: (span) => {
        spans.push(span);
        // Deliberately include both boundaries, as history providers may do.
        return Readable.from(
          points.filter((p) => {
            const time = Date.parse(p.timestamp);
            return (
              time >= span.from.epochMilliseconds &&
              time <= span.to.epochMilliseconds
            );
          }),
        );
      },
    };
    const iterator = importObservations(
      store,
      source,
      context,
      "bounded",
      window,
      new AbortController().signal,
    );
    const first = await iterator.next();
    expect(first.value).toEqual(points[0]);
    expect(spans).toHaveLength(1);
    expect(
      await store.imported("bounded", start, start + 3600000),
    ).toBeUndefined();
    const received = [first.value];
    for await (const p of iterator) received.push(p);
    expect(received).toEqual(points);
    expect(spans).toHaveLength(12);
    expect(
      spans.every(
        (s) => s.to.epochMilliseconds - s.from.epochMilliseconds === 300000,
      ),
    ).toBe(true);
    expect(spans[11].to.equals(window.to)).toBe(true);
    expect(
      await store.imported("bounded", start, start + 3600000),
    ).toMatchObject({ stage: "full" });
    expect(
      await store.imported("bounded", start, start + 300000),
    ).toBeUndefined();
  }));

it("keeps a late empty metadata failure partial across bounded requests", async () =>
  fixture(async (store) => {
    let calls = 0;
    const source: BathymetrySource = {
      ...provider(() =>
        Object.assign(Readable.from(++calls === 1 ? [points[0]] : []), {
          metadataIncomplete: calls === 12,
        }),
      ),
      observationRequestMilliseconds: 300000,
    };
    for await (const _ of importObservations(
      store,
      source,
      context,
      "partial",
      window,
      new AbortController().signal,
    )) {
    }
    expect(calls).toBe(12);
    expect(
      await store.imported("partial", start, start + 3600000),
    ).toMatchObject({ stage: "partial" });
  }));

it("retains the first segment and destroys a late reader after cancellation", async () =>
  fixture(async (store) => {
    const controller = new AbortController();
    const pending = Promise.withResolvers<Readable>();
    const started = Promise.withResolvers<void>();
    let calls = 0;
    const source: BathymetrySource = {
      ...provider(() => undefined),
      observationRequestMilliseconds: 300000,
      createObservationReader: () => {
        if (++calls === 1) return Readable.from([points[0]]);
        started.resolve();
        return pending.promise;
      },
    };
    const iterator = importObservations(
      store,
      source,
      context,
      "cancelled",
      window,
      controller.signal,
    );
    expect((await iterator.next()).value).toEqual(points[0]);
    const next = iterator.next();
    await started.promise;
    controller.abort(new Error("cancelled"));
    await expect(next).rejects.toThrow("cancelled");
    const late = Readable.from([points[300]]);
    pending.resolve(late);
    await new Promise((resolve) => setImmediate(resolve));
    expect(late.destroyed).toBe(true);
    expect(calls).toBe(2);
    expect(
      (await store.query(start, start + 3600000)).map((c) => c.count),
    ).toEqual([1]);
    expect(
      await store.imported("cancelled", start, start + 3600000),
    ).toBeUndefined();
  }));

it("times out a stalled segment stream without starting another request", async () =>
  fixture(async (store) => {
    const stalled = new Readable({ objectMode: true, read() {} });
    let calls = 0;
    const source: BathymetrySource = {
      ...provider(() => {
        calls++;
        return stalled;
      }),
      observationRequestMilliseconds: 300000,
    };
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const iterator = importObservations(
        store,
        source,
        context,
        "stalled",
        window,
        new AbortController().signal,
      );
      const next = iterator.next();
      const rejected = expect(next).rejects.toThrow(
        "Observation segment read timed out",
      );
      await new Promise((resolve) => setImmediate(resolve));
      await vi.advanceTimersByTimeAsync(30000);
      await rejected;
      expect(stalled.destroyed).toBe(true);
      expect(calls).toBe(1);
      expect(
        await store.imported("stalled", start, start + 3600000),
      ).toBeUndefined();
    } finally {
      vi.useRealTimers();
      stalled.destroy();
    }
  }));
