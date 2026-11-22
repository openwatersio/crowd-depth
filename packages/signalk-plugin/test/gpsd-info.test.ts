import gpsdProvider from "./fixtures/gpsd-provider.json" with { type: "json" };
import { expect, test, vi } from "vitest";
import { createServer } from "node:net";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import type { ServerAPI } from "@signalk/server-api";
import {
  gpsdDeviceInfo,
  gpsdDevices,
  detectGpsdSensor,
  cachedGpsdSensor,
} from "../src/gpsd-info.js";

test("GPSD recognizes a manufacturer without guessing a model", () => {
  const device = {
    driver: "Garmin USB binary",
    subtype: "SW ROM CORE 3.01,HW 00080000",
    subtype1: "FWVER=SPG 3.01",
    path: "/dev/serial/by-id/private",
    serial: "private",
    cycle: 1,
  };
  const result = gpsdDeviceInfo([device]);
  expect(result.make).toBe("Garmin");
  expect(result.model).toBeUndefined();
  expect(JSON.stringify(result)).not.toContain("private");
  expect(gpsdDeviceInfo([device, device])).toEqual({});
  expect(gpsdDeviceInfo([{ driver: "NMEA0183" }]).make).toBeUndefined();
});

test.each([
  { host: "127.0.0.1" },
  { hostname: "127.0.0.1" },
  { hostname: "127.0.0.1", host: "192.0.2.1" },
])(
  "queries the configured GPSD endpoint %j and accepts split JSON lines",
  async (endpoint) => {
    const server = createServer((socket) => {
      socket.on("data", (data) => {
        expect(data.toString()).toBe("?DEVICES;\n");
        socket.write('{"class":"VERSION","release":"3.25"}\r\n{"class":"DEV');
        socket.end('ICES","devices":[{"driver":"Garmin USB binary"}]}\r\n');
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
                      subOptions: { type: "gpsd", ...endpoint, port },
                    },
                  },
                ],
              },
            ],
          },
        },
      } as unknown as ServerAPI;
      expect((await detectGpsdSensor(app, "receiver.GP")).make).toBe("Garmin");
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

