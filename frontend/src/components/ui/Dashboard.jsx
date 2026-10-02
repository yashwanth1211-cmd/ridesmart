import { useEffect, useMemo, useState } from 'react'
import {
  MapTrifold,
  Path,
  ChartLineUp,
  MagnifyingGlass,
  CloudCheck,
  Clock,
} from '@phosphor-icons/react'
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
 * The passenger app shell, built directly on the product UI video
 * (public/ui.mp4 - the design video, looping muted behind the panels). That
 * video is a warm dark bus map, so the console sits on a dark gradient veil
 * over it with translucent amber-tinted glass: a vertical view rail, the live
 * map with a floating "ETA predictive" card and a Q-search fleet filter, and
 * a metrics strip at the foot.
 *
 * The README's demo script is the spec for the layout underneath:
 *   1. map shows buses moving live
 *   2. plan a journey
 *   3. compare the options
 *   4. change a bus's crowd and watch the ranking shift
 *   5. authority dashboard
 *
 * which maps onto the three views. The journey state is held HERE rather than
 * inside the planner, so switching to the map keeps the selected route and its
 * polyline instead of resetting to defaults.
 */

const VIEWS = [
  { id: 'map', label: 'Live map', icon: MapTrifold },
  { id: 'planner', label: 'Journey planner', icon: Path },
  { id: 'authority', label: 'Authority', icon: ChartLineUp },
]

function RouteChips({ origin, destination }) {
  if (!destination) return null
  return (
    <div className="pointer-events-none absolute top-3 left-3 z-10 flex max-w-[85%] flex-wrap items-center gap-1.5">
      <span className="glass-panel-strong rounded-md px-2 py-1 text-[11px] font-medium text-white">
        {origin?.name ?? '—'}
      </span>
      <span className="text-[11px] text-amber-300">→</span>
      <span className="glass-panel-strong rounded-md px-2 py-1 text-[11px] font-medium text-white">
        {destination.name}
      </span>
    </div>
  )
}

/**
 * The floating "ETA predictive" card, mirroring the one that overlay the live
 * map in the product UI frame: predicted time, arrival clock, current speed
 * and the destination, on an amber-lit sheet.
 */

/**
 * A render-safe clock. `Date.now()` during render breaks the purity rules the
 * app lints for, so the "arrives" stamp ticks here on a slow interval and the
 * card only reads state.
 */
function useNow(intervalMs = 15000) {
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), intervalMs)
    return () => clearInterval(timer)
  }, [intervalMs])

  return now
}

function EtaCard({ journey, buses }) {
  const { selected, plan } = journey
  const now = useNow()
  const leadingSpeed = Math.max(0, ...buses.map((b) => b.speedKmph ?? 0))
  const arrival = selected
    ? new Date(now + (selected.etaMin ?? 0) * 60000).toLocaleTimeString([], {
        hour: '2-digit',
        minute: '2-digit',
      })
    : null

  return (
    <div className="pointer-events-none absolute bottom-3 left-3 z-10 w-52">
      <div className="glass-panel-strong rounded-xl p-3 border-amber-400/25 glow-amber">
        <p className="flex items-center gap-1.5 text-[9px] font-semibold tracking-[0.2em] text-amber-300 uppercase">
          <Clock size={12} />
          ETA predictive
        </p>

        <p className="mt-1 font-mono text-2xl leading-none font-semibold text-amber-200">
          {selected ? `${selected.etaMin ?? '—'} min` : '—'}
        </p>

        <dl className="mt-2 flex flex-col gap-1 text-[11px] text-gray-300">
          {selected && (
            <div className="flex items-center justify-between gap-2">
              <dt className="text-gray-500">Arrives</dt>
              <dd className="font-mono text-amber-100">{arrival}</dd>
            </div>
          )}
          <div className="flex items-center justify-between gap-2">
            <dt className="text-gray-500">Speed</dt>
            <dd className="font-mono text-amber-100">{Math.round(leadingSpeed)} km/h</dd>
          </div>
          <div className="flex items-center justify-between gap-2">
            <dt className="text-gray-500">Route</dt>
            <dd className="truncate text-white">{selected?.code ?? '—'}</dd>
          </div>
        </dl>

        {plan.destination && (
          <p className="mt-2 border-t border-white/10 pt-1.5 text-[10px] text-gray-400">
            to {plan.destination.name}
          </p>
        )}
      </div>
    </div>
  )
}

