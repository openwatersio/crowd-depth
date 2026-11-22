import { expect, test, vi } from "vitest";
import { Readable } from "node:stream";
import { Temporal } from "@js-temporal/polyfill";
import { createDB } from "../../src/storage.js";
import { cacheChartInputs } from "../../src/tiles/inputs.js";
import { Timeframe, type BathymetrySource } from "../../src/types.js";

const from = Temporal.Instant.from("2020-01-01T00:00Z");
const window = new Timeframe(from, from.add({ hours: 1 }));
const sample = {
  longitude: 1,
  latitude: 2,
  depth: 3,
  heading: 0,
  timestamp: from,
};
function setup(read = () => Readable.from([sample])) {
  const db = createDB(":memory:");
  const controller = new AbortController();
  const createReader = vi.fn(read);
  const source: BathymetrySource = {
    createReader,
    getAvailableTimeframes: () => [window],
  };
  const cached = cacheChartInputs(db, source, "source-v1", controller.signal);
  return { db, controller, source, cached, createReader };
}
async function collect(reader: ReturnType<BathymetrySource["createReader"]>) {
  const stream = await reader;
  const results = [];
  if (stream) for await (const row of stream) results.push(row);
  return results;
}

test("preview streams immediately, concurrent refinement shares the completed hour and restart reuses it", async () => {
  let finish!: () => void;
  const gate = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const s = setup(() =>
    Readable.from(
      (async function* () {
        yield sample;
        await gate;
        yield { ...sample, depth: 4, timestamp: from.add({ seconds: 1 }) };
        yield { ...sample, timestamp: window.to };
      })(),
    ),
  );
  const preview = (await s.cached.createReader(window))![
    Symbol.asyncIterator
  ]();
  expect((await preview.next()).value.depth).toBe(3);
  const refinement = collect(s.cached.createReader(window));
  expect(s.createReader).toHaveBeenCalledTimes(1);
  finish();
  while (!(await preview.next()).done) {
    /* drain */
  }
  expect((await refinement).map((s) => s.depth)).toEqual([3, 4]);
  const restarted = cacheChartInputs(
    s.db,
    s.source,
    "source-v1",
    new AbortController().signal,
  );
  expect(await collect(restarted.createReader(window))).toHaveLength(2);
  expect(s.createReader).toHaveBeenCalledTimes(1);
  const changed = cacheChartInputs(
    s.db,
    s.source,
    "source-v2",
    new AbortController().signal,
  );
  expect(await collect(changed.createReader(window))).toHaveLength(2);
  expect(s.createReader).toHaveBeenCalledTimes(2);
  s.db.close();
});

test("failed or cancelled streams never publish partial input chunks", async () => {
  const s = setup(() =>
    Readable.from(
      (async function* () {
        for (let i = 0; i < 1100; i++) yield sample;
        throw new Error("provider failed");
      })(),
    ),
  );
  await expect(collect(s.cached.createReader(window))).rejects.toThrow(
    "provider failed",
  );
  expect(
    s.db.prepare("SELECT count(*) AS n FROM chart_input_chunks").get(),
  ).toEqual({ n: 0 });
  expect(
    s.db.prepare("SELECT count(*) AS n FROM chart_input_pages").get(),
  ).toEqual({ n: 0 });
  s.createReader.mockImplementation(() => Readable.from([sample]));
  expect(await collect(s.cached.createReader(window))).toHaveLength(1);
  expect(s.createReader).toHaveBeenCalledTimes(2);
  s.db.close();
});

test("mutable tail and partial windows are reread, and empty settled hours remain retryable", async () => {
  const s = setup(() => Readable.from([]));
  const partial = new Timeframe(from.add({ seconds: 1 }), window.to);
  await collect(s.cached.createReader(partial));
  await collect(s.cached.createReader(partial));
  const now = Temporal.Now.instant();
  const tailStart = Temporal.Instant.fromEpochMilliseconds(
    Math.floor(now.epochMilliseconds / 3600000) * 3600000,
  );
  const tail = new Timeframe(tailStart, tailStart.add({ hours: 1 }));
  await collect(s.cached.createReader(tail));
  await collect(s.cached.createReader(tail));
  await collect(s.cached.createReader(window));
  await collect(s.cached.createReader(window));
  expect(s.createReader).toHaveBeenCalledTimes(6);
  s.db.close();
});

test("acquired chunks can be prioritized spatially without calling history", async () => {
  const s = setup();
  try {
    await collect(s.cached.createReader(window));
    expect(s.cached.getStoredTimeframes!(window, [0, 1, 2, 3])).toEqual([
      window,
    ]);
    expect(s.cached.getStoredTimeframes!(window, [10, 10, 11, 11])).toEqual([]);
    expect(s.cached.getStoredTimeframes!(window, [170, -10, -170, 10])).toEqual(
      [],
    );
    expect(s.createReader).toHaveBeenCalledTimes(1);
    s.db.prepare("DELETE FROM chart_input_pages").run();
    expect(
      s.db.prepare("SELECT count(*) n FROM chart_input_spatial").get(),
    ).toEqual({ n: 0 });
  } finally {
    s.db.close();
  }
});

test("timed-out provider reads release consumers without stacking queries", async () => {
  vi.useFakeTimers();
  const db = createDB(":memory:");
  const controller = new AbortController();
  let resolve!: (reader: Readable) => void;
  const read = vi
    .fn()
    .mockImplementationOnce(
      () =>
        new Promise<Readable>((r) => {
          resolve = r;
        }),
    )
    .mockImplementation(() => Readable.from([sample]));
  const cached = cacheChartInputs(
    db,
    { createReader: read, getAvailableTimeframes: () => [] },
    "timeout",
    controller.signal,
  );
  const collect = async () => {
    const result = [];
    for await (const row of cached.createReader(window)!) result.push(row);
    return result;
  };
  try {
    const first = expect(collect()).rejects.toThrow("timed out");
    await vi.advanceTimersByTimeAsync(30001);
    await first;
    await expect(collect()).rejects.toThrow("still pending");
    expect(read).toHaveBeenCalledTimes(1);
    const late = Readable.from([sample]);
    resolve(late);
    await vi.advanceTimersByTimeAsync(0);
    expect(late.destroyed).toBe(true);
    expect(await collect()).toHaveLength(1);
    expect(read).toHaveBeenCalledTimes(2);
  } finally {
    controller.abort();
    db.close();
    vi.useRealTimers();
  }
});
