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
 *  - The route polyline comes from useRouteShape (real OSRM road geometry), not
 *    from PlanOption.stops, which carries no coordinates. Stop MARKERS come
 *    from useRouteStops and are drawn as their own GeoJSON source.
 *
 * SCOPE. Every layer here draws ONE route or nothing at all. There is exactly
 * one 'route' source, one 'stops' source and one 'buses' source, each replaced
 * wholesale through setData(), so a previous selection cannot survive the next
 * one. With selectedRouteId null the map is emptied: no polyline, no stops, no
 * buses. Do not add a layer that ignores selectedRouteId - an earlier version
 * of this file drew the whole network because selection was only ever applied
 * as a paint filter (a highlight halo), which changed how a bus looked without
 * ever removing one.
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
  routeShape = [],
  origin = null,
  destination = null,
  selectedRouteId = null,
  selectedRouteCode = null,
  onSelectBus = null,
  className = '',
}) {
  const containerRef = useRef(null)
  const mapRef = useRef(null)
  const readyRef = useRef(false)
  const latest = useRef({})
  const popupRef = useRef(null)
  const fittedRouteRef = useRef('')

  latest.current = {
    buses,
    routeStops,
    routeShape,
    origin,
    destination,
    selectedRouteId,
    selectedRouteCode,
    onSelectBus,
  }

  /** Pushes the current ref'd props into the map's sources. Safe to call often. */
  const sync = () => {
    const map = mapRef.current
    if (!map || !readyRef.current) return

    const {
      buses: allBuses,
      routeStops: rs,
      routeShape: shape,
      origin: o,
      destination: d,
      selectedRouteId: routeId,
      selectedRouteCode: code,
      onSelectBus: cb,
    } = latest.current

    /*
      NOTHING is drawn without a selection, and only the selected route's buses
      are drawn once there is one.

      useLiveBuses already scopes its fetch to routeId, so this filter should
      never remove anything. It stays because it is the last line of defence
      between a prop and the map: the previous version of this file had no such
      guard and relied purely on the feed being unfiltered-but-visually-dimmed,
      which is why selecting a route still drew the whole network. A future
      caller passing a fleet-wide array cannot regress that.
    */
    const b = routeId == null ? [] : allBuses.filter((x) => x.routeId === routeId)

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
    }))

    // Draw the REAL road polyline, not a line through the stop coordinates.
    // Stop markers still come from routeStops, but the path between them comes
    // from OSRM geometry so the line on screen is the road the bus drives.
    // Falls back to joining the stops if geometry is missing.
    const shapeCoords =
      routeId == null
        ? []
        : shape
            .filter((p) => Number.isFinite(p.lon) && Number.isFinite(p.lat))
            .map((p) => [p.lon, p.lat])

    const stopCoords =
      routeId == null
        ? []
        : rs
            .filter((s) => Number.isFinite(s.lon) && Number.isFinite(s.lat))
            .map((s) => [s.lon, s.lat])

    const coords = shapeCoords.length >= 2 ? shapeCoords : stopCoords

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

    // Stop markers for the selected route only. This source did not exist
    // before: routeStops fed only the polyline fallback, so the map showed no
    // stops at all. One source, replaced wholesale by setData, so switching
    // routes cannot leave the previous route's stops behind.
    map.getSource('stops')?.setData(
      toCollection(routeId == null ? [] : rs, (s) => ({
        routeId,
        stopId: s.id ?? null,
        name: s.name ?? '',
        accessible: Boolean(s.accessible),
      })),
    )

    // Frame the route the moment its coordinates resolve - on the very first
    // mount routeStops usually arrive AFTER the map's 'load' event, so an
    // early fitBounds here would be skipped and the map would sit on the
    // generic default viewport until the view happened to remount.
    //
    // Keyed on routeId, NOT on a coordinate signature. A signature cannot
    // distinguish "the user picked a different route" from "this route has no
    // geometry yet", so selecting a route whose data had not resolved left the
    // viewport fitted to the previous route. The routeId also has to be reset
    // when the selection is cleared, or re-picking the same route later would
    // match the stale ref and skip the refit entirely.
    if (routeId == null) {
      fittedRouteRef.current = ''
    } else if (coords.length > 1 && fittedRouteRef.current !== String(routeId)) {
      fittedRouteRef.current = String(routeId)
      const bounds = new LngLatBounds()
      coords.forEach((c) => bounds.extend(c))
      map.fitBounds(bounds, { padding: 90, maxZoom: 15, duration: 900 })
    }

    // Endpoints belong to the journey, not the route, so they follow
    // plan.origin/plan.destination. With no route selected there is no journey
    // worth marking.
    map
      .getSource('endpoints')
      ?.setData(toCollection(routeId == null ? [] : [o, d].filter(Boolean), (s) => ({ code: s.code })))

    // The selected route's vehicles get a halo so the passenger can pick their
    // own bus out of the traffic. With no selection both filters hide
    // everything, which is what empties the map.
    map.setFilter('bus-halo', ['==', ['get', 'routeCode'], code ?? '__none__'])
    map.setFilter('bus-points', ['!=', ['get', 'routeCode'], '__none__'])

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

      // Stops for the selected route. Added below the line layers so a marker
      // always sits on top of the road it belongs to, and above the bus layer
      // being added next so a vehicle is never hidden behind its own stop.
      map.addSource('stops', { type: 'geojson', data: EMPTY })
      map.addLayer({
        id: 'stop-halo',
        type: 'circle',
        source: 'stops',
        paint: {
          'circle-radius': 7,
          'circle-color': '#0b1020',
          'circle-stroke-width': 2,
          'circle-stroke-color': '#e6ecff',
        },
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

      // Origin and destination sit on top of everything so they are never
      // hidden behind a stop or a vehicle.
      map.addSource('endpoints', { type: 'geojson', data: EMPTY })
      map.addLayer({
        id: 'endpoints',
        type: 'circle',
        source: 'endpoints',
        paint: {
          'circle-radius': 7,
          'circle-color': ['match', ['get', 'code'], 'STOP_VIT', '#4f8cff', '#ff5a5f'],
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

  return (
    <div className={`relative overflow-hidden ${className}`}>
      <div ref={containerRef} className="h-full w-full" />
      <p className="pointer-events-none absolute right-2 bottom-2 rounded bg-black/40 px-1.5 py-0.5 text-[10px] text-gray-400">
        {selectedRouteId == null
          ? 'No route selected'
          : `${buses.length} bus${buses.length === 1 ? '' : 'es'} on ${selectedRouteCode ?? 'route'}`}
      </p>
    </div>
  )
}
