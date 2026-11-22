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

test("GPSD reports driver and firmware without inventing a model or leaking device paths", () => {
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
  expect(result.gpsd?.subtype1).toBe("FWVER=SPG 3.01");
  expect(JSON.stringify(result)).not.toContain("private");
  expect(gpsdDeviceInfo([device, device])).toEqual({});
  expect(gpsdDeviceInfo([{ driver: "NMEA0183" }]).make).toBeUndefined();
});

test.each(["wrapped", "providers/gpsd", "@signalk/streams/gpsd"])(
  "queries %s GPSD using hostname before host and accepts split JSON lines",
  async (type) => {
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
                    type,
                    options:
                      type === "wrapped"
                        ? {
                            subOptions: {
                              type: "gpsd",
                              hostname: "127.0.0.1",
                              host: "wrong.invalid",
                              port,
                            },
                          }
                        : {
                            hostname: "127.0.0.1",
                            host: "wrong.invalid",
                            port,
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
  },
);

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
