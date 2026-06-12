import axios from 'axios';
import i18n from 'i18next';
import { getSelectedStageId } from '../utils/stageUtils';
import { emitToastError } from '../utils/toastEmitter';

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

// Global response error interceptor (B2.1)
api.interceptors.response.use(
  (response) => response,
  (error) => {
    const detail = error?.response?.data?.detail;
    const msg =
      (typeof detail === 'string' ? detail : null) ||
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
