/**
 * Adapter over the RideSmart FastAPI backend.
 *
 * ============================================================================
 * What this file is for
 * ============================================================================
 * The frontend is written against tests_docs/api_contract.yaml, which
 * tests_docs/docs/INTEGRATION_REVIEW.md calls the source of truth: "if the code
 * and this file disagree, that is a bug." This module is the single place where
 * the wire format is turned into the shape the components want, so no component
 * ever indexes into a raw API payload.
 *
 * It is deliberately TOLERANT. Five members built this backend in parallel and
 * the shapes drifted before the contract was settled. Four separate spellings of
 * the same idea are still in the history, and a hard-coded lookup silently
 * renders the wrong thing rather than throwing:
 *
 *   crowd level   "low" | "med" | "high"      <- contract, current app
 *                 "medium"                    <- Member 2's original
 *                 "LOW" | "MEDIUM" | "HIGH"   <- Member 1's original
 *   planner key   options[]                   <- contract
 *                 routes[]                    <- Member 1
 *                 candidates[]                <- Member 2
 *   coordinates   lat / lon                   <- contract
 *                 latitude / longitude        <- Member 1 and Member 2
 *
 * Feed "MEDIUM" into a lookup keyed by the contract's "med" and you get the
 * default - which is "Low". A full bus would be reported as nearly empty. Every
 * normaliser below therefore accepts all known spellings.
 *
 * ============================================================================
 * BACKEND CONTRACT (origin/sync-main-with-integration)
 * ============================================================================
 *   GET  /api/health              -> { status, database, time }
 *   GET  /api/routes              -> [{ id, code, name, direction, stop_count }]
 *   GET  /api/routes/{id}         -> Route & { stops: RouteStop[] }
 *   GET  /api/routes/{id}/stops   -> [{ seq, scheduled_offset_sec, stop }]
 *   GET  /api/stops               -> [{ id, code, name, lat, lon, accessible, kind }]
 *   POST /api/routes/plan         -> { from, to, generated_at, options[] }
 *   GET  /api/journey             -> { from, to, sort, generated_at,
 *                                      direct[], transfers[], message }
 *   GET  /api/buses/active        -> [BusPosition]     (poll fallback, ~2s)
 *   GET  /api/buses/{id}/location -> BusPosition
 *   GET  /api/trips/{id}/eta      -> [{ stop_id, stop_name, scheduled_min,
 *                                      predicted_min, delay_min }]
 *   PUT  /api/trips/{id}/crowd    -> CrowdEstimate     (the demo trigger)
 *   GET  /api/authority/dashboard -> AuthorityDashboard
 *   WS   /api/ws/buses            -> [BusPosition] pushed every ~2s
 *
 * The /api prefix is REAL - database/main.py mounts every router with
 * prefix="/api" - so the browser's /api/... path is forwarded unchanged.
 *
 * Errors are { detail, code } with HTTP 400 (unknown stop / no connection) or
 * 404 (missing route, trip or bus).
 *
 * TWO PLANNERS, DELIBERATELY
 * ==========================
 * POST /api/routes/plan returns ROUTES between two stops. GET /api/journey
 * returns BUSES between two stops. Both are wired up and the planner uses the
 * second one:
 *
 *   /routes/plan  route-level. Answering "what are my trade-offs?". Lists a
 *                 corridor once and lets you weigh it against another corridor.
 *   /journey      vehicle-level. Answering "which bus do I physically catch?".
 *                 Enforces direction per bus, withholds vehicles that have
 *                 already passed the boarding stop, and reports a specific
 *                 registration, arrival and crowd reading.
 *
 * The distinction matters because a route list cannot answer the second
 * question. It has no bus number, no crowd reading for one vehicle, and it
 * cannot tell a bus that is two minutes away from one that left ten minutes ago.
 * The plan endpoint is kept because the crowd trade-off across corridors is a
 * real product feature - it is just not what someone standing at a stop needs.
 */

/**
 * Base URL for the API.
 *
 * Empty by default, which makes every request same-origin and sends it through
 * the Vite dev proxy in vite.config.js. That sidesteps CORS entirely. Set
 * VITE_API_URL (the variable the backend's .env.example already defines) to
 * call the API cross-origin instead - the backend allows CORS from :5173.
 */
