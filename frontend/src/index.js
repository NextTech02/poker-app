import React from 'react';
import ReactDOM from 'react-dom/client';
import './styles/index.css';
import './config/i18n'; // Initialize i18n
import App from './App';

const root = ReactDOM.createRoot(document.getElementById('root'));
root.render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);

// ── Service Worker: é o que faz o app ABRIR sem internet ─────────────────────
// Sem ele, todo o modo offline (IndexedDB + fila de sync) era inútil na prática:
// bastava um F5 sem rede para o navegador mostrar "sem conexão" e o app nem
// carregar. Registrado só em produção — em desenvolvimento o SW atrapalha o
// hot-reload e serviria bundles velhos do cache.
if (process.env.NODE_ENV === 'production' && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch((err) => {
      // Falhar aqui não pode derrubar o app: sem SW ele só perde o offline.
      console.warn('[SW] registro falhou:', err);
    });
  });
}
