import { sameSource } from "../device-info.js";
import { liveGnssQuality } from "../gnss-quality.js";
import {
  Context,
  Delta,
  Path,
  ServerAPI,
  getSourceId,
} from "@signalk/server-api";
import { PassThrough } from "stream";
import { Config, depthReference } from "../config.js";
import { Temporal } from "@js-temporal/polyfill";
import { BathymetryData } from "../types.js";
import { bowBearing } from "./transforms.js";

/** Maximum age of last position fix for a depth to be saved */
const ttl = 2000;

export function createLiveStream(app: ServerAPI, config: Config) {
  const path = `environment.depth.${config.path}` as Path;
  const { offset } = depthReference(config);

  app.debug(`Collecting depth data from environment.depth.${path}`);

  const unsubscribes: (() => void)[] = [];

  const stream = new PassThrough({ objectMode: true });
  stream.on("close", () => {
    unsubscribes.forEach((f) => f());
  });

  // Subscribe to data updates
  app.subscriptionmanager.subscribe(
    {
      context: "vessels.self" as Context,
      sourcePolicy: "all",
      subscribe: [{ path, policy: "instant" }],
    },
    unsubscribes,
    (error) => app.error(error as string),
    (delta: Delta) => {
      delta.updates.forEach((update) => {
        const source =
          update.$source ??
          (update.source ? getSourceId(update.source) : undefined);
        if (
          config.sounder.source &&
          !sameSource(app, source, config.sounder.source)
        )
          return;
        const timestamp = Temporal.Instant.from(
          update.timestamp ?? Temporal.Now.instant(),
        );
        type Position = {
          value: { longitude: number; latitude: number };
          timestamp: string;
        };
        const positions = app.getSelfPath("navigation.position") as
          | (Position & { $source?: string; values?: Record<string, Position> })
          | undefined;
        const position =
          !config.gnss.source ||
          sameSource(app, positions?.$source, config.gnss.source)
            ? positions
            : Object.entries(positions?.values ?? {}).find(([ref]) =>
                sameSource(app, ref, config.gnss.source),
              )?.[1];

        if ("values" in update) {
          update.values.forEach(({ path: valuePath, value }) => {
            if (
              valuePath !== path ||
              typeof value !== "number" ||
              !Number.isFinite(value) ||
              value <= 0
            )
              return;
            const depth = (value as number) + offset;

            if (!position)
              return app.debug("No position data, ignoring depth data");
            if (isStale(position, timestamp, ttl))
              return app.debug("Stale position data, ignoring depth data");

            const heading = bowBearing({
              heading: freshValue("navigation.headingTrue", timestamp),
              courseOverGround: freshValue(
                "navigation.courseOverGroundTrue",
                timestamp,
              ),
              speedOverGround: freshValue(
                "navigation.speedOverGround",
                timestamp,
              ),
            });

            const data: BathymetryData = {
              longitude: position.value.longitude,
              latitude: position.value.latitude,
              depth,
              timestamp,
              heading,
              gnss: liveGnssQuality(
                app,
                config.gnss.source ?? positions?.$source,
                timestamp,
              ),
            };

            app.debug(
              "Collected depth: %dm at %d, %d",
              data.depth.toFixed(2),
              data.latitude.toFixed(6),
              data.longitude.toFixed(6),
            );

            stream.push(data);
          });
        }
      });
    },
  );

  return stream;

  function freshValue(path: string, timestamp: Temporal.Instant) {
    const node = app.getSelfPath(path) as
      { value: unknown; timestamp: string } | undefined;
    if (!node || isStale(node, timestamp, ttl)) return undefined;
    return typeof node.value === "number" ? node.value : undefined;
  }
}

function isStale(
  object: { timestamp: string },
  timestamp: Temporal.Instant,
  ttl: number,
) {
  return (
    !object?.timestamp ||
    Temporal.Instant.from(object.timestamp).epochMilliseconds <
      timestamp.subtract({ milliseconds: ttl }).epochMilliseconds
  );
}
