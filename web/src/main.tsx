import {StrictMode} from 'react';
import {createRoot} from 'react-dom/client';
import '@fontsource-variable/space-grotesk';
import '@fontsource/ibm-plex-mono/500.css';
import {App} from './App';
import {AdminApp} from './AdminApp';
import './styles.css';

const RootApp = window.location.pathname.startsWith('/admin') ? AdminApp : App;

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <RootApp />
  </StrictMode>,
);
