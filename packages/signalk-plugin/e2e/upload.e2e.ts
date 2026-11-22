import {
  createServer as createTcpServer,
  type AddressInfo,
  type Socket,
} from "node:net";
import gpsdProvider from "../test/fixtures/gpsd-provider.json" with { type: "json" };
import { afterEach, describe, expect, test } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type Server } from "node:http";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import Ajv from "ajv/dist/2020.js";
import schema from "../../../docs/CSB-schema-3_1_0-2024-04.json" with { type: "json" };
import type { Config } from "../src/config.js";

/**
 * Runs the built plugin inside a real Signal K server and checks what it
 * uploads to a stand-in trusted node: that the server can load the plugin,
 * that soundings reach it through the real delta and History API paths, and
 * that the submission is valid CSB with the depth reference it claims.
 *
 * Needs a signalk-server install: point SIGNALK_SERVER_DIR at its package
 * directory (e.g. node_modules/signalk-server). Skipped without one, except
 * under CI.
 */
const SERVER_DIR = process.env.SIGNALK_SERVER_DIR;
const PLUGIN_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");
const HISTORY_PROVIDER = join(PLUGIN_DIR, "e2e/fixtures/history-provider");

function serverDir() {
  if (!SERVER_DIR) throw new Error("SIGNALK_SERVER_DIR is not set");
  return SERVER_DIR;
}

// Transducer 0.5 m below the waterline; the depth path is below the transducer.
const config: Config = {
  path: "belowTransducer",
  sounder: { x: 0, y: 3, z: 0.5, make: "Airmar", model: "DST800" },
  gnss: { x: 0, y: 9, z: 2, make: "Garmin", model: "GPS 24xd" },
  sharing: { anonymous: false },
};

type Upload = {
  properties: {
    trustedNode: Record<string, unknown>;
    platform: Record<string, unknown>;
  };
  features: {
    geometry: { coordinates: [number, number] };
    properties: { depth: number; time: string; gnss?: Record<string, unknown> };
  }[];
};

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/** A trusted node that hands out an identity and keeps every upload. */
async function startTrustedNode() {
  const uploads: Upload[] = [];
  const waiters: (() => void)[] = [];
  const server: Server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const body = Buffer.concat(chunks);
    if (req.url?.endsWith("/identify")) {
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify({
          uuid: "e2e00000-0000-4000-8000-000000000000",
          token: "e2e",
        }),
      );
      return;
    }
    if (req.url?.endsWith("/geojson")) {
      const form = await new Request("http://node/geojson", {
        method: "POST",
        headers: { "content-type": req.headers["content-type"] ?? "" },
        body,
      }).formData();
      uploads.push(JSON.parse(await (form.get("file") as Blob).text()));
      waiters.splice(0).forEach((w) => w());
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify({ success: true, message: "ok", submissionIds: [] }),
      );
      return;
    }
    res.statusCode = 404;
    res.end();
  });
  server.listen(0);
  await once(server, "listening");
  cleanups.push(() => new Promise((r) => server.close(r)));
  const { port } = server.address() as { port: number };

  return {
    url: `http://127.0.0.1:${port}/`,
    uploads,
    async next(timeoutMs = 30_000): Promise<Upload> {
      if (uploads.length) return uploads.shift()!;
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error("No upload reached the trusted node")),
          timeoutMs,
        );
        waiters.push(() => {
          clearTimeout(timer);
          resolve();
        });
      });
      return uploads.shift()!;
    },
    /** Uploads until they hold at least `soundings` soundings between them. */
    async collect(soundings: number): Promise<Upload[]> {
      const collected: Upload[] = [];
      while (collected.reduce((n, u) => n + u.features.length, 0) < soundings) {
        collected.push(await this.next());
      }
      return collected;
    },
  };
}

interface ServerOptions {
  trustedNodeUrl: string;
  /** crowd-depth is enabled at boot, or later through the admin API. */
  enableAtBoot: boolean;
  historyRows?: object[];
  gpsdPort?: number;
  schedule?: string;
  pluginConfig?: Config;
  gnssSensors?: {
    sensorId: string;
    $source: string;
    fromBow: number;
    fromCenter: number;
  }[];
  priorityOverrides?: Record<string, { sourceRef: string; timeout: number }[]>;
}

