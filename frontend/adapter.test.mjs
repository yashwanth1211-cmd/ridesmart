/**
 * Unit tests for the adapter's normalisers.
 *
 * These cover the cases a live server cannot produce, which is the whole point.
 * No endpoint in api_contract.yaml returns prediction metadata yet, so the
 * trust logic in mapOption would otherwise ship completely unexercised - and
 * unexercised trust logic is exactly the kind that silently renders a
 * "92% confidence" badge over a guess.
 *
 * api.js is importable here because it reads import.meta.env behind optional
 * chaining, so an undefined import.meta.env in Node resolves to '' rather than
 * throwing.
 */
import {
  mapOption,
  mapPlan,
  mapStop,
  mapJourney,
  mapJourneyOption,
  normalizeCrowd,
  normalizeEta,
  normalizeDelay,
} from './src/lib/api.js'

let pass = 0, fail = 0
const failures = []
const check = (n, c, d) => {
  if (c) { pass += 1; console.log(`  ok   ${n}`) }
  else { fail += 1; failures.push(`${n}${d ? ` -- ${d}` : ''}`); console.log(`  FAIL ${n}${d ? ` -- ${d}` : ''}`) }
}

const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b)

console.log('\n== stop kind: transit vs campus anchor ==')
{
  const base = { id: 1, code: 'STOP_VIT', name: 'VIT', lat: 12.968142, lon: 79.156252, accessible: true }
  check('missing kind defaults to transit', mapStop(base).kind === 'transit', mapStop(base).kind)
  check('explicit transit stays transit', mapStop({ ...base, kind: 'transit' }).kind === 'transit', '')
  check('campus is preserved', mapStop({ ...base, kind: 'campus' }).kind === 'campus', mapStop({ ...base, kind: 'campus' }).kind)
  // An unknown value must not become 'campus', or a typo silently relabels a
  // surveyed stop as a guess.
  check('unknown kind is not promoted to campus', mapStop({ ...base, kind: 'campus-ish' }).kind === 'transit', mapStop({ ...base, kind: 'campus-ish' }).kind)
  check('lat/lon still mapped', mapStop(base).lat === 12.968142 && mapStop(base).lon === 79.156252, '')
}

console.log('\n== prediction: absent means absent ==')
{
  check('plain contract option has prediction === null', mapOption({ code: '21A', eta_min: 12 }).prediction === null, JSON.stringify(mapOption({ code: '21A', eta_min: 12 }).prediction))
  check('empty object still yields null', mapOption({ code: '21A' }).prediction === null, '')
  check('confidence of 0 is not treated as absent', mapOption({ code: 'x', confidence: 0 }).prediction !== null, '0 confidence was swallowed')
}

console.log('\n== prediction: trust derivation ==')
{
  // eta_model.py -> predict_eta(): method "segment_baseline", no validated flag.
  const baseline = mapOption({ code: '21A', method: 'segment_baseline', eta_seconds: 720, arrival_time: '2026-10-02T08:00:00+00:00' }).prediction
  check('segment_baseline is present', baseline !== null, '')
  check('segment_baseline method parsed', baseline?.method === 'segment_baseline', JSON.stringify(baseline))
  check('segment_baseline eta_seconds parsed', baseline?.etaSeconds === 720, JSON.stringify(baseline))
  check('segment_baseline arrival_time parsed', baseline?.arrivalTime === '2026-10-02T08:00:00+00:00', JSON.stringify(baseline))
  check('segment_baseline is trusted', baseline?.trusted === true, JSON.stringify(baseline))

  // eta_ml.py -> predict_eta_ml(): method "experimental_random_forest", validated False.
  const ml = mapOption({ code: '7B', method: 'experimental_random_forest', validated: false, eta_seconds: 900 }).prediction
  check('experimental model is present', ml !== null, '')
  check('experimental model is UNTRUSTED', ml?.trusted === false, JSON.stringify(ml))
  check('validated:false is captured', ml?.validated === false, JSON.stringify(ml))

  // A method name advertising itself as experimental must lose even if the
  // backend forgets to send the flag.
  const sloppy = mapOption({ code: '7B', method: 'experimental_random_forest' }).prediction
  check('experimental method name alone still untrusted', sloppy?.trusted === false, JSON.stringify(sloppy))

  // A confidence figure with nothing behind it is a red flag.
  const naked = mapOption({ code: 'x', confidence: 92 }).prediction
  check('confidence with no sample count is untrusted', naked?.trusted === false, JSON.stringify(naked))

  const backed = mapOption({ code: 'x', confidence: 92, samples: 480 }).prediction
  check('confidence WITH sample count is trusted', backed?.trusted === true, JSON.stringify(backed))
  check('sample count singularised correctly in shape', Number.isFinite(backed?.samples), '')

  // Explicitly validated experimental method is still experimental.
  const mixed = mapOption({ code: 'x', method: 'experimental_random_forest', validated: true }).prediction
  check('validated:true on an experimental name stays untrusted', mixed?.trusted === false, JSON.stringify(mixed))
}

