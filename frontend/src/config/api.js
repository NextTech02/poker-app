import axios from 'axios';
import i18n from 'i18next';
import { getSelectedStageId } from '../utils/stageUtils';
import { emitToastError } from '../utils/toastEmitter';
import { putGetCache, getGetCache } from '../offline/db';
import { markOffline, markOnline } from '../offline/connectivity';

const API_URL = process.env.REACT_APP_API_URL || 'http://localhost:8000';

const api = axios.create({
  baseURL: API_URL,
  headers: {
    'Content-Type': 'application/json',
  },
});

// Add auth token and selected stage to requests
api.interceptors.request.use((config) => {
  const token = localStorage.getItem('supabase_token');
  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
  }

  const stageId = getSelectedStageId();
  if (stageId) {
    config.headers['X-Stage-ID'] = stageId;
  }

  return config;
});

// ── Cache de leitura (read-through) para funcionar OFFLINE ───────────────────
// Toda resposta GET bem-sucedida é guardada no IndexedDB. Quando a rede falha
// (offline), servimos a última resposta cacheada daquele endpoint — assim as
// telas mostram os últimos dados vistos (torneios, jogadores, mesas...) em vez
// de quebrar. Online, sempre bate no servidor: nada de dado velho com rede.
//
// A chave é escopada por USUÁRIO + ORGANIZAÇÃO (claims do JWT), senão o cache de
// um cliente vazaria para outro no mesmo dispositivo. É limpo no logout.

// Endpoints voláteis/ruidosos: não vale cachear (mudam a cada segundo ou têm
// lógica offline própria).
const NO_CACHE = ['/timer/', '/health', '/sync/', '/broadcast-code'];

const isNetworkError = (error) =>
  !error?.response &&
  (error?.code === 'ERR_NETWORK' || error?.message === 'Network Error' ||
   error?.code === 'ECONNABORTED' || !navigator.onLine);

const scopeFromToken = () => {
  try {
    const t = localStorage.getItem('supabase_token');
    const c = JSON.parse(atob(t.split('.')[1]));
    return `${c.sub || 'anon'}:${c.organization_id || 'noorg'}`;
  } catch (_) {
    return 'anon:noorg';
  }
};

const cacheKey = (config) => {
  const method = (config.method || 'get').toLowerCase();
  const url = config.url || '';
  const params = config.params ? JSON.stringify(config.params) : '';
  const stage = config.headers?.['X-Stage-ID'] || getSelectedStageId() || '';
  return `${scopeFromToken()}|${method}|${url}|${params}|${stage}`;
};

const isCacheableGet = (config) => {
  if ((config.method || 'get').toLowerCase() !== 'get') return false;
  const url = config.url || '';
  return !NO_CACHE.some((p) => url.includes(p));
};

// Global response error interceptor (B2.1)
api.interceptors.response.use(
  (response) => {
    // Guarda a resposta para leitura offline (fire-and-forget).
    try {
      if (isCacheableGet(response.config)) {
        markOnline();
        putGetCache(cacheKey(response.config), response.data);
      }
    } catch (_) { /* cache nunca atrapalha a resposta */ }
    return response;
  },
  async (error) => {
    // OFFLINE: se for uma leitura e tivermos cache, devolve o cache em vez de
    // falhar — é o que faz as telas carregarem sem internet.
    if (isNetworkError(error) && error.config && isCacheableGet(error.config)) {
      markOffline();
      const cached = await getGetCache(cacheKey(error.config));
      if (cached !== null && cached !== undefined) {
        return { data: cached, status: 200, statusText: 'OK (cache offline)',
                 headers: {}, config: error.config, _fromCache: true };
      }
    }

    const detail = error?.response?.data?.detail;
    // Erros de validação (422) do FastAPI vêm como LISTA de objetos
    // ({type, loc, msg, input, ctx}), não como texto. Sem achatar aqui, quem
    // renderizasse `detail` direto quebraria a tela com "Objects are not valid
    // as a React child". Convertemos para uma frase legível, indicando o campo.
    const flattenDetail = (d) => {
      if (typeof d === 'string') return d;
      if (Array.isArray(d)) {
        return d
          .map((item) => {
            if (typeof item === 'string') return item;
            const field = Array.isArray(item?.loc)
              ? item.loc.filter((p) => p !== 'body').join('.')
              : null;
            const text = item?.msg || '';
            return field ? `${field}: ${text}` : text;
          })
          .filter(Boolean)
          .join(' · ');
      }
      if (d && typeof d === 'object') {
        /* Recusa com CÓDIGO (ver backend/app/utils/erros.py). O servidor manda
           `{code, message, ...extras}` justamente para NÃO decidir o idioma: o
           sistema atende clubes no Brasil, no Peru e na Colômbia, e uma frase
           pronta em português chegaria assim para todos eles.

           A chave é `errors.<code>` e o padrão inline é a própria `message` do
           servidor — então um código que a tela ainda não conhece aparece em
           português, em vez de virar "erro desconhecido". Os extras entram como
           variáveis da frase ({{name}}, {{nivel}}). */
        if (d.code) return i18n.t(`errors.${d.code}`, d.message, d);
        return d.msg || d.message || null;
      }
      return null;
    };

    const msg =
      flattenDetail(detail) ||
      error?.message ||
      'Erro desconhecido';

    // Skip logging for requests marked as silent (e.g. permissions check)
    const silent = error?.config?._silentError;
    if (!silent) {
      console.error('[API Error]', {
        status: error?.response?.status,
        url: error?.config?.url,
        message: msg,
      });
    }

    // Auto-toast for 5xx server errors (unless silent)
    if (!silent && error?.response?.status >= 500) {
      emitToastError(i18n.t('errors.serverError', 'Erro interno do servidor. Tente novamente em instantes.'));
    }

    return Promise.reject({ ...error, userMessage: msg });
  }
);

export default api;
