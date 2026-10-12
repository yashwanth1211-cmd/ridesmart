import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  config,
  demoJourney,
  getJourney,
  getRouteShape,
  getRouteStops,
  getStops,
  setTripCrowd,
} from '@/lib/api'

/**
 * A plan with nothing in it: no origin, no destination, no rows.
 *
 * The journey starts EMPTY on purpose - the map is scoped to a chosen journey,
 * so before From and To are picked there is nothing to draw and nothing to show.
 * This is the stable object useJourney falls back to whenever the query has no
 * stop pair, so clearing the pickers clears the plan, the selection and the map
 * in one render. It is a module constant so the same reference can be set over
 * and over without re-rendering.
 */
export const EMPTY_JOURNEY = {
  origin: null,
  destination: null,
  generatedAt: null,
  sort: 'eta',
  options: [],
  transfers: [],
  message: null,
}

/**
 * Colours the two legs of a journey are drawn in, shared by the map (paint
 * layers) and the cards (leg chips) so neither can drift from the other.
 */
export const JOURNEY_LEG_COLORS = ['#4f8cff', '#7ae0a1']

/**
 * The stops of one leg, joined with the coordinates the journey payload does
 * not carry. JourneyStop is { stop_id, name, eta_min, accessible } - no lat/lon -
 * so the map can only draw a stop marker by matching it against the reference
 * stop list. Stops without a match are dropped rather than drawn at [0, 0].
 */
function legStopsWithCoords(legStops, stopsByCode) {
  const byId = stopsByCode
  return (legStops ?? [])
    .map((s) => {
      const stop = byId[s.stopId]
      return stop ? { ...s, lat: stop.lat, lon: stop.lon, stopCode: stop.code } : null
    })
    .filter((s) => s && Number.isFinite(s.lat) && Number.isFinite(s.lon))
}

/**
 * The set of legs the map should draw for a selected option or transfer.
 *
 * A direct option is one blue leg on its own route. A transfer is two legs,
 * first blue, second green, each with its own slice of road, its own stops and
 * its own offered vehicle. This is the shape every map layer reads, so the
 * "two legs in two colours" rule lives here and nowhere else.
 */
export function buildJourneyLegs(selected, stops = []) {
  if (!selected) return []

  const stopsByCode = new Map(stops.map((s) => [s.id, s]))

  if (Array.isArray(selected.legs)) {
    return selected.legs.map((leg, i) => ({
      routeId: leg.routeId,
      code: leg.code,
      name: leg.name,
      color: JOURNEY_LEG_COLORS[i % JOURNEY_LEG_COLORS.length],
      shape: leg.shape ?? [],
      shapeM: leg.shapeM ?? null,
      stops: legStopsWithCoords(leg.stops, stopsByCode),
      // The vehicle that answers this leg, so the map can pick it out of the
      // route's other buses.
      busIds: leg.busId != null ? [leg.busId] : [],
      via: i > 0,
    }))
  }

  return [
    {
      routeId: selected.routeId,
      code: selected.code,
      name: selected.name,
      color: JOURNEY_LEG_COLORS[0],
      shape: selected.shape ?? [],
      shapeM: selected.shapeM ?? null,
      stops: legStopsWithCoords(selected.stops, stopsByCode),
      busIds: selected.busId != null ? [selected.busId] : [],
      via: false,
    },
  ]
}

/**
 * Stops for the from/to pickers. Fetched once - the stop list is reference
 * data, not live data, so there is no reason to poll it.
 */
export function useStops() {
  const [stops, setStops] = useState([])
  const [source, setSource] = useState('pending')
  const [error, setError] = useState(null)

  useEffect(() => {
    const controller = new AbortController()
    let cancelled = false

    getStops({ signal: controller.signal })
      .then((rows) => {
        if (cancelled) return
        setStops(rows)
        setSource('api')
        setError(null)
      })
      .catch((err) => {
        if (cancelled || err?.name === 'AbortError') return
        setSource('demo')
        setError(err?.message ?? 'Could not load stops')
      })

    return () => {
      cancelled = true
      controller.abort()
    }
  }, [])

  return { stops, source, error }
}

/**
 * The fastest selection rule, applied everywhere "the default" is needed:
 * pick the option with the lowest arrival time, breaking ties by the shorter
 * ride (shape_m is exact road distance, stops[] has no length). The backend
 * ranks by ETA already, but the tie-break is a client-side rule the backend
 * does not encode.
 */