console.log('\n== prediction: spelling tolerance ==')
{
  check('prediction_method alias', mapOption({ code: 'x', prediction_method: 'segment_baseline' }).prediction?.method === 'segment_baseline', '')
  check('eta_method alias', mapOption({ code: 'x', eta_method: 'segment_baseline' }).prediction?.method === 'segment_baseline', '')
  check('eta_predicted_sec alias', mapOption({ code: 'x', eta_predicted_sec: 300 }).prediction?.etaSeconds === 300, '')
  check('prediction_arrival alias', mapOption({ code: 'x', prediction_arrival: 'T' }).prediction?.arrivalTime === 'T', '')
  check('model version alias', mapOption({ code: 'x', model_version: 'v2' }).prediction?.version === 'v2', '')
  check('legacy version key', mapOption({ code: 'x', version: 'v3' }).prediction?.version === 'v3', '')
  check('observed_samples alias', mapOption({ code: 'x', observed_samples: 7 }).prediction?.samples === 7, '')
}

console.log('\n== crowd normalisation (contract bands) ==')
{
  check('0.39 -> low', normalizeCrowd('med', { ratio: 0.39 }) === 'low', '')
  check('0.40 -> medium (inclusive lower edge)', normalizeCrowd('low', { ratio: 0.4 }) === 'medium', '')
  check('0.74 -> medium', normalizeCrowd('low', { ratio: 0.74 }) === 'medium', '')
  check('0.75 -> high (inclusive upper edge)', normalizeCrowd('low', { ratio: 0.75 }) === 'high', '')
  check('ratio beats a stale label', normalizeCrowd('low', { ratio: 0.9 }) === 'high', '')
  check('MEDIUM uppercase maps to medium', normalizeCrowd('MEDIUM') === 'medium', '')
  check('med contract spelling maps to medium', normalizeCrowd('med') === 'medium', '')
  check('load/capacity derives the band', normalizeCrowd(null, { load: 35, capacity: 50 }) === 'medium', '')
  check('zero capacity does not divide', normalizeCrowd('high', { load: 5, capacity: 0 }) === 'high', '')
  check('unknown label falls back to low', normalizeCrowd('bananas') === 'low', '')
}

console.log('\n== eta / delay guards ==')
{
  check('null eta -> null (never 0)', normalizeEta(null) === null, '')
  check('undefined eta -> null', normalizeEta(undefined) === null, '')
  check("empty string eta -> null", normalizeEta('') === null, '')
  check('0 eta stays 0 only when actually 0', normalizeEta(0) === 0, '')
  check('float eta rounds', normalizeEta(11.6) === 12, '')
  check('garbage eta -> null', normalizeEta('soon') === null, '')
  check('negative eta clamps to 0', normalizeEta(-4) === 0, '')
  check('null delay -> 0', normalizeDelay(null) === 0, '')
  check('negative delay preserved (running early)', normalizeDelay(-2) === -2, '')
}

