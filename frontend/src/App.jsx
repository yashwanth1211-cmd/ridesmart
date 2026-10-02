import { Suspense, lazy } from 'react'
import { BrowserRouter, useRoutes } from 'react-router-dom'
import Home from '@/pages/Home'
import Layout from '@/components/Layout'

/*
  The boarding experience pulls in three.js + drei, so it is code split.
  Rolldown emits it as its own chunk, and three is additionally pinned to a
  dedicated vendor group in vite.config.js.

  The console is also split: it pulls in MapLibre, which is a large dependency
  and is only needed once you leave the landing page.
*/
const BoardingExperience = lazy(() => import('@/pages/Boarding'))
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
      element: <Layout />,
      children: [
        {
          index: true,
          element: (
            <Suspense fallback={<PageLoading />}>
              <Home />
            </Suspense>
          ),
        },
      ],
    },
    /*
      The passenger console is full-bleed - the map needs the whole viewport - so
      it sits outside <Layout> like the boarding scene does, and supplies its own
      header.
    */
    {
      path: '/app',
      element: (
        <Suspense fallback={<PageLoading />}>
          <Console />
        </Suspense>
      ),
    },
    {
      path: '/board',
      element: (
        <Suspense fallback={<PageLoading />}>
          <BoardingExperience />
        </Suspense>
      ),
    },
  ])
}

export default function App() {
  return (
    <BrowserRouter>
      <AppRoutes />
    </BrowserRouter>
  )
}
