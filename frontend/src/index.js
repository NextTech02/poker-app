import React from 'react';
import ReactDOM from 'react-dom/client';
import './styles/index.css';
import i18n, { garantirIdioma } from './config/i18n';
import App from './App';

const root = ReactDOM.createRoot(document.getElementById('root'));

// O idioma detectado agora pode vir num chunk separado (ver config/i18n.js).
// Esperar por ele antes do primeiro render evita o pior efeito colateral de
// carregar traducao sob demanda: a tela aparecer em portugues e trocar para
// espanhol meio segundo depois, na frente do operador.
//
// Para quem usa pt-BR — a maioria — a promessa ja nasce resolvida e o render
// acontece no mesmo tick. Para os outros, o chunk custa ~25 KB comprimidos,
// contra os ~250 KB que sairam do bundle principal.
//
// `garantirIdioma` nunca rejeita; o `.then` sozinho basta e nao ha caminho de
// erro que deixe a tela em branco.
garantirIdioma(i18n.language).then(() => {
  root.render(
    <React.StrictMode>
      <App />
    </React.StrictMode>
  );
});

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
