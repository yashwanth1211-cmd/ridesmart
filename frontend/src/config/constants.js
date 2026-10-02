/*
  ============================================================================
  RideSmart - cinematic boarding scene configuration
  ============================================================================

  THIS IS THE ONLY FILE YOU NEED TO TOUCH when you swap the procedural bus
  for your real model, or when the camera path needs re-aiming.

  Coordinate system (three.js default, right-handed, Y up):
    +X  = the RIGHT of the screen. The bus's passenger/door side is +X.
    +Y  = up.
    +Z  = the direction the bus travels.

  The bus drives from TRAVEL.startZ up to TRAVEL.stopZ (a positive delta),
  so it approaches the camera from far down the road and decelerates into the
  stop at z = 0.

  Bus orientation: forward = +Z, which makes the bus's LEFT side +X. India is
  left-hand traffic, so passenger doors belong on +X. That is where the camera
  ends up. If your model has its doors on -X, flip DOOR.side to -1.
*/

// ---------------------------------------------------------------------------
// Global state machine
// ---------------------------------------------------------------------------

export const APP_STATE = {
  LOADING: 'LOADING',
  ARRIVING: 'ARRIVING',
  STOPPED: 'STOPPED',
  ENTERING: 'ENTERING',
  DASHBOARD: 'DASHBOARD',
}

/** States in which the DOM dashboard should be mounted and interactive. */
export const INTERACTIVE_STATES = [APP_STATE.DASHBOARD]

// ---------------------------------------------------------------------------
// Model + procedural fallback
// ---------------------------------------------------------------------------

export const MODEL = {
  /** Drop bus.glb into public/models/ and it is picked up automatically. */
  url: '/models/bus.glb',

  /**
   * Node names to look for inside the .glb. Anything that is not found is
   * simply skipped, so a partial model still renders.
   *   door  -> hinged panel(s) that swing open on the passenger side
   *   wheel -> steering/spinning wheels (anything you want to roll)
   *   NOTE: three.js exposes glTF node names on `object.name`, but
   *   `primitive.name` (the mesh) is often more reliable. Both are checked.
   */
  doorNodes: ['door', 'door_l', 'door_r', 'door_left', 'door_right', 'Door', 'DoorL', 'DoorR'],
  wheelNodes: ['wheel', 'wheel_fl', 'wheel_fr', 'wheel_rl', 'wheel_rr', 'Wheel'],

  /** If the model faces -Z instead of +Z, set true and BUS_FORWARD_OFFSET flips. */
  facesPositiveZ: true,

  /**
   * GLB door handling. The door node's own rotation is tweened, so its origin
   * must sit on the hinge for the swing to look right. If your door swings
   * from the middle or spins the wrong way, either re-origin the node on the
   * hinge in Blender, or change `doorAxis` to 'x' / 'z'.
   */
  doorAxis: 'y',
  doorOpenDelta: -1.85,
}

// ---------------------------------------------------------------------------
// Bus dimensions - used for BOTH the procedural proxy and the camera maths.
// Re-measure these against your real .glb (a city bus is ~11 x 2.5 x 3.1 m).
// ---------------------------------------------------------------------------

export const BUS = {
  length: 11,
  width: 2.5,
  height: 3.1,
  /** Deck height above the road surface. Camera eye height sits ~1.05 above this. */
  floorY: 0.55,
  roofY: 3.05,
  halfWidth: 1.25,
  halfLength: 5.5,
  wheelRadius: 0.52,

  /** Axle Z positions. Six wheels: one front axle, two rear axles. */
  axles: [3.9, -2.6, -3.9],
  wheelTrack: 1.15,

  DOOR: {
    /** +1 = passenger side on +X. Flip to -1 if your model's doors face -X. */
    side: 1,
    /** Door opening centre along Z, and how far it spans. */
    centerZ: 1.95,
    width: 1.9,
    height: 2.1,
    /** Swing angle in radians once fully open (roughly 105 degrees). */
    openAngle: -1.85,
    /** Hinge position relative to the door centre. */
    hingeOffset: 0.95,
  },

  /** Where the driver sits (India = right hand side = -X). Used for the interior set dressing. */
  driverX: -0.72,
}

/** Eye height the camera settles at once inside the saloon. */
export const CAMERA_EYE_Y = BUS.floorY + 1.05

// ---------------------------------------------------------------------------
// Travel - the ARRIVING phase
// ---------------------------------------------------------------------------

export const TRAVEL = {
  startZ: -70,
  stopZ: 0,
  /** Seconds of bus driving. */
  duration: 7.5,
  /** Settle pause (brake hiss, suspension bounce) before the door opens. */
  settleDuration: 0.55,
  /** Door swing duration. */
  doorDuration: 0.95,
}

// ---------------------------------------------------------------------------
// Camera path - THE MAIN THING TO RE-AIM
// ---------------------------------------------------------------------------

