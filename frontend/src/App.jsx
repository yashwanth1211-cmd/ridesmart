import { Suspense, lazy } from 'react'
import { BrowserRouter, Navigate, useRoutes } from 'react-router-dom'

/*
  The app is the console, end to end: the video-based dashboard described in
  src/components/ui/Dashboard.jsx. There is no separate landing page and no 3D
  boarding sequence - everything is layered on the product UI video, so both
  routes below resolve to the same experience.

  The console is code-split: it pulls in MapLibre, the only large dependency
  left, and is only needed once the shell loads.
*/
const Console = lazy(() => import('@/pages/Console'))

function PageLoading() {
  return (
    <div className="flex min-h-[60vh] items-center justify-center">
      <div className="flex flex-col items-center gap-3">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-line border-t-accent" />
        <p className="text-[13px] text-faint">Loading experience</p>
      </div>
    </div>
  )
}

function AppRoutes() {
  return useRoutes([
    {
      path: '/',
      element: (
        <Suspense fallback={<PageLoading />}>
          <Console />
        </Suspense>
      ),
    },
    {
      path: '/app',
      element: (
        <Suspense fallback={<PageLoading />}>
          <Console />
        </Suspense>
      ),
    },
    { path: '*', element: <Navigate to="/" replace /> },
  ])
}

export default function App() {
  return (
    <BrowserRouter>
      <AppRoutes />
    </BrowserRouter>
  )
}