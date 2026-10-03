import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { config, demoPlan, getRouteShape, getRouteStops, getStops, planJourney, setTripCrowd } from '@/lib/api'

/**
 * The demo journey, matching the backend's seed data.
 * simulation_ml/seed/seed.py is built around exactly this pair: 21A is the
 * fast-but-packed option and 7B the slow-but-empty one, and the seed docstring
 * says "Plan STOP_RAJAJINAGAR -> STOP_MAJESTIC and you get two options."
 */
export const DEFAULT_JOURNEY = { from: 'STOP_RAJAJINAGAR', to: 'STOP_MAJESTIC' }

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
 * Three behaviours worth calling out:
 *
 *  - The last good plan stays on screen while a refresh is in flight, so the
 *    list does not flash empty every few seconds.
 *  - A failed poll falls back to the demo plan and sets source to 'demo'. The UI
 *    shows an "offline" badge, so on-screen numbers are never silently
 *    fabricated.
 *  - A 400 from the planner is NOT treated as a transport failure. The contract
 *    uses 400 for "unknown stop code" and "no route connects the two stops",
 *    which is a user-actionable message rather than something to paper over with
 *    demo data. Those are surfaced as `error` with an empty option list.
 */
export function useJourney({
  from = DEFAULT_JOURNEY.from,
  to = DEFAULT_JOURNEY.to,
  accessibilityOnly = false,
  pollIntervalMs = config.pollIntervalMs,
} = DEFAULT_JOURNEY) {
  const [plan, setPlan] = useState(() => demoPlan())
  const [source, setSource] = useState('pending')
  const [error, setError] = useState(null)
  const [settledKey, setSettledKey] = useState(null)
  const [selectedId, setSelectedId] = useState(null)
  const [overriding, setOverriding] = useState(false)

  // Guards against a slow response for an old from/to pair overwriting a newer
  // one, which would otherwise show the wrong journey after a fast double-click.
  const requestId = useRef(0)

  const queryKey = `${from}|${to}|${accessibilityOnly}`

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
      try {
        const next = await planJourney({ from, to, accessibilityOnly }, { signal })
        if (signal?.aborted || id !== requestId.current) return
        setPlan(next)
        setSource('api')
        setError(null)
        setSettledKey(queryKey)
        setSelectedId((current) =>
          next.options.some((o) => o.id === current) ? current : (next.options[0]?.id ?? null),
        )
      } catch (err) {
        if (signal?.aborted || err?.name === 'AbortError') return
        if (id !== requestId.current) return

        if (err?.status === 400) {
          // A rejected journey is a real answer, not an outage. Show it empty.
          setPlan({ origin: null, destination: null, generatedAt: null, options: [] })
          setSource('api')
          setError(err.message)
          setSelectedId(null)
        } else {
          setPlan(demoPlan())
          setSource('demo')
          setError(err?.message ?? 'RideSmart API unreachable')
        }
        setSettledKey(queryKey)
      }
    },
    [from, to, accessibilityOnly, queryKey],
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

  const selected = useMemo(
    () => plan.options.find((o) => o.id === selectedId) ?? plan.options[0] ?? null,
    [plan, selectedId],
  )

  return {
    plan,
    options: plan.options,
    selected,
    selectOption: setSelectedId,
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
