import axios from 'axios';
import { getSelectedStageId } from '../utils/stageUtils';

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

  // Add selected stage ID to headers if one is selected
  const stageId = getSelectedStageId();
  if (stageId) {
    config.headers['X-Stage-ID'] = stageId;
  }

  return config;
});

export default api;
