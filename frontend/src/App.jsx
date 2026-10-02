import { Suspense, lazy } from 'react'
import { BrowserRouter, Navigate, useRoutes } from 'react-router-dom'

/*
  The app runs on the product UI video end to end, exactly as provided - no 3D
  and no generated intro. '/' IS the cinematic intro: the video playing
  fullscreen, which hands off to /app where the same video loops behind the
  console.

  The console is code-split: it pulls in MapLibre, the only large dependency
  left, and is only needed once you leave the intro.
*/
const Intro = lazy(() => import('@/pages/Intro'))
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
          <Intro />
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