import { createConnection } from "node:net";
import type { ServerAPI } from "@signalk/server-api";
import type { SensorInfo } from "./device-info.js";

type EndpointOptions = {
  type?: string;
  hostname?: string;
  host?: string;
  port?: string | number;
};
type Provider = {
  id: string;
  enabled?: boolean;
  pipeElements?: {
    type?: string;
    enabled?: boolean;
    options?: EndpointOptions & { subOptions?: EndpointOptions };
  }[];
};

/** GPSD DEVICE responses identify a driver/family, not necessarily a retail model. */
export function gpsdDeviceInfo(devices: unknown): SensorInfo {
  if (!Array.isArray(devices) || devices.length !== 1) return {};
  const d = devices[0];
  if (!d || typeof d !== "object") return {};
  const text = (v: unknown) =>
    typeof v === "string" && v.trim() ? v.trim() : undefined;
  const driver = text(d.driver);
  return {
    // GPSD's published Garmin binary drivers identify the receiver vendor.
    // A chipset protocol such as u-blox does not identify the receiver maker.
    make: ["Garmin USB binary", "Garmin Serial binary"].includes(driver ?? "")
      ? "Garmin"
      : undefined,
  };
}

/** Read-only ?DEVICES query, bounded even if the daemon never finishes a line. */
export function gpsdDevices(host: string, port: number): Promise<unknown> {
  return new Promise((resolve) => {
    const socket = createConnection({ host, port });
    let buffer = "";
    const finish = (devices?: unknown) => {
      clearTimeout(timer);
      socket.destroy();
      resolve(devices);
    };
    const timer = setTimeout(() => finish(), 2000);
    socket.setEncoding("utf8");
    socket.on("connect", () => socket.write("?DEVICES;\n"));
    socket.on("error", () => finish());
    socket.on("end", () => finish());
    socket.on("data", (chunk) => {
      buffer += chunk;
      if (buffer.length > 65536) return finish();
      let end: number;
      while ((end = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 1);
        try {
          const message = JSON.parse(line);
          if (message.class === "DEVICES") return finish(message.devices);
        } catch {
          /* GPSD may truncate oversized messages. */
        }
      }
    });
  });
}

function gpsdEndpoint(app: ServerAPI, source: string | undefined) {
  if (!source) return;
  const providers =
    (
      app as ServerAPI & {
        config?: { settings?: { pipedProviders?: Provider[] } };
      }
    ).config?.settings?.pipedProviders ?? [];
  const provider = providers
    .filter((p) => source === p.id || source.startsWith(`${p.id}.`))
    .sort((a, b) => b.id.length - a.id.length)[0];
  if (provider?.enabled === false) return;
  const connections = provider?.pipeElements
    ?.filter((p) => p.enabled !== false)
    .map((p) =>
      p.type === "providers/gpsd" || p.type === "@signalk/streams/gpsd"
        ? p.options
        : p.options?.subOptions?.type === "gpsd"
          ? p.options.subOptions
          : undefined,
    )
    .filter((p): p is EndpointOptions => p !== undefined);
  if (connections?.length !== 1) return;
  const connection = connections[0]!;
  const port = Number(connection.port ?? 2947);
  const host = connection.hostname ?? connection.host ?? "localhost";
  if (
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65535 ||
    typeof host !== "string" ||
    !host
  )
    return;
  return { host, port };
}

export async function detectGpsdSensor(
  app: ServerAPI,
  source: string | undefined,
): Promise<SensorInfo> {
  const endpoint = gpsdEndpoint(app, source);
  return endpoint
    ? gpsdDeviceInfo(await gpsdDevices(endpoint.host, endpoint.port))
    : {};
}

type CachedIdentity = {
  key: string;
  value: SensorInfo;
  expiresAt: number;
  pending: boolean;
};
const identities = new WeakMap<ServerAPI, CachedIdentity>();

/** Admin responses never wait for GPSD. Share refreshes and retry after a minute. */
export function cachedGpsdSensor(
  app: ServerAPI,
  source: string | undefined,
): SensorInfo {
  const endpoint = gpsdEndpoint(app, source);
  if (!endpoint) {
    identities.delete(app);
    return {};
  }
  const key = JSON.stringify([source, endpoint.host, endpoint.port]);
  let entry = identities.get(app);
  if (entry?.key === key && (entry.pending || entry.expiresAt > Date.now()))
    return entry.value;
  entry = { key, value: {}, expiresAt: 0, pending: true };
  identities.set(app, entry);
  const refreshing = entry;
  void gpsdDevices(endpoint.host, endpoint.port)
    .then(gpsdDeviceInfo)
    .catch(() => ({}))
    .then((value) => {
      refreshing.value = value;
      refreshing.expiresAt = Date.now() + 60_000;
      refreshing.pending = false;
    });
  return entry.value;
}

/** DEVICE fields are descriptive, not proof of a retail model. */
export function gpsdReportInfo(
  devices: unknown,
  anonymous: boolean,
): SensorInfo {
  if (!Array.isArray(devices) || devices.length !== 1) return {};
  const d = devices[0];
  if (!d || typeof d !== "object") return {};
  const text = (v: unknown) =>
    typeof v === "string" && v.trim() ? v.trim() : undefined;
  return {
    ...gpsdDeviceInfo(devices),
    gpsd: {
      driver: text(d.driver),
      cycle:
        typeof d.cycle === "number" && Number.isFinite(d.cycle) && d.cycle > 0
          ? d.cycle
          : undefined,
      // Subtype strings are free-form and can contain device serial numbers.
      ...(anonymous
        ? {}
        : { subtype: text(d.subtype), subtype1: text(d.subtype1) }),
    },
  };
}

const reportDevices = new WeakMap<
  ServerAPI,
  { key: string; expires: number; pending: boolean; value: Promise<unknown> }
>();

export async function detectGpsdDetails(
  app: ServerAPI,
  source: string | undefined,
  anonymous: boolean,
): Promise<SensorInfo> {
  const endpoint = gpsdEndpoint(app, source);
  if (!endpoint) return {};
  const key = JSON.stringify([source, endpoint.host, endpoint.port]);
  let cached = reportDevices.get(app);
  if (
    !cached ||
    cached.key !== key ||
    (!cached.pending && cached.expires <= Date.now())
  ) {
    const entry = {
      key,
      expires: 0,
      pending: true,
      value: gpsdDevices(endpoint.host, endpoint.port),
    };
    reportDevices.set(app, entry);
    entry.value = entry.value
      .catch(() => undefined)
      .finally(() => {
        entry.pending = false;
        entry.expires = Date.now() + 60_000;
      });
    cached = entry;
  }
  return gpsdReportInfo(await cached.value, anonymous);
}
