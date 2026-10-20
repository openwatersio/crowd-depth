// A Mapbox Vector Tile 2.1 encoder for the few feature kinds the live layer writes.
// Coordinates are integers in the tile's extent, y down.

export const EXTENT = 4096;

export type Point = [number, number];
export type Value = string | number;

export type Feature =
  | { type: "Point"; points: Point[]; properties: Record<string, Value> }
  | { type: "LineString"; lines: Point[][]; properties: Record<string, Value> }
  /** Rings of each polygon, its outer ring first; winding is fixed on encoding. */
  | {
      type: "Polygon";
      polygons: Point[][][];
      properties: Record<string, Value>;
    };

class Writer {
  bytes: number[] = [];
  varint(n: number) {
    while (n > 0x7f) {
      this.bytes.push((n & 0x7f) | 0x80);
      n = Math.floor(n / 128);
    }
    this.bytes.push(n);
  }
  key(field: number, wire: number) {
    this.varint((field << 3) | wire);
  }
  message(field: number, write: (w: Writer) => void) {
    const inner = new Writer();
    write(inner);
    this.key(field, 2);
    this.varint(inner.bytes.length);
    for (const b of inner.bytes) this.bytes.push(b);
  }
  string(field: number, s: string) {
    const b = Buffer.from(s, "utf8");
    this.key(field, 2);
    this.varint(b.length);
    for (const x of b) this.bytes.push(x);
  }
  packed(field: number, values: number[]) {
    this.message(field, (w) => values.forEach((v) => w.varint(v)));
  }
}

const zigzag = (n: number) => (n << 1) ^ (n >> 31);
const command = (id: number, count: number) => (id & 0x7) | (count << 3);

/** Twice the signed area in tile coordinates; positive is clockwise on screen, as MVT
 * wants an outer ring. */
function area(ring: Point[]): number {
  let a = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    a += (ring[j][0] - ring[i][0]) * (ring[j][1] + ring[i][1]);
  }
  return a;
}

function geometry(feature: Feature): { type: number; commands: number[] } {
  const out: number[] = [];
  let cx = 0;
  let cy = 0;
  const move = ([x, y]: Point) => {
    out.push(zigzag(x - cx), zigzag(y - cy));
    cx = x;
    cy = y;
  };
  const path = (points: Point[], close: boolean) => {
    out.push(command(1, 1));
    move(points[0]);
    out.push(command(2, points.length - 1));
    points.slice(1).forEach(move);
    if (close) out.push(command(7, 1));
  };
  if (feature.type === "Point") {
    out.push(command(1, feature.points.length));
    feature.points.forEach(move);
    return { type: 1, commands: out };
  }
  if (feature.type === "LineString") {
    for (const line of feature.lines) if (line.length > 1) path(line, false);
    return { type: 2, commands: out };
  }
  for (const rings of feature.polygons) {
    rings.forEach((ring, i) => {
      // A closed ring repeats its first point, which MVT leaves to ClosePath.
      const open =
        ring.length > 1 &&
        ring[0][0] === ring[ring.length - 1][0] &&
        ring[0][1] === ring[ring.length - 1][1]
          ? ring.slice(0, -1)
          : ring;
      if (open.length < 3) return;
      const a = area(open);
      if (a === 0) return;
      path((i === 0) === a > 0 ? open : [...open].reverse(), true);
    });
  }
  return { type: 3, commands: out };
}

/** Encode layers of features as one tile. */
export function encodeTile(layers: Record<string, Feature[]>): Buffer {
  const tile = new Writer();
  for (const [name, features] of Object.entries(layers)) {
    if (features.length === 0) continue;
    const keys = new Map<string, number>();
    const values = new Map<string, { index: number; value: Value }>();
    const index = <T>(
      map: Map<string, T>,
      k: string,
      make: (i: number) => T,
    ) => {
      if (!map.has(k)) map.set(k, make(map.size));
      return map.get(k)!;
    };
    const encoded = features.map((f) => {
      const tags: number[] = [];
      for (const [k, v] of Object.entries(f.properties)) {
        if (v === undefined || v === null) continue;
        tags.push(
          index(keys, k, (i) => i),
          index(values, `${typeof v}:${v}`, (i) => ({ index: i, value: v }))
            .index,
        );
      }
      return { tags, ...geometry(f) };
    });
    tile.message(3, (layer) => {
      layer.varint((15 << 3) | 0);
      layer.varint(2);
      layer.string(1, name);
      for (const f of encoded) {
        if (f.commands.length === 0) continue;
        layer.message(2, (w) => {
          w.packed(2, f.tags);
          w.key(3, 0);
          w.varint(f.type);
          w.packed(4, f.commands);
        });
      }
      for (const k of keys.keys()) layer.string(3, k);
      for (const { value } of values.values()) {
        layer.message(4, (w) => {
          if (typeof value === "string") w.string(1, value);
          else if (Number.isInteger(value) && value >= 0) {
            w.key(5, 0);
            w.varint(value);
          } else {
            // A double: wire type 1, 8 bytes little-endian.
            const b = Buffer.alloc(8);
            b.writeDoubleLE(value);
            w.key(3, 1);
            for (const x of b) w.bytes.push(x);
          }
        });
      }
      layer.key(5, 0);
      layer.varint(EXTENT);
    });
  }
  return Buffer.from(tile.bytes);
}
