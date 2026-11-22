import { sameSource } from "../device-info.js";
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

  type Position = {
    value: { longitude: number; latitude: number };
    timestamp: string;
  };
  /** The selected receiver's latest fix in the full model. */
  const cachedPosition = (): Position | undefined => {
    const cached = app.getSelfPath("navigation.position") as
      | (Position & {
          $source?: string;
          values?: Record<string, Position>;
        })
      | undefined;
    if (!config.gnss.source) return cached;
    return sameSource(app, cached?.$source, config.gnss.source)
      ? cached
      : Object.entries(cached?.values ?? {}).find(([source]) =>
          sameSource(app, source, config.gnss.source),
        )?.[1];
  };
  let position = cachedPosition();
  const explicitDepth = config.sounder.source;
  const explicitGps = config.gnss.source;
  // Separate subscriptions preserve server preference independently for each path.
  app.subscriptionmanager.subscribe(
    {
      context: "vessels.self" as Context,
      subscribe: [{ path: "navigation.position" as Path, policy: "instant" }],
      sourcePolicy: explicitGps ? "all" : "preferred",
    },
    unsubscribes,
    (error) => app.error(error as string),
    (delta: Delta) => {
      for (const update of delta.updates) {
        const source =
          update.$source ??
          (update.source ? getSourceId(update.source) : undefined);
        if (explicitGps && !sameSource(app, source, explicitGps)) continue;
        if (!("values" in update)) continue;
        for (const item of update.values) {
          if (item.path !== "navigation.position") continue;
          const value = item.value as Position["value"] | null;
          position =
            value &&
            Number.isFinite(value.longitude) &&
            Number.isFinite(value.latitude)
              ? {
                  value,
                  timestamp:
                    update.timestamp ?? Temporal.Now.instant().toString(),
                }
              : undefined;
        }
      }
    },
  );

  // Subscribe to data updates
  app.subscriptionmanager.subscribe(
    {
      context: "vessels.self" as Context,
      subscribe: [{ path, policy: "instant" }],
      sourcePolicy: explicitDepth ? "all" : "preferred",
    },
    unsubscribes,
    (error) => app.error(error as string),
    (delta: Delta) => {
      delta.updates.forEach((update) => {
        const source =
          update.$source ??
          (update.source ? getSourceId(update.source) : undefined);
        if (explicitDepth && !sameSource(app, source, explicitDepth)) return;
        const timestamp = Temporal.Instant.from(
          update.timestamp ?? Temporal.Now.instant(),
        );

        if ("values" in update) {
          update.values.forEach(({ path: valuePath, value }) => {
            if (
              valuePath !== path ||
              typeof value !== "number" ||
              value === 0 ||
              !Number.isFinite(value)
            )
              return;
            const depth = (value as number) + offset;

            // Signal K 2.28 to 2.34 never attach a sourcePolicy "all" subscription
            // to a path whose meta arrived before its first value
            // (SignalK/signalk-server#3159), as after a restart, so read the full
            // model when the subscription hasn't delivered a current fix.
            if (!position || isStale(position, timestamp, ttl))
              position = cachedPosition() ?? position;
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
