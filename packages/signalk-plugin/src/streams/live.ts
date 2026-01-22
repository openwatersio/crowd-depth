import { Context, Delta, Path, ServerAPI } from "@signalk/server-api";
import { PassThrough } from "stream";
import { Config } from "../config.js";
import { Temporal } from "@js-temporal/polyfill";

/** Maximum age of last position fix for a depth to be saved */
const ttl = 2000;

export function createLiveStream(app: ServerAPI, config: Config) {
  const path = `environment.depth.${config.path}` as Path;
  let offset = 0;
  if (config.path === "belowTransducer") offset += config.sounder?.z ?? 0;
  if (config.path === "belowKeel") offset += config.sounder?.draft ?? 0;

  app.debug(`Subscribing to ${path}`);

  const unsubscribes: (() => void)[] = [];

  const stream = new PassThrough({ objectMode: true });
  stream.on("close", () => {
    unsubscribes.forEach((f) => f());
  });

  // Subscribe to data updates
  app.subscriptionmanager.subscribe(
    {
      context: "vessels.self" as Context,
      subscribe: [{ path, policy: "instant" }],
    },
    unsubscribes,
    (error) => app.error(error as string),
    (delta: Delta) => {
      delta.updates.forEach((update) => {
        const timestamp = Temporal.Instant.from(
          update.timestamp ?? Temporal.Now.instant(),
        );
        const position = app.getSelfPath("navigation.position");
        let heading = app.getSelfPath("navigation.headingTrue");

        if ("values" in update) {
          update.values.forEach(({ value }) => {
            if (!value) return;
            const depth = (value as number) + offset;

            if (!position)
              return app.debug("No position data, ignoring depth data");
            if (isStale(position, timestamp, ttl))
              return app.debug("Stale position data, ignoring depth data");

            // TODO: Figure out the right behavior here. A couple options:
            // 1. Only require heading if configured sensor offsets are significant
            // 2. Use dead reckoning to guess heading from last position
            if (!heading) {
              app.debug("No heading data");
            } else if (isStale(heading, timestamp, ttl)) {
              app.debug("Stale heading data");
              heading = undefined;
            }

            stream.push({
              longitude: position.value.longitude,
              latitude: position.value.latitude,
              depth,
              timestamp,
              heading: heading?.value,
            });
          });
        }
      });
    },
  );

  return stream;
}

function isStale(
  object: { timestamp: string },
  timestamp: Temporal.Instant,
  ttl: number,
) {
  return (
    !object?.timestamp ||
    Temporal.Instant.from(object.timestamp) <
      timestamp.subtract({ milliseconds: ttl })
  );
}
