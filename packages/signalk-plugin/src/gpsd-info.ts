import { createConnection } from "node:net";
import type { ServerAPI } from "@signalk/server-api";
import type { SensorInfo } from "./device-info.js";

type Connection = {
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
    options?: Connection & { subOptions?: Connection };
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
    make: driver === "u-blox" || driver === "Garmin" ? driver : undefined,
    gpsd: {
      driver,
      subtype: text(d.subtype),
      subtype1: text(d.subtype1),
      cycle:
        typeof d.cycle === "number" && Number.isFinite(d.cycle)
          ? d.cycle
          : undefined,
    },
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

export async function detectGpsdSensor(
  app: ServerAPI,
  source: string | undefined,
): Promise<SensorInfo> {
  if (!source) return {};
  const providers =
    (
      app as ServerAPI & {
        config?: { settings?: { pipedProviders?: Provider[] } };
      }
    ).config?.settings?.pipedProviders ?? [];
  const provider = providers.find(
    (p) =>
      p.enabled !== false && (source === p.id || source.startsWith(`${p.id}.`)),
  );
  const connection = provider?.pipeElements
    ?.map((p) =>
      p.type === "providers/gpsd" || p.type === "@signalk/streams/gpsd"
        ? { ...p.options, type: "gpsd" }
        : p.options?.subOptions,
    )
    .find((p) => p?.type === "gpsd");
  if (!connection) return {};
  const port = Number(connection.port ?? 2947);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return {};
  return gpsdDeviceInfo(
    await gpsdDevices(
      connection.hostname ?? connection.host ?? "localhost",
      port,
    ),
  );
}