console.log('\n== plan-level tolerance ==')
{
  const viaRoutes = mapPlan({ from: null, to: null, routes: [{ code: '1A', eta_min: 5 }] })
  check('Member 1 "routes" key accepted', viaRoutes.options.length === 1, JSON.stringify(viaRoutes))
  const viaCandidates = mapPlan({ candidates: [{ code: '1A', eta_min: 5 }] })
  check('Member 2 "candidates" key accepted', viaCandidates.options.length === 1, '')
  const sorted = mapPlan({ options: [{ code: 'A', eta_min: 9 }, { code: 'B', eta_min: 3 }] })
  check('options sorted by eta ascending', eq(sorted.options.map((o) => o.code), ['B', 'A']), JSON.stringify(sorted.options.map((o) => o.code)))
  check('empty payload yields no options, no throw', mapPlan({}).options.length === 0, '')
}

console.log('\n== journey: the two clocks stay separate ==')
{
  // The bug this guards: the panel labelled the WAIT for the bus to reach the
  // stop where the passenger was standing as "arriving in", so a bus at the kerb
  // read as "arriving in 0 min" while being an hour from the destination.
  const o = mapJourneyOption({
    option_id: 'live:trip-7',
    route_id: 12,
    route_code: '21A UP',
    route_number: '21A',
    route_name: 'Vellore New Bus Stand - Katpadi',
    direction: 'up',
    arrives_in_min: 0,
    eta_min: 55,
    journey_min: 55,
    delay_min: 2,
    kind: 'live',
    bus_id: 31,
    bus_reg: 'TN09AB1234',
    bus_type: 'express',
    crowd_level: 'low',
    crowd_load: 18,
    capacity: 52,
    wheelchair_accessible: true,
    low_floor: true,
    score: 55,
  })

  check('wait and destination ETA are not conflated', o.arrivesInMin === 0 && o.etaMin === 55, JSON.stringify({ w: o.arrivesInMin, e: o.etaMin }))
  check('ride time mapped', o.journeyMin === 55, String(o.journeyMin))
  check('delay mapped', o.delayMin === 2, String(o.delayMin))
  check('registration surfaced', o.busReg === 'TN09AB1234', String(o.busReg))
  check('bus type surfaced', o.busType === 'express', String(o.busType))
  check('direction surfaced (matters: a route runs one way between two points)', o.direction === 'up', String(o.direction))
  check('route number kept separate from the directional code', o.routeNumber === '21A' && o.code === '21A UP', JSON.stringify({ n: o.routeNumber, c: o.code }))
  check('accessibility flags mapped', o.wheelchair === true && o.lowFloor === true, '')

  // An eta_min that is missing must fall back to the wait rather than to null:
  // null renders as an em-dash, which reads as "unknown" when the value exists.
  const legacy = mapJourneyOption({ option_id: 'x', arrives_in_min: 12, eta_min: null })
  check('missing destination ETA falls back to the wait', legacy.etaMin === 12, String(legacy.etaMin))
}

console.log('\n== journey: identity is the vehicle, not the corridor ==')
{
  // Two buses on one corridor are two options. Keying on routeId collapsed them
  // into one card and left the other unselectable.
  const a = mapJourneyOption({ option_id: 'live:1', route_id: 5, bus_id: 10, eta_min: 5 })
  const b = mapJourneyOption({ option_id: 'live:2', route_id: 5, bus_id: 11, eta_min: 9 })
  check('same route, different bus, different option id', a.id !== b.id, `${a.id} vs ${b.id}`)
  check('busId maps through', a.busId === 10 && b.busId === 11, '')

  // Two scheduled departures on one route must not collide either, which is why
  // the backend puts the departure timestamp in option_id.
  const s1 = mapJourneyOption({ option_id: 'sched:5:2026-10-05T09:35', route_id: 5, departs_at: '2026-10-05T09:35:00+00:00', eta_min: 20 })
  const s2 = mapJourneyOption({ option_id: 'sched:5:2026-10-05T09:50', route_id: 5, departs_at: '2026-10-05T09:50:00+00:00', eta_min: 35 })
  check('two departures on one route do not collide', s1.id !== s2.id, `${s1.id} vs ${s2.id}`)
  check('scheduled kind detected', s1.kind === 'scheduled', String(s1.kind))
}