function fastestOptionId(options) {
  if (!options.length) return null
  const [best] = [...options].sort(
    (a, b) =>
      (a.etaMin ?? Infinity) - (b.etaMin ?? Infinity) ||
      (a.shapeM ?? Infinity) - (b.shapeM ?? Infinity),
  )
  return best.id
}

function fastestTransferIdOf(transfers) {
  if (!transfers.length) return null
  const [best] = [...transfers].sort(
    (a, b) => (a.totalMin ?? Infinity) - (b.totalMin ?? Infinity),
  )
  return best.id
}

/**
 * Plans a journey and keeps the result fresh.
 *
 * Talks to GET /api/journey, so it needs stop IDs and the answers are BUSES
 * rather than routes. Four behaviours worth calling out:
 *
 *  - The last good plan stays on screen while a refresh is in flight, so the
 *    list does not flash empty every few seconds.
 *  - A failed poll falls back to the demo journey and sets source to 'demo'. The
 *    UI shows an "offline" badge, so on-screen numbers are never silently
 *    fabricated.
 *  - A 404 from the planner is NOT treated as a transport failure. The contract
 *    uses it for "unknown stop id", which is a user-actionable message rather
 *    than something to paper over with demo data. Surfaced as `error` with an
 *    empty option list.
 *  - "No buses found for this journey" arrives as a 200 with `message` set and
 *    both lists empty. That is an ANSWER, not an error, and is kept distinct
 *    from `error` so the panel can show the backend's wording - which knows
 *    whether suggesting a swap would help - instead of a generic failure string.
 */
