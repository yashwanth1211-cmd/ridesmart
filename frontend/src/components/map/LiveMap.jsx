import { useEffect, useRef } from 'react'
import { LngLatBounds, Map as MapLibreMap, NavigationControl, Popup, setWorkerUrl } from 'maplibre-gl'
import 'maplibre-gl/dist/maplibre-gl.css'
import MapLibreWorker from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url'

/*
 * Point MapLibre at a properly bundled worker.
 *
 * By default MapLibre resolves its worker relative to its own import.meta.url.
 * Under Vite that is the pre-bundled dep chunk, so the derived path is a
 * sibling "maplibre-gl-worker.mjs" that was never emitted. The symptom is subtle
 * and reads like a styling bug: the map canvas mounts and the GeoJSON sources
 * work, but every raster tile request dies with "Worker failed to load. Check
 * that the worker URL is correct." and you get an empty grey background.
 *
 * The suffix matters and the obvious version is a trap:
 *
 *   ?url          copies the file VERBATIM. maplibre-gl-worker.mjs imports
 *                 "./maplibre-gl-shared.mjs", which is not part of the public
 *                 package export map, so nothing emits that file and the worker
 *                 404s on its very first import. It works in dev (Vite serves
 *                 straight out of node_modules) and breaks in the build - the
 *                 worst possible failure mode.
 *
 *   ?worker&url   compiles the worker as its own entry, bundling its imports,
 *                 then hands back the URL. Correct in dev and in production.
 */
setWorkerUrl(MapLibreWorker)
import { CROWD_LEVELS, MAP_DEFAULTS, MAP_STYLE } from '@/config/constants'

/**
 * Live map of the selected journey's legs, drawn with MapLibre GL as the
 * README's tech stack requires.
 *
 * Design notes:
 *  - The map instance is created once and NEVER re-created. Re-creating it on a
 *    prop change would reset the user's pan and zoom every time a bus moved.
 *    Instead the latest props are held in a ref and a sync() function pushes
 *    them into the existing sources via setData().
 *  - Buses are a GeoJSON source + circle layer, not DOM markers. At 2-second
 *    update intervals with a handful of buses either is fine, but a symbol
 *    layer keeps hundreds of vehicles cheap and avoids React reconciliation on
 *    the map subtree entirely.
 *  - The road polylines are the SLICED shapes the journey payload carries
 *    (buildJourneyLegs), one per leg, so what is drawn is exactly the road the
 *    selected option drives between the two stops - no whole-route fetch, and
 *    no step where the drawn line and the listed stops can drift apart.
 *
 * SCOPE. The map draws exactly the selected journey's legs, or nothing. There
 * is one 'route' source (one LineString per leg, coloured per leg), one 'stops'
 * source (each leg's stops, same colours) and one 'buses' source (only buses on
 * the leg routes, tinted by their leg). Each source is replaced wholesale
 * through setData(), so a previous selection cannot survive the next one. With
 * zero legs the map is emptied: no polyline, no stops, no buses, no endpoints.
 * Do not add a layer that ignores the legs - an earlier version of this file
 * drew the whole network because selection was only ever applied as a paint
 * filter (a highlight halo), which changed how a bus looked without ever
 * removing one.
 */

const EMPTY = { type: 'FeatureCollection', features: [] }

function toCollection(items, map) {
  return {
    type: 'FeatureCollection',
    features: items
      .filter((item) => Number.isFinite(item.lon) && Number.isFinite(item.lat))
      .map((item) => ({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [item.lon, item.lat] },
        properties: map(item),
      })),
  }
}

/** The coordinates to draw a leg with: its sliced shape, or its stops' joins. */
function legCoords(leg) {
  if (Array.isArray(leg.shape) && leg.shape.length >= 2) {
    return leg.shape.filter((p) => Array.isArray(p) && p.length >= 2)
  }
  return (leg.stops ?? []).map((s) => [s.lon, s.lat])
}

