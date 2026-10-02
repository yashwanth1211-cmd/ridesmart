import { Broadcast, CloudSlash } from '@phosphor-icons/react'

/**
 * Bus feed health. Distinguishes the WebSocket from the polling fallback.
 */
export default function FeedBadge({ transport, count, error }) {
  const live = transport === 'ws'
  const tone = live
    ? 'bg-ok-soft text-ok'
    : transport === 'poll'
      ? 'bg-brand-blue/20 text-accent'
      : 'bg-white/10 text-gray-300'

  const label = live ? 'Live feed' : transport === 'poll' ? 'Polling' : 'Connecting'

  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-[11px] font-medium ${tone}`}
      title={error ?? undefined}
    >
      {live ? <Broadcast size={11} /> : <CloudSlash size={11} />}
      {label}
      <span className="text-gray-400">· {count}</span>
    </span>
  )
}