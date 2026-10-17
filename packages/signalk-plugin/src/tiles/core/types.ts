// Adapted from signalk-livedepth-plugin (MIT); see THIRD_PARTY_NOTICES.md.
/**
 * A depth sounding at a position, depth in metres (canonical Signal K). The
 * shared input to {@link createTileAccumulator} on both the server plugin and
 * the chart client.
 */
export interface Sounding {
  lon: number;
  lat: number;
  depth: number;
}
