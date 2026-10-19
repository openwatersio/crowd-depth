// Tide levels from the Slackwater engine, the predictor signalk-tides runs, for the
// grid's tide reduction (src/grid/tide.py).
//
//   node predict.mjs stations   one JSON line per tide station
//   node predict.mjs version    the engine and station database versions, as one JSON line
//   node predict.mjs levels     for each JSON line {station, start, end, step} on stdin
//                               (epoch seconds), a line [station, [[time, level], ...]]
//                               above the station's chart datum, start and end included
import { readFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { stations } from "@slackwater/database";
import { findStation } from "slackwater";

if (process.argv[2] === "stations") {
  for (const s of stations) {
    if (s.kind !== "tide") continue;
    const row = {
      id: s.id,
      lon: s.longitude,
      lat: s.latitude,
      chart_datum: s.chart_datum,
      has_datums: s.datums?.[s.chart_datum] != null,
      diurnal_range: (s.datums?.MHHW ?? NaN) - (s.datums?.MLLW ?? NaN),
      commercial_use: s.license?.commercial_use === true,
      license: s.license?.type ?? null,
      attribution: s.attribution ?? null,
      // A station with no quality record is accepted, as the database itself treats it.
      accepted: s.quality?.accepted !== false,
    };
    console.log(JSON.stringify(row));
  }
} else if (process.argv[2] === "version") {
  const version = (name) =>
    JSON.parse(readFileSync(new URL(`./node_modules/${name}/package.json`, import.meta.url))).version;
  const names = ["slackwater", "@slackwater/engine", "@slackwater/database"];
  console.log(JSON.stringify(names.map((n) => `${n}@${version(n)}`).join(" ")));
} else if (process.argv[2] === "levels") {
  for await (const line of createInterface({ input: process.stdin })) {
    const { station, start, end, step } = JSON.parse(line);
    // A station the engine can't predict gives an empty series: that day goes without.
    let series = [];
    try {
      const { timeline } = findStation(station).getTimelinePrediction({
        start: new Date(start * 1000),
        end: new Date(end * 1000),
        timeFidelity: step,
      });
      series = timeline.map((p) => [p.time.getTime() / 1000, p.level]);
    } catch (error) {
      console.error(`${station}: ${error.message}`);
    }
    console.log(JSON.stringify([station, series]));
  }
} else {
  console.error("usage: node predict.mjs stations|levels");
  process.exit(2);
}
