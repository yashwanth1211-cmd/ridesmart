import { useCallback, useEffect, useRef, useState } from 'react'
import { getAuthorityDashboard } from '@/lib/api'

/**
 * Authority KPIs from GET /api/authority/dashboard.
 *
 * Unlike the passenger plan these are pure counters, so there is no demo
 * fallback: inventing "84 total buses" for an authority view would be the worst
 * kind of lie, since that screen exists to be trusted. On failure it reports
 * zeros plus the error, and the panel says the feed is unavailable.
 */
export function useAuthority({ pollIntervalMs = 10000 } = {}) {
  const [kpis, setKpis] = useState(null)
  const [error, setError] = useState(null)
  const requestId = useRef(0)

  const load = useCallback(async ({ signal } = {}) => {
    const id = ++requestId.current
    try {
      const next = await getAuthorityDashboard({ signal })
      if (signal?.aborted || id !== requestId.current) return
      setKpis(next)
      setError(null)
    } catch (err) {
      if (signal?.aborted || err?.name === 'AbortError') return
      if (id !== requestId.current) return
      setError(err?.message ?? 'Authority feed unavailable')
    }
  }, [])

  useEffect(() => {
    const controller = new AbortController()
    const run = () => load({ signal: controller.signal })

    run()
    const timer = setInterval(run, pollIntervalMs)

    return () => {
      controller.abort()
      clearInterval(timer)
    }
  }, [load, pollIntervalMs])

  /*
    loading is DERIVED, not stored. Keeping a `loading` flag meant calling
    setState synchronously in the effect, which schedules a second render pass
    before the request has even left. "We have never had a successful response"
    is exactly the condition the panel needs, and it is already available.
  */
  const loading = kpis === null && error === null

  return { kpis, error, loading, refresh: () => load() }
}
