import type { ServerAPI } from "@signalk/server-api";
import type { Config } from "./config.js";
import { sameSource } from "./device-info.js";

export type PositionOrigin = { x: number; y: number };
type Sensor = {
  sensorId: string;
  $source: string;
  fromBow: number | null;
  fromCenter: number | null;
};
const finite = (v: unknown): v is number =>
  typeof v === "number" && Number.isFinite(v);

/** Location represented by this source's coordinates, not necessarily its antenna. */
export function gnssOrigin(
  app: ServerAPI,
  config: Config,
  source?: string,
): PositionOrigin | null {
  const settings = (
    app as ServerAPI & {
      config?: {
        settings?: { gnssSensors?: Sensor[]; gnssCorrection?: string };
      };
    }
  ).config?.settings;
  const sensors = (settings?.gnssSensors ?? []).filter(
    (sensor) => sensor.$source && !sensor.$source.endsWith(".ccrp"),
  );
  if (source?.endsWith(".ccrp")) {
    const length = app.getSelfPath("design.length.value") as
      { overall?: number } | number | undefined;
    const overall = typeof length === "number" ? length : length?.overall;
    return finite(overall) && overall > 0 ? { x: 0, y: overall / 2 } : null;
  }
  const matching = sensors.filter((sensor) =>
    sameSource(app, sensor.$source, source),
  );
  const sensor =
    matching.findLast(
      (sensor) => finite(sensor.fromBow) && finite(sensor.fromCenter),
    ) ?? matching[0];
  if (sensor) {
    // Replace mode has no per-sample marker: absent heading can leave raw fixes.
    if (settings?.gnssCorrection === "replace") return null;
    return finite(sensor.fromBow) && finite(sensor.fromCenter)
      ? { x: -sensor.fromCenter, y: sensor.fromBow }
      : null;
  }
  if (sensors.length) return null;
  // Preserve existing installations' saved geometry when no server row replaces it.
  if (finite(config.gnss.x) && finite(config.gnss.y))
    return { x: config.gnss.x, y: config.gnss.y };
  // Any server row supersedes the old server-wide paths, including unlinked rows.
  if (settings?.gnssSensors?.length) return null;
  // Legacy server-wide offsets cannot identify one of several configured antennas.
  const node = app.getSelfPath("navigation.position") as
    { $source?: string; values?: Record<string, unknown> } | undefined;
  if (node?.values && Object.keys(node.values).length > 1) return null;
  if (source && node?.$source && !sameSource(app, source, node.$source))
    return null;
  const x = app.getSelfPath("sensors.gps.fromCenter.value");
  const y = app.getSelfPath("sensors.gps.fromBow.value");
  return finite(x) && finite(y) ? { x: -x, y } : null;
}
