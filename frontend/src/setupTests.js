// Carregado automaticamente pelo react-scripts antes de cada arquivo de teste.
import '@testing-library/jest-dom';

// O jsdom não implementa structuredClone, que o IndexedDB usa para clonar
// valores na gravação. Sem isso, todo teste que toca a persistência offline
// falha com ReferenceError.
if (typeof global.structuredClone !== 'function') {
  global.structuredClone = (valor) =>
    valor === undefined ? undefined : JSON.parse(JSON.stringify(valor));
}

// O jsdom expõe `crypto` sem `randomUUID` em algumas versões; o código de
// produção já tem fallback, mas os testes precisam de um valor utilizável.
if (typeof global.crypto === 'undefined') {
  global.crypto = {};
}

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
