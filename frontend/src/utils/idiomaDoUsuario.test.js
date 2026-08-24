/**
 * Quem ganha: o idioma do clube ou o da pessoa?
 *
 * A regra tem um caso que é fácil de quebrar sem perceber — distinguir "a
 * pessoa escolheu" de "o navegador estava assim". O detector do i18next grava o
 * palpite dele no localStorage, então olhar para `i18nextLng` responderia
 * "escolheu" para todo mundo e o idioma do clube nunca chegaria a ninguém. Os
 * testes abaixo prendem essa distinção.
 */
import {
  IDIOMAS,
  IDIOMAS_SUPORTADOS,
  idiomaEscolhidoPeloUsuario,
  marcarEscolhaDoUsuario,
  aplicarIdiomaDaOrganizacao,
} from './idiomaDoUsuario';

const criarI18n = (idiomaAtual) => ({
  language: idiomaAtual,
  changeLanguage: jest.fn(function (novo) {
    this.language = novo;
  }),
});

beforeEach(() => {
  localStorage.clear();
});

describe('catálogo', () => {
  it('lista os três idiomas com bandeira', () => {
    expect(IDIOMAS.map((l) => l.code)).toEqual(['pt-BR', 'en-US', 'es-ES']);
    expect(IDIOMAS.every((l) => l.cc && l.name)).toBe(true);
  });

  it('IDIOMAS_SUPORTADOS acompanha o catálogo', () => {
    expect(IDIOMAS_SUPORTADOS).toEqual(IDIOMAS.map((l) => l.code));
  });
});

describe('escolha da pessoa', () => {
  it('sem escolha nenhuma, devolve null', () => {
    expect(idiomaEscolhidoPeloUsuario()).toBeNull();
  });

  it('o palpite do detector do i18next NÃO conta como escolha', () => {
    // Este é o ponto do arquivo inteiro: `i18nextLng` está sempre preenchido
    // depois da primeira visita. Se ele contasse, nenhum clube conseguiria
    // definir o idioma dos seus operadores.
    localStorage.setItem('i18nextLng', 'pt-BR');
    expect(idiomaEscolhidoPeloUsuario()).toBeNull();
  });

  it('clicar na bandeira registra a escolha e ela sobrevive', () => {
    marcarEscolhaDoUsuario('es-ES');
    expect(idiomaEscolhidoPeloUsuario()).toBe('es-ES');
  });

  it('idioma que não existe é ignorado, não guardado', () => {
    marcarEscolhaDoUsuario('tlh-KX');
    expect(idiomaEscolhidoPeloUsuario()).toBeNull();
  });

  it('valor estragado no storage é tratado como ausência de escolha', () => {
    localStorage.setItem('aceblind:idiomaEscolhido', 'lixo');
    expect(idiomaEscolhidoPeloUsuario()).toBeNull();
  });

  it('sem localStorage (modo anônimo) não quebra: o clube decide', () => {
    const original = Object.getOwnPropertyDescriptor(window, 'localStorage');
    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      get() {
        throw new Error('storage bloqueado');
      },
    });
    try {
      expect(idiomaEscolhidoPeloUsuario()).toBeNull();
      expect(() => marcarEscolhaDoUsuario('en-US')).not.toThrow();
    } finally {
      Object.defineProperty(window, 'localStorage', original);
    }
  });
});

describe('idioma do clube', () => {
  it('aplica quando a pessoa nunca escolheu', () => {
    const i18n = criarI18n('pt-BR');
    expect(aplicarIdiomaDaOrganizacao(i18n, 'es-ES')).toBe(true);
    expect(i18n.changeLanguage).toHaveBeenCalledWith('es-ES');
  });

  it('NÃO atropela quem já escolheu o seu', () => {
    marcarEscolhaDoUsuario('pt-BR');
    const i18n = criarI18n('pt-BR');
    expect(aplicarIdiomaDaOrganizacao(i18n, 'es-ES')).toBe(false);
    expect(i18n.changeLanguage).not.toHaveBeenCalled();
  });

  it('não faz nada se a tela já está no idioma do clube', () => {
    const i18n = criarI18n('es-ES');
    expect(aplicarIdiomaDaOrganizacao(i18n, 'es-ES')).toBe(false);
    expect(i18n.changeLanguage).not.toHaveBeenCalled();
  });

  it('idioma inválido vindo do banco é ignorado', () => {
    const i18n = criarI18n('pt-BR');
    expect(aplicarIdiomaDaOrganizacao(i18n, 'fr-FR')).toBe(false);
    expect(aplicarIdiomaDaOrganizacao(i18n, null)).toBe(false);
    expect(i18n.changeLanguage).not.toHaveBeenCalled();
  });

  it('sem i18n não estoura', () => {
    expect(aplicarIdiomaDaOrganizacao(null, 'es-ES')).toBe(false);
  });
});
