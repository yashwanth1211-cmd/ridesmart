import { useState } from 'react'
import { Link } from 'react-router-dom'
import { MapTrifold, Path, ChartLineUp, ArrowCounterClockwise } from '@phosphor-icons/react'
import { DEFAULT_JOURNEY } from '@/config/constants'
import { useJourney, useRouteStops, useStops } from '@/lib/useJourney'
import { useLiveBuses } from '@/lib/useLiveBuses'
import LiveMap from '@/components/map/LiveMap'
import AuthorityPanel from './AuthorityPanel'
import JourneyPlanner from './JourneyPlanner'
import CrowdIndicator from './CrowdIndicator'
import SourceBadge from './SourceBadge'
import FeedBadge from './FeedBadge'

/**
 * The passenger app shell.
 *
 * The README's demo script is the spec for this layout:
 *   1. map shows buses moving live
 *   2. plan a journey
 *   3. compare the options
 *   4. change a bus's crowd and watch the ranking shift
 *   5. authority dashboard
 *
 * which maps onto three tabs. The journey state is held HERE rather than inside
 * the planner, so switching to the map keeps the selected route and its polyline
 * instead of resetting to defaults.
 */

const VIEWS = [
  { id: 'map', label: 'Live map', icon: MapTrifold },
  { id: 'planner', label: 'Journey planner', icon: Path },
  { id: 'authority', label: 'Authority', icon: ChartLineUp },
]