export const config = {
  apiBase: import.meta.env?.VITE_API_URL ?? '',
  pollIntervalMs: 5000,
  /** The contract says the WebSocket pushes roughly every 2s. */
  busPollIntervalMs: 2000,
  /** How long to wait on a reconnecting socket before falling back to polling. */
  wsGraceMs: 6000,
}

// ---------------------------------------------------------------------------
// Crowd
// ---------------------------------------------------------------------------

/** Every crowd spelling seen across the member branches, mapped to one key. */
const CROWD_ALIASES = {
  low: 'low',
  med: 'medium',
  medium: 'medium',
  high: 'high',
}

/**
 * Contract thresholds, from api_contract.yaml:
 *   low  = load / capacity < 0.4
 *   med  = 0.4 <= ratio < 0.75
 *   high = ratio >= 0.75
 *
 * The label is only trusted when the ratio is missing. When both are present
 * the ratio wins, because a "med" label computed against a stale capacity will
 * not match the occupancy actually on board.
 */
export function normalizeCrowd(level, { load, capacity, ratio } = {}) {
  const r =
    Number.isFinite(Number(ratio)) && ratio !== null
      ? Number(ratio)
      : Number.isFinite(Number(load)) &&
          Number.isFinite(Number(capacity)) &&
          Number(capacity) > 0
        ? Number(load) / Number(capacity)
        : null

  if (r !== null) {
    if (r < 0.4) return 'low'
    if (r < 0.75) return 'medium'
    return 'high'
  }

  if (typeof level === 'string') {
    const key = CROWD_ALIASES[level.trim().toLowerCase()]
    if (key) return key
  }

  return 'low'
}

/**
 * Minutes. The contract states minutes_are_integers: true, but a float from an
 * older branch must not render as "11.5 min", and a missing value must not
 * render as "0 min" - that reads as "the bus is here now".
 */
export function normalizeEta(value) {
  if (value === null || value === undefined || value === '') return null
  const n = Number(value)
  if (!Number.isFinite(n)) return null
  return Math.max(0, Math.round(n))
}

/** Signed delay. Negative means running early, which is worth showing. */
export function normalizeDelay(value) {
  if (value === null || value === undefined || value === '') return 0
  const n = Number(value)
  return Number.isFinite(n) ? Math.round(n) : 0
}