test("does not query a parent provider when the selected nested provider is disabled", async () => {
  const server = createServer((socket) => {
    socket.on("data", () =>
      socket.end(
        '{"class":"DEVICES","devices":[{"driver":"Garmin Serial binary"}]}\n',
      ),
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

test("recognizes published Garmin drivers but does not infer receiver make from a chipset", () => {
  for (const driver of ["Garmin USB binary", "Garmin Serial binary"]) {
    expect(gpsdDeviceInfo([{ driver }])).toEqual({ make: "Garmin" });
  }
  for (const driver of ["u-blox", "Garmin", "NMEA0183", 123, null]) {
    expect(gpsdDeviceInfo([{ driver }]).make).toBeUndefined();
  }
});

test("skips disabled and ambiguous GPSD pipes", async () => {
  const server = createServer((socket) => {
    socket.on("data", () =>
      socket.end(
        '{"class":"DEVICES","devices":[{"driver":"Garmin USB binary"}]}\n',
      ),
    );
  }).listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const pipe = {
      options: {
        subOptions: {
          type: "gpsd",
          host: "127.0.0.1",
          port: (server.address() as AddressInfo).port,
        },
      },
    };
    const app = (pipeElements: unknown[]) =>
      ({
        config: { settings: { pipedProviders: [{ id: "gps", pipeElements }] } },
      }) as unknown as ServerAPI;
    expect(
      await detectGpsdSensor(app([{ ...pipe, enabled: false }]), "gps.GP"),
    ).toEqual({});
    expect(await detectGpsdSensor(app([pipe, pipe]), "gps.GP")).toEqual({});
    expect(
      await detectGpsdSensor(
        app([{ ...pipe, enabled: false }, pipe]),
        "gps.GP",
      ),
    ).toEqual({ make: "Garmin" });
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("recognizes Signal K's shipped direct GPSD provider configuration", async () => {
  const server = createServer((socket) =>
    socket.on("data", () =>
      socket.end(
        '{"class":"DEVICES","devices":[{"driver":"Garmin USB binary"}]}\n',
      ),
    ),
  ).listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    // Signal K 2.33.0 settings/volare-gpsd-settings.json, changing only the test port.
    const provider = structuredClone(gpsdProvider);
    provider.pipeElements[0].options!.port = (
      server.address() as AddressInfo
    ).port;
    const app = {
      config: { settings: { pipedProviders: [provider] } },
    } as unknown as ServerAPI;
    expect(await detectGpsdSensor(app, `${provider.id}.GP`)).toEqual({
      make: "Garmin",
    });
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("cached hints return immediately, share refreshes, expire, and retry failures", async () => {
  let requests = 0;
  let reply = false;
  const sockets = new Set<import("node:net").Socket>();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("data", () => {
      requests++;
      if (reply)
        socket.end(
          '{"class":"DEVICES","devices":[{"driver":"Garmin USB binary"}]}\n',
        );
    });
  }).listen(0, "127.0.0.1");
  await once(server, "listening");
  let now = Date.now();
  const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
  try {
    const app = {
      config: {
        settings: {
          pipedProviders: [
            {
              id: "gps",
              pipeElements: [
                {
                  type: "providers/gpsd",
                  options: {
                    hostname: "127.0.0.1",
                    port: (server.address() as AddressInfo).port,
                  },
                },
              ],
            },
          ],
        },
      },
    } as unknown as ServerAPI;
    expect(cachedGpsdSensor(app, "gps.GP")).toEqual({});
    expect(cachedGpsdSensor(app, "gps.GP")).toEqual({});
    await vi.waitFor(() => expect(requests).toBe(1));
    // Let the bounded query fail, then confirm repeated reads do not immediately retry.
    await new Promise((resolve) => setTimeout(resolve, 2100));
    expect(cachedGpsdSensor(app, "gps.GP")).toEqual({});
    expect(requests).toBe(1);
    reply = true;
    now += 60_001;
    expect(cachedGpsdSensor(app, "gps.GP")).toEqual({});
    await vi.waitFor(() =>
      expect(cachedGpsdSensor(app, "gps.GP")).toEqual({ make: "Garmin" }),
    );
    expect(requests).toBe(2);
    now += 60_001;
    expect(cachedGpsdSensor(app, "gps.GP")).toEqual({});
    await vi.waitFor(() =>
      expect(cachedGpsdSensor(app, "gps.GP")).toEqual({ make: "Garmin" }),
    );
    expect(requests).toBe(3);
    expect(cachedGpsdSensor(app, "other.GP")).toEqual({});
  } finally {
    clock.mockRestore();
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("GPSD reports driver and firmware without guessing retail identity or leaking paths", async () => {
  const { gpsdReportInfo } = await import("../src/gpsd-info.js");
  const devices = [
    {
      driver: "u-blox",
      subtype: "Firmware serial=private",
      subtype1: "HW1",
      cycle: 1,
      path: "/dev/private",
      serial: "private",
    },
  ];
  expect(gpsdReportInfo(devices, false)).toMatchObject({
    gpsd: {
      driver: "u-blox",
      subtype: devices[0].subtype,
      subtype1: "HW1",
      cycle: 1,
    },
  });
  expect(gpsdReportInfo(devices, false).make).toBeUndefined();
  const anonymous = gpsdReportInfo(devices, true);
  expect(JSON.stringify(anonymous)).not.toContain("private");
  expect(anonymous.gpsd).toEqual({ driver: "u-blox", cycle: 1 });
  expect(gpsdReportInfo([...devices, ...devices], false)).toEqual({});
});

test("report lookups share the GPSD query and apply anonymous filtering per caller", async () => {
  const { getSensorInfo } = await import("../src/metadata.js");
  const { config } = await import("./helper.js");
  let queries = 0;
  const server = createServer((socket) =>
    socket.on("data", () => {
      queries++;
      socket.end(
        JSON.stringify({
          class: "DEVICES",
          devices: [
            {
              driver: "Garmin USB binary",
              subtype: "serial=private",
              cycle: 1,
            },
          ],
        }) + "\n",
      );
    }),
  );
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const port = (server.address() as AddressInfo).port;
    const app = {
      getPath: () => ({}),
      getSelfPath: () => ({ $source: "gps.GP" }),
      config: {
        settings: {
          pipedProviders: [
            {
              id: "gps",
              pipeElements: [
                {
                  type: "providers/gpsd",
                  options: { hostname: "127.0.0.1", port },
                },
              ],
            },
          ],
        },
      },
    } as unknown as ServerAPI;
    const [identified, anonymous] = await Promise.all([
      getSensorInfo(app, config),
      getSensorInfo(app, { ...config, sharing: { anonymous: true } }),
    ]);
    expect(identified.gnss.gpsd?.subtype).toBe("serial=private");
    expect(anonymous.gnss.gpsd?.subtype).toBeUndefined();
    expect(anonymous.gnss.make).toBe("Garmin");
    await getSensorInfo(app, config);
    expect(queries).toBe(1);
  } finally {
    server.close();
    await once(server, "close");
  }
});