async function startSignalK({
  trustedNodeUrl,
  enableAtBoot,
  historyRows,
  gpsdPort,
  schedule,
  pluginConfig = config,
  gnssSensors,
  priorityOverrides,
}: ServerOptions) {
  const configDir = await mkdtemp(join(tmpdir(), "crowd-depth-e2e-"));
  cleanups.push(() => rm(configDir, { recursive: true, force: true }));
  const modules = join(configDir, "node_modules");
  await mkdir(join(configDir, "plugin-config-data"), { recursive: true });
  await mkdir(modules);
  await symlink(PLUGIN_DIR, join(modules, "crowd-depth"), "dir");
  const dependencies: Record<string, string> = { "crowd-depth": "*" };
  if (historyRows) {
    await symlink(
      HISTORY_PROVIDER,
      join(modules, "e2e-history-provider"),
      "dir",
    );
    dependencies["e2e-history-provider"] = "*";
    await writeFile(
      join(configDir, "plugin-config-data", "e2e-history-provider.json"),
      JSON.stringify({ enabled: true, configuration: {} }),
    );
  }
  await writeFile(
    join(configDir, "package.json"),
    JSON.stringify({ name: "e2e-config", private: true, dependencies }),
  );
  const provider = structuredClone(gpsdProvider);
  if (gpsdPort) provider.pipeElements[0].options!.port = gpsdPort;
  await writeFile(
    join(configDir, "settings.json"),
    JSON.stringify({
      interfaces: {},
      gnssSensors,
      pipedProviders: gpsdPort ? [provider] : [],
    }),
  );
  if (priorityOverrides) {
    await writeFile(
      join(configDir, "priorities.json"),
      JSON.stringify({ priorityOverrides }),
    );
  }
  await writeFile(
    join(configDir, "defaults.json"),
    JSON.stringify({
      vessels: {
        self: {
          uuid: "urn:mrn:signalk:uuid:e2e00000-0000-4000-8000-000000000001",
          name: "E2E Vessel",
        },
      },
    }),
  );
  if (enableAtBoot) {
    await writeFile(
      join(configDir, "plugin-config-data", "crowd-depth.json"),
      JSON.stringify({
        enabled: true,
        configuration: gpsdPort
          ? {
              ...pluginConfig,
              gnss: { ...pluginConfig.gnss, source: `${provider.id}.GP` },
            }
          : pluginConfig,
      }),
    );
  }

  const port = await freePort();
  const child: ChildProcess = spawn(
    process.execPath,
    [join(serverDir(), "bin", "signalk-server")],
    {
      env: {
        ...process.env,
        SIGNALK_NODE_CONFIG_DIR: configDir,
        PORT: String(port),
        BATHY_URL: trustedNodeUrl,
        // Report every few seconds rather than every six hours.
        BATHY_DEFAULT_SCHEDULE: schedule ?? "*/3 * * * * *",
        // Leave reports only the moment a sounding takes to reach storage,
        // not the minutes a buffering history provider needs.
        BATHY_REPORT_DELAY: "1",
        E2E_HISTORY: JSON.stringify(historyRows ?? []),
        // Don't wait long for a history provider in tests that have none, and
        // give one that registers after the plugin starts time to be found.
        BATHY_HISTORY_WAIT: historyRows ? "20" : "2",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let log = "";
  child.stdout!.on("data", (d) => (log += d));
  child.stderr!.on("data", (d) => (log += d));
  cleanups.push(async () => {
    if (child.exitCode === null) {
      child.kill();
      await once(child, "exit");
    }
  });

  const base = `http://127.0.0.1:${port}`;
  await waitFor(
    async () => (await fetch(`${base}/signalk`)).ok,
    () => log,
  );

  return {
    base,
    log: () => log,
    /** Waits for the plugin's status line in the admin API to match. */
    async waitForStatus(pattern: RegExp) {
      await waitFor(
        async () => {
          const plugins = (await (
            await fetch(`${base}/skServer/plugins`)
          ).json()) as { id: string; statusMessage?: string }[];
          const status = plugins.find(
            (p) => p.id === "crowd-depth",
          )?.statusMessage;
          return pattern.test(status ?? "");
        },
        () => log,
      );
    },
    async enable(configuration = config) {
      const res = await fetch(`${base}/skServer/plugins/crowd-depth/config`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ enabled: true, configuration }),
      });
      expect(res.ok, await res.text()).toBe(true);
    },
    async sendDeltas(deltas: object[]) {
      const ws = new WebSocket(
        `ws://127.0.0.1:${port}/signalk/v1/stream?subscribe=none`,
      );
      await new Promise((resolve, reject) => {
        ws.onopen = resolve;
        ws.onerror = reject;
      });
      for (const delta of deltas) {
        ws.send(JSON.stringify(delta));
        await new Promise((r) => setTimeout(r, 200));
      }
      ws.close();
    },
  };
}

