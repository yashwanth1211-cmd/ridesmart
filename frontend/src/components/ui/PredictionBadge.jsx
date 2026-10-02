import { useId } from 'react'
import { Sparkle, WarningCircle, Flask } from '@phosphor-icons/react'

/**
 * Provenance for a model-generated ETA.
 *
 * Renders NOTHING when the backend sent no prediction metadata, which is the
 * case for every endpoint in api_contract.yaml today. That is the correct
 * default: the absence of a number is honest, and inventing one client-side is
 * not an option this component offers.
 *
 * The whole reason this is a separate component rather than three more spans
 * inside OptionCard is the trust split. simulation_ml/eta_ml.py trains a
 * RandomForest on synthetic data and returns `validated: false`; if that ever
 * reaches the API, showing its output with the same weight as a contract-backed
 * ETA would be a lie told by typography. So an untrusted prediction is:
 *
 *   - rendered in the warning colour, not the accent colour
 *   - prefixed "Experimental", not a bare confidence percentage
 *   - marked aria-describedby so a screen reader hears the caveat too
 *   - never allowed to stand alone - it always sits beside the real ETA
 */
const METHOD_LABELS = {
  segment_baseline: 'Segment baseline',
  experimental_random_forest: 'Random forest',
}

function label(method) {
  if (!method) return null
  if (METHOD_LABELS[method]) return METHOD_LABELS[method]
  // Unknown method: show the raw token rather than hiding the fact that a
  // model was involved.
  return method.replace(/_/g, ' ')
}

export default function PredictionBadge({ prediction, className = '' }) {
  const caveatId = useId()

  if (!prediction) return null

  const { trusted, method, confidence, samples, version } = prediction
  const parts = []

  if (Number.isFinite(confidence)) parts.push(`${Math.round(confidence)}% confidence`)
  if (Number.isFinite(samples)) {
    parts.push(`${samples} sample${samples === 1 ? '' : 's'}`)
  }

  const methodLabel = label(method)

  const untrustedDetails = (
    <span
      id={caveatId}
      className="sr-only"
    >
      This estimate comes from an unvalidated experimental model. Treat it as a rough
      indication, not a guarantee.
    </span>
  )

  return (
    <span
      className={`inline-flex flex-wrap items-center gap-1.5 text-[11px] ${
        trusted ? 'text-gray-300' : 'text-warn'
      } ${className}`}
      aria-describedby={trusted ? undefined : caveatId}
    >
      {trusted ? <Sparkle size={12} /> : <Flask size={12} />}

      {!trusted && (
        <span className="inline-flex items-center gap-1 font-medium">
          Experimental
          <WarningCircle size={11} className="opacity-70" />
        </span>
      )}

      {methodLabel && <span className={trusted ? '' : 'opacity-90'}>{methodLabel}</span>}

      {parts.length > 0 && <span className="opacity-80">· {parts.join(' · ')}</span>}

      {version && <span className="opacity-70">· {version}</span>}

      {/*
        The caveat has to reach assistive tech, not just sighted users. The
        describedby link ties the "Experimental" badge to the hidden caveat so a
        screen reader announces the warning the moment it reaches the badge,
        instead of treating the badge as visual-only information.
      */}
      {!trusted && untrustedDetails}
    </span>
  )
}