export function useJourney({
  fromStopId = null,
  toStopId = null,
  accessibilityOnly = false,
  sort = 'eta',
  includeTransfers = true,
  pollIntervalMs = config.pollIntervalMs,
} = {}) {
  const [plan, setPlan] = useState(EMPTY_JOURNEY)
  const [source, setSource] = useState('pending')
  const [error, setError] = useState(null)
  const [settledKey, setSettledKey] = useState(null)
  const [selectedId, setSelectedId] = useState(null)
  const [overriding, setOverriding] = useState(false)

  /*
    Whether the user deliberately cleared the selection.

    `selectedId === null` is ambiguous on its own: it is both "the user cleared
    it" and "we have not answered yet", because both start out null. Without a
    separate marker the 5-second plan poll below would resurrect the fastest
    option within one tick of a clear, and the map would never stay empty.
  */
  const clearedRef = useRef(false)

  // Guards against a slow response for an old from/to pair overwriting a newer
  // one, which would otherwise show the wrong journey after a fast double-click.
  const requestId = useRef(0)

  const queryKey = `${fromStopId}|${toStopId}|${accessibilityOnly}|${sort}|${includeTransfers}`

  /*
    loading is DERIVED from whether we have an answer for the CURRENT query.
    Storing it as state and calling setLoading(true) inside the effect scheduled
    an extra render on every from/to change, before the request had even left.
    Comparing keys gives the same UI for free and cannot drift out of sync.
  */
  const loading = settledKey !== queryKey

  const load = useCallback(
    async ({ signal } = {}) => {
      const id = ++requestId.current

      // No stop pair means nothing to plan for - and the map is scoped to the
      // chosen journey, so clearing From or To must clear the plan, the source
      // label and the selection in one go. `EMPTY_JOURNEY` is a module constant,
      // so re-setting it on every poll tick is a no-op render-wise. The stop
      // list arriving late is handled the same way: querying before it lands
      // would send from_stop_id=undefined, which the backend correctly rejects
      // with a 404 - and that 404 would be rendered as "unknown stop" the
      // instant the panel mounts.
      if (!fromStopId || !toStopId) {
        setPlan(EMPTY_JOURNEY)
        setSource('pending')
        setSelectedId(null)
        // An empty picker pair is "no journey requested", NOT "the user cleared
        // it". Boot - stops not picked yet - also lands here, and latching
        // `cleared` here would permanently suppress the default-selection below
        // the first time both pickers are ever filled: the map would stay empty
        // forever. Only clearSelection() (the X on the route selector) is a
        // deliberate clear.
        clearedRef.current = false
        setSettledKey(queryKey)
        return
      }

      try {
        const next = await getJourney(
          { fromStopId, toStopId, accessibilityOnly, sort, includeTransfers },
          { signal },
        )
        if (signal?.aborted || id !== requestId.current) return
        setPlan(next)
        setSource('api')
        setError(null)
        setSettledKey(queryKey)
        // A deliberate clear survives re-planning; only a stale pointer (the
        // bus dropped out of the new plan) falls back to the best option.
        // "Best" is the FASTEST option - the default must be the one that gets
        // the passenger there soonest, with the shortest ride breaking ties.
        if (clearedRef.current) return
        setSelectedId((current) => {
          if (next.options.some((o) => o.id === current)) return current
          // The module-level helpers, not the memos: `load` runs before the
          // memos below are initialised, so capturing them here would reference
          // a binding during its own initialisation.
          return fastestOptionId(next.options) ?? fastestTransferIdOf(next.transfers)
        })
      } catch (err) {
        if (signal?.aborted || err?.name === 'AbortError') return
        if (id !== requestId.current) return

        if (err?.status === 404) {
          // An unknown stop id is a real answer, not an outage. Show it empty.
          setPlan({
            origin: null,
            destination: null,
            generatedAt: null,
            options: [],
            transfers: [],
            message: null,
            sort,
          })
          setSource('api')
          setError(err.message)
          setSelectedId(null)
          // The user did not clear the map, so a later valid journey must be
          // allowed to pick a default again.
          clearedRef.current = false
        } else {
          setPlan(demoJourney())
          setSource('demo')
          setError(err?.message ?? 'RideSmart API unreachable')
        }
        setSettledKey(queryKey)
      }
    },
    [fromStopId, toStopId, accessibilityOnly, sort, includeTransfers, queryKey],
  )

  useEffect(() => {
    const controller = new AbortController()

    /*
      oxlint-disable-next-line react/set-state-in-effect

      False positive: load() is async and every setState below is reached only
      after `await planJourney(...)` resolves, so nothing is set synchronously
      during this effect. This is the canonical "fetch on mount" effect - the
      alternative (hand-rolling a request in the event that changed the query)
      is exactly what this hook exists to avoid.
    */
    load({ signal: controller.signal })

    const timer = setInterval(() => load({ signal: controller.signal }), pollIntervalMs)

    return () => {
      controller.abort()
      clearInterval(timer)
    }
  }, [load, pollIntervalMs])

  /**
   * The documented demo trigger: empty a bus, then re-plan the same journey and
   * watch the ranking change. PUT first, then force an immediate re-plan so the
   * user sees the consequence without waiting for the next poll.
   */
  const overrideCrowd = useCallback(
    async (tripId, load_) => {
      if (!tripId) return { ok: false, message: 'No active trip for that route' }
      setOverriding(true)
      try {
        await setTripCrowd({ tripId, load: load_ })
        await load()
        return { ok: true }
      } catch (err) {
        return { ok: false, message: err?.message ?? 'Could not update crowd level' }
      } finally {
        setOverriding(false)
      }
    },
    [load],
  )

  /**
   * The FASTEST direct option: lowest eta, ties broken by the shorter ride.
   * The map and the cards mark this option, and it is the default selection.
   */
  const fastestId = useMemo(() => fastestOptionId(plan.options), [plan.options])

  /**
   * The FASTEST transfer, by total journey minutes. Marked the same way so the
   * carrier card for a transfer-only journey also has a "fastest" callout.
   */
  const fastestTransferId = useMemo(() => fastestTransferIdOf(plan.transfers), [plan.transfers])

  const selected = useMemo(() => {
    /*
      `selectedId === null` means the user explicitly cleared the selection, and
      that must stay cleared. The previous `?? plan.options[0]` fallback made a
      "nothing selected" state unreachable, which is why the map always had some
      route to draw and the empty case could never be exercised.

      A non-null id that matches nothing - the bus dropped out of the plan after
      a re-plan, or an id selected while it was a transfer that is now a direct
      option - still falls back to the best option, because that is a stale
      pointer rather than a deliberate choice. Transfers are selectable too, so
      the lookup searches both lists.
    */
    if (selectedId === null) return null
    return (
      plan.options.find((o) => o.id === selectedId) ??
      plan.transfers.find((t) => t.id === selectedId) ??
      plan.options.find((o) => o.id === fastestId) ??
      plan.transfers.find((t) => t.id === fastestTransferId) ??
      null
    )
  }, [plan, selectedId, fastestId, fastestTransferId])

  return {
    plan,
    options: plan.options,
    transfers: plan.transfers ?? [],
    /** The backend's own wording for an empty result, when it gave one. */
    message: plan.message ?? null,
    sort: plan.sort ?? 'eta',
    selected,
    /** The fastest direct option's id, for the FASTEST callout on card and map. */
    fastestId,
    /** The fastest transfer's id, so a transfer-only journey still marks one. */
    fastestTransferId,
    /** True when the currently selected option IS the fastest one. */
    selectedIsFastest:
      selected != null && (selected.id === fastestId || selected.id === fastestTransferId),
    selectedRouteId: selected?.routeId ?? null,
    selectOption: (id) => {
      clearedRef.current = false
      setSelectedId(id)
    },
    /**
     * Explicitly clears the selection. Split from selectOption because passing
     * null through the setter looks identical to "keep the current selection"
     * at the call site, and one of those two readings is always wrong.
     */
    clearSelection: () => {
      clearedRef.current = true
      setSelectedId(null)
    },
    source,
    isLive: source === 'api',
    error,
    loading,
    overriding,
    overrideCrowd,
    refresh: () => load(),
  }
}

