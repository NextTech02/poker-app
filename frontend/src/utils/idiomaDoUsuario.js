/**
 * Quem manda no idioma da tela: o clube ou a pessoa?
 *
 * As duas coisas, nesta ordem: o clube define o PADRÃO (é o idioma escolhido na
 * criação da organização, guardado em `app_settings.language`), e a pessoa pode
 * trocar para si mesma pelo seletor de bandeiras. A escolha da pessoa vale mais
 * — e continua valendo nas visitas seguintes.
 *
 * Por que isto precisa de um arquivo próprio, e não dá para usar só o
 * `i18nextLng` do localStorage: o detector do i18next GRAVA nesse mesmo lugar o
 * idioma que ele adivinhou pelo navegador. Depois da primeira visita ele está
 * sempre preenchido, e não há como distinguir "a pessoa escolheu português" de
 * "o navegador estava em português". Se olhássemos só para ele, o idioma do
 * clube nunca seria aplicado a ninguém.
 *
 * Então guardamos a escolha EXPLÍCITA numa chave separada, escrita em um lugar
 * só: quando alguém clica numa bandeira.
 */

const CHAVE = 'aceblind:idiomaEscolhido';

/**
 * Os idiomas que o sistema fala, num lugar só: o seletor de bandeiras, o
 * seletor do Financeiro e o formulário de criação de organização listam todos
 * daqui. `cc` é o código de país da bandeira.
 */
export const IDIOMAS = [
  { code: 'pt-BR', name: 'Português', cc: 'br' },
  { code: 'en-US', name: 'English', cc: 'us' },
  { code: 'es-ES', name: 'Español', cc: 'es' },
];

export const IDIOMAS_SUPORTADOS = IDIOMAS.map((l) => l.code);

const ehSuportado = (codigo) => IDIOMAS_SUPORTADOS.includes(codigo);

/** O idioma que a pessoa escolheu a dedo, ou null se ela nunca escolheu. */
export const idiomaEscolhidoPeloUsuario = () => {
  try {
    const salvo = window.localStorage.getItem(CHAVE);
    return ehSuportado(salvo) ? salvo : null;
  } catch (e) {
    // Modo anônimo / storage bloqueado: sem memória, o clube decide sempre.
    return null;
  }
};

/** Registra que a escolha veio da pessoa (chamar ao clicar no seletor). */
export const marcarEscolhaDoUsuario = (codigo) => {
  if (!ehSuportado(codigo)) return;
  try {
    window.localStorage.setItem(CHAVE, codigo);
  } catch (e) {
    /* sem storage a escolha vale só nesta sessão — melhor que quebrar */
  }
};

/**
 * Aplica o idioma do clube, respeitando quem já escolheu o seu.
 * Devolve true se trocou de fato — os testes se apoiam nisso.
 */
export const aplicarIdiomaDaOrganizacao = (i18n, idiomaDaOrg) => {
  if (!i18n || !ehSuportado(idiomaDaOrg)) return false;
  if (idiomaEscolhidoPeloUsuario()) return false;
  if (i18n.language === idiomaDaOrg) return false;
  i18n.changeLanguage(idiomaDaOrg);
  return true;
};
