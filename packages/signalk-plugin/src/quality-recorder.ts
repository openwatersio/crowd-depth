import {
  getSourceId,
  type Context,
  type Delta,
  type Path,
  type ServerAPI,
} from "@signalk/server-api";
import type { DatabaseSync, StatementSync } from "node:sqlite";
import { Temporal } from "@js-temporal/polyfill";
import type { Config } from "./config.js";
import type { BathymetryData } from "./types.js";
import {
  liveGnssQuality,
  qualitySource,
  type GnssQuality,
} from "./gnss-quality.js";
import { sameSource } from "./device-info.js";

/** Optional enrichment must not consume an unbounded fraction of an SD card. */
export function pruneQuality(db: DatabaseSync) {
  db.prepare(
    "DELETE FROM gnss_samples WHERE timestamp < max(?, coalesce((SELECT max(toTimestamp) - 2000 FROM reports), 0))",
  ).run(Date.now() - 30 * 86400_000);
  db.exec(
    "DELETE FROM gnss_samples WHERE (timestamp, source) IN (SELECT timestamp, source FROM gnss_samples ORDER BY timestamp DESC, source DESC LIMIT -1 OFFSET 200000)",
  );
}

/** Record GPS fixes independently of depth timing, without changing a history provider. */
export function recordQuality(
  app: ServerAPI,
  config: Config,
  db: DatabaseSync,
  signal: AbortSignal,
) {
  if (signal.aborted) return;
  const insert = db.prepare(
    "INSERT OR REPLACE INTO gnss_samples(timestamp, longitude, latitude, source, quality) VALUES(?,?,?,?,?)",
  );
  const lastSecond = new Map<string, number>();
  const unsubscribes: (() => void)[] = [];
  const prune = () => {
    try {
      pruneQuality(db);
    } catch (error) {
      app.error(`GPS quality cleanup failed: ${error}`);
    }
  };
  prune();
  const timer = setInterval(prune, 60_000);
  timer.unref();
  signal.addEventListener(
    "abort",
    () => {
      clearInterval(timer);
      unsubscribes.forEach((fn) => fn());
    },
    { once: true },
  );
  app.subscriptionmanager.subscribe(
    {
      context: "vessels.self" as Context,
      subscribe: [{ path: "navigation.position" as Path, policy: "instant" }],
      sourcePolicy: config.gnss.source ? "all" : "preferred",
    },
    unsubscribes,
    (error) => app.error(String(error)),
    (delta: Delta) => {
      for (const update of delta.updates) {
        if (!("values" in update) || !update.timestamp) continue;
        const source =
          update.$source ??
          (update.source ? getSourceId(update.source) : undefined);
        if (
          !source ||
          (config.gnss.source && !sameSource(app, source, config.gnss.source))
        )
          continue;
        const position = update.values.find(
          (value) => value.path === "navigation.position",
        )?.value as { longitude?: unknown; latitude?: unknown } | undefined;
        if (
          !position ||
          typeof position.longitude !== "number" ||
          !Number.isFinite(position.longitude) ||
          typeof position.latitude !== "number" ||
          !Number.isFinite(position.latitude)
        )
          continue;
        const { longitude, latitude } = position;
        let time: Temporal.Instant;
        try {
          time = Temporal.Instant.from(update.timestamp);
        } catch {
          continue;
        }
        // Let all values in this update reach the model before reading its quality.
        queueMicrotask(() => {
          if (signal.aborted) return;
          const second = Math.floor(time.epochMilliseconds / 1000);
          if (lastSecond.get(source) === second) return;
          const quality = liveGnssQuality(app, source, time);
          if (!quality) return;
          try {
            insert.run(
              time.epochMilliseconds,
              longitude,
              latitude,
              qualitySource(app, source),
              JSON.stringify(quality),
            );
            lastSecond.set(source, second);
          } catch (error) {
            app.error(`GPS quality capture failed: ${error}`);
          }
        });
      }
    },
  );
}

const lookups = new WeakMap<DatabaseSync, StatementSync>();
/** Match a recorded receiver and fix, never attach today's quality to old soundings. */
export function recordedQuality(
  app: ServerAPI,
  db: DatabaseSync,
  point: BathymetryData,
  source?: string,
): GnssQuality | undefined {
  if (!source) return;
  let query = lookups.get(db);
  if (!query) {
    query = db.prepare(
      `SELECT source, quality FROM gnss_samples WHERE timestamp >= ? AND timestamp < ? AND longitude BETWEEN ? AND ? AND latitude BETWEEN ? AND ? ORDER BY timestamp`,
    );
    lookups.set(db, query);
  }
  const rows = query.all(
    point.timestamp.epochMilliseconds,
    point.timestamp.epochMilliseconds + 1000,
    point.longitude - 1e-7,
    point.longitude + 1e-7,
    point.latitude - 1e-7,
    point.latitude + 1e-7,
  ) as { source: string; quality: string }[];
  const matched = rows.find((row) => row.source === qualitySource(app, source));
  if (!matched) return;
  try {
    return JSON.parse(matched.quality) as GnssQuality;
  } catch {
    return;
  }
}
