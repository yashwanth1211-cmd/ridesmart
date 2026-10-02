/*
  ============================================================================
  RideSmart - console configuration
  ============================================================================

  The app is the video-based console (see public/ui.mp4). There is no 3D scene,
  so the crowd/map/journey defaults below are the only shared configuration the
  UI needs.
*/

// ---------------------------------------------------------------------------
// Crowd bands
// ---------------------------------------------------------------------------

/**
 * Keyed by the adapter's internal `low` | `medium` | `high`.
 *
 * The wire format is NOT these keys. tests_docs/api_contract.yaml specifies
 * `crowd_level` as an enum of "low" | "med" | "high" - note `med`, not `medium`.
 * src/lib/api.js normalizeCrowd() collapses the wire value (and the
 * "MEDIUM"/"medium" spellings from the two earlier backends) into these keys
 * before anything renders, because looking up "MEDIUM" in a table keyed
 * "medium" would fall through to the default and report a packed bus as empty.
 *
 * `riders`/`capacity` are only fallbacks for when the API omits the numbers.
 */
export const CROWD_LEVELS = {
  low: { label: 'Low', color: '#6bbd8b', ring: 'rgba(107,189,139,0.5)', riders: 12, capacity: 52 },
  medium: { label: 'Medium', color: '#d8ad5c', ring: 'rgba(216,173,92,0.5)', riders: 33, capacity: 52 },
  high: { label: 'High', color: '#e28573', ring: 'rgba(226,133,115,0.5)', riders: 49, capacity: 52 },
}

/**
 * Band edges from the contract, mirrored here so the UI can draw a threshold
 * marker on the occupancy bar. crowd_level_for() in
 * simulation_ml/db/models.py uses the same numbers.
 */
export const CROWD_THRESHOLDS = { low: 0.4, high: 0.75 }

// ---------------------------------------------------------------------------
// Map defaults
// ---------------------------------------------------------------------------

/**
 * Seed data is a real Bengaluru corridor (~12.97N, 77.59E) - see
 * simulation_ml/seed/seed.py - so the map opens on the city the buses are
 * actually driving through rather than on [0, 0] in the ocean.
 */
export const MAP_DEFAULTS = {
  center: [12.9745, 77.5946],
  zoom: 12.4,
  minZoom: 10,
  maxZoom: 18,
}

/**
 * Tile source. The backend's .env.example exposes VITE_MAP_TILE_URL and says
 * "Leave blank to use the free OpenStreetMap raster tiles. Set only if you have
 * a key." MapLibre has no built-in style, so a raster-only style object is
 * assembled here rather than pulling in a remote style JSON.
 */
export const MAP_STYLE = {
  version: 8,
  sources: {
    osm: {
      type: 'raster',
      tiles: import.meta.env?.VITE_MAP_TILE_URL
        ? [import.meta.env.VITE_MAP_TILE_URL]
        : ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'],
      tileSize: 256,
      attribution: '&copy; OpenStreetMap contributors',
      maxzoom: 19,
    },
  },
  layers: [{ id: 'osm', type: 'raster', source: 'osm' }],
}

/** Journey planned on first load, matching the seed's deliberate 21A vs 7B contrast. */
export const DEFAULT_JOURNEY = { from: 'STOP_COLLEGE', to: 'STOP_RAILWAY' }