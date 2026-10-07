import { useCallback, useEffect, useMemo, useState } from 'react'
import { busSocketUrl, config, getActiveBuses, mapBusPosition } from '@/lib/api'

/** Stable identity so "no buses for this route" does not re-render on every tick. */
const EMPTY_BUSES = []

/**
 * How long to let a burst of route switches settle before opening a socket.
 *
 * See the note on connect() below. It only has to be longer than a human's
 * click interval, so it is deliberately tiny next to busPollIntervalMs.
 */
const OPEN_SETTLE_MS = 120

/**
 * Live bus positions for ONE OR MORE routes, preferring the WebSocket and
 * falling back to polling.
 *
 * WHY "MORE THAN ONE": the journey map is scoped to the selected legs. A direct
 * bus is one leg, so one route id; a transfer is two legs, so two. `routeIds`
 * takes an array (a single id is also accepted) and one subscription is opened
 * per route, merged into one bus list.
 *
 * THE SCOPE IS THE POINT OF THIS HOOK. The version before took no arguments,
 * fetched /api/buses/active with no route filter, and passed the result to the
 * map, which drew every bus on the network whatever route was selected. The
 * filter lived only in the map's paint layer as a highlight halo, so it changed
 * how a bus looked without ever removing one. The scope now lives here, in the
 * fetch itself, and the map is handed only the requested routes' buses. With a
 * transfer that means buses from BOTH legs - never a bus from a route the
 * passenger is not travelling on.
 *
 * The contract says /api/ws/buses "pushes the same BusPosition array as
 * /api/buses/active roughly every 2 seconds" and that clients "must tolerate a
 * heartbeat-only message", and /api/buses/active is the documented polling
 * fallback. So per route the order is:
 *
 *   1. open the socket, scoped to the route, and take data from it
 *   2. if no frame arrives within wsGraceMs, start polling and keep retrying
 *      the socket in the background
 *   3. the moment a socket frame lands, stop polling
 *
 * The route set drives the effect's dependency list, so switching journeys
 * tears down the old sockets and intervals before the new ones start. That is
 * what stops a deselected route from continuing to push updates.
 *
 * ONE RULE, easy to get wrong: normalise exactly once, at the boundary where
 * wire data enters. getActiveBuses() already returns UI-shaped rows, and a raw
 * socket frame is wire-shaped. If a single helper re-maps both, the polling
 * path feeds it rows that have no bus_id/lat/lon keys and it silently produces a
 * list of undefineds - the map goes blank with no error anywhere. So apply()
 * takes normalised rows only, and the two producers normalise at their own
 * boundary.
 *
 * State updates on every tick would re-render the whole app twice a second, so
 * the array identity is kept stable when the payload has not meaningfully
 * changed - only bus positions, counts and the crowd band are compared.
 */
