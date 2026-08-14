// Carregado automaticamente pelo react-scripts antes de cada arquivo de teste.
import '@testing-library/jest-dom';

// O jsdom não implementa structuredClone, que o IndexedDB usa para clonar
// valores na gravação. Sem isso, todo teste que toca a persistência offline
// falha com ReferenceError.
if (typeof global.structuredClone !== 'function') {
  global.structuredClone = (valor) =>
    valor === undefined ? undefined : JSON.parse(JSON.stringify(valor));
}

// O jsdom expõe `crypto` sem `randomUUID` (e, nesta versão, sem
// `getRandomValues`). Isso é buraco do jsdom, não do navegador: todo alvo que
// o projeto suporta tem `getRandomValues`, e o código offline conta com ele
// para gerar id de fila sem usar Math.random. Emprestamos o WebCrypto do Node.
if (typeof global.crypto === 'undefined') {
  global.crypto = {};
}
if (typeof global.crypto.getRandomValues !== 'function') {
  // eslint-disable-next-line global-require
  const { webcrypto } = require('crypto');
  global.crypto.getRandomValues = (buffer) => webcrypto.getRandomValues(buffer);
}

// TextEncoder/TextDecoder não existem no jsdom. A importação de jogadores
// depende deles para decidir o formato do arquivo pelo CONTEÚDO (o "xls" do
// concorrente é HTML com a extensão trocada).
// eslint-disable-next-line global-require
const { TextEncoder, TextDecoder } = require('util');
if (typeof global.TextEncoder === 'undefined') global.TextEncoder = TextEncoder;
if (typeof global.TextDecoder === 'undefined') global.TextDecoder = TextDecoder;

// matchMedia é usado por componentes que reagem a tema/tamanho de tela.
if (typeof window !== 'undefined' && !window.matchMedia) {
  window.matchMedia = (query) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  });
}

// O jsdom não implementa scrollTo; telas com listas longas chamam durante a
// renderização e o aviso polui a saída dos testes.
if (typeof window !== 'undefined' && !window.scrollTo) {
  window.scrollTo = () => {};
}

// ResizeObserver não existe no jsdom. A tela de transmissão mede o cabeçalho
// para encaixar a barra de prêmios; sem o polyfill ela nem renderiza.
if (typeof global.ResizeObserver === 'undefined') {
  global.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
}
