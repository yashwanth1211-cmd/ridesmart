import { Link } from 'react-router-dom'
import { ArrowRight, Cube, MapTrifold, Path, ChartLineUp, Sparkle } from '@phosphor-icons/react'

const VIEWS = [
  {
    to: '/app',
    icon: MapTrifold,
    title: 'Live map',
    body: 'Every active bus on a MapLibre map, streamed over the API WebSocket with a polling fallback.',
  },
  {
    to: '/app',
    icon: Path,
    title: 'Journey planner',
    body: 'Pick two stops and compare every ranked option — fast but packed versus slower but empty.',
  },
  {
    to: '/app',
    icon: ChartLineUp,
    title: 'Authority dashboard',
    body: 'Fleet counts, delays, and which corridors are running hot, straight from the API.',
  },
]

export default function Home() {
  return (
    <div className="flex flex-col gap-12">
      <section className="flex max-w-2xl flex-col gap-4">
        <span className="inline-flex w-fit items-center gap-1.5 rounded-md bg-brand-blue/15 px-2 py-1 text-[11px] font-medium text-accent-ink">
          <span className="h-1.5 w-1.5 rounded-full bg-brand-blue" />
          Crowd-aware route planning
        </span>

        <h1 className="text-4xl leading-none font-medium tracking-tight text-ink">
          Know which bus to take
          <br />
          before you reach the stop.
        </h1>

        <p className="text-[15px] leading-relaxed text-muted">
          RideSmart shows you every route between two stops with a predicted arrival and a live
          crowding estimate, so you can choose the trade-off that suits you — faster but packed, or
          a few minutes later and empty.
        </p>

        <div className="flex flex-wrap items-center gap-3">
          <Link
            to="/app"
            className="inline-flex h-10 items-center gap-2 rounded-md bg-brand-blue/80 px-4 text-[13px] font-medium text-white glow-blue transition-colors hover:bg-brand-blue"
          >
            Open the app
            <ArrowRight size={15} />
          </Link>

          <Link
            to="/board"
            className="inline-flex h-10 items-center gap-2 rounded-md border border-white/10 px-4 text-[13px] font-medium text-gray-200 transition-colors hover:bg-white/10"
          >
            <Cube size={15} />
            Cinematic boarding intro
          </Link>
        </div>
      </section>

      <section className="grid gap-4 sm:grid-cols-3">
        {VIEWS.map(({ to, icon: Icon, title, body }) => (
          <Link
            key={title}
            to={to}
            className="glass-panel flex flex-col gap-3 p-5 transition-colors hover:bg-white/10"
          >
            <span className="flex h-8 w-8 items-center justify-center rounded-md bg-white/10 text-accent">
              <Icon size={16} />
            </span>
            <h2 className="text-[14px] font-medium text-white">{title}</h2>
            <p className="text-[13px] leading-relaxed text-gray-300">{body}</p>
          </Link>
        ))}
      </section>

      <section className="glass-panel flex flex-col gap-3 p-5">
        <h2 className="flex items-center gap-2 text-[14px] font-medium text-white">
          <Sparkle size={15} className="text-accent" />
          Try the demo
        </h2>
        <ol className="flex list-decimal flex-col gap-1.5 pl-5 text-[13px] leading-relaxed text-gray-300">
          <li>
            Start the API and the simulator, then open the live map — the buses start moving.
          </li>
          <li>
            Plan <code className="font-mono text-white">City College → Railway Station</code>. The
            seed guarantees two options.
          </li>
          <li>
            Compare them: <strong className="font-medium text-white">21A</strong> is faster but
            medium-crowded, <strong className="font-medium text-white">7B</strong> is slower and
            nearly empty.
          </li>
          <li>
            Press <em>Empty it</em> on 7B, then re-plan — the ranking changes, because the data is
            real.
          </li>
        </ol>
      </section>

      <section className="flex items-start gap-3 rounded-2xl border border-white/10 bg-black/40 p-5 backdrop-blur-xl">
        <Path size={16} className="mt-0.5 shrink-0 text-accent" />
        <p className="text-[13px] leading-relaxed text-gray-300">
          This app is written against{' '}
          <code className="font-mono text-white">tests_docs/api_contract.yaml</code>, the contract
          the backend team treats as the source of truth. All traffic goes through{' '}
          <code className="font-mono text-white">src/lib/api.js</code>, which normalises the wire
          format in one place.
        </p>
      </section>
    </div>
  )
}