async function freePort(): Promise<number> {
  const server = createServer().listen(0);
  await once(server, "listening");
  const { port } = server.address() as { port: number };
  await new Promise((r) => server.close(r));
  return port;
}

async function waitFor(check: () => Promise<boolean>, log: () => string) {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    try {
      if (await check()) return;
    } catch {
      // Not listening yet
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`Timed out waiting on the Signal K server:\n${log()}`);
}

function expectValidCsb(upload: Upload) {
  const validate = new Ajv({ allErrors: true }).compile(schema);
  expect(validate(upload), JSON.stringify(validate.errors, null, 2)).toBe(true);
}

// The bow points east, so the transducer, 6 m forward of the antenna, sits 6 m
// east of each fix.
const HEADING = Math.PI / 2;
const TRANSDUCER_LONGITUDE = 177.4300566;

function expectAtTransducer(features: Upload["features"]) {
  for (const f of features) {
    expect(f.geometry.coordinates[0]).toBeCloseTo(TRANSDUCER_LONGITUDE, 6);
  }
}

// CI always runs the suite, so a missing server fails rather than skips it.
const RUN = SERVER_DIR || process.env.CI;

describe.skipIf(!RUN)("uploads from a real Signal K server", () => {
  test("live soundings arrive measured from the waterline", async () => {
    const node = await startTrustedNode();
    const sk = await startSignalK({
      trustedNodeUrl: node.url,
      enableAtBoot: true,
    });
    // Soundings sent before the plugin subscribes would be lost.
    await sk.waitForStatus(/Next report at/);

    // Signal K must await the async hook before serializing its admin response.
    const plugins = (await (
      await fetch(`${sk.base}/skServer/plugins`)
    ).json()) as {
      id: string;
      uiSchema?: unknown;
    }[];
    expect(
      plugins.find((plugin) => plugin.id === "crowd-depth")?.uiSchema,
    ).toEqual({
      sounder: {
        make: { "ui:placeholder": "" },
        model: { "ui:placeholder": "" },
      },
      gnss: { make: { "ui:placeholder": "" }, model: { "ui:placeholder": "" } },
    });

    const fix = (i: number) => ({
      path: "navigation.position",
      value: { latitude: -17.6 + i * 1e-4, longitude: 177.43 },
    });
    const update = (values: object[]) => ({
      context: "vessels.self",
      updates: [
        {
          source: { label: "e2e" },
          // No timestamp: the server stamps each delta as it arrives. One
          // stamped before it's sent could predate a report that ran while it
          // was in flight, and that report's successor would skip it.
          values,
        },
      ],
    });
    // A depth is only kept with a fresh position fix and heading, which moves
    // it from the antenna to the transducer, so those speak first, as they
    // would on board.
    await sk.sendDeltas([
      update([fix(0), { path: "navigation.headingTrue", value: HEADING }]),
      ...[3.2, 3.4, 3.6].map((depth, i) =>
        update([
          fix(i),
          { path: "environment.depth.belowTransducer", value: depth },
        ]),
      ),
    ]);

    // A report can fall between soundings, splitting them over two uploads.
    const uploads = await node.collect(3);
    uploads.forEach(expectValidCsb);
    for (const upload of uploads) {
      expect(upload.properties.trustedNode.verticalReferenceOfDepth).toBe(
        "Waterline",
      );
    }
    expect(
      uploads.flatMap((u) => u.features.map((f) => f.properties.depth)),
    ).toEqual([3.7, 3.9, 4.1]);
    expectAtTransducer(uploads.flatMap((u) => u.features));
  });

  test("GPSD NMEA quality reaches the report without extra GPSD configuration", async () => {
    const sockets = new Set<Socket>();
    const gpsd = createTcpServer((socket) => {
      sockets.add(socket);
      socket.on("close", () => sockets.delete(socket));
      let timer: ReturnType<typeof setInterval> | undefined;
      socket.on("data", (data) => {
        if (!data.toString().includes("?WATCH")) return;
        const send = () => {
          const time = new Date()
            .toISOString()
            .slice(11, 19)
            .replaceAll(":", "");
          const body = `GPGGA,${time},1736.0000,S,17725.8000,E,2,08,0.9,10.0,M,2.0,M,,`;
          const checksum = [...body]
            .reduce((value, char) => value ^ char.charCodeAt(0), 0)
            .toString(16)
            .toUpperCase()
            .padStart(2, "0");
          socket.write(`$${body}*${checksum}\r\n`);
        };
        if (!timer) timer = setInterval(send, 250);
        send();
      });
      socket.on("close", () => clearInterval(timer));
    }).listen(0, "127.0.0.1");
    await once(gpsd, "listening");
    cleanups.push(async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => gpsd.close(() => resolve()));
    });
    const node = await startTrustedNode();
    const sk = await startSignalK({
      trustedNodeUrl: node.url,
      enableAtBoot: true,
      gpsdPort: (gpsd.address() as AddressInfo).port,
      pluginConfig: {
        ...config,
        sounder: { ...config.sounder, x: 0, y: 0 },
        gnss: { ...config.gnss, x: 0, y: 0 },
      },
    });
    await sk.waitForStatus(/Next report at/);
    await new Promise((resolve) => setTimeout(resolve, 1500));
    await sk.sendDeltas([
      {
        context: "vessels.self",
        updates: [
          {
            source: { label: "e2e" },
            values: [{ path: "navigation.headingTrue", value: HEADING }],
          },
          {
            source: { label: "e2e" },
            values: [{ path: "environment.depth.belowTransducer", value: 3.2 }],
          },
        ],
      },
    ]);
    const upload = await node.next();
    expectValidCsb(upload);
    expect(upload.features[0].properties.gnss).toMatchObject({
      satellites: 8,
      horizontalDilution: 0.9,
    });
  });

  test.each([false, true])(
    "records GPS quality without provider quality paths (history=%s)",
    async (history) => {
      const node = await startTrustedNode();
      const time = new Date(Date.now() + 10_000).toISOString();
      const sk = await startSignalK({
        trustedNodeUrl: node.url,
        enableAtBoot: true,
        pluginConfig: { ...config, gnss: { ...config.gnss, source: "e2e.XX" } },
        historyRows: history
          ? [
              {
                time,
                latitude: -17.6,
                longitude: 177.43,
                depth: 3.2,
                heading: HEADING,
              },
            ]
          : undefined,
      });
      await sk.waitForStatus(/Next report at/);
      const update = (values: object[]) => ({
        context: "vessels.self",
        updates: [{ timestamp: time, source: { label: "e2e" }, values }],
      });
      await sk.sendDeltas([
        update([
          { path: "navigation.gnss.satellites", value: 9 },
          { path: "navigation.gnss.horizontalDilution", value: 0.8 },
          {
            path: "navigation.position",
            value: { latitude: -17.6, longitude: 177.43 },
          },
          { path: "navigation.headingTrue", value: HEADING },
        ]),
        update([{ path: "environment.depth.belowTransducer", value: 3.2 }]),
      ]);
      const upload = await node.next();
      expectValidCsb(upload);
      expect(upload.features[0].properties.gnss).toEqual({
        satellites: 9,
        horizontalDilution: 0.8,
      });
    },
  );

  test("uses Signal K receiver geometry without plugin horizontal fields", async () => {
    const node = await startTrustedNode();
    const sk = await startSignalK({
      trustedNodeUrl: node.url,
      enableAtBoot: true,
      pluginConfig: { ...config, gnss: { z: 2 } },
      gnssSensors: [
        { sensorId: "gps", $source: "e2e.XX", fromBow: 9, fromCenter: 1 },
      ],
    });
    await sk.waitForStatus(/Next report at/);
    const update = (values: object[]) => ({
      context: "vessels.self",
      updates: [{ source: { label: "e2e" }, values }],
    });
    await sk.sendDeltas([
      update([
        {
          path: "navigation.position",
          value: { latitude: -17.6, longitude: 177.43 },
        },
        { path: "navigation.headingTrue", value: HEADING },
      ]),
      update([{ path: "environment.depth.belowTransducer", value: 3.2 }]),
    ]);
    const upload = await node.next();
    expectValidCsb(upload);
    expectAtTransducer(upload.features);
    // Heading east: the antenna is 1 m to port (north), so move south to the transducer.
    expect(upload.features[0].geometry.coordinates[1]).toBeLessThan(-17.600005);
  });

  test("detects the depth path when setup has no saved path", async () => {
    const node = await startTrustedNode();
    const { path: _path, ...settings } = config;
    const sk = await startSignalK({
      trustedNodeUrl: node.url,
      enableAtBoot: true,
      pluginConfig: settings as Config,
    });
    const deltas = [
      {
        context: "vessels.self",
        updates: [
          {
            source: { label: "e2e" },
            values: [
              {
                path: "navigation.position",
                value: { latitude: -17.6, longitude: 177.43 },
              },
              { path: "navigation.headingTrue", value: HEADING },
              { path: "environment.depth.belowSurface", value: 3.2 },
            ],
          },
        ],
      },
    ];
    await sk.sendDeltas(deltas);
    await sk.waitForStatus(/Next report at/);
    await sk.sendDeltas(deltas);
    const upload = await node.next();
    expectValidCsb(upload);
    expect(upload.features[0].properties.depth).toBe(3.2);
    expect(upload.properties.trustedNode.verticalReferenceOfDepth).toBe(
      "Waterline",
    );
  });

  test("a settings restart flushes queued soundings with the previous sensor settings", async () => {
    const node = await startTrustedNode();
    const sk = await startSignalK({
      trustedNodeUrl: node.url,
      enableAtBoot: true,
      schedule: "0 0 1 1 *",
    });
    await sk.waitForStatus(/Next report at/);
    const update = (values: object[]) => ({
      context: "vessels.self",
      updates: [{ source: { label: "e2e" }, values }],
    });
    await sk.sendDeltas([
      update([
        {
          path: "navigation.position",
          value: { latitude: -17.6, longitude: 177.43 },
        },
        { path: "navigation.headingTrue", value: HEADING },
      ]),
      update([{ path: "environment.depth.belowTransducer", value: 3.2 }]),
    ]);
    // Flush ends on a whole second; let this sounding's second finish.
    await new Promise((resolve) => setTimeout(resolve, 1200));
    expect(node.uploads).toHaveLength(0);
    await sk.enable({
      ...config,
      sounder: { ...config.sounder, model: "Replacement", z: 5 },
    });
    const upload = await node.next();
    expectValidCsb(upload);
    expect(upload.features.map((feature) => feature.properties.depth)).toEqual([
      3.7,
    ]);
    expect(upload.properties.platform.sensors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "Sounder", model: "DST800" }),
      ]),
    );
  });

  test.each(["disable", "anonymous"])(
    "changing sharing to %s does not flush an identified report",
    async (action) => {
      const node = await startTrustedNode();
      const sk = await startSignalK({
        trustedNodeUrl: node.url,
        enableAtBoot: true,
        schedule: "0 0 1 1 *",
      });
      await sk.waitForStatus(/Next report at/);
      const update = (values: object[]) => ({
        context: "vessels.self",
        updates: [{ source: { label: "e2e" }, values }],
      });
      await sk.sendDeltas([
        update([
          {
            path: "navigation.position",
            value: { latitude: -17.6, longitude: 177.43 },
          },
          { path: "navigation.headingTrue", value: HEADING },
        ]),
        update([{ path: "environment.depth.belowTransducer", value: 3.2 }]),
      ]);
      await new Promise((resolve) => setTimeout(resolve, 1200));
      const response = await fetch(
        `${sk.base}/skServer/plugins/crowd-depth/config`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            enabled: action !== "disable",
            configuration: {
              ...config,
              sharing: { anonymous: action === "anonymous" },
            },
          }),
        },
      );
      expect(response.ok, await response.text()).toBe(true);
      await sk.waitForStatus(
        action === "disable" ? /Stopped/ : /Next report at/,
      );
      await new Promise((resolve) => setTimeout(resolve, 1000));
      expect(node.uploads).toHaveLength(0);
    },
  );

  test("soundings read through the History API arrive measured from the waterline", async () => {
    const node = await startTrustedNode();
    const start = Date.now() - 60 * 60 * 1000;
    const rows = [3.2, 3.4, 3.6].map((depth, i) => ({
      time: new Date(start + i * 1000).toISOString(),
      latitude: -17.6 + i * 1e-4,
      longitude: 177.43,
      heading: HEADING,
      depth,
    }));
    const sk = await startSignalK({
      trustedNodeUrl: node.url,
      // Enabled after boot, so the history provider has usually registered and
      // the plugin uses it from the start rather than waiting for it.
      enableAtBoot: false,
      historyRows: rows,
    });
    await sk.enable();

    const upload = await node.next();
    expectValidCsb(upload);
    expect(upload.properties.trustedNode.verticalReferenceOfDepth).toBe(
      "Waterline",
    );
    expect(upload.features.map((f) => f.properties.depth)).toEqual([
      3.7, 3.9, 4.1,
    ]);
    expectAtTransducer(upload.features);

    // Nothing more follows: the next report finds no new soundings.
    await new Promise((r) => setTimeout(r, 4000));
    expect(node.uploads).toEqual([]);
  });
});

