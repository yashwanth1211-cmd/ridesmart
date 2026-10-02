import { useEffect, useMemo, useState } from 'react'
import { getTripEtas } from '@/lib/api'

/**
 * Per-stop scheduled-vs-predicted arrivals for one running trip.
 *
 * This enriches PlanOption.stops[], which only carries eta_min - the minutes
 * REMAINING from boarding. That is enough to draw a timeline, but it cannot tell
 * a passenger whether the bus is running late or making up time at a particular
 * stop, which is exactly the question the delay badge raises one screen up.
 *
 * GET /api/trips/{id}/eta answers it properly:
 *
 *   [{ stop_id, stop_name, scheduled_min, predicted_min, delay_min }, ...]
 *
 * Two behaviours worth noting:
 *
 *  - It is keyed by trip, not by journey, so it is only requested when a bus is
 *    actually serving the selected route. There is no such thing as an ETA for
 *    a route with no active trip, and the timeline simply falls back to the
 *    planner's own numbers.
 *  - There is no demo fallback. A fabricated per-stop delay would look exactly
 *    like a real one, and this is the panel where a passenger decides whether to
 *    get on the bus. On failure it returns null and the UI carries on.
 */
export function useTripEtas(tripId) {
  /*
    The trip id is stored alongside the rows so a change of trip - or the
    selection becoming empty - is handled during render. Clearing a stored array
    inside the effect instead would schedule a second render pass on every
    selection change.
  */
  const [loaded, setLoaded] = useState({ tripId: null, rows: null })

  useEffect(() => {
    if (!tripId) return undefined

    const controller = new AbortController()

    getTripEtas(tripId, { signal: controller.signal })
      .then((rows) => {
        if (!controller.signal.aborted) setLoaded({ tripId, rows })
      })
      .catch(() => {
        if (!controller.signal.aborted) setLoaded({ tripId, rows: null })
      })

    return () => controller.abort()
  }, [tripId])

  /*
    Keyed by stop id so StopTimeline can merge the two sources: planner data
    provides the guaranteed origin->destination slice, this adds the delay
    detail for whichever stops happen to overlap.
  */
  return useMemo(() => {
    if (!tripId || loaded.tripId !== tripId) return {}
    return Object.fromEntries((loaded.rows ?? []).map((r) => [r.stopId, r]))
  }, [loaded, tripId])
}
