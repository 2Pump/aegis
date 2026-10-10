import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { createBrowserRouter, Navigate, RouterProvider } from 'react-router-dom';
import { Shell } from './components/Shell';
import { AppError } from './components/AppError';
import { installStaleBuildReload } from './lib/staleBuild';
import { Home } from './pages/Home';
import { FixturePage, HullPage } from './pages/HullPage';
import { CalibrationPage } from './pages/Calibration';
import { PressurePage } from './pages/Pressure';
import { IntelPage } from './pages/Intel';
import { CensusPage, DevelopersPage, NotFound, WatchPage } from './pages/Static';
import { AccountPage, SignInPage, VerifyPage } from './pages/Account';
import { PricingPage } from './pages/Pricing';
import { TermsPage } from './pages/Terms';
import { PaidPage } from './components/Paywall';
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
      {
        path: '/pressure',
        element: (
          <PaidPage heading="Pressure" feature="pressure">
            <PressurePage />
          </PaidPage>
        ),
      },
      {
        path: '/intel',
        element: (
          <PaidPage heading="Intel" feature="intel">
            <IntelPage />
          </PaidPage>
        ),
      },
      {
        path: '/census',
        element: (
          <PaidPage heading="Scan" feature="scan">
            <CensusPage />
          </PaidPage>
        ),
      },
      { path: '/watch', element: <WatchPage /> },
      { path: '/developers', element: <DevelopersPage /> },
      { path: '/signin', element: <SignInPage /> },
      { path: '/auth/verify', element: <VerifyPage /> },
      { path: '/account', element: <AccountPage /> },
      { path: '/pricing', element: <PricingPage /> },
      { path: '/terms', element: <TermsPage /> },
      { path: '*', element: <NotFound /> },
    ],
  },
]);

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <RouterProvider router={router} />
  </StrictMode>,
);