console.log('\n== journey: scheduled entries do not invent a vehicle ==')
{
  const s = mapJourneyOption({ option_id: 'sched:1', route_id: 1, kind: 'scheduled', departs_at: '2026-10-05T09:35:00+00:00', eta_min: 20, arrives_in_min: 20, journey_min: 25 })
  check('no bus id for a timetable entry', s.busId === null, String(s.busId))
  check('no registration invented', s.busReg === null, String(s.busReg))
  check('departure time preserved', s.departsAt === '2026-10-05T09:35:00+00:00', String(s.departsAt))
  // No delay column, because there is no vehicle to be late. Rendering "on
  // time" for a bus that has not left the depot is a fabricated reassurance.
  check('absent delay stays null, not 0', s.delayMin === null, String(s.delayMin))
  check('absent crowd stays null', s.crowd === null, String(s.crowd))
}

console.log('\n== journey: crowd recomputed from the reading ==')
{
  // The stored label is written at seed time from an off-peak profile and never
  // rescaled, so a full bus can carry "low". The load and capacity are the
  // reading; the label is a cache of an older one.
  const full = mapJourneyOption({ option_id: 'a', crowd_level: 'low', crowd_load: 50, capacity: 52, crowd_ratio: 0.96 })
  check('a full bus does not read as low', full.crowd === 'high', full.crowd)
  check('ratio used when supplied', full.ratio === 0.96, String(full.ratio))

  const derived = mapJourneyOption({ option_id: 'b', crowd_level: 'high', crowd_load: 10, capacity: 52 })
  check('ratio derived from load/capacity', derived.ratio === 10 / 52, String(derived.ratio))
  check('derived ratio re-bands the label', derived.crowd === 'low', derived.crowd)

  const zero = mapJourneyOption({ option_id: 'c', crowd_load: 5, capacity: 0 })
  check('zero capacity does not divide', zero.ratio === null, String(zero.ratio))
}

console.log('\n== journey: stops between the two endpoints ==')
{
  const o = mapJourneyOption({
    option_id: 'x',
    route_id: 1,
    eta_min: 30,
    stops: [
      { stop_id: 4, stop_code: 'STOP_VIT', name: 'VIT', seq: 3, eta_min: 5, accessible: true },
      { stop_id: 6, stop_code: 'STOP_CMC', name: 'CMC Hospital', seq: 4, eta_min: 12, accessible: false },
      { stop_id: 9, stop_code: 'STOP_KATPADI', name: 'Katpadi Junction', seq: 7, eta_min: 30, accessible: true },
    ],
  })
  check('all three stops mapped', o.stops.length === 3, String(o.stops.length))
  check('order preserved as served', eq(o.stops.map((s) => s.seq), [3, 4, 7]), JSON.stringify(o.stops.map((s) => s.seq)))
  check('per-stop eta is from now, not the route origin', o.stops[0].etaMin === 5, String(o.stops[0].etaMin))
  check('stop accessibility mapped', o.stops[1].accessible === false && o.stops[0].accessible === true, '')
  check('stop_code mapped to code', o.stops[2].code === 'STOP_KATPADI', String(o.stops[2].code))
  check('missing stops list does not throw', mapJourneyOption({ option_id: 'y' }).stops.length === 0, '')
}