function MapView({ buses, journey, routeStops, transport, error }) {
  const { plan, selected, source } = journey
  const [focusedBusId, setFocusedBusId] = useState(null)

  const focused = buses.find((b) => b.busId === focusedBusId) ?? null

  return (
    <div className="grid h-full min-h-0 grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1fr)_320px]">
      <div className="glass-panel overflow-hidden p-1.5">
        <LiveMap
          buses={buses}
          routeStops={routeStops}
          origin={plan.origin}
          destination={plan.destination}
          selectedRouteCode={selected?.code ?? null}
          onSelectBus={setFocusedBusId}
          className="h-full min-h-[320px] rounded-xl"
        />
      </div>

      <div className="flex min-h-0 flex-col gap-4 overflow-y-auto scroll-slim">
        <section className="glass-panel flex flex-col gap-3 p-4">
          <header className="flex items-center justify-between gap-3">
            <h2 className="text-[13px] font-medium text-white">Fleet</h2>
            <FeedBadge transport={transport} count={buses.length} error={error} />
          </header>

          {buses.length === 0 ? (
            <p className="rounded-lg border border-dashed border-white/10 px-3 py-6 text-center text-[12px] text-gray-400">
              No buses reporting. Start the simulator:
              <br />
              <code className="mt-1 block text-[11px] text-gray-500">
                python -m simulation_ml.simulate --speed 5 --interval 2
              </code>
            </p>
          ) : (
            <ul className="flex flex-col gap-2">
              {buses.map((bus) => (
                <li key={bus.busId}>
                  <button
                    type="button"
                    onClick={() => setFocusedBusId(bus.busId === focusedBusId ? null : bus.busId)}
                    className={`glass-inset flex w-full items-center gap-3 px-3 py-2.5 text-left transition-colors hover:bg-white/10 ${
                      bus.busId === focusedBusId ? 'border-brand-blue/60' : ''
                    }`}
                  >
                    <span className="flex w-12 shrink-0 flex-col">
                      <span className="text-[13px] font-medium text-white">{bus.routeCode ?? '—'}</span>
                      <span className="text-[10px] text-gray-500">{bus.reg ?? `bus ${bus.busId}`}</span>
                    </span>

                    <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                      <CrowdIndicator
                        level={bus.crowd}
                        load={bus.load}
                        capacity={bus.capacity}
                        compact
                      />
                      <span className="truncate text-[11px] text-gray-500">
                        {bus.nextStopName ? `next: ${bus.nextStopName}` : 'no next stop reported'}
                      </span>
                    </span>

                    <span className="shrink-0 text-[12px] text-gray-400">
                      {Math.round(bus.speedKmph ?? 0)} km/h
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>

        {focused && (
          <section className="glass-panel flex flex-col gap-3 p-4">
            <h2 className="text-[13px] font-medium text-white">
              {focused.routeCode ?? 'Bus'} · {focused.reg ?? focused.busId}
            </h2>
            <CrowdIndicator
              level={focused.crowd}
              load={focused.load}
              capacity={focused.capacity}
            />
            <dl className="grid grid-cols-2 gap-2 text-[12px]">
              {[
                ['Speed', `${Math.round(focused.speedKmph ?? 0)} km/h`],
                ['Heading', `${Math.round(focused.heading ?? 0)}°`],
                ['Wheelchair', focused.wheelchair ? 'Yes' : 'No'],
                ['Low floor', focused.lowFloor ? 'Yes' : 'No'],
              ].map(([label, value]) => (
                <div key={label} className="glass-inset px-3 py-2">
                  <dt className="text-[10px] text-gray-500">{label}</dt>
                  <dd className="text-gray-200">{value}</dd>
                </div>
              ))}
            </dl>
            {focused.ts && (
              <p className="text-[10px] text-gray-500">
                last fix {new Date(focused.ts).toLocaleTimeString()}
              </p>
            )}
          </section>
        )}

        {plan.destination && (
          <section className="glass-panel flex flex-col gap-2 p-4">
            <div className="flex items-center justify-between gap-3">
              <h2 className="text-[13px] font-medium text-white">Selected journey</h2>
              <SourceBadge source={source} />
            </div>
            <p className="text-[12px] text-gray-300">
              {plan.origin?.name ?? '—'} → {plan.destination?.name ?? '—'}
            </p>
            {selected && (
              <p className="text-[11px] text-gray-500">
                Showing route {selected.code} on the map · {selected.etaMin ?? '—'} min
              </p>
            )}
          </section>
        )}
      </div>
    </div>
  )
}

export default function Dashboard() {
  const [view, setView] = useState('map')

  const [from, setFrom] = useState(DEFAULT_JOURNEY.from)
  const [to, setTo] = useState(DEFAULT_JOURNEY.to)
  const [accessibilityOnly, setAccessibilityOnly] = useState(false)

  const { stops } = useStops()
  const journey = useJourney({ from, to, accessibilityOnly })
  const { buses, transport, error: busError } = useLiveBuses()

  const routeStops = useRouteStops(journey.selected?.routeId, {
    fromId: journey.plan.origin?.id,
    toId: journey.plan.destination?.id,
  })

  return (
    <div className="flex h-full min-h-0 flex-col gap-4 p-4 md:p-6">
      {/* ---- header ---- */}
      <header className="glass-panel flex flex-wrap items-center justify-between gap-3 px-4 py-3">
        <div className="flex items-center gap-3">
          <span className="rounded-md bg-brand-red/80 px-2 py-1 text-[11px] font-medium text-white glow-red">
            RideSmart
          </span>
          <nav className="flex items-center gap-1" aria-label="Views">
            {VIEWS.map(({ id, label, icon: Icon }) => (
              <button
                key={id}
                type="button"
                onClick={() => setView(id)}
                aria-current={view === id ? 'page' : undefined}
                className={`inline-flex h-8 items-center gap-1.5 rounded-lg px-3 text-[12px] transition-colors ${
                  view === id
                    ? 'bg-brand-blue/20 text-accent'
                    : 'text-gray-300 hover:bg-white/10 hover:text-white'
                }`}
              >
                <Icon size={14} />
                <span className="hidden sm:inline">{label}</span>
              </button>
            ))}
          </nav>
        </div>

        <div className="flex items-center gap-2">
          <FeedBadge transport={transport} count={buses.length} error={busError} />
          <Link
            to="/board"
            className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-white/10 px-2.5 text-[12px] text-gray-300 transition-colors hover:bg-white/10 hover:text-white"
          >
            <ArrowCounterClockwise size={13} />
            <span className="hidden sm:inline">Boarding intro</span>
          </Link>
        </div>
      </header>

      {/* ---- active view ---- */}
      <main className="min-h-0 flex-1">
        {view === 'map' && (
          <MapView
            buses={buses}
            journey={journey}
            routeStops={routeStops}
            transport={transport}
            error={busError}
          />
        )}

        {view === 'planner' && (
          <JourneyPlanner
            journey={journey}
            stops={stops}
            buses={buses}
            from={from}
            to={to}
            onFromChange={setFrom}
            onToChange={setTo}
            accessibilityOnly={accessibilityOnly}
            onAccessibilityOnlyChange={setAccessibilityOnly}
          />
        )}

        {view === 'authority' && <AuthorityPanel />}
      </main>
    </div>
  )
}
