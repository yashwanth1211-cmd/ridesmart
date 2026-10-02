import Dashboard from '@/components/ui/Dashboard'

/**
 * Full-bleed passenger console: live map, journey planner, authority dashboard.
 *
 * A page rather than a component in <Layout>, because the map owns the whole
 * viewport and must not inherit the marketing shell's header and padding.
 */
export default function Console() {
  return (
    <div className="h-dvh w-full overflow-hidden bg-canvas">
      <Dashboard />
    </div>
  )
}
