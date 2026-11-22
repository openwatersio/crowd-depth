import type { ServerAPI } from "@signalk/server-api";

/** Look up only the selected device, including stable CAN-name source refs. */
export function sourceDevice(app: ServerAPI, sourceRef: string) {
  const dot = sourceRef.indexOf(".");
  const label = dot === -1 ? sourceRef : sourceRef.slice(0, dot);
  const instance = dot === -1 ? "" : sourceRef.slice(dot + 1);
  const sources = app.getPath?.("sources") as
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

/** Compare source aliases only when the server identifies the same CAN device. */
export function sameSource(app: ServerAPI, a?: string, b?: string): boolean {
  if (!a || !b) return false;
  if (a === b) return true;
  if (a.split(".")[0] !== b.split(".")[0]) return false;
  const left = sourceDevice(app, a)?.canName;
  const right = sourceDevice(app, b)?.canName;
  return typeof left === "string" && left.length > 0 && left === right;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export type SensorInfo = {
  make?: string;
  model?: string;
  nmea2000?: {
    modelId?: string;
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

/** Preserve reported identities verbatim: a model ID need not be a retail name. */
export function detectSensor(
  app: ServerAPI,
  source: string | undefined,
  anonymous: boolean,
): SensorInfo {
  const device = source ? sourceDevice(app, source) : undefined;
  if (!device) return {};
  const productCode = device.productCode;
  return {
    make: text(device.manufacturerCode),
    model: text(device.modelId),
    // Extension to the CSB sensor description, retaining the device's own fields.
    nmea2000: {
      modelId: text(device.modelId),
      modelVersion: text(device.modelVersion),
      softwareVersionCode: text(device.softwareVersionCode),
      productCode:
        typeof productCode === "number" && Number.isFinite(productCode)
          ? productCode
          : undefined,
      ...(anonymous
        ? {}
        : {
            modelSerialCode: text(device.modelSerialCode),
            canName: text(device.canName),
          }),
    },
  };
}
