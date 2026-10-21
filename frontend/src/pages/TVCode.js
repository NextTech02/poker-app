import React, { useState, useEffect, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import api from '../config/api';
import './TVCode.css';

/**
 * Página PÚBLICA de acesso ao telão por CÓDIGO (para TVs). A pessoa entra em
 * /tv, escolhe o que a TV vai mostrar — o relógio de blinds ou o quadro de
 * mesas e assentos — e digita o código do dia. Também aceita /tv/:code, que
 * vai direto para os blinds (e /tv/:code/mesas, direto para as mesas).
 */
const TVCode = () => {
  const { t } = useTranslation();
  const { code: codeParam } = useParams();
  const navigate = useNavigate();
  const [code, setCode] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  // O que esta TV mostra: 'blinds' (relógio) ou 'mesas' (quem senta onde).
  const [tela, setTela] = useState('blinds');

  const resolve = useCallback(async (value, destino = 'blinds') => {
    const c = (value || '').trim().toUpperCase();
    if (!c) return;
    setLoading(true);
    setError('');
    try {
      // Sem token: a TV não faz login, e o código é a credencial.
      const res = await api.get(`/public/tv/${encodeURIComponent(c)}`, { _public: true });
      const dayId = res.data?.day_id;
      const tId = res.data?.tournament_id;
      if (dayId && destino === 'mesas') {
        navigate(`/tv/${encodeURIComponent(c)}/mesas`, { replace: true });
      } else if (dayId) {
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
    resolve(code, tela);
  };

  return (
    <div className="tv-code">
      <div className="tv-code__card">
        <h1 className="tv-code__title">
          {tela === 'mesas' ? t('tv.seatingTitle', 'Mesas e assentos') : t('tv.title', 'Tela de Blinds')}
        </h1>
        <p className="tv-code__subtitle">{t('tv.subtitle', 'Digite o código do torneio informado pelo sistema')}</p>
        <div className="tv-code__screens" role="radiogroup" aria-label={t('tv.screenLabel', 'O que mostrar nesta TV')}>
          {[
            ['blinds', t('tv.screenBlinds', 'Blinds')],
            ['mesas', t('tv.screenSeating', 'Mesas e assentos')],
          ].map(([valor, rotulo]) => (
            <button
              key={valor}
              type="button"
              role="radio"
              aria-checked={tela === valor}
              className={`tv-code__screen ${tela === valor ? 'is-on' : ''}`}
              onClick={() => setTela(valor)}
            >{rotulo}</button>
          ))}
        </div>
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
