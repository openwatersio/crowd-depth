import { expect, it } from "vitest";
import { Readable } from "node:stream";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Temporal } from "@js-temporal/polyfill";
import { createObservationStore } from "../../dist/observations/client.js";
import { storedHistorySource } from "../../src/observations/source.js";
import { Timeframe, type BathymetrySource } from "../../src/types.js";
import { config } from "../helper.js";
const from = Date.parse("2026-11-24T12:00:00Z");
const window = new Timeframe(
  Temporal.Instant.fromEpochMilliseconds(from),
  Temporal.Instant.fromEpochMilliseconds(from + 3600000),
);
const point = {
  timestamp: "2026-11-24T12:00:00.123456789Z",
  longitude: -80,
  latitude: 26,
  depth: 3.123456,
  headingTrue: 1.5,
  depthSource: "sounder.1",
  positionSource: "gps.1",
};
async function fixture(
  run: (store: ReturnType<typeof createObservationStore>) => Promise<void>,
) {
  const dir = mkdtempSync(join(tmpdir(), "observation-source-"));
  const store = createObservationStore(join(dir, "observations.sqlite"));
  try {
    await run(store);
  } finally {
    await store.close();
    rmSync(dir, { recursive: true, force: true });
  }
}
const upstream = (
  read: () => Readable | Promise<Readable>,
): BathymetrySource => ({
  createObservationReader: read,
  createReader: () => {
    throw Error("corrected provider path must not be read");
  },
  getAvailableTimeframes: () => [window],
});
it("stores originals, applies reference once, and replays offline without the provider", async () =>
  fixture(async (store) => {
    let calls = 0;
    const cfg = {
      ...config,
      path: "belowTransducer" as const,
      sounder: { ...config.sounder, z: 0.7 },
    };
    const source = storedHistorySource(
      store,
      upstream(() => {
        if (++calls > 1) throw Error("offline");
        return Readable.from([point]);
      }),
      cfg,
      new AbortController().signal,
    );
    const first = await (await source.createReader(window))!.toArray();
    const second = await (await source.createReader(window))!.toArray();
    expect(second).toEqual(first);
    expect(calls).toBe(1);
    expect(first[0].depth).toBe(point.depth + 0.7);
    expect(first[0].timestamp.toString()).toBe(point.timestamp);
    expect(first[0].heading).toBe(1.5);
    const chunks = await store.query(from, from + 3600000);
    expect((await store.read(chunks[0].id))!.points).toEqual([point]);
  }));
it("cancelled acquisitions are not merged into a later completed window", async () =>
  fixture(async (store) => {
    let calls = 0;
    const source = storedHistorySource(
      store,
      upstream(() =>
        Readable.from(
          ++calls === 1
            ? Array.from({ length: 600 }, () => point)
            : [{ ...point, depth: 7 }],
        ),
      ),
      config,
      new AbortController().signal,
    );
    const cancelled = (await source.createReader(window))!;
    for await (const _ of cancelled) break;
    const completed = await (await source.createReader(window))!.toArray();
    expect(completed).toHaveLength(1);
    expect(completed[0].depth).toBe(7);
    expect(await (await source.createReader(window))!.toArray()).toEqual(
      completed,
    );
    expect((await store.query(from, from + 3600000)).length).toBeGreaterThan(1);
  }));
it("shares acquisition between concurrent preview and QC reads", async () =>
  fixture(async (store) => {
    let calls = 0;
    const source = storedHistorySource(
      store,
      upstream(() => {
        calls++;
        return Readable.from([point]);
      }),
      config,
      new AbortController().signal,
    );
    const a = (await source.createPreviewReader!(window))!.toArray();
    const b = (await source.createReader(window))!.toArray();
    expect(await a).toEqual(await b);
    expect(calls).toBe(1);
  }));

it("replays a stale preview offline, then replaces it with one fresh version for QC", async () =>
  fixture(async (store) => {
    let depth = 3;
    const source = storedHistorySource(
      store,
      upstream(() => Readable.from([{ ...point, depth }])),
      config,
      new AbortController().signal,
    );
    await (await source.createReader(window))!.toArray();
    const old = (await store.query(from, from + 3600000))[0];
    const identity = JSON.stringify((await store.read(old.id))!.acquisition);
    await store.publishImport(identity, from, from + 3600000, [old.id], 0);
    depth = 9;
    expect(
      (await (await source.createPreviewReader!(window))!.toArray())[0].depth,
    ).toBe(3);
    expect(
      (await (await source.createReader(window))!.toArray()).map(
        (p) => p.depth,
      ),
    ).toEqual([9]);
    expect(
      (await (await source.createPreviewReader!(window))!.toArray()).map(
        (p) => p.depth,
      ),
    ).toEqual([9]);
    expect(
      await source.getStoredTimeframes!(window, [-81, 25, -79, 27]),
    ).toEqual([window]);
    // Originals survive replacement, but their manifest membership does not.
    expect(await store.query(from, from + 3600000)).toHaveLength(2);
    expect(
      (await store.imported(identity, from, from + 3600000))!.chunks,
    ).not.toContain(old.id);
  }));
