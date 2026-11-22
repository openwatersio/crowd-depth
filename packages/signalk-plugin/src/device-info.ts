import type { ServerAPI } from "@signalk/server-api";

/** Look up only the selected device, including stable CAN-name source refs. */
export function sourceDevice(app: ServerAPI, sourceRef: string) {
  const dot = sourceRef.indexOf(".");
  const label = dot === -1 ? sourceRef : sourceRef.slice(0, dot);
  const instance = dot === -1 ? "" : sourceRef.slice(dot + 1);
  const sources = app.getPath("sources") as
    | Record<string, Record<string, { n2k?: Record<string, unknown> }>>
    | undefined;
  const connection = sources?.[label];
  return (
    connection?.[instance]?.n2k ??
    Object.values(connection ?? {}).find(
      (device) => device?.n2k?.canName === instance,
    )?.n2k
  );
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export type SensorInfo = {
  make?: string;
  model?: string;
  nmea2000?: {
    modelVersion?: string;
    softwareVersionCode?: string;
    productCode?: number;
    modelSerialCode?: string;
    canName?: string;
  };
  gpsd?: {
    driver?: string;
    subtype?: string;
    subtype1?: string;
    cycle?: number;
  };
};

/** Additional device fields for reports; UI hints stay limited to make/model. */
export function detectSensorDetails(
  app: ServerAPI,
  source: string | undefined,
  anonymous: boolean,
): SensorInfo {
  const device = source ? sourceDevice(app, source) : undefined;
  if (!device) return {};
  return {
    ...detectSensor(app, source),
    nmea2000: {
      productCode:
        typeof device.productCode === "number" &&
        Number.isFinite(device.productCode)
          ? device.productCode
          : undefined,
      ...(anonymous
        ? {}
        : {
            modelVersion: text(device.modelVersion),
            softwareVersionCode: text(device.softwareVersionCode),
            modelSerialCode: text(device.modelSerialCode),
            canName: text(device.canName),
          }),
    },
  };
}

/** Reported model IDs need not be retail model names. */
export function detectSensor(
  app: ServerAPI,
  source: string | undefined,
): SensorInfo {
  const device = source ? sourceDevice(app, source) : undefined;
  return device
    ? { make: text(device.manufacturerCode), model: text(device.modelId) }
    : {};
}

/** Address and CAN-name refs are aliases only within the same connection. */
export function sameSource(
  app: ServerAPI,
  a: string | undefined,
  b: string | undefined,
) {
  if (!a || !b) return false;
  if (a === b) return true;
  if (a.split(".")[0] !== b.split(".")[0]) return false;
  const left = sourceDevice(app, a)?.canName;
  const right = sourceDevice(app, b)?.canName;
  return typeof left === "string" && left.length > 0 && left === right;
}
