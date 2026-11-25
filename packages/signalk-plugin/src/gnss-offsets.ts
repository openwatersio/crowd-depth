import type { ServerAPI } from "@signalk/server-api";
import { sourceDevice } from "./device-info.js";

type Sensor = {
  sensorId: string;
  $source: string;
  fromBow: number | null;
  fromCenter: number | null;
};

/** Replace streams have no per-sample flag distinguishing raw from corrected fixes. */
export function assertGnssPositionMode(app: ServerAPI) {
  const settings = (
    app as ServerAPI & { config?: { settings?: { gnssCorrection?: string } } }
  ).config?.settings;
  if (settings?.gnssCorrection === "replace") {
    throw new Error(
      "Signal K GNSS replace mode mixes raw and corrected positions when heading is unavailable. Use both mode and select the raw GPS source or its .ccrp source, then restart Crowd Depth.",
    );
  }
}

/** Signal K's per-source geometry; never fall back to another antenna's offsets. */
export function gnssOffsets(
  app: ServerAPI,
  source: string | undefined,
  legacy?: { x?: number; y?: number; source?: string },
) {
  assertGnssPositionMode(app);
  const { settings } =
    (
      app as ServerAPI & {
        config?: {
          settings?: { gnssSensors?: Sensor[]; gnssCorrection?: string };
        };
      }
    ).config ?? {};
  const sensors = settings?.gnssSensors ?? [];
  const mode = settings?.gnssCorrection ?? "off";
  const canonical = (ref: string) => {
    const name = sourceDevice(app, ref)?.canName;
    return typeof name === "string"
      ? `${ref.slice(0, ref.indexOf("."))}.${name}`
      : ref;
  };
  const corrected =
    mode === "both"
      ? sensors.find((s) => `${s.sensorId}.ccrp` === source)
      : undefined;
  const sensor =
    corrected ??
    sensors.find((s) => source && canonical(s.$source) === canonical(source));
  // Only migrate legacy geometry when the server has no sensor configuration
  // at all. Never borrow it for a different explicitly selected antenna.
  if (
    !sensors.length &&
    mode === "off" &&
    source &&
    (!legacy?.source || canonical(legacy.source) === canonical(source)) &&
    finite(legacy?.x) &&
    finite(legacy?.y)
  ) {
    return { gnss: { x: legacy.x, y: legacy.y } };
  }
  if (!sensor || !finite(sensor.fromBow) || !finite(sensor.fromCenter)) {
    throw new Error(
      "Set the selected GPS source's distance from bow and centerline in Signal K's GNSS sensor settings, then restart Crowd Depth.",
    );
  }
  const gnss = { x: sensor.fromCenter, y: sensor.fromBow };
  if (!corrected) return { gnss };
  const length = app.getSelfPath("design.length.value") as
    { overall?: number } | number | undefined;
  const overall = typeof length === "number" ? length : length?.overall;
  if (!finite(overall) || overall <= 0) {
    throw new Error(
      "Set vessel length in Signal K before using a corrected .ccrp position source.",
    );
  }
  return { gnss, positionOrigin: { x: 0, y: overall / 2 } };
}

function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}