describe.skipIf(!RUN)("identity hints through the real admin API", () => {
  test.each([true, false])(
    "GPSD replies=%s: plugin listing stays responsive",
    async (respond) => {
      let requests = 0;
      const sockets = new Set<Socket>();
      const gpsd = createTcpServer((socket) => {
        sockets.add(socket);
        socket.on("close", () => sockets.delete(socket));
        socket.on("data", (data) => {
          if (data.toString().includes("?DEVICES;")) {
            requests++;
            if (respond)
              socket.end(
                '{"class":"DEVICES","devices":[{"driver":"Garmin USB binary"}]}\n',
              );
          }
        });
      }).listen(0, "127.0.0.1");
      await once(gpsd, "listening");
      cleanups.push(async () => {
        for (const socket of sockets) socket.destroy();
        await new Promise<void>((resolve) => gpsd.close(() => resolve()));
      });
      const node = await startTrustedNode();
      const sk = await startSignalK({
        trustedNodeUrl: node.url,
        enableAtBoot: true,
        gpsdPort: (gpsd.address() as AddressInfo).port,
      });
      await sk.waitForStatus(/Next report at/);
      const hints = async () => {
        const response = await fetch(`${sk.base}/skServer/plugins`);
        expect(response.ok).toBe(true);
        const plugins = (await response.json()) as {
          id: string;
          uiSchema: { gnss: { make: { "ui:placeholder": string } } };
        }[];
        return plugins.find((p) => p.id === "crowd-depth")!.uiSchema.gnss.make[
          "ui:placeholder"
        ];
      };
      const start = performance.now();
      const values = await Promise.all(Array.from({ length: 6 }, hints));
      expect(performance.now() - start).toBeLessThan(1000);
      if (respond) {
        await waitFor(async () => (await hints()) === "Garmin", sk.log);
      } else {
        expect(values).toEqual(Array(6).fill(""));
      }
      await waitFor(async () => requests === 1, sk.log);
      expect(requests).toBe(1);
    },
  );
});

