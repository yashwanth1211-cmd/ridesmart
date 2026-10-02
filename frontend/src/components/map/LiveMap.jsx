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
 * Live map of bus positions, drawn with MapLibre GL as the README's tech stack
 * requires.
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
 *  - The route polyline comes from useRouteStops, not from PlanOption.stops,
 *    which carries no coordinates.
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

export default function LiveMap({
  buses = [],
  routeStops = [],
  origin = null,
  destination = null,
  selectedRouteCode = null,
  onSelectBus = null,
  className = '',
}) {
  const containerRef = useRef(null)
  const mapRef = useRef(null)
  const readyRef = useRef(false)
  const latest = useRef({})
  const popupRef = useRef(null)

  latest.current = { buses, routeStops, origin, destination, selectedRouteCode, onSelectBus }

  /** Pushes the current ref'd props into the map's sources. Safe to call often. */
  const sync = () => {
    const map = mapRef.current
    if (!map || !readyRef.current) return

    const { buses: b, routeStops: rs, origin: o, destination: d, selectedRouteCode: code, onSelectBus: cb } =
      latest.current

    const busGeo = toCollection(b, (x) => ({
      busId: x.busId,
      tripId: x.tripId,
      routeCode: x.routeCode ?? '',
      reg: x.reg ?? '',
      crowd: x.crowd,
      load: x.load,
      capacity: x.capacity,
      speed: Math.round(x.speedKmph ?? 0),
      nextStop: x.nextStopName ?? '',
    }))

    const coords = rs
      .filter((s) => Number.isFinite(s.lon) && Number.isFinite(s.lat))
      .map((s) => [s.lon, s.lat])

    map.getSource('buses')?.setData(busGeo)
    map.getSource('route')?.setData(
      coords.length < 2
        ? EMPTY
        : {
            type: 'FeatureCollection',
            features: [
              { type: 'Feature', geometry: { type: 'LineString', coordinates: coords }, properties: {} },
            ],
          },
    )
    map.getSource('endpoints')?.setData(toCollection([o, d].filter(Boolean), (s) => ({ code: s.code })))

    // The selected route's vehicles get a halo so the passenger can pick their
    // own bus out of the traffic.
    map.setFilter('bus-halo', ['==', ['get', 'routeCode'], code ?? '__none__'])
    map.setFilter('bus-points', ['!=', ['get', 'routeCode'], code ?? '__none__'])

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
        paint: { 'line-color': '#4f8cff', 'line-width': 3.5, 'line-opacity': 0.95 },
      })

      map.addSource('buses', { type: 'geojson', data: EMPTY })
      map.addLayer({
        id: 'bus-halo',
        type: 'circle',
        source: 'buses',
        filter: ['==', ['get', 'routeCode'], '__none__'],
        paint: {
          'circle-radius': 13,
          'circle-color': '#4f8cff',
          'circle-opacity': 0.22,
          'circle-stroke-width': 1,
          'circle-stroke-color': '#4f8cff',
        },
      })
      map.addLayer({
        id: 'bus-points',
        type: 'circle',
        source: 'buses',
        filter: ['!=', ['get', 'routeCode'], '__none__'],
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
          'text-field': ['get', 'routeCode'],
          'text-size': 11,
          'text-offset': [0, 1.5],
          'text-anchor': 'top',
          'text-allow-overlap': false,
        },
        paint: { 'text-color': '#e6ecff', 'text-halo-color': '#0b1020', 'text-halo-width': 1.2 },
      })

      map.addSource('endpoints', { type: 'geojson', data: EMPTY })
      map.addLayer({
        id: 'endpoints',
        type: 'circle',
        source: 'endpoints',
        paint: {
          'circle-radius': 7,
          'circle-color': ['match', ['get', 'code'], 'STOP_COLLEGE', '#4f8cff', '#ff5a5f'],
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

    // Frame the route when one is selected.
    if (routeStops.length > 1) {
      const bounds = new LngLatBounds()
      routeStops.forEach((s) => bounds.extend([s.lon, s.lat]))
      map.fitBounds(bounds, { padding: 90, maxZoom: 15, duration: 900 })
    }

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

  return (
    <div className={`relative overflow-hidden ${className}`}>
      <div ref={containerRef} className="h-full w-full" />
      <p className="pointer-events-none absolute right-2 bottom-2 rounded bg-black/40 px-1.5 py-0.5 text-[10px] text-gray-400">
        {buses.length} bus{buses.length === 1 ? '' : 'es'} tracked
      </p>
    </div>
  )
}
