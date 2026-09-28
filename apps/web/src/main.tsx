import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { createBrowserRouter, RouterProvider } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { WagmiProvider } from 'wagmi';
import { wagmiConfig } from './wagmi';
import { Shell } from './components/Shell';
import { Home } from './pages/Home';
import { FixturePage, HullPage } from './pages/HullPage';
import { CalibrationPage } from './pages/Calibration';
import { CensusPage, NotFound, RulesPage, WatchPage } from './pages/Static';
import './styles.css';

const router = createBrowserRouter([
  {
    element: <Shell />,
    children: [
      { path: '/', element: <Home /> },
      { path: '/hull/:address', element: <HullPage /> },
      { path: '/fixture/:name', element: <FixturePage /> },
      { path: '/rules', element: <RulesPage /> },
      { path: '/calibration', element: <CalibrationPage /> },
      { path: '/census', element: <CensusPage /> },
      { path: '/watch', element: <WatchPage /> },
      { path: '*', element: <NotFound /> },
    ],
  },
]);

const qc = new QueryClient();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <WagmiProvider config={wagmiConfig}>
      <QueryClientProvider client={qc}>
        <RouterProvider router={router} />
      </QueryClientProvider>
    </WagmiProvider>
  </StrictMode>,
);
