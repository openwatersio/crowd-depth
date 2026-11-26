// A stand-in for a history plugin such as signalk-questdb: it answers every
// query with the soundings the test hands it in E2E_HISTORY, stored exactly as
// Signal K received them (depth below the transducer, raw antenna position, heading).
module.exports = (app) => ({
  id: "e2e-history-provider",
  name: "E2E history provider",
  schema: () => ({}),
  start() {
    const rows = JSON.parse(process.env.E2E_HISTORY ?? "[]");
    const inRange = (from, to) =>
      rows.filter((r) => {
        const t = Date.parse(r.time);
        return t >= Date.parse(from) && t < Date.parse(to);
      });
    // One row per resolution bucket, stamped with its first sounding rather
    // than the bucket start: enough for the plugin, which finds its reporting
    // windows by asking for 6 h buckets.
    const bucketed = (rows, resolution) => {
      const seen = new Set();
      return rows.filter((r) => {
        const bucket = Math.floor(Date.parse(r.time) / (resolution * 1000));
        if (seen.has(bucket)) return false;
        seen.add(bucket);
        return true;
      });
    };
    app.registerHistoryApiProvider({
      async getValues(query) {
        const from = query.from.toString();
        const to = query.to.toString();
        return {
          context: "vessels.self",
          range: { from, to },
          values: query.pathSpecs.map((p) => ({
            path: p.path,
            $source: "e2e",
            method: p.aggregate,
          })),
          data: bucketed(inRange(from, to), query.resolution ?? 1).map((r) => [
            r.time,
            ...query.pathSpecs.map((p) =>
              p.path === "navigation.position"
                ? [r.longitude, r.latitude]
                : p.path === "environment.depth.belowTransducer"
                  ? r.depth
                  : p.path === "navigation.headingTrue"
                    ? r.heading
                    : null,
            ),
          ]),
        };
      },
      async getContexts() {
        return ["vessels.self"];
      },
      async getPaths() {
        return [
          "navigation.position",
          "environment.depth.belowTransducer",
          "navigation.headingTrue",
        ];
      },
    });
  },
  stop() {},
});
