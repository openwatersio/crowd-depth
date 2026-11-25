import { DatabaseSync } from "node:sqlite";
import { expect, it, vi } from "vitest";
import { Readable } from "node:stream";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Temporal } from "@js-temporal/polyfill";
import { createObservationStore } from "../../dist/observations/client.js";
import { storedHistorySource } from "../../src/observations/source.js";
import { Timeframe, type BathymetrySource } from "../../src/types.js";
import { app, config } from "../helper.js";
import { createHistorySource } from "../../src/sources/history.js";
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
  run: (
    store: ReturnType<typeof createObservationStore>,
    file: string,
  ) => Promise<void>,
) {
  const dir = mkdtempSync(join(tmpdir(), "observation-source-"));
  const store = createObservationStore(join(dir, "observations.sqlite"));
  try {
    await run(store, join(dir, "observations.sqlite"));
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
it("does not make preview wait for a full-first hung metadata acquisition", async () =>
  fixture(async (store) => {
    const controller = new AbortController();
    const started = Promise.withResolvers<void>();
    const source = storedHistorySource(
      store,
      {
        ...upstream(() => {
          started.resolve();
          return new Promise<Readable>(() => {});
        }),
        createObservationPreviewReader: () => Readable.from([point]),
      },
      config,
      controller.signal,
    );
    const full = (await source.createReader(window))!.toArray();
    void full.catch(() => {});
    await started.promise;
    try {
      const preview = await (await source.createPreviewReader!(
        window,
      ))!.toArray();
      expect(preview).toHaveLength(1);
      expect(preview[0].depth).toBe(point.depth);
    } finally {
      controller.abort(new Error("test complete"));
      await expect(full).rejects.toThrow("test complete");
    }
  }));
it("persists a preview when optional metadata is unavailable, then enriches it in place", async () =>
  fixture(async (store) => {
    let metadataAvailable = false;
    let metadataReads = 0;
    const cfg = { ...config, gnss: { ...config.gnss, source: "gps.1" } };
    const history = await createHistorySource(
      {
        ...app,
        getHistoryApi: async () => ({
          getPaths: async () => {
            metadataReads++;
            if (!metadataAvailable) throw Error("optional metadata offline");
            return ["navigation.gnss.satellites"];
          },
          getValues: async (request: { sourcePolicy?: string }) =>
            request.sourcePolicy === "all"
              ? {
                  values: [
                    { path: "navigation.gnss.satellites", $source: "gps.1" },
                  ],
                  data: [[point.timestamp, 12]],
                }
              : {
                  values: [
                    { path: "navigation.position", $source: "gps.1" },
                    {
                      path: "environment.depth.belowTransducer",
                      $source: "sounder.1",
                    },
                  ],
                  data: [
                    [
                      point.timestamp,
                      [point.longitude, point.latitude],
                      point.depth,
                    ],
                  ],
                },
        }),
      } as unknown as typeof app,
      { ...cfg, path: "belowTransducer" },
    );
    const source = storedHistorySource(
      store,
      history!,
      { ...cfg, path: "belowTransducer" },
      new AbortController().signal,
    );
    const preview = await (await source.createPreviewReader!(
      window,
    ))!.toArray();
    expect(preview).toHaveLength(1);
    expect(metadataReads).toBe(0);
    const hints = await source.getStoredTimeframes!(window, [-81, 25, -79, 27]);
    expect(hints).toHaveLength(1);
    expect(
      (await (await source.createReader(window))!.toArray())[0].depth,
    ).toBe(preview[0].depth);
    expect(
      await (await source.createPreviewReader!(window))!.toArray(),
    ).toEqual(preview);
    metadataAvailable = true;
    const old = (await store.query(from, from + 3600000))[0];
    const identity = JSON.stringify((await store.read(old.id))!.acquisition);
    const receipt = (await store.imported(identity, from, from + 3600000))!;
    expect(receipt.stage).toBe("partial");
    await store.publishImport(
      identity,
      from,
      from + 3600000,
      receipt.chunks,
      Date.now() - 300001,
      "replace",
      "partial",
    );
    const enriched = await (await source.createReader(window))!.toArray();
    expect(enriched[0].gnss).toEqual({ satellites: 12 });
    expect(enriched[0].depth).toBe(preview[0].depth);
    metadataAvailable = false;
    expect(
      await (await source.createPreviewReader!(window))!.toArray(),
    ).toEqual(enriched);
  }));
it("refreshes stale full core observations during a metadata outage and briefly caches the partial result", async () =>
  fixture(async (store) => {
    let calls = 0;
    const source = storedHistorySource(
      store,
      upstream(() => {
        calls++;
        return Readable.from(
          calls === 1
            ? [{ ...point, gnss: { satellites: 12, integrity: "safe" } }]
            : [
                { ...point, depth: 7, metadataIncomplete: true },
                {
                  ...point,
                  timestamp: "2026-11-24T12:00:05Z",
                  depth: 8,
                  metadataIncomplete: true,
                },
              ],
        );
      }),
      config,
      new AbortController().signal,
    );
    await (await source.createReader(window))!.toArray();
    const chunk = (await store.query(from, from + 3600000))[0];
    const identity = JSON.stringify((await store.read(chunk.id))!.acquisition);
    await store.publishImport(
      identity,
      from,
      from + 3600000,
      [chunk.id],
      Date.now() - 86400001,
    );
    const refreshed = await (await source.createReader(window))!.toArray();
    expect(refreshed.map((p) => p.depth)).toEqual([7, 8]);
    expect(refreshed[0].gnss).toEqual({ satellites: 12, integrity: "safe" });
    expect(refreshed[1].gnss).toBeUndefined();
    expect(await store.imported(identity, from, from + 3600000)).toMatchObject({
      stage: "partial",
      fresh: true,
    });
    expect(await (await source.createReader(window))!.toArray()).toEqual(
      refreshed,
    );
    expect(calls).toBe(2);
  }));
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

it("reacquires a preview taken before the provider's write delay elapsed", async () =>
  fixture(async (store) => {
    const end = Date.now() - 60000;
    const tail = new Timeframe(
      Temporal.Instant.fromEpochMilliseconds(end - 3600000),
      Temporal.Instant.fromEpochMilliseconds(end),
    );
    const points = [0, 1].map((i) => ({
      ...point,
      timestamp: new Date(end - 2000 + i * 1000).toISOString(),
    }));
    let calls = 0;
    const source = storedHistorySource(
      store,
      upstream(() => Readable.from(points.slice(0, ++calls))),
      config,
      new AbortController().signal,
    );
    expect(
      await (await source.createPreviewReader!(tail))!.toArray(),
    ).toHaveLength(1);
    expect(await (await source.createReader(tail))!.toArray()).toHaveLength(2);
    expect(calls).toBe(2);
  }));

it("retains owned timestamps when history is pruned and replaces revised aggregates", async () =>
  fixture(async (store) => {
    const points = [0, 1, 2, 3].map((i) => ({
      ...point,
      timestamp: new Date(from + i * 1000).toISOString(),
      depth: i + 1,
    }));
    let response = points.slice(0, 3);
    const source = storedHistorySource(
      store,
      upstream(() => Readable.from(response)),
      config,
      new AbortController().signal,
    );
    const read = async () => (await source.createReader(window))!.toArray();
    const expire = async () => {
      const first = (await store.query(from, from + 3600000))[0];
      const identity = JSON.stringify(
        (await store.read(first.id))!.acquisition,
      );
      const receipt = (await store.imported(identity, from, from + 3600000))!;
      await store.publishImport(
        identity,
        from,
        from + 3600000,
        receipt.chunks,
        0,
      );
    };
    expect((await read()).map((p) => p.depth)).toEqual([1, 2, 3]);
    await expire();
    // Upstream removes its earlier rows, revises one value, and adds a late observation.
    response = [{ ...points[1], depth: 20 }, points[3]];
    expect((await read()).map((p) => p.depth)).toEqual([1, 20, 3, 4]);
    await expire();
    response = [];
    expect((await read()).map((p) => p.depth)).toEqual([1, 20, 3, 4]);
    expect(
      (await (await source.createPreviewReader!(window))!.toArray()).map(
        (p) => p.depth,
      ),
    ).toEqual([1, 20, 3, 4]);
  }));

it("combines stored viewport hints with undiscovered provider visits", async () =>
  fixture(async (store) => {
    const older = new Timeframe(
      window.from.subtract({ hours: 24 }),
      window.to.subtract({ hours: 24 }),
    );
    let queries = 0;
    const source = storedHistorySource(
      store,
      {
        ...upstream(() => Readable.from([point])),
        async getPreviewTimeframes() {
          queries++;
          return [older];
        },
      },
      config,
      new AbortController().signal,
    );
    await (await source.createReader(window))!.toArray();
    const hints = await source.getPreviewTimeframes!(
      new Timeframe(older.from, window.to),
      [-81, 25, -79, 27],
    );
    expect(hints).toEqual([older, window]);
    expect(queries).toBe(1);
  }));

it("reuses an unsettled import when a preview waited behind its acquisition", async () =>
  fixture(async (store) => {
    const end = Date.now();
    const tail = new Timeframe(
      Temporal.Instant.fromEpochMilliseconds(end - 3600000),
      Temporal.Instant.fromEpochMilliseconds(end),
    );
    let calls = 0;
    const source = storedHistorySource(
      store,
      upstream(() => {
        calls++;
        return Readable.from([
          { ...point, timestamp: new Date(end - 2000).toISOString() },
        ]);
      }),
      config,
      new AbortController().signal,
    );
    const qc = (await source.createReader(tail))!.toArray();
    const preview = (await source.createPreviewReader!(tail))!.toArray();
    expect(await preview).toEqual(await qc);
    expect(calls).toBe(1);
  }));

it("replays nonaligned owned windows through aligned reads after provider retention", async () =>
  fixture(async (store) => {
    const odd = new Timeframe(
      window.from.add({ minutes: 23 }),
      window.to.add({ minutes: 23 }),
    );
    const points = [40, 70].map((minutes, i) => ({
      ...point,
      timestamp: window.from.add({ minutes }).toString(),
      depth: 3 + i,
    }));
    let pruned = false;
    const provider = {
      ...upstream(() => Readable.from(pruned ? [] : points)),
      createObservationPreviewReader: () => Readable.from(points),
    };
    const source = storedHistorySource(
      store,
      provider,
      config,
      new AbortController().signal,
    );
    expect(
      await (await source.createPreviewReader!(odd))!.toArray(),
    ).toHaveLength(2);
    pruned = true;
    expect(
      (await (await source.createReader(window))!.toArray()).map(
        (p) => p.depth,
      ),
    ).toEqual([3]);
    const next = new Timeframe(window.to, window.to.add({ hours: 1 }));
    expect(
      (await (await source.createReader(next))!.toArray()).map((p) => p.depth),
    ).toEqual([4]);
    // Empty aligned receipts cannot hide the older nonaligned manifest on repeat.
    expect(
      (await (await source.createReader(window))!.toArray()).map(
        (p) => p.depth,
      ),
    ).toEqual([3]);
  }));

it("resolves overlapping manifest versions without double-counting a timestamp", async () =>
  fixture(async (store) => {
    const pointTime = window.from.add({ minutes: 40 }).toString();
    let depth = 3;
    const source = storedHistorySource(
      store,
      upstream(() =>
        Readable.from([{ ...point, timestamp: pointTime, depth }]),
      ),
      config,
      new AbortController().signal,
    );
    await (await source.createReader(
      new Timeframe(window.from, window.to.add({ hours: 1 })),
    ))!.toArray();
    depth = 7;
    await (await source.createReader(
      new Timeframe(
        window.from.add({ minutes: 30 }),
        window.to.add({ minutes: 30 }),
      ),
    ))!.toArray();
    const result = await (await source.createReader(window))!.toArray();
    expect(result).toHaveLength(1);
    expect(result[0].depth).toBe(7);
  }));

it("keeps exact owned receipts readable when derived spatial hints are absent", async () =>
  fixture(async (store) => {
    const source = storedHistorySource(
      store,
      upstream(() => Readable.from([point])),
      config,
      new AbortController().signal,
    );
    await (await source.createReader(window))!.toArray();
    const hint = vi
      .spyOn(store, "importedPageInView")
      .mockResolvedValue({ windows: [] });
    try {
      expect(
        (await (await source.createReader(window))!.toArray()).map(
          (p) => p.depth,
        ),
      ).toEqual([point.depth]);
    } finally {
      hint.mockRestore();
    }
  }));

it("publishes retained preview overlap immediately and still acquires the uncovered interval", async () =>
  fixture(async (store) => {
    let expanded = false;
    const pending = Promise.withResolvers<Readable>();
    let calls = 0;
    const early = {
      ...point,
      timestamp: window.from.add({ minutes: 40 }).toString(),
    };
    const late = {
      ...point,
      timestamp: window.to.add({ minutes: 10 }).toString(),
      depth: 8,
    };
    const provider = {
      ...upstream(() => Readable.from([])),
      createObservationPreviewReader: () => {
        calls++;
        return expanded ? pending.promise : Readable.from([early]);
      },
    };
    const source = storedHistorySource(
      store,
      provider,
      config,
      new AbortController().signal,
    );
    await (await source.createPreviewReader!(window))!.toArray();
    expanded = true;
    const shifted = new Timeframe(
      window.from.add({ minutes: 30 }),
      window.to.add({ minutes: 30 }),
    );
    const reader = (await source.createPreviewReader!(shifted))!;
    const iterator = reader[Symbol.asyncIterator]();
    const first = await iterator.next();
    expect(first.value.timestamp.toString()).toBe(early.timestamp);
    pending.resolve(Readable.from([early, late]));
    const rest = [];
    for (;;) {
      const next = await iterator.next();
      if (next.done) break;
      rest.push(next.value);
    }
    expect(
      rest.some(
        (p) => p.timestamp.toString() === late.timestamp && p.depth === 8,
      ),
    ).toBe(true);
    expect(calls).toBe(2);
  }));

it("reacquires a corrupt cached preview and repairs identical original bytes", async () =>
  fixture(async (store, file) => {
    let calls = 0;
    const source = storedHistorySource(
      store,
      {
        ...upstream(() => Readable.from([point])),
        createObservationPreviewReader: () => {
          calls++;
          return Readable.from([point]);
        },
      },
      config,
      new AbortController().signal,
    );
    await (await source.createPreviewReader!(window))!.toArray();
    const db = new DatabaseSync(file);
    const ids = db.prepare("SELECT id FROM observation_chunks").all();
    db.exec("UPDATE observation_chunks SET data=X'00'");
    try {
      expect(
        (await (await source.createPreviewReader!(window))!.toArray()).map(
          (p) => p.depth,
        ),
      ).toEqual([point.depth]);
      expect(calls).toBe(2);
      expect(db.prepare("SELECT id FROM observation_chunks").all()).toEqual(
        ids,
      );
    } finally {
      db.close();
    }
  }));

it("does not redeliver the prefix to QC when a later cached chunk is repaired", async () =>
  fixture(async (store, file) => {
    const points = Array.from({ length: 514 }, (_, i) => ({
      ...point,
      timestamp: window.from.add({ milliseconds: i }).toString(),
    }));
    let calls = 0;
    const source = storedHistorySource(
      store,
      upstream(() => {
        calls++;
        return Readable.from(points);
      }),
      config,
      new AbortController().signal,
    );
    await (await source.createReader(window))!.toArray();
    const db = new DatabaseSync(file);
    try {
      db.exec(
        "UPDATE observation_chunks SET data=X'00' WHERE id=(SELECT max(id) FROM observation_chunks)",
      );
      const result = await (await source.createReader(window))!.toArray();
      expect(calls).toBe(2);
      expect(result).toHaveLength(514);
      expect(new Set(result.map((p) => p.timestamp.toString())).size).toBe(514);
    } finally {
      db.close();
    }
  }));

it.each([false, true])(
  "persists new originals despite a malformed %s overlapping manifest",
  async (exact) =>
    fixture(async (store, file) => {
      let calls = 0;
      const source = storedHistorySource(
        store,
        upstream(() => {
          calls++;
          return Readable.from([{ ...point, depth: calls === 1 ? 3 : 8 }]);
        }),
        config,
        new AbortController().signal,
      );
      const damaged = exact
        ? window
        : new Timeframe(window.from, window.to.add({ hours: 1 }));
      await (await source.createReader(damaged))!.toArray();
      const db = new DatabaseSync(file);
      const identity = String(
        db.prepare("SELECT identity FROM observation_imports LIMIT 1").get()!
          .identity,
      );
      db.prepare("UPDATE observation_imports SET chunks='broken'").run();
      db.close();
      await expect(
        (await source.createReader(window))!.toArray(),
      ).rejects.toThrow("manifest is unreadable");
      expect(calls).toBe(2);
      const chunks = await store.query(
        from,
        from + 3600000,
        [-81, 25, -79, 27],
      );
      const originals = await Promise.all(chunks.map((c) => store.read(c.id)));
      expect(originals.flatMap((c) => c!.points.map((p) => p.depth))).toContain(
        8,
      );
      if (!exact)
        expect(
          (await store.imported(identity, from, from + 3600000))?.chunks.length,
        ).toBeGreaterThan(0);
    }),
);

it.each([
  "createReader",
  "createPreviewReader",
  "createObservationReader",
  "createObservationPreviewReader",
] as const)(
  "%s destruction stops segmented acquisition before an uncancellable request settles",
  async (method) =>
    fixture(async (store) => {
      const first = Promise.withResolvers<Readable>();
      const entered = Promise.withResolvers<void>();
      let calls = 0;
      const provider: BathymetrySource = {
        ...upstream(() => {
          calls++;
          if (calls === 1) {
            entered.resolve();
            return first.promise;
          }
          return Readable.from([]);
        }),
        observationRequestMilliseconds: 300000,
      };
      const source = storedHistorySource(
        store,
        provider,
        config,
        new AbortController().signal,
      );
      const reader = (await source[method]!(window))!;
      const result = reader.toArray();
      void result.catch(() => {});
      await entered.promise;
      reader.destroy(new Error("consumer cancelled"));
      await expect(result).rejects.toThrow("consumer cancelled");
      const retry = (await source[method]!(window))!;
      await expect(retry.toArray()).rejects.toThrow(
        "Observation provider request still pending",
      );
      expect(calls).toBe(1);
      const late = Readable.from([]);
      first.resolve(late);
      await new Promise((resolve) => setImmediate(resolve));
      expect(late.destroyed).toBe(true);
      expect(calls).toBe(1);
      expect(
        await store.imported(
          JSON.stringify({
            kind: "history-aggregate",
            depthPath: `environment.depth.${config.path}`,
            settings: {
              sounder: config.sounder,
              gnss: config.gnss,
              path: config.path,
              positionOrigin: config.positionOrigin,
            },
          }),
          from,
          from + 3600000,
        ),
      ).toBeUndefined();
    }),
);