function num(value) {
  if (value === null || value === undefined || value === '') return null
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

function lat(entry) {
  return num(entry?.lat ?? entry?.latitude)
}

function lon(entry) {
  return num(entry?.lon ?? entry?.lng ?? entry?.longitude)
}

// ---------------------------------------------------------------------------
// Wire -> UI mappers. Every one of these tolerates the older spellings.
// ---------------------------------------------------------------------------

export function mapStop(entry) {
  return {
    id: entry.id ?? entry.stop_id,
    code: entry.code,
    name: entry.name,
    lat: lat(entry),
    lon: lon(entry),
    accessible: Boolean(entry.accessible),
    // 'transit' is a surveyed OSM bus stop/station; 'campus' is a landmark
    // anchor (Kingston Engineering College) where no bay was mapped. Default
    // to 'transit' so a payload from an older backend still reads correctly.
    kind: entry.kind === 'campus' ? 'campus' : 'transit',
  }
}

export function mapRoute(entry) {
  return {
    id: entry.id ?? entry.route_id,
    code: entry.code ?? entry.route_number,
    name: entry.name ?? `${entry.from} → ${entry.to}`,
    direction: entry.direction ?? null,
    stopCount: entry.stop_count ?? null,
  }
}

/** One entry of PlanOption.stops[] - minutes remaining to that stop. */
export function mapPlanStop(entry) {
  return {
    stopId: entry.stop_id,
    name: entry.name,
    etaMin: normalizeEta(entry.eta_min),
    accessible: Boolean(entry.accessible),
  }
}

/**
 * One candidate route. This is the object the whole product turns on, so the
 * normaliser is defensive: the seed data deliberately produces one fast-packed
 * and one slow-empty option, and a UI that misreads either one destroys the
 * entire point of the feature.
 */
export function mapOption(entry) {
  const load = num(entry.crowd_load ?? entry.passenger_count)
  const capacity = num(entry.capacity)

  return {
    id: `route-${entry.route_id ?? entry.code}`,
    routeId: entry.route_id,
    code: entry.code,
    name: entry.name ?? null,

    etaMin: normalizeEta(entry.eta_min ?? entry.eta_predicted_min ?? entry.eta_minutes),
    etaScheduledMin: normalizeEta(entry.eta_scheduled_min),
    delayMin: normalizeDelay(entry.delay_min),

    crowd: normalizeCrowd(entry.crowd_level ?? entry.crowd, {
      load,
      capacity,
      ratio: entry.crowd_ratio,
    }),
    load,
    capacity,
    /** 0..1, or null when the backend sent neither a ratio nor a capacity. */
    ratio: num(entry.crowd_ratio) ?? (capacity > 0 && load !== null ? load / capacity : null),

    wheelchair: Boolean(entry.wheelchair_accessible),
    lowFloor: Boolean(entry.low_floor),
    score: num(entry.score),
    stops: (entry.stops ?? []).map(mapPlanStop),

    /**
     * Optional model metadata. NULL unless the backend actually sends it.
     *
     * No endpoint in api_contract.yaml returns this today, and the adapter
     * deliberately does not synthesise a value when it is absent. A confidence
     * number invented client-side is worse than no number: a passenger makes a
     * decision to leave their stop based on it.
     *
     * Member 4 has now landed two predictors, and both return a `method` plus
     * a `validated` flag, so those spellings are handled alongside the
     * confidence/samples/version shape:
     *
     *   simulation_ml/eta_model.py  predict_eta()      -> method "segment_baseline"
     *   simulation_ml/eta_ml.py     predict_eta_ml()   -> method "experimental_random_forest",
     *                                                    validated: False
     *
     * The distinction matters. eta_ml.py trains a RandomForest on SYNTHETIC
     * data and says so in its own docstring and in the `validated: false` it
     * returns, so `validated` is honoured here and `trusted` is derived from
     * it. The UI uses that to mark an experimental figure instead of quietly
     * presenting it with the same authority as a contract-backed ETA.
     *
     * Note this is additive: no current field is required for it.
     */
    prediction: (() => {
      const method = entry.prediction_method ?? entry.method ?? entry.eta_method ?? null
      const confidence = num(entry.eta_confidence ?? entry.confidence ?? entry.eta_confidence_pct)
      const samples = num(entry.samples ?? entry.observed_samples)
      const version = entry.model_version ?? entry.version ?? null
      const etaSeconds = num(entry.eta_seconds ?? entry.prediction_eta_sec ?? entry.eta_predicted_sec)
      const arrivalTime = entry.arrival_time ?? entry.prediction_arrival ?? null
      const validated = entry.validated === undefined || entry.validated === null ? null : Boolean(entry.validated)

      // arrivalTime and validated are part of the presence test too. A
      // prediction that carries only an absolute arrival time is still a
      // prediction, and dropping it would make the field silently vanish
      // depending on which subset the backend happened to send.
      if (
        method === null &&
        confidence === null &&
        samples === null &&
        !version &&
        etaSeconds === null &&
        arrivalTime === null &&
        validated === null
      ) {
        return null
      }

      return {
        method,
        confidence,
        samples,
        version,
        etaSeconds,
        arrivalTime,
        validated,
        /*
          Trust is derived, not asserted. Three independent ways to end up
          untrusted, any one of which is enough:
            - the backend explicitly said validated: false
            - the method name advertises itself as experimental
            - there is a confidence claim but no sample count behind it
          Defaulting to trusted when nothing is known keeps a future, properly
          validated model usable without a code change.
        */
        trusted: validated !== false
          && !(typeof method === 'string' && /experimental|untrained|baseline_untuned/i.test(method))
          && !(confidence !== null && samples === null),
      }
    })(),
  }
}

export function mapPlan(payload) {
  // options[] is the contract; routes[] and candidates[] are the two branches
  // that predate it.
  const rows = payload?.options ?? payload?.routes ?? payload?.candidates ?? []

  return {
    origin: payload?.from ? mapStop(payload.from) : null,
    destination: payload?.to ? mapStop(payload.to) : null,
    generatedAt: payload?.generated_at ?? null,
    options: rows.map(mapOption).sort((a, b) => (a.etaMin ?? 0) - (b.etaMin ?? 0)),
  }
}

export function mapBusPosition(entry) {
  const load = num(entry.crowd_load)
  const capacity = num(entry.capacity)

  return {
    busId: entry.bus_id,
    tripId: entry.trip_id ?? null,
    routeId: entry.route_id ?? null,
    routeCode: entry.route_code ?? null,
    // Short reference, "Bus 4" - the label shown large. `reg` stays as the
    // smaller vehicle detail underneath it.
    name: entry.bus_name ?? null,
    reg: entry.bus_reg ?? null,
    lat: lat(entry),
    lon: lon(entry),
    heading: num(entry.heading) ?? 0,
    speedKmph: num(entry.speed_kmph) ?? num(entry.speed) ?? 0,
    nextStopName: entry.next_stop_name ?? null,
    crowd: normalizeCrowd(entry.crowd_level ?? entry.crowd, { load, capacity }),
    load,
    capacity,
    wheelchair: Boolean(entry.wheelchair_accessible),
    lowFloor: Boolean(entry.low_floor),
    ts: entry.ts ?? null,
  }
}

export function mapDashboardKpis(payload) {
  return {
    totalBuses: num(payload?.total_buses) ?? 0,
    activeBuses: num(payload?.active_buses) ?? 0,
    delayedBuses: num(payload?.delayed_buses) ?? 0,
    avgDelayMin: num(payload?.avg_delay_min),
    highDemandRoute: payload?.high_demand_route ?? null,
    crowdedRoute: payload?.crowded_route ?? null,
    routes: (payload?.routes ?? []).map((r) => ({
      routeId: r.route_id,
      code: r.code,
      activeTrips: num(r.active_trips) ?? 0,
      avgDelayMin: num(r.avg_delay_min),
      avgCrowdRatio: num(r.avg_crowd_ratio),
      demandScore: num(r.demand_score),
    })),
  }
}

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

/**
 * Turns a non-2xx response into a real Error.
 *
 * The contract defines failures as { detail, code }. Surfacing `detail` matters
 * here because the planner's 400 is user-actionable - "Unknown stop code
 * STOP_MARS" tells the user which picker is wrong, and a generic "request failed"
 * does not.
 */
async function request(path, { signal, method = 'GET', body } = {}) {
  const res = await fetch(`${config.apiBase}${path}`, {
    signal,
    method,
    headers: {
      Accept: 'application/json',
      ...(body ? { 'Content-Type': 'application/json' } : null),
    },
    ...(body ? { body: JSON.stringify(body) } : null),
  })

  if (!res.ok) {
    let detail = `Request failed (${res.status})`
    let code = null
    try {
      const payload = await res.json()
      if (payload?.detail) detail = String(payload.detail)
      if (payload?.code) code = String(payload.code)
    } catch {
      // Non-JSON error body; the status-based message is fine.
    }
    const error = new Error(detail)
    error.status = res.status
    error.code = code
    throw error
  }

  return res.json()
}

// ---------------------------------------------------------------------------
// Endpoints
// ---------------------------------------------------------------------------

export const getHealth = (options) => request('/api/health', options)

export const getStops = (options) => request('/api/stops', options).then((r) => r.map(mapStop))

export const getRoutes = (options) => request('/api/routes', options).then((r) => r.map(mapRoute))

export const getRouteStops = (routeId, options) =>
  request(`/api/routes/${routeId}/stops`, options).then((r) =>
    r.map((rs) => ({ seq: rs.seq, offsetSec: rs.scheduled_offset_sec, stop: mapStop(rs.stop) })),
  )

/**
 * The route's real road polyline from OSRM.
 *
 * Stop coordinates are not a route: adjacent stops can be kilometres apart with
 * a lake or a park between them, so a line through them is not drivable. The map
 * draws this instead, which is why the line on screen matches where the bus is.
 */
export const getRouteShape = (routeId, options) =>
  request(`/api/routes/${routeId}/shape`, options).then((r) => ({
    routeId: r.route_id,
    code: r.code,
    totalM: r.total_m,
    points: (r.points || []).map((p) => ({ lat: p.lat, lon: p.lon, cumM: p.cum_m })),
  }))


/**
 * The centrepiece. POST with a JSON body keyed by stop CODE - not a free-text
 * query, which is what the retired Member 1 backend took.
 *
 * accessibility_only filters out options with no wheelchair-accessible bus.
 */
export const planJourney = ({ from, to, accessibilityOnly = false }, options) =>
  request('/api/routes/plan', {
    ...options,
    method: 'POST',
    body: { from, to, accessibility_only: accessibilityOnly },
  }).then(mapPlan)

/** One stop on the requested slice of a route, in travel order. */
export function mapJourneyStop(entry) {
  return {
    stopId: entry.stop_id,
    code: entry.stop_code,
    name: entry.name,
    seq: entry.seq,
    /** Minutes from now until the bus reaches this stop. */
    etaMin: normalizeEta(entry.eta_min),
    accessible: Boolean(entry.accessible),
  }
}

/**
 * One BUS that can take the passenger from `from` to `to`.
 *
 * Two arrival times arrive from the backend and they are NOT interchangeable,
 * which is the whole reason this mapper exists rather than reusing mapOption:
 *
 *   arrivesInMin  until the bus reaches the BOARDING point. What a passenger
 *                 standing at the stop is waiting on, so what the ranking uses.
 *   etaMin        until it reaches the DESTINATION. What the headline number
 *                 should show, because that is what "you'll get there in N
 *                 minutes" means to someone choosing between two buses.
 *
 * Collapsing them produced a panel reading "arriving in 0 min" for a bus sitting
 * at their stop while it was fifty minutes from where they were going.
 */
export function mapJourneyOption(entry) {
  const load = num(entry.crowd_load)
  const capacity = num(entry.capacity)
  const waitMin = normalizeEta(entry.arrives_in_min) ?? 0

  /*
    Whether there is a real vehicle behind this row.

    The backend labels it, but the signal is corroborated rather than trusted
    alone: a bus id or a passenger count are both evidence that a vehicle exists,
    and the backend always sends at least one of them for a live entry. Falling
    back to the label alone would be worse, since a mislabelled scheduled entry
    would then be shown as a running bus.

    Everything below branches on it, because the normalisers are built for a live
    bus and applying them to a timetable entry invents readings:

      normalizeDelay(null)  -> 0, and a card reading "0 min late" on a bus that
                               has not departed is a fabricated reassurance.
      normalizeCrowd(null)  -> 'low', and an "empty" bar for a bus still at the
                               depot invents the one number the passenger is most
                               likely to act on.

    So a scheduled entry gets null for both, which the UI already renders as
    "scheduled" and "not running yet" rather than as a figure.
  */
  const isLive = entry.kind === 'live' || entry.bus_id != null || entry.crowd_load != null

  return {
    // A live bus is identified by its TRIP, not its route: two buses on the same
    // corridor are two different options, and keying on the route would collapse
    // them and make one unselectable.
    id: entry.option_id,
    routeId: entry.route_id,
    code: entry.route_code,
    routeNumber: entry.route_number,
    name: entry.route_name,
    direction: entry.direction,

    etaMin: normalizeEta(entry.eta_min) ?? waitMin,
    arrivesInMin: waitMin,
    journeyMin: normalizeEta(entry.journey_min),
    delayMin: isLive ? normalizeDelay(entry.delay_min) : null,

    kind: isLive ? 'live' : 'scheduled',
    busId: entry.bus_id ?? null,
    busName: entry.bus_name ?? null,
    busReg: entry.bus_reg ?? null,
    busType: entry.bus_type ?? null,

    crowd: isLive
      ? normalizeCrowd(entry.crowd_level ?? entry.crowd, {
          load,
          capacity,
          ratio: entry.crowd_ratio,
        })
      : null,
    load: isLive ? load : null,
    capacity,
    ratio: isLive
      ? (num(entry.crowd_ratio) ?? (capacity > 0 && load !== null ? load / capacity : null))
      : null,

    wheelchair: Boolean(entry.wheelchair_accessible),
    lowFloor: Boolean(entry.low_floor),
    score: num(entry.score),
    stops: (entry.stops ?? []).map(mapJourneyStop),

    departsAt: entry.departs_at ?? null,
    scheduledArrival: entry.scheduled_arrival ?? null,
    predictedArrival: entry.predicted_arrival ?? null,
  }
}

/** One vehicle in a multi-leg journey. */
export function mapJourneyLeg(entry) {
  return {
    routeId: entry.route_id,
    code: entry.route_code,
    routeNumber: entry.route_number,
    name: entry.route_name,
    direction: entry.direction,
    busId: entry.bus_id,
    // Not `name` - that key is already the ROUTE name in this mapper.
    busName: entry.bus_name ?? null,
    busReg: entry.bus_reg,
    busType: entry.bus_type,
    arrivesInMin: normalizeEta(entry.arrives_in_min) ?? 0,
    crowd: normalizeCrowd(entry.crowd_level, { load: num(entry.crowd_load), capacity: num(entry.capacity) }),
    load: num(entry.crowd_load),
    capacity: num(entry.capacity),
    wheelchair: Boolean(entry.wheelchair_accessible),
    stops: (entry.stops ?? []).map(mapJourneyStop),
  }
}

/**
 * The whole GET /api/journey response, mapped to UI shape.
 *
 * `message` is preserved verbatim rather than replaced with a generic string.
 * The backend distinguishes "same stop", "nothing connects these" and "no direct
 * bus, here is a transfer", and those call for different words on screen - a
 * swap suggestion is useful for one of them and nonsense for the other.
 */
export function mapJourney(payload) {
  const direct = (payload?.direct ?? []).map(mapJourneyOption)
  const sort = payload?.sort === 'crowd' ? 'crowd' : 'eta'

  return {
    origin: payload?.from ? mapStop(payload.from) : null,
    destination: payload?.to ? mapStop(payload.to) : null,
    generatedAt: payload?.generated_at ?? null,
    sort,
    options: direct.sort((a, b) => (a.score ?? a.etaMin ?? 0) - (b.score ?? b.etaMin ?? 0)),
    // A leg list is read twice, so it is normalised once. `(t.legs ?? [])` in the
    // id but not the body used to throw on a transfer that somehow arrived
    // without legs, taking the whole panel down rather than dropping one row.
    transfers: (payload?.transfers ?? []).map((t) => {
      const rawLegs = t.legs ?? []
      return {
        id: `transfer-${rawLegs.map((l) => l?.route_id ?? '?').join('-')}-${t.total_min ?? 0}`,
        transfers: t.transfers ?? 1,
        legs: rawLegs.map(mapJourneyLeg),
        via: t.transfer_stop ? mapStop(t.transfer_stop) : null,
        waitMin: t.wait_min ?? 0,
        totalMin: t.total_min ?? 0,
        routeId: rawLegs[0]?.route_id ?? null,
        // `join` on an empty list yields '', which would render as a blank chip
        // rather than the fallback label.
        code: rawLegs.length
          ? rawLegs.map((l) => l?.route_code).filter(Boolean).join(' + ')
          : '1 transfer',
      }
    }),
    message: payload?.message ?? null,
  }
}

/**
 * GET /api/journey - the direction-aware planner.
 *
 * Takes stop IDs rather than codes because the pickers already hold the mapped
 * stop objects, and an id cannot be typo'd into a different stop the way a
 * string can.
 */
export const getJourney = ({ fromStopId, toStopId, sort = 'eta', accessibilityOnly = false, includeTransfers = true }, options) => {
  const params = new URLSearchParams({
    from_stop_id: String(fromStopId),
    to_stop_id: String(toStopId),
    sort,
  })
  if (accessibilityOnly) params.set('accessibility_only', 'true')
  if (!includeTransfers) params.set('include_transfers', 'false')

  return request(`/api/journey?${params.toString()}`, options).then(mapJourney)
}

/**
 * Polling fallback for the WebSocket.
 *
 * routeId is optional and additive. Passing it scopes the response to one
 * route, which is what the live map wants; omitting it returns the whole fleet
 * and is still what the fleet-wide panels use.
 */
export const getActiveBuses = (routeId, options) =>
  request(`/api/buses/active${routeId ? `?route_id=${encodeURIComponent(routeId)}` : ''}`, options).then((r) =>
    r.map(mapBusPosition),
  )

export const getTripEtas = (tripId, options) =>
  request(`/api/trips/${tripId}/eta`, options).then((r) =>
    r.map((s) => ({
      stopId: s.stop_id,
      stopName: s.stop_name,
      scheduledMin: normalizeEta(s.scheduled_min),
      predictedMin: normalizeEta(s.predicted_min),
      delayMin: normalizeDelay(s.delay_min),
    })),
  )

/**
 * Manual crowd override - the documented demo trigger: empty a bus, re-plan the
 * same journey, and watch the ranking change.
 */
export const setTripCrowd = ({ tripId, load, capacity, stopId }, options) =>
  request(`/api/trips/${tripId}/crowd`, {
    ...options,
    method: 'PUT',
    body: {
      load,
      ...(capacity ? { capacity } : null),
      ...(stopId ? { stop_id: stopId } : null),
    },
  }).then((r) => ({
    tripId: r.trip_id,
    stopId: r.stop_id,
    load: r.load,
    capacity: r.capacity,
    ratio: num(r.ratio),
    level: normalizeCrowd(r.level, { load: r.load, capacity: r.capacity, ratio: r.ratio }),
  }))

export const getAuthorityDashboard = (options) =>
  request('/api/authority/dashboard', options).then(mapDashboardKpis)

/**
 * WebSocket URL for the live feed, derived from the same base the REST calls
 * use. Returns null when the app is served over plain http, because the browser
 * blocks mixed-content ws:// from an https page.
 */
export function busSocketUrl(routeId) {
  if (typeof window === 'undefined') return null

  // routeId scopes the subscription server-side. The socket is reopened
  // whenever the selection changes (see useLiveBuses), so the map never
  // receives vehicles belonging to a route it is not showing.
  const scope = routeId != null ? `?route_id=${encodeURIComponent(routeId)}` : ''

  const explicit = import.meta.env?.VITE_WS_URL
  if (explicit) return explicit + scope

  const base = config.apiBase
  if (base) {
    const url = new URL(base)
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
    url.pathname = `${url.pathname.replace(/\/$/, '')}/api/ws/buses`
    return url.toString() + scope
  }

  const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
  return `${proto}//${window.location.host}/api/ws/buses${scope}`
}

// ---------------------------------------------------------------------------
// Offline fallback
// ---------------------------------------------------------------------------

/**
 * The seed data's headline story, hardcoded so the planner still demonstrates
 * the speed-vs-crowd trade-off with the API stopped. These numbers are copied
 * from simulation_ml/seed/seed.py and are labelled as demo data in the UI.
 *
 * `score` mirrors planner.py: W_ETA * eta_min + W_CROWD * (ratio * 100), with
 * W_ETA = 1.0, W_CROWD = 0.6 and LOWER being better. V2 (41 min, empty) scores
 * 55.4 and beats V1 (24 min, packed) at 66.0, which is the whole point: crowd
 * flips the ranking when the two are close enough in time.
 */
/**
 * The offline fallback, shaped like a GET /api/journey response.
 *
 * Deliberately not a wrapper around DEMO_PLAN. The two endpoints answer different
 * questions - DEMO_PLAN is a list of ROUTES to compare, this is a list of BUSES
 * to catch - so the numbers here are per-vehicle (registration, arrival at the
 * boarding point, arrival at the destination, direction) and DEMO_PLAN's are
 * route-wide. Reusing it would have meant fabricating fields the planner never
 * emits and then rendering them as if they were live.
 *
 * The two arrival times per bus are the ones the endpoint reports:
 * arrivesInMin is the wait at the boarding stop, etaMin is time to destination.
 */
export const DEMO_JOURNEY = {
  origin: {
    id: 1,
    code: 'STOP_VIT',
    name: 'VIT',
    lat: 12.96814,
    lon: 79.15625,
  },
  destination: {
    id: 2,
    code: 'STOP_VELLORE_OLD_BUS_STAND',
    name: 'Vellore Old Bus Stand',
    lat: 12.92215,
    lon: 79.13252,
  },
  generatedAt: null,
  sort: 'eta',
  message: null,
  options: [
    {
      id: 'trip-1',
      routeId: 1,
      code: 'V1',
      routeNumber: 'V1',
      name: 'VIT - Bagayam',
      direction: 'up',
      etaMin: 24,
      arrivesInMin: 3,
      journeyMin: 21,
      delayMin: 1,
      kind: 'live',
      busId: 1,
      busName: 'Bus 1',
      busReg: 'TN09AB1001',
      busType: 'ordinary',
      crowd: 'medium',
      load: 35,
      capacity: 50,
      ratio: 0.7,
      wheelchair: true,
      lowFloor: true,
      score: 24,
      departsAt: null,
      scheduledArrival: null,
      predictedArrival: null,
      stops: [
        { stopId: 1, code: 'STOP_VIT', name: 'VIT', seq: 1, etaMin: 3, accessible: true },
        {
          stopId: 2,
          code: 'STOP_VELLORE_OLD_BUS_STAND',
          name: 'Vellore Old Bus Stand',
          seq: 7,
          etaMin: 24,
          accessible: true,
        },
      ],
    },
    {
      id: 'trip-2',
      routeId: 2,
      code: 'V2',
      routeNumber: 'V2',
      name: 'VIT - Otteri',
      direction: 'up',
      etaMin: 41,
      arrivesInMin: 8,
      journeyMin: 33,
      delayMin: 3,
      kind: 'live',
      busId: 2,
      busName: 'Bus 2',
      busReg: 'TN09AB1002',
      busType: 'ordinary',
      crowd: 'low',
      load: 12,
      capacity: 50,
      ratio: 0.24,
      wheelchair: false,
      lowFloor: false,
      score: 41,
      departsAt: null,
      scheduledArrival: null,
      predictedArrival: null,
      stops: [
        { stopId: 1, code: 'STOP_VIT', name: 'VIT', seq: 1, etaMin: 8, accessible: true },
        {
          stopId: 2,
          code: 'STOP_VELLORE_OLD_BUS_STAND',
          name: 'Vellore Old Bus Stand',
          seq: 8,
          etaMin: 41,
          accessible: true,
        },
      ],
    },
    {
      id: 'trip-3',
      routeId: 3,
      code: 'M1',
      routeNumber: 'M1',
      name: 'VIT - Christian Medical College',
      direction: 'up',
      etaMin: 29,
      arrivesInMin: 5,
      journeyMin: 24,
      delayMin: 1,
      kind: 'live',
      busId: 3,
      busName: 'Bus 3',
      busReg: 'TN09AB1003',
      busType: 'ordinary',
      crowd: 'high',
      load: 52,
      capacity: 60,
      ratio: 0.867,
      wheelchair: true,
      lowFloor: true,
      score: 29,
      departsAt: null,
      scheduledArrival: null,
      predictedArrival: null,
      stops: [
        { stopId: 1, code: 'STOP_VIT', name: 'VIT', seq: 1, etaMin: 5, accessible: true },
        {
          stopId: 2,
          code: 'STOP_VELLORE_OLD_BUS_STAND',
          name: 'Vellore Old Bus Stand',
          seq: 7,
          etaMin: 29,
          accessible: true,
        },
      ],
    },
  ],
  transfers: [],
}

/** Deep clone, so a caller mutating the fallback cannot corrupt the next call. */
export function demoJourney() {
  return structuredClone(DEMO_JOURNEY)
}

export const DEMO_PLAN = {
  origin: {
    id: 1,
    code: 'STOP_VIT',
    name: 'VIT',
    lat: 12.96814,
    lon: 79.15625,
  },
  destination: {
    id: 2,
    code: 'STOP_VELLORE_OLD_BUS_STAND',
    name: 'Vellore Old Bus Stand',
    lat: 12.92215,
    lon: 79.13252,
  },
  options: [
    {
      id: 'route-1',
      routeId: 1,
      code: 'V1',
      name: 'VIT - Bagayam',
      etaMin: 24,
      etaScheduledMin: 23,
      delayMin: 1,
      crowd: 'medium',
      load: 35,
      capacity: 50,
      ratio: 0.7,
      wheelchair: true,
      lowFloor: true,
      score: 66.0,
      // Same shape mapOption() produces, so components can rely on the key
      // existing. Null means "no model metadata", never a zeroed-out stand-in.
      prediction: null,
      stops: [
        { stopId: 1, name: 'VIT', etaMin: 24 },
        { stopId: 2, name: 'Vellore Old Bus Stand', etaMin: 0 },
      ].map((s) => ({ ...s, accessible: true })),
    },
    {
      id: 'route-2',
      routeId: 2,
      code: 'V2',
      name: 'VIT - Otteri',
      etaMin: 41,
      etaScheduledMin: 38,
      delayMin: 3,
      crowd: 'low',
      load: 12,
      capacity: 50,
      ratio: 0.24,
      wheelchair: false,
      lowFloor: false,
      score: 55.4,
      prediction: null,
      stops: [
        { stopId: 1, name: 'VIT', etaMin: 41 },
        { stopId: 2, name: 'Vellore Old Bus Stand', etaMin: 0 },
      ].map((s) => ({ ...s, accessible: true })),
    },
    {
      id: 'route-3',
      routeId: 3,
      code: 'M1',
      name: 'VIT - Christian Medical College',
      etaMin: 29,
      etaScheduledMin: 28,
      delayMin: 1,
      crowd: 'high',
      load: 52,
      capacity: 60,
      ratio: 0.867,
      wheelchair: true,
      lowFloor: true,
      score: 81.0,
      prediction: null,
      stops: [
        { stopId: 1, name: 'VIT', etaMin: 29 },
        { stopId: 2, name: 'Vellore Old Bus Stand', etaMin: 0 },
      ].map((s) => ({ ...s, accessible: true })),
    },
  ],
}

export function demoPlan() {
  return structuredClone(DEMO_PLAN)
}
