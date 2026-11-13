import { expect, test } from "vitest";
import { createBatch, type Live } from "../../web/batch.js";

const live = (rev: number, ids: number[], tiles: Live["tiles"] = []): Live => ({
  rev,
  tiles,
  provisional: { features: ids.map((id) => ({ id })) },
});

test("refreshes are batched, and soundings stay drawn until their tiles land", () => {
  let t = 0;
  const batch = createBatch(30_000, () => t);
  // First poll: no refresh, the host has just fetched its tiles.
  expect(batch.next({ ...live(1, [1, 2]), all: true })).toEqual({
    data: [{ id: 1 }, { id: 2 }],
  });
  batch.taken();
  // Sounding 1 is written into a cell; its tile changed, but it's too soon to refresh.
  // It stays drawn, so only the new one is sent.
  t = 10_000;
  expect(batch.next({ ...live(2, [2, 3], [[15, 1, 1]]), stored: [1] })).toEqual(
    { upsert: [{ id: 3 }] },
  );
  batch.taken();
  // Nothing new: nothing to send.
  t = 12_000;
  expect(batch.next(live(2, [2, 3]))).toEqual({});
  batch.taken();
  // Time to refresh, with every tile changed since; sounding 1 is still drawn.
  t = 31_000;
  const refreshed = batch.next(live(3, [2, 3], [[15, 1, 2]]));
  expect(refreshed.refresh).toEqual({
    tiles: [
      [15, 1, 1],
      [15, 1, 2],
    ],
  });
  // With the refresh, every sounding, in case the host lost them.
  expect(refreshed.data).toEqual([{ id: 1 }, { id: 2 }, { id: 3 }]);
  batch.taken();
  // A poll later its tile has loaded, so sounding 1 goes.
  t = 33_000;
  expect(batch.next(live(3, [2, 3]))).toEqual({ remove: [1] });
});

test("a feed that no longer reaches back refetches everything at the next refresh", () => {
  let t = 0;
  const batch = createBatch(30_000, () => t);
  batch.next(live(1, []));
  t = 40_000;
  expect(batch.next({ ...live(9, []), all: true }).refresh).toEqual({});
});

test("a sounding that leaves without being stored, as QC rejected it, goes at once", () => {
  const batch = createBatch(30_000, () => 0);
  batch.next(live(1, [1, 2]));
  expect(batch.next(live(2, [2]))).toEqual({ data: [{ id: 2 }] });
});

test("a refresh the host didn't take is asked for again", () => {
  let t = 0;
  const batch = createBatch(30_000, () => t);
  batch.next(live(1, []));
  t = 40_000;
  expect(batch.next(live(2, [], [[15, 1, 1]])).refresh).toEqual({
    tiles: [[15, 1, 1]],
  });
  batch.failed();
  t = 42_000;
  expect(batch.next(live(2, [])).refresh).toEqual({ tiles: [[15, 1, 1]] });
});

test("a fetch that fails after the host took a refresh doesn't refresh again early", () => {
  let t = 0;
  const batch = createBatch(30_000, () => t);
  batch.next(live(1, []));
  t = 40_000;
  expect(batch.next(live(2, [], [[15, 1, 1]])).refresh).toBeDefined();
  batch.taken();
  batch.failed();
  t = 42_000;
  expect(batch.next(live(2, [])).refresh).toBeUndefined();
});

test("once the host holds the soundings, only those that came, changed or went are sent", () => {
  const batch = createBatch(30_000, () => 0);
  // Until the host has taken them, every sounding.
  expect(batch.next(live(1, [1, 2]))).toEqual({ data: [{ id: 1 }, { id: 2 }] });
  batch.taken();
  expect(batch.next(live(2, [2, 3]))).toEqual({
    upsert: [{ id: 3 }],
    remove: [1],
  });
  batch.taken();
  expect(batch.next(live(2, [2, 3]))).toEqual({});
  // A sounding whose depth changed under the same id is sent again.
  const changed = live(3, [2, 3]);
  changed.provisional.features[0] = { id: 2, depth: 4 } as never;
  expect(batch.next(changed)).toEqual({ upsert: [{ id: 2, depth: 4 }] });
});

test("an answer the host may not have taken sends every sounding again", () => {
  const batch = createBatch(30_000, () => 0);
  batch.next(live(1, [1, 2]));
  batch.taken();
  expect(batch.next(live(2, [2, 3]))).toEqual({
    upsert: [{ id: 3 }],
    remove: [1],
  });
  batch.failed();
  expect(batch.next(live(2, [2, 3]))).toEqual({ data: [{ id: 2 }, { id: 3 }] });
});

test("a fetch that fails while the host holds the soundings keeps sending changes", () => {
  const batch = createBatch(30_000, () => 0);
  batch.next(live(1, [1, 2]));
  batch.taken();
  // The next fetch failed: nothing was offered, so the host still holds 1 and 2.
  batch.failed();
  expect(batch.next(live(2, [2]))).toEqual({ remove: [1] });
});

test("after a pause, every sounding is sent again, even past a poll in flight", () => {
  const batch = createBatch(30_000, () => 0);
  batch.next(live(1, [1, 2]));
  batch.taken();
  expect(batch.next(live(2, [1, 2, 3]))).toEqual({ upsert: [{ id: 3 }] });
  // Polling stopped and resumed while that answer was in flight.
  batch.resend();
  batch.taken();
  expect(batch.next(live(2, [1, 2, 3]))).toEqual({
    data: [{ id: 1 }, { id: 2 }, { id: 3 }],
  });
});

test("the plugin's batch for the view replaces the runtime's own", () => {
  let t = 0;
  const batch = createBatch(30_000, () => t);
  batch.next({ ...live(1, []), all: true });
  batch.taken();
  t = 6_000;
  expect(
    batch.next({ ...live(2, [], [[15, 1, 1]]), refreshMs: 5_000 }).refresh,
  ).toEqual({
    tiles: [[15, 1, 1]],
  });
  batch.taken();
  t = 9_000;
  expect(batch.next(live(3, [], [[15, 1, 2]])).refresh).toBeUndefined();
  batch.taken();
  // 6 s on, past the plugin's 5 s but, with no batch from the plugin, short of 30 s.
  t = 12_000;
  expect(batch.next(live(4, [])).refresh).toBeUndefined();
  batch.taken();
  expect(batch.next({ ...live(4, []), refreshMs: 5_000 }).refresh).toEqual({
    tiles: [[15, 1, 2]],
  });
});
