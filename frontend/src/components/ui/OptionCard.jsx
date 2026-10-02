import { Users, Wheelchair, Steps, Gauge, MapPin } from '@phosphor-icons/react'
import CrowdIndicator from './CrowdIndicator'
import DelayBadge from './DelayBadge'
import PredictionBadge from './PredictionBadge'

/**
 * One candidate route from POST /api/routes/plan.
 *
 * The contract is emphatic that options must be shown side by side: "The UI must
 * render every entry - showing one option defeats the purpose of the feature."
 * The seed deliberately produces a fast-but-packed route and a slow-but-empty
 * one, and the whole product is the passenger choosing between them. So this
 * card never collapses to a single "best" result - the list shows them all and
 * lets the ranking be a suggestion rather than a decision made for them.
 */
export default function OptionCard({ option, selected = false, onSelect = null, rank = null }) {
  const eta = option.etaMin

  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={selected}
      className={`glass-inset flex w-full flex-col gap-3 px-4 py-3.5 text-left transition-colors ${
        selected
          ? 'border-brand-blue/70 bg-brand-blue/10'
          : 'hover:border-white/20 hover:bg-white/10'
      }`}
    >
      {/* header: rank, route code, name */}
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">
          {rank !== null && (
            <span
              className={`mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-md text-[11px] font-medium ${
                rank === 1 ? 'bg-accent/20 text-accent' : 'bg-white/10 text-gray-300'
              }`}
            >
              {rank}
            </span>
          )}
          <div className="flex min-w-0 flex-col">
            <span className="text-[14px] font-medium text-white">{option.code}</span>
            {option.name && (
              <span className="truncate text-[11px] text-gray-400">{option.name}</span>
            )}
          </div>
        </div>

        <div className="flex shrink-0 flex-col items-end">
          <span className="text-[20px] leading-none font-medium text-white">
            {eta ?? '—'}
            <span className="ml-0.5 text-[12px] font-normal text-gray-400">min</span>
          </span>
          {Number.isFinite(option.etaScheduledMin) && (
            <span className="mt-1 text-[10px] text-gray-500">
              {option.etaScheduledMin} min scheduled
            </span>
          )}
        </div>
      </div>

      {/* crowd + delay */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <CrowdIndicator
            level={option.crowd}
            load={option.load}
            capacity={option.capacity}
            ratio={option.ratio}
            compact
          />
          {Number.isFinite(option.load) && Number.isFinite(option.capacity) && (
            <span className="text-[11px] text-gray-400">
              {option.load}/{option.capacity}
            </span>
          )}
        </div>

        <DelayBadge
          minutes={option.delayMin}
          scheduledMin={option.etaScheduledMin}
          predictedMin={option.etaMin}
        />
      </div>

      {/* accessibility + model metadata */}
      <div className="flex flex-wrap items-center gap-3 text-[11px] text-gray-400">
        {Array.isArray(option.stops) && option.stops.length > 1 && (
          <span className="inline-flex items-center gap-1">
            <MapPin size={12} />
            {option.stops.length - 1} {option.stops.length - 1 === 1 ? 'stop' : 'stops'} remaining
          </span>
        )}
        {option.wheelchair && (
          <span className="inline-flex items-center gap-1 text-accent">
            <Wheelchair size={12} />
            Wheelchair accessible
          </span>
        )}
        {option.lowFloor && (
          <span className="inline-flex items-center gap-1">
            <Steps size={12} />
            Low floor
          </span>
        )}
        {option.wheelchair && option.lowFloor && <span className="sr-only">Accessible vehicle</span>}
        {option.score !== null && (
          <span className="inline-flex items-center gap-1" title="Internal ranking score, lower is better">
            <Gauge size={12} />
            score {option.score}
          </span>
        )}

        {/*
          Only rendered when the backend sends real model metadata. No endpoint
          in the contract does today, and the badge renders nothing rather than
          a fabricated confidence figure.
        */}
        <PredictionBadge prediction={option.prediction} />

        {!option.wheelchair && !option.lowFloor && option.score === null && !option.prediction && (
          <span className="inline-flex items-center gap-1">
            <Users size={12} />
            Standard vehicle
          </span>
        )}
      </div>
    </button>
  )
}
