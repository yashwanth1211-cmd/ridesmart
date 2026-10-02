import { Bus, Broadcast, Clock, TrendUp, WarningCircle, Users } from '@phosphor-icons/react'
import { CROWD_LEVELS } from '@/config/constants'
import { useAuthority } from '@/lib/useAuthority'
import { normalizeCrowd } from '@/lib/api'

/**
 * Transport-authority view, fed by GET /api/authority/dashboard.
 *
 * Unlike the passenger planner this screen has NO demo fallback, and that is a
 * deliberate asymmetry. Passenger-facing ETAs are useful even when stale, so
 * degrading to clearly-labelled demo data is reasonable. Authority KPIs are
 * counters people make deployment decisions from - "84 buses, 12 delayed" must
 * never be a hardcoded number that looks live. On failure this says so.
 */

function Kpi({ label, value, hint, icon: Icon, tone = 'default' }) {
  const toneClass =
    tone === 'warn' ? 'text-busy' : tone === 'ok' ? 'text-ok' : 'text-white'

  return (
    <div className="glass-inset flex flex-col gap-1 px-4 py-3">
      <span className="flex items-center gap-1.5 text-[11px] text-gray-400">
        {Icon && <Icon size={12} />}
        {label}
      </span>
      <span className={`text-2xl leading-none font-medium ${toneClass}`}>{value}</span>
      {hint && <span className="text-[11px] text-gray-500">{hint}</span>}
    </div>
  )
}

export default function AuthorityPanel() {
  const { kpis, error, loading } = useAuthority()

  if (loading && !kpis) {
    return (
      <div className="glass-panel flex h-full items-center justify-center p-8">
        <p className="text-[13px] text-gray-400">Loading authority KPIs…</p>
      </div>
    )
  }

  if (error && !kpis) {
    return (
      <div className="glass-panel flex h-full flex-col items-center justify-center gap-2 p-8 text-center">
        <WarningCircle size={22} className="text-busy" />
        <p className="text-[13px] text-gray-200">Authority feed unavailable</p>
        <p className="max-w-sm text-[12px] text-gray-500">
          {error}. This screen shows live fleet counters, so it shows nothing rather than
          placeholder numbers. Check that the API is running on port 8000.
        </p>
      </div>
    )
  }

  const delayedShare =
    kpis.activeBuses > 0 ? Math.round((kpis.delayedBuses / kpis.activeBuses) * 100) : null

  return (
    <div className="flex h-full min-h-0 flex-col gap-4">
      <section className="glass-panel flex flex-col gap-3 p-4">
        <header className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="flex items-center gap-2 text-[13px] font-medium text-white">
            <Broadcast size={14} className="text-accent" />
            Fleet status
          </h2>
          {error && (
            <span className="text-[11px] text-busy">Last refresh failed — showing last good data</span>
          )}
        </header>

        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <Kpi label="Total buses" value={kpis.totalBuses} icon={Bus} />
          <Kpi label="Active" value={kpis.activeBuses} icon={Broadcast} tone="ok" />
          <Kpi
            label="Delayed"
            value={kpis.delayedBuses}
            icon={Clock}
            tone={kpis.delayedBuses > 0 ? 'warn' : 'default'}
            hint={delayedShare === null ? null : `${delayedShare}% of active`}
          />
          <Kpi
            label="Average delay"
            value={kpis.avgDelayMin === null ? '—' : `${kpis.avgDelayMin.toFixed(1)} min`}
            icon={TrendUp}
          />
        </div>

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div className="glass-inset flex items-center justify-between gap-3 px-4 py-3">
            <span className="text-[12px] text-gray-400">Highest demand route</span>
            <span className="rounded-md bg-accent/20 px-2 py-1 text-[13px] font-medium text-accent">
              {kpis.highDemandRoute ?? '—'}
            </span>
          </div>
          <div className="glass-inset flex items-center justify-between gap-3 px-4 py-3">
            <span className="text-[12px] text-gray-400">Most crowded route</span>
            <span className="rounded-md bg-brand-red/20 px-2 py-1 text-[13px] font-medium text-busy">
              {kpis.crowdedRoute ?? '—'}
            </span>
          </div>
        </div>
      </section>

      <section className="glass-panel flex min-h-0 flex-1 flex-col gap-3 p-4">
        <header className="flex items-center justify-between gap-3">
          <h2 className="text-[13px] font-medium text-white">Per-route breakdown</h2>
          <span className="text-[11px] text-gray-400">{kpis.routes.length} routes</span>
        </header>

        <div className="scroll-slim -mr-2 min-h-0 flex-1 overflow-y-auto pr-2">
          <table className="w-full border-collapse text-left">
            <thead>
              <tr className="text-[11px] tracking-wide text-gray-400 uppercase">
                <th className="py-2 pr-3 font-medium">Route</th>
                <th className="py-2 pr-3 font-medium">Trips</th>
                <th className="py-2 pr-3 font-medium">Avg delay</th>
                <th className="py-2 pr-3 font-medium">Crowding</th>
                <th className="py-2 font-medium">Demand</th>
              </tr>
            </thead>
            <tbody>
              {kpis.routes.map((route) => {
                const crowd = normalizeCrowd(null, { ratio: route.avgCrowdRatio })
                const band = CROWD_LEVELS[crowd]

                return (
                  <tr key={route.routeId} className="border-t border-white/5 text-[13px]">
                    <td className="py-2.5 pr-3 font-medium text-white">{route.code}</td>
                    <td className="py-2.5 pr-3 text-gray-300">{route.activeTrips}</td>
                    <td className="py-2.5 pr-3 text-gray-300">
                      {route.avgDelayMin === null ? '—' : `${route.avgDelayMin.toFixed(1)} min`}
                    </td>
                    <td className="py-2.5 pr-3">
                      <span className="inline-flex items-center gap-1.5">
                        <span
                          className="h-2 w-2 rounded-full"
                          style={{ backgroundColor: band.color }}
                        />
                        <span className="text-gray-300">
                          {route.avgCrowdRatio === null
                            ? '—'
                            : `${Math.round(route.avgCrowdRatio * 100)}%`}
                        </span>
                      </span>
                    </td>
                    <td className="py-2.5 text-gray-300">
                      {route.demandScore === null ? '—' : route.demandScore.toFixed(1)}
                    </td>
                  </tr>
                )
              })}

              {kpis.routes.length === 0 && (
                <tr>
                  <td colSpan={5} className="py-8 text-center text-[13px] text-gray-400">
                    No per-route statistics yet. Run the simulator to generate traffic.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        <p className="flex items-center gap-1.5 text-[11px] text-gray-500">
          <Users size={12} />
          Crowding bands use the contract thresholds: low &lt; 40%, medium &lt; 75%, high above.
        </p>
      </section>
    </div>
  )
}
