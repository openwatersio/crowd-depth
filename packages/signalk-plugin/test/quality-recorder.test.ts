import { expect, test, vi } from "vitest";
import type { Delta, ServerAPI } from "@signalk/server-api";
import { Temporal } from "@js-temporal/polyfill";
import { createDB } from "../src/storage.js";
import { app, config } from "./helper.js";
import { recordQuality, pruneQuality } from "../src/quality-recorder.js";

test("records GPS independently at one fix per second and stops on abort", async () => {
  const db = createDB(":memory:");
  const time = Temporal.Instant.fromEpochMilliseconds(
    Math.floor(Date.now() / 1000) * 1000,
  );
  let receive: (delta: Delta) => void = () => {};
  const unsubscribe = vi.fn();
  const subscribe = vi.fn((_command, unsubs, _error, callback) => {
    receive = callback;
    unsubs.push(unsubscribe);
  });
  const api = {
    ...app,
    getPath: () => ({}),
    getSelfPath: (path: string) =>
      path === "navigation.gnss.satellites"
        ? { $source: "gps", timestamp: time.toString(), value: 8 }
        : undefined,
    subscriptionmanager: { subscribe },
  } as unknown as ServerAPI;
  const controller = new AbortController();
  db.prepare("INSERT INTO gnss_samples VALUES(?,?,?,?,?)").run(
    Date.now() - 31 * 86400_000,
    1,
    2,
    "gps",
    "{}",
  );
  recordQuality(
    api,
    { ...config, gnss: { ...config.gnss, source: "gps" } },
    db,
    controller.signal,
  );
  const send = (source = "gps", milliseconds = 0) =>
    receive({
      context: "vessels.self",
      updates: [
        {
          $source: source,
          timestamp: time.add({ milliseconds }).toString(),
          values: [
            {
              path: "navigation.position",
              value: { longitude: 1, latitude: 2 },
            },
          ],
        },
      ],
    } as Delta);
  send("other");
  send();
  send("gps", 100);
  await Promise.resolve();
  expect(db.prepare("SELECT count(*) AS n FROM gnss_samples").get()?.n).toBe(1);
  expect(subscribe.mock.calls[0][0].sourcePolicy).toBe("all");
  controller.abort();
  expect(unsubscribe).toHaveBeenCalledOnce();
  send("gps", 1000);
  await Promise.resolve();
  expect(db.prepare("SELECT count(*) AS n FROM gnss_samples").get()?.n).toBe(1);
  db.close();
});

test("pruning respects report checkpoints and caps optional retained fixes", () => {
  const db = createDB(":memory:");
  const now = Date.now();
  const insert = db.prepare("INSERT INTO gnss_samples VALUES(?,?,?,?,?)");
  db.exec("BEGIN");
  for (let i = 0; i < 200002; i++) insert.run(now + i, 1, 2, "gps", "{}");
  db.exec("COMMIT");
  pruneQuality(db);
  expect(db.prepare("SELECT count(*) AS n FROM gnss_samples").get()?.n).toBe(
    200000,
  );
  db.prepare("INSERT INTO reports(fromTimestamp, toTimestamp) VALUES(?,?)").run(
    now,
    now + 200000,
  );
  pruneQuality(db);
  expect(
    db.prepare("SELECT min(timestamp) AS t FROM gnss_samples").get()?.t,
  ).toBe(now + 198000);
  db.close();
});
