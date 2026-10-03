import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '../../../../docs/design/system/station.ts';
import '../../../../docs/design/system/tokens.css';
import './styles/fonts.css';
import { App } from './App.tsx';

const root = document.getElementById('root');
if (root) {
  createRoot(root).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}