describe.skipIf(!RUN)("source selection through Signal K subscriptions", () => {
  test.each(["", "chosen.XX"])(
    "selected source %j respects preferred or explicit delivery",
    async (selected) => {
      const node = await startTrustedNode();
      const priorities = [
        { sourceRef: "preferred.XX", timeout: 60000 },
        { sourceRef: "chosen.XX", timeout: 60000 },
      ];
      const sk = await startSignalK({
        trustedNodeUrl: node.url,
        enableAtBoot: true,
        pluginConfig: {
          ...config,
          sounder: { ...config.sounder, x: 0, y: 0, z: 0, source: selected },
          gnss: { ...config.gnss, x: 0, y: 0, source: selected },
        },
        priorityOverrides: {
          "navigation.position": priorities,
          "environment.depth.belowTransducer": priorities,
        },
      });
      await sk.waitForStatus(/Next report at/);
      const context = (await (
        await fetch(`${sk.base}/signalk/v1/api/self`)
      ).json()) as string;
      const delta = (label: string, values: object[]) => ({
        context,
        updates: [{ $source: `${label}.XX`, source: { label }, values }],
      });
      await sk.sendDeltas([
        delta("preferred", [
          { path: "navigation.position", value: { longitude: 1, latitude: 2 } },
        ]),
        delta("chosen", [
          {
            path: "navigation.position",
            value: { longitude: 10, latitude: 20 },
          },
        ]),
        delta("preferred", [
          { path: "environment.depth.belowTransducer", value: 90 },
        ]),
        delta("chosen", [
          { path: "environment.depth.belowTransducer", value: 3 },
        ]),
      ]);
      const current = (await (
        await fetch(
          `${sk.base}/signalk/v1/api/vessels/self/environment/depth/belowTransducer`,
        )
      ).json()) as { $source: string };
      expect(current.$source).toBe("preferred.XX");
      const uploads = await node.collect(1);
      expect(
        uploads.flatMap((u) => u.features.map((f) => f.properties.depth)),
      ).toEqual([selected ? 3 : 90]);
      expect(
        uploads.flatMap((u) =>
          u.features.map((f) => f.geometry.coordinates.slice(0, 2)),
        ),
      ).toEqual([selected ? [10, 20] : [1, 2]]);
    },
  );
});