export function useLiveBuses(routeIds = null) {
  const list = useMemo(() => {
    if (routeIds == null) return []
    const ids = Array.isArray(routeIds) ? routeIds : [routeIds]
    // A duplicate route (two selections on one corridor) must not open two
    // sockets for it.
    return [...new Set(ids.map((r) => Number(r)).filter((r) => Number.isFinite(r) && r > 0))].sort(
      (a, b) => a - b,
    )
  }, [routeIds])

  /*
    Both state slots key on the same scope signature - the sorted, joined route
    ids - and the signature travels WITH the data. Deriving "these buses are
    stale" during render is what makes rapid switching safe: a frame for the
    previous journey can never be shown under the new selection, and no extra
    render pass is needed to blank the list. Same shape as useRouteStops.
  */
  const scopeKey = list.length > 0 ? list.join(',') : 'all'

  /** Per-route arrays: { [routeId]: BusPosition[] } for the current scope. */
  const [loaded, setLoaded] = useState({ key: '', byRoute: {} })

  /*
    The transport label travels with its scope, for the same reason the buses
    do. Resetting it from inside the effect meant calling setState synchronously
    during render commit, which re-renders a second time for a value that can be
    derived.
  */
  const [link, setLink] = useState({ key: '', transport: 'connecting' })

  const markTransport = useCallback((scope, value) => {
    setLink((prev) => (prev.key === scope && prev.transport === value ? prev : { key: scope, transport: value }))
  }, [])

  const [error, setError] = useState(null)

  /** Cheap signature so an identical payload does not trigger a re-render. */
  const signature = (rows) =>
    rows
      .map((b) => `${b.busId}:${b.lat?.toFixed(5)}:${b.lon?.toFixed(5)}:${b.crowd}:${b.load}`)
      .sort()
      .join('|')

  /** Accepts normalised rows only. See the note above. */
  const apply = useCallback((scope, routeId, rows) => {
    setLoaded((prev) => {
      const stored = prev.byRoute[routeId] ?? []
      if (prev.key === scope && signature(stored) === signature(rows)) return prev
      return { key: scope, byRoute: { ...prev.byRoute, [routeId]: rows } }
    })
  }, [])

  useEffect(() => {
    // No journey selected means show ALL buses on the map.

    let cancelled = false

    // All buses (no selection) - poll once for all
    const per = new Map()

    const stopPolling = (routeId) => {
      const state = per.get(routeId)
      if (state?.pollTimer) {
        clearInterval(state.pollTimer)
        state.pollTimer = null
      }
    }

    const startPolling = (routeId) => {
      const state = per.get(routeId)
      if (!state || state.pollTimer) return
      markTransport(scopeKey, 'poll')

      const tick = async () => {
        try {
          // Already normalised by the adapter - do NOT map again.
          apply(scopeKey, routeId, await getActiveBuses(routeId))
          setError(null)
        } catch (err) {
          if (cancelled) return
          setError(err?.message ?? 'Live feed unavailable')
        }
      }

      tick()
      state.pollTimer = setInterval(tick, config.busPollIntervalMs)
    }

    /*
      A burst of route switches must not open a socket per click.

      Cancelling a handshake that has not finished yet makes the browser log
      "WebSocket is closed before the connection is established" and the frame
      never reaches the server, so the only way to avoid the noise AND the
      wasted connection is not to make the request in the first place. A short
      settle window collapses a burst into one socket for the route the user
      actually ended on; 120ms is imperceptible next to the 2s push interval.
    */
    const openSocket = (routeId) => {
      if (cancelled) return
      const state = per.get(routeId)
      if (!state) return

      const url = busSocketUrl(routeId)
      if (!url || typeof WebSocket === 'undefined') {
        startPolling(routeId)
        return
      }

      let ws
      try {
        ws = new WebSocket(url)
      } catch {
        startPolling(routeId)
        return
      }
      state.socket = ws

      // If the socket accepts but never delivers, poll rather than show nothing.
      state.graceTimer = setTimeout(() => {
        if (!state.gotSocketData) startPolling(routeId)
      }, config.wsGraceMs)

      ws.onopen = () => {
        if (!cancelled) setError(null)
      }

      ws.onmessage = (event) => {
        let payload
        try {
          payload = JSON.parse(event.data)
        } catch {
          return // malformed frame; the next tick will carry the truth
        }

        // The contract requires tolerating a heartbeat-only message, so anything
        // that is not an array of positions is ignored rather than rendered.
        if (!Array.isArray(payload)) return

        state.gotSocketData = true
        clearTimeout(state.graceTimer)
        stopPolling(routeId)
        state.retries = 0
        markTransport(scopeKey, 'ws')
        setError(null)
        // Raw wire frame, so this is the one place that maps.
        apply(scopeKey, routeId, payload.map(mapBusPosition))
      }

      ws.onerror = () => {
        // onclose always follows; reconnection is handled there.
      }

      ws.onclose = () => {
        clearTimeout(state.graceTimer)
        if (cancelled) return

        startPolling(routeId)
        const delay = Math.min(1000 * 2 ** state.retries, 15000)
        state.retries += 1
        state.retryTimer = setTimeout(() => openSocket(routeId), delay)
      }
    }

    const connect = (routeId) => {
      const state = per.get(routeId)
      if (!state) return
      clearTimeout(state.openTimer)
      state.openTimer = setTimeout(() => openSocket(routeId), OPEN_SETTLE_MS)
    }

    for (const routeId of list) connect(routeId)

    return () => {
      cancelled = true
      for (const state of per.values()) {
        clearTimeout(state.openTimer)
        clearTimeout(state.graceTimer)
        clearTimeout(state.retryTimer)
        clearInterval(state.pollTimer)
        /*
          Closing the socket is what actually stops the previous route updating.
          Setting `cancelled` only stops THIS hook instance writing to state -
          the old socket stays open server-side, keeps its 2-second timer, and
          keeps pushing a route the user has already switched away from.
        */
        const ws = state.socket
        if (ws) {
          ws.onclose = null
          ws.onerror = null
          ws.onmessage = null
          ws.onopen = null

          if (ws.readyState === WebSocket.OPEN) {
            ws.close()
          } else if (ws.readyState === WebSocket.CONNECTING) {
            // close() on a socket that has not finished its handshake never
            // reaches the server and makes the browser log "closed before the
            // connection is established". Waiting for open and closing then is
            // the only way to abandon it cleanly.
            ws.addEventListener('open', () => ws.close(), { once: true })
          }
        }
      }
    }
    // The effect's work is keyed entirely on the sorted route list; the helper
    // callbacks are stable and `list` cannot change without its key changing.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scopeKey])

  // Stale rows from a previous selection are never returned, so switching
  // journeys blanks the map immediately instead of painting the old routes'
  // buses until the first frame for the new one lands.
  const buses =
    loaded.key === scopeKey
      ? (scopeKey === 'all'
          ? (loaded.byRoute['__all__'] || [])
          : Object.values(loaded.byRoute).flat())
      : EMPTY_BUSES

  const transport = list.length === 0 || link.key !== scopeKey ? 'connecting' : link.transport

  return { buses, transport, error, isLive: transport === 'ws' }
}