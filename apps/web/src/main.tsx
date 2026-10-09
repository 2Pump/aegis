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
          <PaidPage heading="Pressure" title="Pressure map" blurb="How many wallets a price move would push toward liquidation — by asset, direction and size range.">
            <PressurePage />
          </PaidPage>
        ),
      },
      {
        path: '/intel',
        element: (
          <PaidPage heading="Intel" title="Intel" blurb="Ecosystem history, the liquidation ledger, oracle watch, protocol changes and carry — recorded live every hour.">
            <IntelPage />
          </PaidPage>
        ),
      },
      {
        path: '/census',
        element: (
          <PaidPage heading="Scan" title="Scan" blurb="Every wallet Phrourax has found on Tydro and Nado, to browse and filter.">
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
