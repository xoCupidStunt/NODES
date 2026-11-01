import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import { StoreProvider } from './state';
import { SaveSyncProvider } from './sync/SaveSyncProvider';
import './styles.css';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <StoreProvider>
      <SaveSyncProvider>
        <App />
      </SaveSyncProvider>
    </StoreProvider>
  </React.StrictMode>,
);
