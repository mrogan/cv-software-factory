import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '../../../../docs/design/system/station.ts';
import '../../../../docs/design/system/tokens.css';
import './styles/fonts.css';
import './styles/base.css';
import './styles/line.css';
import './styles/reel.css';
import './styles/pictures.css';
import './styles/sheet.css';
import { App } from './App.tsx';

const root = document.getElementById('root');
if (root) {
  createRoot(root).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}
