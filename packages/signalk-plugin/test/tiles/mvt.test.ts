import { expect, test } from "vitest";
import { VectorTile } from "@mapbox/vector-tile";
import { PbfReader as Pbf } from "pbf";
import { encodeTile } from "../../src/tiles/mvt.js";

test("a polygon simplified to nothing takes its holes with it", () => {
  const square = (x: number, y: number, s: number) =>
    [
      [x, y],
      [x + s, y],
      [x + s, y + s],
      [x, y + s],
      [x, y],
    ] as [number, number][];
  const tile = new VectorTile(
    new Pbf(
      encodeTile({
        DEPARE: [
          {
            type: "Polygon",
            polygons: [
              [square(0, 0, 100), square(10, 10, 20)],
              // Its outer ring a line, its hole still a square.
              [
                [
                  [200, 0],
                  [300, 0],
                  [200, 0],
                ],
                square(210, 10, 20),
              ],
            ],
            properties: {},
          },
        ],
      }),
    ),
  );
  const rings = tile.layers.DEPARE.feature(0).loadGeometry();
  expect(rings.map((r) => r[0].x)).toEqual([0, 10]);
});
