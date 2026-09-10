import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import LanguageDetector from 'i18next-browser-languagedetector';

// ── Traducoes: uma no bundle, as outras sob demanda ─────────────────────────
// Os tres arquivos somam 379 KB de JSON. Importar todos aqui os colocava no
// BUNDLE PRINCIPAL: quem abre o sistema baixava, interpretava e mantinha na
// memoria os tres idiomas para usar UM. Era ~250 KB de puro desperdicio no
// caminho critico, antes do primeiro pixel.
//
// O pt-BR continua estatico porque e o `fallbackLng`: ele precisa estar em
// memoria de forma sincrona para qualquer chave que falte em outro idioma. Os
// outros dois viram chunks separados, carregados so quando alguem de fato usa.
import ptBR from '../locales/pt-BR.json';

const IDIOMA_PADRAO = 'pt-BR';

/** Import dinamico = webpack corta cada um num arquivo proprio. */
const CARREGADORES = {
  'en-US': () => import(/* webpackChunkName: "locale-en-US" */ '../locales/en-US.json'),
  'es-ES': () => import(/* webpackChunkName: "locale-es-ES" */ '../locales/es-ES.json'),
};

// Set, e nao array: `carregados.has(codigo)` e O(1) e este teste roda a cada
// troca de idioma e a cada boot.
const carregados = new Set([IDIOMA_PADRAO]);
// Guarda a promessa EM VOO, nao so o resultado: sem isto, dois pedidos
// simultaneos do mesmo idioma baixariam o mesmo chunk duas vezes.
const emVoo = new Map();

/**
 * Garante que o idioma esta carregado. Resolve na hora se ja estiver.
 *
 * Nunca rejeita: um chunk que nao baixa (rede caindo no meio) deixa a tela em
 * pt-BR, que e bem melhor do que uma tela em branco.
 */
export const garantirIdioma = (codigo) => {
  if (!codigo || carregados.has(codigo)) return Promise.resolve();
  if (emVoo.has(codigo)) return emVoo.get(codigo);

  const carregar = CARREGADORES[codigo];
  if (!carregar) return Promise.resolve();

  const promessa = carregar()
    .then((mod) => {
      // `deep` e `overwrite` ligados: o bundle chega inteiro e substitui.
      i18n.addResourceBundle(codigo, 'translation', mod.default || mod, true, true);
      carregados.add(codigo);
    })
    .catch(() => {
      /* fica no fallback pt-BR */
    })
    .finally(() => emVoo.delete(codigo));

  emVoo.set(codigo, promessa);
  return promessa;
};

const resources = {
  [IDIOMA_PADRAO]: {
    translation: ptBR
  }
};

i18n
  .use(LanguageDetector)
  .use(initReactI18next)
  .init({
    resources,
    fallbackLng: 'pt-BR',
    debug: false,

    interpolation: {
      escapeValue: false // React already escapes values
    },

    detection: {
      order: ['localStorage', 'navigator'],
      lookupLocalStorage: 'i18nextLng',
      caches: ['localStorage']
    }
  });

/**
 * Diz ao NAVEGADOR em que idioma a página está.
 *
 * Sem isto o `index.html` fica para sempre com `lang="pt-BR"`, mesmo com a
 * interface renderizada em espanhol ou inglês. O Chrome lê esse atributo, vê
 * "página em português" para um usuário de língua espanhola, e TRADUZ A PÁGINA
 * POR CIMA — retraduzindo um texto que já estava em espanhol.
 *
 * O estrago é pior do que parece, porque a tradução automática não conhece o
 * vocabulário de poker: num clube colombiano, o "break"/intervalo do torneio
 * aparecia como "allanamiento", que é como se traduz arrombamento. O operador
 * conclui, com razão, que "a tradução está toda errada" — e ela está, só que
 * não é a nossa.
 *
 * Declarando o idioma certo, o Chrome para de oferecer tradução: a página já
 * está no idioma do usuário. De quebra conserta o captcha, que lia este mesmo
 * atributo (Captcha.js) e por isso saía sempre em português para todo mundo.
 */
const sincronizarIdiomaDoDocumento = (idioma) => {
  if (typeof document === 'undefined') return;
  const escolhido = idioma || i18n.language || 'pt-BR';
  document.documentElement.lang = escolhido;
};

sincronizarIdiomaDoDocumento(i18n.language);
i18n.on('languageChanged', sincronizarIdiomaDoDocumento);

// Trocar de idioma agora pode precisar BAIXAR o idioma. Embrulhar o metodo aqui
// cobre todos os chamadores de uma vez (o seletor de bandeiras e o idioma da
// organizacao) sem que nenhum deles precise saber que o carregamento e
// preguicoso. O contrato continua o mesmo: devolve uma promessa.
const trocaOriginal = i18n.changeLanguage.bind(i18n);
i18n.changeLanguage = (codigo, ...resto) =>
  garantirIdioma(codigo).then(() => trocaOriginal(codigo, ...resto));

export default i18n;
