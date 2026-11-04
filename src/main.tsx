import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import { StoreProvider } from './state';
import { CloudProvider } from './cloud/CloudProvider';
import { SignInGate } from './components/SignInGate';
import { SaveSyncProvider } from './sync/SaveSyncProvider';
import './styles.css';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <StoreProvider>
      <CloudProvider>
        <SaveSyncProvider>
          <SignInGate>
            <App />
          </SignInGate>
        </SaveSyncProvider>
      </CloudProvider>
    </StoreProvider>
  </React.StrictMode>,
);