/**
 * Ordered stops for one route, used to draw the route polyline on the map.
 *
 * PlanOption.stops[] deliberately carries no coordinates - it is
 * { stop_id, name, eta_min, accessible } - so the geometry has to come from
 * GET /api/routes/{id}/stops, which nests a full Stop including lat/lon.
 *
 * The result is trimmed to the slice between origin and destination. The API
 * returns the WHOLE route, and drawing all of it would imply the bus serves
 * stops this passenger is not travelling through.
 *
 * IMPORTANT: `fromId`/`toId` must be compared against THIS route's stop ids.
 * On a two-directional network, "origin" and "destination" are ambiguous - the
 * same pair of places is served in one order by "21A UP" and the other by
 * "21A DN". This hook resolves the indices against the selected route's own stop
 * list and falls back to the whole route when the endpoints are not on it, so a
 * direction mismatch degrades to a slightly over-long line rather than an empty
 * map.
 */
export function useRouteStops(routeId, { fromId, toId } = {}) {
  /*
    Holds the routeId the data belongs to alongside the data. Deriving "no route
    selected means no geometry" from routeId alone would mean calling setStops([])
    synchronously inside the effect, which triggers a cascading render on every
    selection change. Keeping the id alongside lets the mismatch be handled
    during render instead, with no extra pass.
  */
  const [loaded, setLoaded] = useState({ routeId: null, stops: [] })
  const requestId = useRef(0)

  useEffect(() => {
    if (!routeId) return undefined

    const controller = new AbortController()
    const id = ++requestId.current

    getRouteStops(routeId, { signal: controller.signal })
      .then((rows) => {
        if (controller.signal.aborted || id !== requestId.current) return
        setLoaded({ routeId, stops: rows.map((r) => r.stop) })
      })
      .catch((err) => {
        if (controller.signal.aborted || err?.name === 'AbortError') return
        if (id !== requestId.current) return
        setLoaded({ routeId, stops: [] })
      })

    return () => controller.abort()
  }, [routeId])

  return useMemo(() => {
    // Stale geometry from the previous route must never be drawn under the new
    // one, and neither must the previous route's shape linger while a fetch is
    // still in flight.
    if (!routeId || loaded.routeId !== routeId) return []
    const stops = loaded.stops
    if (!stops.length) return []

    const from = fromId ?? stops[0]?.id
    const to = toId ?? stops[stops.length - 1]?.id

    const iFrom = stops.findIndex((s) => s.id === from)
    const iTo = stops.findIndex((s) => s.id === to)

    // Unknown endpoints: fall back to the whole route rather than drawing nothing.
    if (iFrom === -1 || iTo === -1 || iFrom >= iTo) return stops

    return stops.slice(iFrom, iTo + 1)
  }, [loaded, routeId, fromId, toId])
}

/**
 * The selected route's real road polyline.
 *
 * Same stale-guard shape as useRouteStops: geometry belonging to a previously
 * selected route must never be drawn under the new one, so the routeId travels
 * with the data and a mismatch is resolved during render rather than with a
 * synchronous setState that would cascade an extra render per selection.
 *
 * Returns [] when there is no geometry, which lets the map fall back to joining
 * stop coordinates instead of drawing nothing at all.
 */
export function useRouteShape(routeId) {
  const [loaded, setLoaded] = useState({ routeId: null, points: [] })
  const requestId = useRef(0)

  useEffect(() => {
    if (!routeId) return undefined

    const controller = new AbortController()
    const id = ++requestId.current

    getRouteShape(routeId, { signal: controller.signal })
      .then((shape) => {
        if (controller.signal.aborted || id !== requestId.current) return
        setLoaded({ routeId, points: shape.points })
      })
      .catch((err) => {
        if (controller.signal.aborted || err?.name === 'AbortError') return
        if (id !== requestId.current) return
        setLoaded({ routeId, points: [] })
      })

    return () => controller.abort()
  }, [routeId])

  return useMemo(() => {
    if (!routeId || loaded.routeId !== routeId) return []
    return loaded.points
  }, [loaded, routeId])
}