export default function LiveMap({
  legs = [],
  buses = [],
  origin = null,
  destination = null,
  fastest = false,
  onSelectBus = null,
  className = '',
}) {
  const containerRef = useRef(null)
  const mapRef = useRef(null)
  const readyRef = useRef(false)
  const latest = useRef({})
  const popupRef = useRef(null)
  const fittedLegsRef = useRef('')

  latest.current = {
    legs,
    buses,
    origin,
    destination,
    fastest,
    onSelectBus,
  }

  /** Pushes the current ref'd props into the map's sources. Safe to call often. */
  const sync = () => {
    const map = mapRef.current
    if (!map || !readyRef.current) return

    const {
      legs: currentLegs,
      buses: allBuses,
      origin: o,
      destination: d,
      onSelectBus: cb,
    } = latest.current

    // Only buses on the legs' routes can be drawn. useLiveBuses already scopes
    // its fetch to those routes, so this filter should never remove anything.
    // It stays because it is the last line of defence between a prop and the
    // map: a future caller passing a fleet-wide array cannot regress that.
    const legRouteIds = currentLegs.map((l) => l.routeId)
    const colorByRoute = new Map(currentLegs.map((l) => [l.routeId, l.color]))
    const keyedBusIds = new Set(currentLegs.flatMap((l) => l.busIds ?? []))

    const b = currentLegs.length === 0 ? [] : allBuses.filter((x) => legRouteIds.includes(x.routeId))

    const busGeo = toCollection(b, (x) => ({
      busId: x.busId,
      tripId: x.tripId,
      routeId: x.routeId,
      routeCode: x.routeCode ?? '',
      // The reference a passenger reads on the marker; reg stays for detail.
      name: x.name ?? '',
      reg: x.reg ?? '',
      crowd: x.crowd,
      load: x.load,
      capacity: x.capacity,
      speed: Math.round(x.speedKmph ?? 0),
      nextStop: x.nextStopName ?? '',
      // Tint the marker by which leg its route belongs to, and single out the
      // offered vehicle (the option's own bus) with a stronger ring.
      color: colorByRoute.get(x.routeId) ?? '#4f8cff',
      keyed: keyedBusIds.has(x.busId),
    }))

    // One LineString per leg, each carrying its own colour in the properties so
    // a transfer draws as two visibly distinct roads on one source.
    const routeFeatures = currentLegs
      .map((leg) => {
        const coords = legCoords(leg)
        return coords.length < 2
          ? null
          : {
              type: 'Feature',
              geometry: { type: 'LineString', coordinates: coords },
              properties: { color: leg.color, code: leg.code },
            }
      })
      .filter(Boolean)

    // Each leg's stops as their own markers, coloured to match the leg they
    // belong to, so the interchange of a transfer is visibly shared.
    const stopItems = currentLegs.flatMap((leg) =>
      (leg.stops ?? []).map((s) => ({ ...s, color: leg.color, legCode: leg.code })),
    )

    map.getSource('buses')?.setData(busGeo)
    map.getSource('route')?.setData(
      routeFeatures.length
        ? { type: 'FeatureCollection', features: routeFeatures }
        : EMPTY,
    )
    map.getSource('stops')?.setData(toCollection(stopItems, (s) => ({
      stopId: s.stopId ?? null,
      name: s.name ?? '',
      legCode: s.legCode ?? '',
      color: s.color ?? '#4f8cff',
    })))

    // Endpoints belong to the journey, not the route, so they follow
    // plan.origin/plan.destination. With no legs there is no journey worth
    // marking.
    map.getSource('endpoints')?.setData(
      toCollection(currentLegs.length === 0 ? [] : [o, d].filter(Boolean), (s, index) => ({
        // origin first, destination second - the same order the array arrives in.
        kind: index === 0 ? 'origin' : 'destination',
      })),
    )

    // Frame the journey the moment its legs resolve. Keyed on the leg id set,
    // NOT on a coordinate signature: the geometry arrives WITH the selection in
    // the journey payload, so a signature cannot distinguish "the user picked a
    // different journey" from "this journey has no geometry yet" - that split
    // only existed when the shape was fetched separately. Clearing the legs
    // resets the key, or re-picking the same journey later would skip the refit.
    const fitCoords = currentLegs.flatMap((leg) => legCoords(leg))
    const legSignature = currentLegs.length ? currentLegs.map((l) => l.routeId).join('|') : ''

    if (currentLegs.length === 0) {
      fittedLegsRef.current = ''
    } else if (fitCoords.length > 1 && fittedLegsRef.current !== legSignature) {
      fittedLegsRef.current = legSignature
      const bounds = new LngLatBounds()
      // Prevent an empty bounds object when every leg somehow lacks points.
      fitCoords.slice(0, 2).forEach((c) => bounds.extend(c))
      fitCoords.forEach((c) => bounds.extend(c))
      map.fitBounds(bounds, { padding: 90, maxZoom: 15, duration: 900 })
    }

    if (cb) {
      map.__onSelectBus = cb
    }
  }

  useEffect(() => {
    if (mapRef.current || !containerRef.current) return undefined

    const map = new MapLibreMap({
      container: containerRef.current,
      style: MAP_STYLE,
      center: MAP_DEFAULTS.center,
      zoom: MAP_DEFAULTS.zoom,
      minZoom: MAP_DEFAULTS.minZoom,
      maxZoom: MAP_DEFAULTS.maxZoom,
      attributionControl: { compact: true },
    })
    mapRef.current = map
    map.addControl(new NavigationControl({ showCompass: false }), 'top-right')

    map.on('load', () => {
      // Route legs: dark casing under a per-leg coloured line.
      map.addSource('route', { type: 'geojson', data: EMPTY })
      map.addLayer({
        id: 'route-casing',
        type: 'line',
        source: 'route',
        paint: { 'line-color': '#0b1020', 'line-width': 7, 'line-opacity': 0.85 },
      })
      map.addLayer({
        id: 'route-line',
        type: 'line',
        source: 'route',
        // Each feature carries its leg's colour, so a transfer is two clearly
        // distinct roads from one source.
        paint: { 'line-color': ['get', 'color'], 'line-width': 3.5, 'line-opacity': 0.95 },
      })

      // Each leg's stops, tinted to match. Above the line layers so a marker
      // always sits on top of the road it belongs to.
      map.addSource('stops', { type: 'geojson', data: EMPTY })
      map.addLayer({
        id: 'stop-halo',
        type: 'circle',
        source: 'stops',
        paint: {
          'circle-radius': 7,
          'circle-color': '#0b1020',
          'circle-stroke-width': 3,
          'circle-stroke-color': ['get', 'color'],
        },
      })

      // Leg buses. The halo tints every vehicle by its leg's colour; the bus
      // that answers the option gets a tighter white ring on top, so the
      // passenger can pick their ride out of the other buses on that road.
      map.addSource('buses', { type: 'geojson', data: EMPTY })
      map.addLayer({
        id: 'bus-halo',
        type: 'circle',
        source: 'buses',
        paint: {
          'circle-radius': 13,
          'circle-color': ['get', 'color'],
          'circle-opacity': 0.22,
          'circle-stroke-width': 1,
          'circle-stroke-color': ['get', 'color'],
        },
      })
      map.addLayer({
        id: 'bus-key',
        type: 'circle',
        source: 'buses',
        filter: ['==', ['get', 'keyed'], true],
        paint: {
          'circle-radius': 10,
          'circle-color': '#ffffff',
          'circle-opacity': 0.95,
          'circle-stroke-width': 2,
          'circle-stroke-color': ['get', 'color'],
        },
      })
      map.addLayer({
        id: 'bus-points',
        type: 'circle',
        source: 'buses',
        paint: {
          'circle-radius': 6,
          'circle-color': [
            'match',
            ['get', 'crowd'],
            'low',
            CROWD_LEVELS.low.color,
            'medium',
            CROWD_LEVELS.medium.color,
            'high',
            CROWD_LEVELS.high.color,
            CROWD_LEVELS.low.color,
          ],
          'circle-stroke-width': 2,
          'circle-stroke-color': '#0b1020',
        },
      })
      map.addLayer({
        id: 'bus-labels',
        type: 'symbol',
        source: 'buses',
        layout: {
          // The bus's own name - "Bus 5" - rather than its route, because that
          // is the reference a passenger reads on the marker.
          'text-field': ['get', 'name'],
          'text-size': 11,
          'text-offset': [0, 1.5],
          'text-anchor': 'top',
          'text-allow-overlap': false,
        },
        paint: { 'text-color': '#e6ecff', 'text-halo-color': '#0b1020', 'text-halo-width': 1.2 },
      })

      // Origin and destination sit on top of everything so they are never
      // hidden behind a stop or a vehicle.
      map.addSource('endpoints', { type: 'geojson', data: EMPTY })
      map.addLayer({
        id: 'endpoints',
        type: 'circle',
        source: 'endpoints',
        paint: {
          'circle-radius': 7,
          'circle-color': [
            'match',
            ['get', 'kind'],
            'origin',
            '#4f8cff',
            'destination',
            '#ff5a5f',
            '#4f8cff',
          ],
          'circle-stroke-width': 2.5,
          'circle-stroke-color': '#ffffff',
        },
      })

      readyRef.current = true
      sync()
    })

    // Click a bus to select it.
    map.on('click', 'bus-points', (e) => {
      const feature = e.features?.[0]
      const cb = map.__onSelectBus
      if (!feature || !cb) return
      cb(Number(feature.properties.busId))
    })
    map.on('click', 'bus-halo', (e) => {
      const feature = e.features?.[0]
      const cb = map.__onSelectBus
      if (!feature || !cb) return
      cb(Number(feature.properties.busId))
    })

    map.on('mouseenter', 'bus-points', () => {
      map.getCanvas().style.cursor = 'pointer'
    })
    map.on('mouseleave', 'bus-points', () => {
      map.getCanvas().style.cursor = ''
    })

    // Tooltip: "Crowd Level: Low/Med/High" on the bus marker itself, per the
    // product spec. One shared Popup instance that is refilled on hover and
    // torn down on leave, so the map never stacks stale popups.
    const showTooltip = (e) => {
      const feature = e.features?.[0]
      if (!feature) return
      const p = feature.properties
      const crowd = CROWD_LEVELS[p.crowd] ?? CROWD_LEVELS.low
      const el = document.createElement('div')
      el.className =
        'pointer-events-none min-w-40 px-1 py-0.5 text-[11px] leading-snug text-white'
      el.innerHTML = `
        <div class="mb-0.5 flex items-center gap-1.5 font-medium">
          <span class="inline-block h-2 w-2 rounded-full" style="background:${crowd.color}"></span>
          ${p.routeCode}
          ${p.name ? `<span class="font-normal text-amber-200/90">${p.name}</span>` : ''}
          ${p.reg ? `<span class="text-[10px] text-gray-500">${p.reg}</span>` : ''}
        </div>
        <div class="text-gray-300">Crowd Level:
          <span class="font-medium" style="color:${crowd.color}">${crowd.label}</span>
          ${Number.isFinite(p.load) && Number.isFinite(p.capacity) ? `&middot; ${p.load}/${p.capacity}` : ''}
        </div>
        ${p.nextStop ? `<div class="mt-0.5 text-gray-400">Next: ${p.nextStop}</div>` : ''}
        ${p.speed || p.speed === 0 ? `<div class="text-gray-400">${p.speed} km/h</div>` : ''}
      `
      popupRef.current?.remove()
      popupRef.current = new Popup({ closeButton: false, closeOnClick: false, className: 'ridesmart-bus-tooltip', offset: 12 })
        .setLngLat(e.lngLat)
        .setDOMContent(el)
        .addTo(map)
    }
    const hideTooltip = () => {
      popupRef.current?.remove()
      popupRef.current = null
    }
    map.on('mouseenter', 'bus-points', showTooltip)
    map.on('mouseenter', 'bus-halo', showTooltip)
    map.on('mouseleave', 'bus-points', hideTooltip)
    map.on('mouseleave', 'bus-halo', hideTooltip)
    map.on('click', hideTooltip)

    return () => {
      popupRef.current?.remove()
      popupRef.current = null
      map.__onSelectBus = null
      map.remove()
      mapRef.current = null
      readyRef.current = false
    }
    // Intentionally empty: the map is a one-time mount. Data arrives via sync().
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Push data on every change, without touching the map instance.
  useEffect(() => {
    sync()
  })

  const busCountText = `${buses.length} bus${buses.length === 1 ? '' : 'es'}`
  const legLabel = legs.map((l) => l.code).join(' + ')

  return (
    <div className={`relative overflow-hidden ${className}`}>
      <div ref={containerRef} className="h-full w-full" />
      <p className="pointer-events-none absolute right-2 bottom-3 rounded bg-black/40 px-1.5 py-0.5 text-[10px] text-gray-400">
        {legs.length === 0
          ? 'Map empty — pick a journey to plan one'
          : `${busCountText} on ${legLabel}`}
      </p>
      {fastest && legs.length > 0 && (
        <span className="pointer-events-none absolute right-2 bottom-8 z-10 rounded-md bg-amber-400/90 px-2 py-0.5 text-[10px] font-semibold tracking-wide text-black uppercase">
          Fastest
        </span>
      )}
    </div>
  )
}