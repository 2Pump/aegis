import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { createBrowserRouter, Navigate, RouterProvider } from 'react-router-dom';
import { Shell } from './components/Shell';
import { AppError } from './components/AppError';
import { installStaleBuildReload } from './lib/staleBuild';
import { Home } from './pages/Home';
import { FixturePage, HullPage } from './pages/HullPage';
import { CalibrationPage } from './pages/Calibration';
import { CensusPage, NotFound, WatchPage } from './pages/Static';
import './styles.css';

installStaleBuildReload();

const router = createBrowserRouter([
  {
    element: <Shell />,
    errorElement: <AppError />,
    children: [
      { path: '/', element: <Home /> },
      { path: '/hull/:address', element: <HullPage /> },
      { path: '/fixture/:name', element: <FixturePage /> },
      // the rules are the drawer now; old links to /rules open it over the well
      { path: '/rules', element: <Navigate to="/?rules=1" replace /> },
      { path: '/calibration', element: <CalibrationPage /> },
      { path: '/census', element: <CensusPage /> },
      { path: '/watch', element: <WatchPage /> },
      { path: '*', element: <NotFound /> },
    ],
  },
]);

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <RouterProvider router={router} />
  </StrictMode>,
);
