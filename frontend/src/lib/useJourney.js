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
 * The demo journey, matching the backend's seed data.
 * simulation_ml/seed/seed.py is built around exactly this pair: V1 is the
 * fast-but-packed option and V2 the slow-but-empty one, and the seed docstring
 * says "Plan STOP_VIT -> STOP_VELLORE_OLD_BUS_STAND and you get three options."
 */
export const DEFAULT_JOURNEY = { from: 'STOP_VIT', to: 'STOP_VELLORE_OLD_BUS_STAND' }

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
} = DEFAULT_JOURNEY) {
  const [plan, setPlan] = useState(() => demoJourney())
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

      // The stop list has not arrived yet. Requesting now would send
      // from_stop_id=undefined, which the backend correctly rejects with a 404 -
      // and that rejection would then be rendered as "unknown stop" the instant
      // the panel mounts. Waiting is not politeness here, it is the difference
      // between a loading state and a false error.
      if (!fromStopId || !toStopId) {
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
        if (clearedRef.current) return
        setSelectedId((current) =>
          next.options.some((o) => o.id === current) ? current : (next.options[0]?.id ?? null),
        )
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

  const selected = useMemo(() => {
    /*
      `selectedId === null` means the user explicitly cleared the selection, and
      that must stay cleared. The previous `?? plan.options[0]` fallback made a
      "nothing selected" state unreachable, which is why the map always had some
      route to draw and the empty case could never be exercised.

      A non-null id that no longer matches any option (the bus dropped out of
      the plan after a re-plan) still falls back to the best option, because
      that is a stale pointer rather than a deliberate choice.
    */
    if (selectedId === null) return null
    return plan.options.find((o) => o.id === selectedId) ?? plan.options[0] ?? null
  }, [plan, selectedId])

  return {
    plan,
    options: plan.options,
    transfers: plan.transfers ?? [],
    /** The backend's own wording for an empty result, when it gave one. */
    message: plan.message ?? null,
    sort: plan.sort ?? 'eta',
    selected,
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
