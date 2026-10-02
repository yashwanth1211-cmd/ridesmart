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
import { mapOption, mapPlan, normalizeCrowd, normalizeEta, normalizeDelay } from './src/lib/api.js'

let pass = 0, fail = 0
const failures = []
const check = (n, c, d) => {
  if (c) { pass += 1; console.log(`  ok   ${n}`) }
  else { fail += 1; failures.push(`${n}${d ? ` -- ${d}` : ''}`); console.log(`  FAIL ${n}${d ? ` -- ${d}` : ''}`) }
}

const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b)

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

console.log(`\n${'='.repeat(56)}`)
console.log(`  ${pass} passed, ${fail} failed`)
if (failures.length) failures.forEach((f) => console.log(`   - ${f}`))
process.exit(fail ? 1 : 0)
