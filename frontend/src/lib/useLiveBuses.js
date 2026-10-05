import { useCallback, useEffect, useRef, useState } from 'react'
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
 * Live bus positions for ONE route, preferring the WebSocket and falling back
 * to polling.
 *
 * THE SCOPE IS THE POINT OF THIS HOOK. The version before took no arguments,
 * fetched /api/buses/active with no route filter, and passed the result to the
 * map, which drew every bus on the network whatever route was selected. The
 * filter lived only in the map's paint layer as a highlight halo, so it changed
 * how a bus looked without ever removing one. The scope now lives here, in the
 * fetch itself, and the map is handed only the selected route's buses.
 *
 * The contract says /api/ws/buses "pushes the same BusPosition array as
 * /api/buses/active roughly every 2 seconds" and that clients "must tolerate a
 * heartbeat-only message", and /api/buses/active is the documented polling
 * fallback. So the order is:
 *
 *   1. open the socket, scoped to routeId, and take data from it
 *   2. if no frame arrives within wsGraceMs, start polling and keep retrying
 *      the socket in the background
 *   3. the moment a socket frame lands, stop polling
 *
 * routeId drives the effect's dependency list, so switching routes tears down
 * the old socket and interval before the new ones start. That is what stops a
 * deselected route from continuing to push updates.
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
export function useLiveBuses(routeId = null) {
  /*
    The routeId the data belongs to travels WITH the data rather than being
    cleared with a setState when the selection changes. Deriving "these buses
    are stale" during render is what makes rapid switching safe: a frame for the
    previous route can never be shown under the new selection, and no extra
    render pass is needed to blank the list. Same shape as useRouteStops.
  */
  const [loaded, setLoaded] = useState({ routeId: null, buses: [] })

  /*
    The transport label travels with its scope, for the same reason the buses
    do. Resetting it from inside the effect meant calling setState synchronously
    during render commit, which re-renders a second time for a value that can be
    derived.
  */
  const [link, setLink] = useState({ routeId: null, transport: 'connecting' })

  const markTransport = useCallback((scope, value) => {
    setLink((prev) => (prev.routeId === scope && prev.transport === value ? prev : { routeId: scope, transport: value }))
  }, [])

  const [error, setError] = useState(null)

  const gotSocketData = useRef(false)

  /** Cheap signature so an identical payload does not trigger a re-render. */
  const signature = (rows) =>
    rows
      .map((b) => `${b.busId}:${b.lat?.toFixed(5)}:${b.lon?.toFixed(5)}:${b.crowd}:${b.load}`)
      .sort()
      .join('|')

  /** Accepts normalised rows only. See the note above. */
  const apply = useCallback((scope, rows) => {
    setLoaded((prev) =>
      prev.routeId === scope && signature(prev.buses) === signature(rows) ? prev : { routeId: scope, buses: rows },
    )
  }, [])

  useEffect(() => {
    // No route selected means no vehicles: nothing is fetched and no socket is
    // opened, so the map genuinely shows nothing rather than showing a default.
    // The transport label resets itself during render (see the derivation at
    // the bottom) rather than being set from here.
    if (routeId == null) return undefined

    let cancelled = false
    let graceTimer = null
    let retryTimer = null
    let pollTimer = null
    let socket = null

    // Fresh subscription for a new route: the previous socket's first frame
    // must not suppress this one's grace timer.
    gotSocketData.current = false

    const stopPolling = () => {
      if (pollTimer) {
        clearInterval(pollTimer)
        pollTimer = null
      }
    }

    const startPolling = () => {
      if (pollTimer) return
      markTransport(routeId, 'poll')

      const tick = async () => {
        try {
          // Already normalised by the adapter - do NOT map again.
          apply(routeId, await getActiveBuses(routeId))
          setError(null)
        } catch (err) {
          if (cancelled) return
          setError(err?.message ?? 'Live feed unavailable')
        }
      }

      tick()
      pollTimer = setInterval(tick, config.busPollIntervalMs)
    }

    let retries = 0
    let openTimer = null

    /*
      A burst of route switches must not open a socket per click.

      Cancelling a handshake that has not finished yet makes the browser log
      "WebSocket is closed before the connection is established" and the frame
      never reaches the server, so the only way to avoid the noise AND the
      wasted connection is not to make the request in the first place. A short
      settle window collapses a burst into one socket for the route the user
      actually ended on; 120ms is imperceptible next to the 2s push interval.
    */
    const openSocket = () => {
      if (cancelled) return

      const url = busSocketUrl(routeId)
      if (!url || typeof WebSocket === 'undefined') {
        startPolling()
        return
      }

      let ws
      try {
        ws = new WebSocket(url)
      } catch {
        startPolling()
        return
      }
      socket = ws

      // If the socket accepts but never delivers, poll rather than show nothing.
      graceTimer = setTimeout(() => {
        if (!gotSocketData.current) startPolling()
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

        gotSocketData.current = true
        clearTimeout(graceTimer)
        stopPolling()
        retries = 0
        markTransport(routeId, 'ws')
        setError(null)
        // Raw wire frame, so this is the one place that maps.
        apply(routeId, payload.map(mapBusPosition))
      }

      ws.onerror = () => {
        // onclose always follows; reconnection is handled there.
      }

      ws.onclose = () => {
        clearTimeout(graceTimer)
        if (cancelled) return

        startPolling()
        const delay = Math.min(1000 * 2 ** retries, 15000)
        retries += 1
        retryTimer = setTimeout(connect, delay)
      }
    }

    const connect = () => {
      clearTimeout(openTimer)
      openTimer = setTimeout(openSocket, OPEN_SETTLE_MS)
    }

    connect()

    return () => {
      cancelled = true
      clearTimeout(openTimer)
      clearTimeout(graceTimer)
      clearTimeout(retryTimer)
      stopPolling()
      /*
        Closing the socket is what actually stops the previous route updating.
        Setting `cancelled` only stops THIS hook instance writing to state - the
        old socket stays open server-side, keeps its 2-second timer, and keeps
        pushing a route the user has already switched away from.
      */
      if (socket) {
        socket.onclose = null
        socket.onerror = null
        socket.onmessage = null
        socket.onopen = null

        if (socket.readyState === WebSocket.OPEN) {
          socket.close()
        } else if (socket.readyState === WebSocket.CONNECTING) {
          // close() on a socket that has not finished its handshake never
          // reaches the server and makes the browser log "closed before the
          // connection is established". Waiting for open and closing then is
          // the only way to abandon it cleanly.
          socket.addEventListener('open', () => socket.close(), { once: true })
        }
        socket = null
      }
    }
  }, [apply, markTransport, routeId])

  // Stale rows from a previous selection are never returned, so switching
  // routes blanks the map immediately instead of painting the old route's buses
  // until the first frame for the new one lands.
  const buses = loaded.routeId === routeId ? loaded.buses : EMPTY_BUSES

  // Derived for the same reason. A label reading "Live feed" while no route is
  // selected, or after the selection moved on, is a claim about a connection
  // that no longer exists.
  const transport = routeId == null || link.routeId !== routeId ? 'connecting' : link.transport

  return { buses, transport, error, isLive: transport === 'ws' }
}