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
  // Sounding 1 is written into a cell; its tile changed, but it's too soon to refresh.
  t = 10_000;
  expect(batch.next(live(2, [2, 3], [[15, 1, 1]]))).toEqual({
    data: [{ id: 1 }, { id: 2 }, { id: 3 }],
  });
  // Nothing new: nothing to send.
  t = 12_000;
  expect(batch.next(live(2, [2, 3]))).toEqual({});
  // Time to refresh, with every tile changed since; sounding 1 is still drawn.
  t = 31_000;
  const refreshed = batch.next(live(3, [2, 3], [[15, 1, 2]]));
  expect(refreshed.refresh).toEqual({
    tiles: [
      [15, 1, 1],
      [15, 1, 2],
    ],
  });
  expect(refreshed.data).toBeUndefined();
  // A poll later its tile has loaded, so sounding 1 goes.
  t = 33_000;
  expect(batch.next(live(3, [2, 3]))).toEqual({ data: [{ id: 2 }, { id: 3 }] });
});

test("a feed that no longer reaches back refetches everything at the next refresh", () => {
  let t = 0;
  const batch = createBatch(30_000, () => t);
  batch.next(live(1, []));
  t = 40_000;
  expect(batch.next({ ...live(9, []), all: true }).refresh).toEqual({});
});