function MapView({ buses, journey, routeStops, transport, error, query }) {
  const { plan, selected, source } = journey
  const [focusedBusId, setFocusedBusId] = useState(null)

  const focused = buses.find((b) => b.busId === focusedBusId) ?? null

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return buses
    return buses.filter(
      (b) =>
        b.routeCode?.toLowerCase().includes(q) ||
        b.reg?.toLowerCase().includes(q) ||
        String(b.busId).includes(q),
    )
  }, [buses, query])

  return (
    <div className="grid h-full min-h-0 grid-cols-1 gap-3 lg:grid-cols-[minmax(0,1fr)_320px]">
      <div className="glass-warm relative overflow-hidden p-1">
        <LiveMap
          buses={buses}
          routeStops={routeStops}
          origin={plan.origin}
          destination={plan.destination}
          selectedRouteCode={selected?.code ?? null}
          onSelectBus={setFocusedBusId}
          className="h-full min-h-[320px] rounded-lg"
        />
        <RouteChips origin={plan.origin} destination={plan.destination} />
        <EtaCard journey={journey} buses={buses} />
      </div>

      <div className="flex min-h-0 flex-col gap-3 overflow-y-auto scroll-slim">
        <section className="glass-warm flex flex-col gap-3 p-4">
          <header className="flex items-center justify-between gap-3">
            <h2 className="text-[13px] font-medium text-white">Fleet</h2>
            <FeedBadge transport={transport} count={buses.length} error={error} />
          </header>

          {visible.length === 0 ? (
            <p className="rounded-lg border border-dashed border-white/10 px-3 py-6 text-center text-[12px] text-gray-400">
              {buses.length === 0
                ? 'No buses reporting. Start the simulator:'
                : 'No buses match your search.'}
              {buses.length === 0 && (
                <code className="mt-1 block text-[11px] text-gray-500">
                  python -m simulation_ml.simulate --speed 5 --interval 2
                </code>
              )}
            </p>
          ) : (
            <ul className="flex flex-col gap-2">
              {visible.map((bus) => (
                <li key={bus.busId}>
                  <button
                    type="button"
                    onClick={() => setFocusedBusId(bus.busId === focusedBusId ? null : bus.busId)}
                    className={`glass-inset flex w-full items-center gap-3 px-3 py-2.5 text-left transition-colors hover:bg-white/10 ${
                      bus.busId === focusedBusId ? 'border-amber-400/50' : ''
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
          <section className="glass-warm flex flex-col gap-3 p-4">
            <h2 className="text-[13px] font-medium text-white">
              {focused.routeCode ?? 'Bus'} · {focused.reg ?? focused.busId}
            </h2>
            <CrowdIndicator level={focused.crowd} load={focused.load} capacity={focused.capacity} />
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
          <section className="glass-warm flex flex-col gap-2 p-4">
            <div className="flex items-center justify-between gap-3">
              <h2 className="text-[13px] font-medium text-white">Selected journey</h2>
              <SourceBadge source={source} />
            </div>
            <p className="text-[12px] text-gray-300">
              {plan.origin?.name ?? '—'} → {plan.destination?.name ?? '—'}
            </p>
            {selected && (
              <p className="text-[11px] text-gray-400">
                Showing route {selected.code} on the map · {selected.etaMin ?? '—'} min
              </p>
            )}
          </section>
        )}
      </div>
    </div>
  )
}

function MetricsBar({ buses, transport }) {
  const total = buses.length
  const moving = buses.filter((b) => (b.speedKmph ?? 0) > 0).length
  const delayed = buses.filter((b) => (b.delayMin ?? 0) > 0).length
  const avgSpeed =
    total > 0 ? Math.round(buses.reduce((sum, b) => sum + (b.speedKmph ?? 0), 0) / total) : 0

  const items = [
    ['In service', total],
    ['Moving', moving],
    ['Avg speed', `${avgSpeed} km/h`],
    ['Delayed', delayed],
  ]

  return (
    <footer className="glass-warm flex flex-wrap items-center gap-x-6 gap-y-1 px-4 py-2">
      {items.map(([label, value]) => (
        <dl key={label} className="flex items-baseline gap-1.5 text-[11px]">
          <dt className="text-gray-500">{label}</dt>
          <dd className="font-mono text-amber-100">{value}</dd>
        </dl>
      ))}
      <span className="ml-auto inline-flex items-center gap-1.5 text-[11px] text-gray-400">
        <CloudCheck size={13} className="text-amber-300" />
        {transport === 'ws' ? 'Live feed' : transport === 'poll' ? 'Polling' : 'Connecting…'}
      </span>
    </footer>
  )
}

export default function Dashboard() {
  const [view, setView] = useState('map')
  const [query, setQuery] = useState('')

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
    <div className="relative flex h-full min-h-0 flex-col gap-3 p-3 md:p-4">
      {/* The product UI video as the base layer, muted and dimmed just enough
          for the glass panels to stay legible. It loops the same RideSmart
          route-tracking screen the real console reconstructs live. */}
      <video
        src="/ui.mp4"
        autoPlay
        muted
        loop
        playsInline
        poster="/ui-final.png"
        aria-hidden
        className="absolute inset-0 -z-10 h-full w-full object-cover"
      />
      <div
        aria-hidden
        className="absolute inset-0 -z-10"
        style={{
          background: 'linear-gradient(180deg, rgba(10,8,6,0.55), rgba(10,8,6,0.1) 45%, rgba(8,6,4,0.55))',
        }}
      />

      {/* ---- header ---- */}
      <header className="glass-warm flex flex-wrap items-center gap-x-4 gap-y-2 rounded-xl px-4 py-2.5 md:py-3">
        <div className="flex items-center gap-3">
          <span className="rounded-md bg-amber-400/90 px-2 py-1 text-[11px] font-semibold text-black glow-amber">
            RideSmart
          </span>
          <h1 className="hidden items-center gap-2 text-[13px] font-medium text-white md:flex">
            <span className="h-2 w-2 rounded-full bg-emerald-400 glow-blue" />
            Route tracking
          </h1>
        </div>

        <div className="ml-auto flex min-w-0 items-center gap-2">
          <label className="relative hidden sm:block">
            <MagnifyingGlass
              size={13}
              className="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-gray-400"
            />
            <input
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Q Search fleet"
              aria-label="Q Search fleet"
              className="h-8 w-40 rounded-lg border border-white/10 bg-black/35 pl-8 pr-3 text-[12px] text-white transition-colors placeholder:text-gray-500 focus:border-amber-400/50 focus:outline-none lg:w-56"
            />
          </label>

          <FeedBadge transport={transport} count={buses.length} error={busError} />
        </div>
      </header>

      {/* ---- body: view rail + active view ---- */}
      <div className="flex min-h-0 flex-1 gap-3">
        <nav
          aria-label="Views"
          className="glass-warm flex w-44 shrink-0 flex-col items-stretch gap-1 rounded-xl p-1.5"
        >
          {VIEWS.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              type="button"
              onClick={() => setView(id)}
              aria-current={view === id ? 'page' : undefined}
              title={label}
              className={`inline-flex h-10 items-center gap-2 rounded-lg px-3 text-[12px] transition-colors ${
                view === id
                  ? 'bg-amber-400/15 font-medium text-amber-300'
                  : 'text-gray-300 hover:bg-white/10 hover:text-white'
              }`}
            >
              <Icon size={16} />
              <span>{label}</span>
            </button>
          ))}
        </nav>

        <main className="relative min-h-0 flex-1">
          {view === 'map' && (
            <MapView
              buses={buses}
              journey={journey}
              routeStops={routeStops}
              transport={transport}
              error={busError}
              query={query}
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

      {/* ---- foot: fleet metrics strip ---- */}
      <MetricsBar buses={buses} transport={transport} />
    </div>
  )
}