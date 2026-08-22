import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import LanguageDetector from 'i18next-browser-languagedetector';

// Import translation files
import ptBR from '../locales/pt-BR.json';
import enUS from '../locales/en-US.json';
import esES from '../locales/es-ES.json';

const resources = {
  'pt-BR': {
    translation: ptBR
  },
  'en-US': {
    translation: enUS
  },
  'es-ES': {
    translation: esES
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

export default i18n;
