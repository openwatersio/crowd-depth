import { expect, test } from "vitest";
import { createServer } from "node:net";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import type { ServerAPI } from "@signalk/server-api";
import {
  gpsdDeviceInfo,
  gpsdDevices,
  detectGpsdSensor,
} from "../src/gpsd-info.js";

test("GPSD recognizes a manufacturer without guessing a model", () => {
  const device = {
    driver: "u-blox",
    subtype: "SW ROM CORE 3.01,HW 00080000",
    subtype1: "FWVER=SPG 3.01",
    path: "/dev/serial/by-id/private",
    serial: "private",
    cycle: 1,
  };
  const result = gpsdDeviceInfo([device]);
  expect(result.make).toBe("u-blox");
  expect(result.model).toBeUndefined();
  expect(JSON.stringify(result)).not.toContain("private");
  expect(gpsdDeviceInfo([device, device])).toEqual({});
  expect(gpsdDeviceInfo([{ driver: "NMEA0183" }]).make).toBeUndefined();
});

test("queries the selected provider's GPSD connection and accepts split JSON lines", async () => {
  const server = createServer((socket) => {
    socket.on("data", (data) => {
      expect(data.toString()).toBe("?DEVICES;\n");
      socket.write('{"class":"VERSION","release":"3.25"}\r\n{"class":"DEV');
      socket.end('ICES","devices":[{"driver":"u-blox"}]}\r\n');
    });
  }).listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const port = (server.address() as AddressInfo).port;
    const app = {
      config: {
        settings: {
          pipedProviders: [
            {
              id: "receiver",
              enabled: true,
              pipeElements: [
                {
                  options: {
                    subOptions: { type: "gpsd", host: "127.0.0.1", port },
                  },
                },
              ],
            },
          ],
        },
      },
    } as unknown as ServerAPI;
    expect((await detectGpsdSensor(app, "receiver.GP")).make).toBe("u-blox");
    expect(await detectGpsdSensor(app, "other.GP")).toEqual({});
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("an unresponsive GPSD connection is bounded", async () => {
  const server = createServer((socket) => {
    socket.on("data", () => {});
  }).listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    expect(
      await gpsdDevices("127.0.0.1", (server.address() as AddressInfo).port),
    ).toBeUndefined();
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("does not query a parent provider when the selected nested provider is disabled", async () => {
  const server = createServer((socket) => {
    socket.on("data", () =>
      socket.end('{"class":"DEVICES","devices":[{"driver":"Garmin"}]}\n'),
    );
  }).listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const app = {
      config: {
        settings: {
          pipedProviders: [
            {
              id: "gps",
              pipeElements: [
                {
                  options: {
                    subOptions: {
                      type: "gpsd",
                      host: "127.0.0.1",
                      port: (server.address() as AddressInfo).port,
                    },
                  },
                },
              ],
            },
            { id: "gps.remote", enabled: false },
          ],
        },
      },
    } as unknown as ServerAPI;
    expect(await detectGpsdSensor(app, "gps.remote.GP")).toEqual({});
    expect(await detectGpsdSensor(app, "gps.GP")).toEqual({ make: "Garmin" });
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