console.log('\n== journey: whole response ==')
{
  const payload = {
    from: { id: 4, code: 'STOP_VIT', name: 'VIT', lat: 12.96, lon: 79.15, accessible: true },
    to: { id: 9, code: 'STOP_KATPADI', name: 'Katpadi Junction', lat: 12.92, lon: 79.24, accessible: true },
    sort: 'crowd',
    generated_at: '2026-10-05T09:50:00+00:00',
    message: null,
    direct: [
      { option_id: 'live:2', route_id: 5, score: 30, eta_min: 30 },
      { option_id: 'live:1', route_id: 5, score: 12, eta_min: 12 },
    ],
    transfers: [
      {
        transfers: 1,
        transfer_stop: { id: 14, code: 'STOP_ARAKKONAM', name: 'Arakkonam', lat: 12.87, lon: 79.31 },
        wait_min: 6,
        total_min: 88,
        legs: [
          { route_id: 21, route_code: '301 UP', route_name: 'Arakkonam - Vellore', direction: 'down', bus_id: 60, bus_reg: 'TN09AB1060', arrives_in_min: 4, crowd_level: 'medium', crowd_load: 30, capacity: 50, stops: [{ stop_id: 4, name: 'VIT', eta_min: 4 }] },
          { route_id: 22, route_code: '302 UP', route_name: 'Arakkonam - Katpadi', direction: 'up', bus_id: 61, bus_reg: 'TN09AB1061', arrives_in_min: 6, crowd_level: 'low', crowd_load: 12, capacity: 50, stops: [{ stop_id: 9, name: 'Katpadi Junction', eta_min: 6 }] },
        ],
      },
    ],
  }

  const p = mapJourney(payload)
  check('origin mapped', p.origin?.name === 'VIT', JSON.stringify(p.origin))
  check('destination mapped', p.destination?.name === 'Katpadi Junction', JSON.stringify(p.destination))
  check('sort echoed', p.sort === 'crowd', p.sort)
  check('two direct options', p.options.length === 2, String(p.options.length))
  // Ordered by score, not by eta: under sort=crowd the two deliberately differ,
  // which is the only way a crowd ranking can do anything.
  check('ordered by the backend score', eq(p.options.map((o) => o.id), ['live:1', 'live:2']), JSON.stringify(p.options.map((o) => o.id)))
  check('one transfer mapped', p.transfers.length === 1, String(p.transfers.length))
  check('transfer legs in order', p.transfers[0].legs.length === 2 && p.transfers[0].legs[0].routeId === 21, '')
  check('interchange stop named', p.transfers[0].via?.name === 'Arakkonam', JSON.stringify(p.transfers[0].via))
  check('wait and total kept', p.transfers[0].waitMin === 6 && p.transfers[0].totalMin === 88, JSON.stringify(p.transfers[0]))
  check('transfer label joins both route codes', p.transfers[0].code === '301 UP + 302 UP', p.transfers[0].code)
  check('no message means null', p.message === null, String(p.message))
}

console.log('\n== journey: empty and degenerate payloads ==')
{
  // The backend's wording is kept verbatim. It distinguishes "same stop" from
  // "nothing connects these" from "you need a transfer", and replacing all three
  // with one string destroys the difference that tells the passenger what to do.
  const friendly = mapJourney({ message: 'No buses found for this journey', direct: [], transfers: [] })
  check('friendly message preserved', friendly.message === 'No buses found for this journey', String(friendly.message))
  check('no options, no throw', friendly.options.length === 0 && friendly.transfers.length === 0, '')

  const bare = mapJourney({})
  check('empty payload yields nothing, no throw', bare.options.length === 0 && bare.transfers.length === 0 && bare.message === null, '')
  check('empty payload has no origin', bare.origin === null, String(bare.origin))
  check('empty payload defaults to eta sort', bare.sort === 'eta', bare.sort)

  const backwards = mapJourney({ message: 'No direct bus runs that way. Try swapping the two stops.', direct: [], transfers: [] })
  check('swap advice is not overwritten', backwards.message.includes('swapping'), String(backwards.message))

  const nullLegs = mapJourney({ transfers: [{ legs: null, total_min: 40, wait_min: 5 }] })
  check('transfer with no legs does not throw', nullLegs.transfers.length === 1 && nullLegs.transfers[0].legs.length === 0, '')
  check('transfer with no legs still has a label', typeof nullLegs.transfers[0].code === 'string', '')
}

console.log(`\n${'='.repeat(56)}`)
console.log(`  ${pass} passed, ${fail} failed`)
if (failures.length) failures.forEach((f) => console.log(`   - ${f}`))
process.exit(fail ? 1 : 0)
