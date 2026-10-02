import { useCallback, useEffect, useRef, useState } from 'react'
import { busSocketUrl, config, getActiveBuses, mapBusPosition } from '@/lib/api'

/**
 * Live bus positions, preferring the WebSocket and falling back to polling.
 *
 * The contract says /api/ws/buses "pushes the same BusPosition array as
 * /api/buses/active roughly every 2 seconds" and that clients "must tolerate a
 * heartbeat-only message", and /api/buses/active is the documented polling
 * fallback. So the order is:
 *
 *   1. open the socket and take data from it
 *   2. if no frame arrives within wsGraceMs, start polling and keep retrying the
 *      socket in the background
 *   3. the moment a socket frame lands, stop polling
 *
 * ONE RULE, easy to get wrong: normalise exactly once, at the boundary where
 * wire data enters. getActiveBuses() already returns UI-shaped rows, and a raw
 * socket frame is wire-shaped. If a single helper re-maps both, the polling path
 * feeds it rows that have no bus_id/lat/lon keys and it silently produces a list
 * of undefineds - the map goes blank with no error anywhere. So apply() takes
 * normalised rows only, and the two producers normalise at their own boundary.
 *
 * State updates on every tick would re-render the whole app twice a second, so
 * the array identity is kept stable when the payload has not meaningfully
 * changed - only bus positions, counts and the crowd band are compared.
 */
export function useLiveBuses() {
  const [buses, setBuses] = useState([])
  const [transport, setTransport] = useState('connecting') // 'connecting' | 'ws' | 'poll'
  const [error, setError] = useState(null)

  const pollRef = useRef(null)
  const gotSocketData = useRef(false)
  const retries = useRef(0)

  /** Cheap signature so an identical payload does not trigger a re-render. */
  const signature = (rows) =>
    rows
      .map((b) => `${b.busId}:${b.lat?.toFixed(5)}:${b.lon?.toFixed(5)}:${b.crowd}:${b.load}`)
      .sort()
      .join('|')

  /** Accepts normalised rows only. See the note above. */
  const apply = useCallback((rows) => {
    setBuses((prev) => (signature(prev) === signature(rows) ? prev : rows))
  }, [])

  useEffect(() => {
    let cancelled = false
    let graceTimer = null
    let retryTimer = null

    const stopPolling = () => {
      if (pollRef.current) {
        clearInterval(pollRef.current)
        pollRef.current = null
      }
    }

    const startPolling = () => {
      if (pollRef.current) return
      setTransport((t) => (t === 'ws' ? 'ws' : 'poll'))

      const tick = async () => {
        try {
          // Already normalised by the adapter - do NOT map again.
          apply(await getActiveBuses())
          setError(null)
        } catch (err) {
          if (cancelled) return
          setError(err?.message ?? 'Live feed unavailable')
        }
      }

      tick()
      pollRef.current = setInterval(tick, config.busPollIntervalMs)
    }

    const connect = () => {
      if (cancelled) return

      const url = busSocketUrl()
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
        retries.current = 0
        setTransport('ws')
        setError(null)
        // Raw wire frame, so this is the one place that maps.
        apply(payload.map(mapBusPosition))
      }

      ws.onerror = () => {
        // onclose always follows; reconnection is handled there.
      }

      ws.onclose = () => {
        clearTimeout(graceTimer)
        if (cancelled) return

        startPolling()
        const delay = Math.min(1000 * 2 ** retries.current, 15000)
        retries.current += 1
        retryTimer = setTimeout(connect, delay)
      }
    }

    connect()

    return () => {
      cancelled = true
      clearTimeout(graceTimer)
      clearTimeout(retryTimer)
      stopPolling()
    }
  }, [apply])

  return { buses, transport, error, isLive: transport === 'ws' }
}
