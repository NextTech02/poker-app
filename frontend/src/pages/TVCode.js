import React, { useState, useEffect, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import api from '../config/api';
import './TVCode.css';

/**
 * Página PÚBLICA de acesso à tela de blinds por CÓDIGO (para TVs). A pessoa entra
 * em /tv, digita o código do torneio e é levada ao broadcast do dia ativo.
 * Também aceita /tv/:code (resolve automaticamente).
 */
const TVCode = () => {
  const { t } = useTranslation();
  const { code: codeParam } = useParams();
  const navigate = useNavigate();
  const [code, setCode] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const resolve = useCallback(async (value) => {
    const c = (value || '').trim().toUpperCase();
    if (!c) return;
    setLoading(true);
    setError('');
    try {
      // Sem token: a TV não faz login, e o código é a credencial.
      const res = await api.get(`/public/tv/${encodeURIComponent(c)}`, { _public: true });
      const dayId = res.data?.day_id;
      const tId = res.data?.tournament_id;
      if (dayId) {
        navigate(`/broadcast/${dayId}`, { replace: true });
      } else if (tId) {
        navigate(`/broadcast/${tId}`, { replace: true });
      } else {
        setError(t('tv.noDay', 'Torneio sem dia para exibir.'));
      }
    } catch (e) {
      // Só o 404 é "código inválido". Sem rede ou com o servidor fora, dizer
      // isso mandaria o operador conferir um código que está certo.
      setError(e?.response?.status === 404
        ? t('tv.invalid', 'Código inválido. Confira e tente de novo.')
        : t('tv.unreachable', 'Não foi possível conectar ao sistema. Verifique a internet e tente de novo.'));
    } finally {
      setLoading(false);
    }
  }, [navigate, t]);

  // /tv/:code → resolve automaticamente
  useEffect(() => {
    if (codeParam) resolve(codeParam);
  }, [codeParam, resolve]);

  const onSubmit = (e) => {
    e.preventDefault();
    resolve(code);
  };

  return (
    <div className="tv-code">
      <div className="tv-code__card">
        <h1 className="tv-code__title">{t('tv.title', 'Tela de Blinds')}</h1>
        <p className="tv-code__subtitle">{t('tv.subtitle', 'Digite o código do torneio informado pelo sistema')}</p>
        <form onSubmit={onSubmit} className="tv-code__form">
          <input
            className="tv-code__input"
            value={code}
            onChange={(e) => setCode(e.target.value.toUpperCase())}
            placeholder="XXXXXX"
            maxLength={12}
            autoFocus
            autoCapitalize="characters"
            spellCheck={false}
          />
          <button className="tv-code__btn" type="submit" disabled={loading || !code.trim()}>
            {loading ? t('tv.loading', 'Abrindo…') : t('tv.enter', 'Entrar')}
          </button>
        </form>
        {error && <div className="tv-code__error">{error}</div>}
      </div>
    </div>
  );
};

export default TVCode;