export const CAMERA = {
  /**
   * MUST be small. At the default 0.1 the interior walls clip straight through
   * the lens the moment the camera crosses the doorway. 0.03 costs almost
   * nothing here because the far plane is 400.
   */
  near: 0.03,
  far: 400,
  fov: 42,

  /** Seconds for the whole approach-and-enter move. */
  journeyDuration: 7.2,
  /** Delay after the door finishes opening before the camera starts moving. */
  startDelay: 0.35,

  /**
   * Position waypoints, sampled along a CatmullRomCurve3.
   *   0. exterior three-quarter, bus approaching from down the road
   *   1. drifting in, still exterior
   *   2. closing on the door
   *   3. outside the doorway, framing the open door
   *   4. crossing the threshold
   *   5. inside, aisle visible
   *   6. settled - standing in the doorway looking forward at the dash
   *
   * ADJUSTMENT GUIDE (once your real .glb is in):
   *   - If you stop too far short of the bus, decrease every X.
   *   - If the camera clips the door frame, decrease the X of waypoints 3-4.
   *   - If the final shot misses the dashboard, edit LOOKAT[6] to point at the
   *     dash mesh's world position (log it once with console.log).
   *   - If the bus faces -Z, negate every Z in BOTH arrays.
   */
  WAYPOINTS: [
    [18, 6.5, 14],
    [12.5, 4.2, 10.5],
    [6.5, 2.6, 6.2],
    [2.9, 2.0, 3.6],
    [1.35, 1.66, 1.95],
    [0.62, 1.6, 1.35],
    [0.45, 1.6, 0.4],
  ],

  /**
   * Matched look-at targets, one per waypoint, also on a CatmullRomCurve3 so
   * the camera pans independently of how it dollies. Keeping the count equal
   * to WAYPOINTS matters - the two curves are sampled with the same t.
   */
  LOOKAT: [
    [0, 2.4, 2],
    [0, 2.3, 1],
    [0.6, 1.9, 1.6],
    [1.25, 1.62, 2.0],
    [0.9, 1.5, 3.4],
    [0.1, 1.42, 5.0],
    [-0.35, 1.3, 5.4],
  ],

  /**
   * Catmull-Rom tension. Lower = looser, more overshoot. 0.5 is centripetal-
   * looking and safe for this path; 0 = tight and polyline-like.
   */
  curveTension: 0.5,
  curveType: 'catmullrom',
}

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// Environment - golden hour
// ---------------------------------------------------------------------------

export const BACKDROP = {
  /**
   * Your cleaned reference photo. Copied to public/textures/transport.jpg.
   * The source is PORTRAIT (736 x 1308), so repeat.y crops a horizontal band
   * out of the middle rather than stretching the whole tall image.
   *
   * If you re-export a landscape version, set repeat.y to 1.
   */
  texture: '/textures/transport.jpg',
  radius: 96,
  height: 78,
  /** Arc of the cylinder the photo wraps around (radians). Wider = flatter. */
  thetaLength: 2.6,
  position: [0, 20, -8],
  /** UV window into the photo: x repeats around the arc, y crops the height. */
  repeat: [1, 0.46],
  offset: [0, 0.3],
  color: '#ffd9b0',
  /** Pushes the backdrop warm so the 3D bus sits in the same light. */
  tint: 0.35,
}

export const LIGHTING = {
  /** Golden hour key light. */
  sun: {
    color: '#ffb067',
    intensity: 3.2,
    position: [-26, 15, 22],
  },
  /** Sky/ground bounce so shadowed sides are not black. */
  hemisphere: { sky: '#ffd9a8', ground: '#4a3b2a', intensity: 0.85 },
  ambient: { color: '#ffcf9e', intensity: 0.35 },
  /** Cool counter-light from the opposite side to separate the bus silhouette. */
  rim: { color: '#8fb4ff', intensity: 1.1, position: [18, 9, -14] },
  shadow: {
    mapSize: 2048,
    camera: { left: -34, right: 34, top: 26, bottom: -12, near: 1, far: 90 },
    bias: -0.0006,
    normalBias: 0.02,
  },
  fog: { color: '#e6b489', near: 26, far: 150 },
}

export const ROAD = {
  /** Asphalt slab. Width spans the stop, length runs the travel direction. */
  width: 22,
  length: 260,
  color: '#3a3a3c',
  /** Sidewalk / kerb on the passenger side (+X). */
  kerb: { height: 0.22, width: 3.4, color: '#b9ada0' },
  /** Lane markings. */
  lanes: { color: '#f2e6c8', width: 0.16, dash: [3.2, 4.6] },
}

// ---------------------------------------------------------------------------
// Renderer / performance
// ---------------------------------------------------------------------------

export const RENDER = {
  /** Capped once the dashboard is live - the camera is static by then. */
  dashboardDpr: [0.75, 1],
  activeDpr: [1, 1.75],
  shadows: true,
  /**
   * THREE.PCFShadowMap. PCFSoftShadowMap was removed in three 0.186 and falls
   * back to this anyway, so name it directly rather than triggering a warning.
   */
  shadowType: 'PCFShadowMap',
  antialias: true,
  /** Frame the boarding phase runs at before it settles. */
  fps: 60,
}

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
