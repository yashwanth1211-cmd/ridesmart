import { NavLink, Outlet } from 'react-router-dom'
import { Bus, House, Cube } from '@phosphor-icons/react'

const NAV = [
  { to: '/', label: 'Home', icon: House, end: true },
  { to: '/board', label: 'Board a bus', icon: Cube },
]

export default function Layout() {
  return (
    <div className="flex min-h-full flex-col bg-canvas">
      <header className="sticky top-0 z-20 border-b border-line bg-canvas/80 backdrop-blur-xl">
        <div className="mx-auto flex h-14 max-w-6xl items-center gap-6 px-6">
          <NavLink to="/" className="flex items-center gap-2">
            <span className="flex h-7 w-7 items-center justify-center rounded-md bg-brand-blue text-white">
              <Bus size={16} weight="fill" />
            </span>
            <span className="text-[15px] font-medium tracking-tight text-ink">RideSmart</span>
          </NavLink>

          <nav className="flex items-center gap-1">
            {NAV.map(({ to, label, icon: Icon, end }) => (
              <NavLink
                key={to}
                to={to}
                end={end}
                className={({ isActive }) =>
                  `inline-flex h-9 items-center gap-2 rounded-md px-3 text-[13px] transition-colors ${
                    isActive
                      ? 'bg-accent-soft text-accent-ink'
                      : 'text-muted hover:bg-raised hover:text-ink'
                  }`
                }
              >
                <Icon size={15} />
                {label}
              </NavLink>
            ))}
          </nav>

          <span className="ml-auto inline-flex items-center gap-1.5 rounded-md bg-brand-red/15 px-2 py-1 text-[11px] font-medium text-brand-red">
            <span className="h-1.5 w-1.5 rounded-full bg-brand-red" />
            Live
          </span>
        </div>
      </header>

      <main className="mx-auto w-full max-w-6xl flex-1 px-6 py-10">
        <Outlet />
      </main>
    </div>
  )
}