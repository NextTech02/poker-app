import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import api from '../../config/api';
import { useRealtimeRefresh } from '../../hooks/useRealtimeRefresh';
import { nomeCurto, revezamentoDaEquipe } from '../../utils/equipes';
import './RevezamentoCard.css';

/**
 * Final por revezamento, no Controle: para cada equipe, quem joga AGORA e quem
 * entra no próximo nível. Calculado aqui a partir do nível do relógio — vira na
 * hora da troca de nível, inclusive sem rede (a ordem já está carregada).
 */
const RevezamentoCard = ({ tournamentId, dayId, nivel, emIntervalo = false }) => {
  const { t } = useTranslation();
  const [dados, setDados] = useState(null);
  const [trocou, setTrocou] = useState(false);
  const nivelAnterior = useRef(nivel);

  const carregar = useCallback(async () => {
    if (!tournamentId) return;
    try {
      const res = await api.get(`/tournaments/${tournamentId}/teams/relay`, { _silentError: true });
      setDados(res?.data || null);
    } catch (_) { /* sem a ordem, o cartão não aparece */ }
  }, [tournamentId]);

  useEffect(() => { carregar(); }, [carregar]);

  useRealtimeRefresh({
    canal: `revezamento-${dayId}`,
    tabelas: [{ table: 'tournament_players', filter: `tournament_day_id=eq.${dayId}` }],
    aoMudar: carregar,
    ativo: !!dayId,
  });

  // Troca de nível: destaca o cartão por um tempo (o floor chama o próximo).
  useEffect(() => {
    if (nivelAnterior.current != null && nivel != null && nivel !== nivelAnterior.current) {
      setTrocou(true);
      const id = setTimeout(() => setTrocou(false), 30000);
      nivelAnterior.current = nivel;
      return () => clearTimeout(id);
    }
    nivelAnterior.current = nivel;
    return undefined;
  }, [nivel]);

  if (!dados?.teams?.length || (dados.final_day_id && dados.final_day_id !== dayId)) return null;
  const inicio = dados.start_level || 1;

  return (
    <div className={`rv-card ${trocou ? 'rv-trocou' : ''}`} role="region" aria-label={t('control.relayTitle', 'Revezamento')}>
      <h3>{t('control.relayTitle', 'Revezamento')} — {t('control.relayLevel', 'nível {{n}}', { n: nivel ?? '—' })}</h3>
      {trocou && (
        <div className="rv-aviso" role="status">
          {t('control.relaySwap', 'Novo nível: entra o próximo de cada equipe (quem está jogando termina a mão).')}
        </div>
      )}
      <div className="rv-lista">
        {dados.teams.map((equipe) => {
          const { atual, proximo } = revezamentoDaEquipe(equipe.members, nivel, inicio);
          const caiu = equipe.status === 'eliminated';
          return (
            <div className={`rv-equipe ${caiu ? 'caiu' : ''}`} key={equipe.team_id}>
              <strong>{equipe.name}</strong>
              {caiu ? (
                <div className="rv-proximo">{t('control.relayOut', 'eliminada')}</div>
              ) : (
                <>
                  <div className="rv-agora">
                    {emIntervalo ? t('control.relayLast', 'Jogou: {{nome}}', { nome: nomeCurto(atual) })
                      : t('control.relayNow', 'Agora: {{nome}}', { nome: nomeCurto(atual) })}
                  </div>
                  <div className="rv-proximo">
                    {emIntervalo ? t('control.relayAfterBreak', 'Depois do intervalo: {{nome}}', { nome: nomeCurto(proximo) })
                      : t('control.relayNext', 'Próximo nível: {{nome}}', { nome: nomeCurto(proximo) })}
                  </div>
                </>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
};

export default RevezamentoCard;
