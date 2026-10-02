import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { useFrame, useThree } from '@react-three/fiber'
import { ScrollControls, useScroll } from '@react-three/drei'
import { ArrowRight, ChartLineUp, MapTrifold, Path } from '@phosphor-icons/react'
import { DASHBOARD_SCROLL, DEFAULT_JOURNEY } from '@/config/constants'
import { useJourney, useRouteStops, useStops } from '@/lib/useJourney'
import { useLiveBuses } from '@/lib/useLiveBuses'
import LiveMap from '@/components/map/LiveMap'
import JourneyPlanner from './JourneyPlanner'
import AuthorityPanel from './AuthorityPanel'
import CrowdIndicator from './CrowdIndicator'
import SourceBadge from './SourceBadge'
import FeedBadge from './FeedBadge'
import ScrollParallax from '@/components/3d/ScrollParallax'

/**
 * The post-boarding dashboard, staged inside the 3D scene as a PeachWorlds
 * style horizontal scroll.
 *
 * drei's <ScrollControls> owns a DOM scroll layer that overlays the canvas (it
 * is appended to the canvas host, so the glass pages literally float over the
 * bus interior). <Scroll html> renders that DOM from inside React Three Fiber
 * and translates it left as the offset goes 0..1; ScrollParallax slides the
 * parked camera sideways at the same time, so the pages read as moving past
 * the lens instead of a flat swipe.
 *
 * Three glass pages:
 *   1. Route planner & live map - the live bus map plus an always-on route bar
 *   2. Route search & list     - the full JourneyPlanner
 *   3. Authority & crowd       - the AuthorityPanel fleet view
 *
 * All live data is fetched HERE (one level above the pages) so the panels are
 * pure props-in / callbacks-out and the same journey state feeds the map, the
 * planner and the route polyline without separate polling instances.
 */

/** Lets inner scrollable regions own their wheel gesture. */
function WheelTrap({ children, className = '' }) {
  const ref = useRef(null)

  useEffect(() => {
    const node = ref.current
    if (!node) return undefined

    const onWheel = (event) => {
      const { target } = event
      if (!(target instanceof Element)) return
      // Option lists, route tables and the map canvas each have their own
      // scroll/zoom. Stopping bubbling here prevents drei's wheel handler on
      // the page-layer div from ALSO sliding the whole stage sideways.
      if (target.closest('.overflow-y-auto, .maplibregl-canvas')) event.stopPropagation()
    }

    node.addEventListener('wheel', onWheel, { passive: true })
    return () => node.removeEventListener('wheel', onWheel)
  }, [])

  return (
    <div ref={ref} className={className}>
      {children}
    </div>
  )
}

/**
 * The DOM side of ScrollControls, written instead of drei's <Scroll html>.
 *
 * drei's ScrollHtml does `ReactDOM.createRoot(state.fixed)` inside a useMemo,
 * and React StrictMode deliberately double-runs render bodies - so under
 * StrictMode (the app renders inside <StrictMode> in main.jsx) createRoot gets
 * called twice on the same container and React throws. This version creates the
 * root once in a guarded effect (with unmount on cleanup) and uses a plain
 * root.render() effect, which is StrictMode-safe, and otherwise mirrors drei:
 * the group carries `style` and is translated by -width*(pages-1)*offset on the
 * damped scroll offset, so the pages slide inside the sticky layer.
 *
 * The rendered children run in their own React root, like drei's. None of the
 * panels below use R3F hooks, so the fiber context does not need re-providing.
 */
function HorizonHtml({ children, style = {}, ...props }) {
  const scroll = useScroll()
  const groupRef = useRef(null)
  const rootRef = useRef(null)
  const { width } = useThree((s) => s.size)

  useLayoutEffect(() => {
    if (!rootRef.current) rootRef.current = createRoot(scroll.fixed)
    return () => {
      rootRef.current?.unmount()
      rootRef.current = null
    }
  }, [scroll.fixed])

  useEffect(() => {
    rootRef.current?.render(
      <div
        ref={groupRef}
        style={{ ...style, position: 'absolute', top: 0, left: 0, willChange: 'transform' }}
        {...props}
      >
        {children}
      </div>,
    )
  })

  useFrame(() => {
    const group = groupRef.current
    if (group && scroll.delta > scroll.eps) {
      group.style.transform = `translate3d(${
        scroll.horizontal ? -width * (scroll.pages - 1) * scroll.offset : 0
      }px, 0, 0)`
    }
  })

  return null
}

function PageEyebrow({ step, title, icon: Icon }) {
  return (
    <div className="flex items-center gap-2 text-[11px] font-medium tracking-[0.18em] text-gray-400 uppercase">
      <span className="rounded-md bg-white/10 px-1.5 py-0.5 font-mono text-gray-300">{step}</span>
      <span className="flex items-center gap-1.5">
        <Icon size={12} />
        {title}
      </span>
      <span className="h-px flex-1 bg-white/10" />
    </div>
  )
}

/** Compact From/To, mirroring JourneyPlanner's own stop picker. */
function StopSelect({ label, value, stops, onChange, id }) {
  return (
    <label className="flex min-w-0 flex-1 flex-col gap-1" htmlFor={id}>
      <span className="text-[10px] tracking-wide text-gray-500 uppercase">{label}</span>
      <select
        id={id}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="h-8 w-full rounded-lg border border-white/10 bg-black/40 px-2.5 text-[12px] text-white focus:border-brand-blue focus:outline-none"
      >
        {stops.length === 0 && <option value={value}>{value}</option>}
        {stops.map((stop) => (
          <option key={stop.code} value={stop.code} className="bg-gray-900">
            {stop.name}
          </option>
        ))}
      </select>
    </label>
  )
}

function RoutePlannerPage({
  journey,
  stops,
  buses,
  routeStops,
  from,
  to,
  onFromChange,
  onToChange,
  transport,
  error,
}) {
  const { plan, selected, source } = journey

  return (
    <WheelTrap className="h-full w-screen shrink-0 p-3 md:p-4">
      <div className="flex h-full min-h-0 flex-col gap-3">
        <div className="glass-panel relative min-h-0 flex-1 overflow-hidden p-1.5">
          <LiveMap
            buses={buses}
            routeStops={routeStops}
            origin={plan.origin}
            destination={plan.destination}
            selectedRouteCode={selected?.code ?? null}
            className="h-full rounded-2xl"
          />

          {/* live state, top-left */}
          <div className="absolute top-3 left-3 flex flex-wrap items-center gap-2">
            <span className="glass-panel-strong inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-[11px] font-medium text-white">
              <MapTrifold size={12} className="text-accent" />
              Live map
            </span>
            <FeedBadge transport={transport} count={buses.length} error={error} />
          </div>

          {/* route bar, bottom-left */}
          {plan.destination && (
            <div className="glass-panel-strong absolute right-3 bottom-3 left-3 flex flex-wrap items-center gap-x-4 gap-y-1 lg:right-auto lg:max-w-md">
              <span className="inline-flex items-center gap-1.5 text-[12px] text-gray-300">
                <span className="font-medium text-white">{plan.origin?.name ?? '—'}</span>
                <ArrowRight size={11} className="text-gray-500" />
                <span className="font-medium text-white">{plan.destination?.name ?? '—'}</span>
              </span>
              <span className="flex items-center gap-1.5">
                <SourceBadge source={source} />
              </span>
              {selected && (
                <span className="flex items-center gap-2">
                  <span className="rounded-md bg-brand-blue/20 px-2 py-0.5 text-[12px] font-medium text-accent">
                    {selected.code}
                  </span>
                  <span className="text-[12px] text-gray-300">{selected.etaMin ?? '—'} min</span>
                  <CrowdIndicator
                    level={selected.crowd}
                    load={selected.load}
                    capacity={selected.capacity}
                    compact
                  />
                </span>
              )}
            </div>
          )}

          {/* compact planner, top-right */}
          <div className="glass-panel-strong absolute top-3 right-3 flex max-w-[360px] flex-col gap-1.5 p-3">
            <span className="flex items-center gap-1.5 text-[10px] tracking-wide text-gray-500 uppercase">
              <Path size={12} className="text-accent" />
              Plan a route
            </span>
            <div className="flex items-center gap-2">
              <StopSelect
                id="horizon-from"
                label="From"
                value={from}
                stops={stops}
                onChange={onFromChange}
              />
              <span className="mt-3.5 text-gray-600">→</span>
              <StopSelect id="horizon-to" label="To" value={to} stops={stops} onChange={onToChange} />
            </div>
            <span className="text-[11px] text-gray-500">Compare every option on page two →</span>
          </div>
        </div>
      </div>
    </WheelTrap>
  )
}

function JourneySearchPage({
  journey,
  stops,
  buses,
  from,
  to,
  onFromChange,
  onToChange,
  accessibilityOnly,
  onAccessibilityOnlyChange,
}) {
  return (
    <WheelTrap className="h-full w-screen shrink-0 p-4 md:p-6">
      <div className="flex h-full min-h-0 flex-col gap-3">
        <PageEyebrow step="2" title="Route search & list" icon={Path} />
        <div className="min-h-0 flex-1">
          <JourneyPlanner
            journey={journey}
            stops={stops}
            buses={buses}
            from={from}
            to={to}
            onFromChange={onFromChange}
            onToChange={onToChange}
            accessibilityOnly={accessibilityOnly}
            onAccessibilityOnlyChange={onAccessibilityOnlyChange}
          />
        </div>
      </div>
    </WheelTrap>
  )
}

function AuthorityCrowdPage() {
  return (
    <WheelTrap className="h-full w-screen shrink-0 p-4 md:p-6">
      <div className="flex h-full min-h-0 flex-col gap-3">
        <PageEyebrow step="3" title="Authority dashboard & crowd analytics" icon={ChartLineUp} />
        <div className="min-h-0 flex-1">
          <AuthorityPanel />
        </div>
      </div>
    </WheelTrap>
  )
}

export default function HorizonDashboard() {
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
    <ScrollControls
      horizontal
      pages={DASHBOARD_SCROLL.pages}
      distance={DASHBOARD_SCROLL.distance}
      damping={DASHBOARD_SCROLL.damping}
      style={{ scrollbarWidth: 'none' }}
    >
      <ScrollParallax />
      <HorizonHtml style={{ width: '100vw', height: '100vh' }}>
        <div
          className="flex h-full flex-row flex-nowrap items-center"
          style={{ width: `${DASHBOARD_SCROLL.pages * 100}vw` }}
        >
          <RoutePlannerPage
            journey={journey}
            stops={stops}
            buses={buses}
            routeStops={routeStops}
            from={from}
            to={to}
            onFromChange={setFrom}
            onToChange={setTo}
            transport={transport}
            error={busError}
          />

          <JourneySearchPage
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

          <AuthorityCrowdPage />
        </div>
      </HorizonHtml>
    </ScrollControls>
  )
}