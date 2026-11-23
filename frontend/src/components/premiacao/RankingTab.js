import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import api from '../../config/api';
import Button from '../Button';
import { useToast } from '../../contexts/ToastContext';
import { useCurrency } from '../../contexts/CurrencyContext';
import { referenciaEmOutraMoeda } from '../../utils/rankingPontos';
import '../../pages/RankingPontos.css';

/**
 * Aba "Ranking" da Premiação: o torneio no ranking de pontos (Manual NSOP).
 *
 * A direção marca o torneio como pontuável, confere o buy-in oficial (B, sem
 * a taxa), confirma quem ficou em cada posição PREMIADA e oficializa. Os
 * pontos ficam congelados: mudar a premiação depois não mexe no ranking;
 * corrigir exige reabrir com motivo (fica no log de atividade).
 *
 * A proposta de posições vem da premiação (quem recebeu naquela posição) e,
 * na falta, da ordem de eliminação — por isso cada posição é um select que a
 * direção pode trocar.
 */
const codigoDoErro = (err) => err?.response?.data?.detail?.code;

const RankingTab = ({ tournamentId }) => {
  const { t, i18n } = useTranslation();
  const { toast } = useToast();
  const { formatCurrency, currency } = useCurrency();

  const [situacao, setSituacao] = useState(null);
  const [pendente, setPendente] = useState(false);
  const [carregando, setCarregando] = useState(true);
  const [salvando, setSalvando] = useState(false);
  const [buyIn, setBuyIn] = useState('');
  const [escolhas, setEscolhas] = useState({});
  const [reabrindo, setReabrindo] = useState(false);
  const [motivo, setMotivo] = useState('');

  const aplicar = useCallback((dados) => {
    setSituacao(dados);
    setBuyIn(dados?.buy_in_custom != null ? String(dados.buy_in_custom) : '');
    setEscolhas(Object.fromEntries((dados?.positions || []).map((p) => [p.position, p.player_id || ''])));
  }, []);

  const carregar = useCallback(async () => {
    setCarregando(true);
    try {
      const res = await api.get(`/points-ranking/tournaments/${tournamentId}`, { _silentError: true });
      setPendente(false);
      aplicar(res.data);
    } catch (err) {
      if (codigoDoErro(err) === 'ranking_migracao_pendente') setPendente(true);
      else toast.error(err?.userMessage || t('pointsRanking.loadError', 'Não foi possível carregar o ranking.'));
    } finally {
      setCarregando(false);
    }
  }, [tournamentId, aplicar, toast, t]);

  useEffect(() => { carregar(); }, [carregar]);

  const executar = async (fn, sucesso) => {
    setSalvando(true);
    try {
      const res = await fn();
      aplicar(res.data);
      if (sucesso) toast.success(sucesso);
      return true;
    } catch (err) {
      toast.error(err?.userMessage || t('pointsRanking.saveError', 'Não foi possível salvar.'));
      return false;
    } finally {
      setSalvando(false);
    }
  };

  const oficial = Boolean(situacao?.official_at);
  const posicoes = situacao?.positions || [];
  const completas = posicoes.length > 0 && posicoes.every((p) => escolhas[p.position]);
  const repetido = useMemo(() => {
    const vistos = Object.values(escolhas).filter(Boolean);
    return vistos.length !== new Set(vistos).size;
  }, [escolhas]);
  const podeOficializar = situacao?.scoring && situacao?.buy_in && posicoes.length > 0 && completas && !repetido;
  const dataHora = (iso) => (iso ? new Date(iso).toLocaleString(i18n?.language, { dateStyle: 'short', timeStyle: 'short' }) : '');

  if (carregando) return <div className="rk-card rk-muted">{t('common.loading', 'Carregando...')}</div>;
  if (pendente) {
    return (
      <div className="rk-card rk-aviso">
        {t('pointsRanking.migrationPending', 'O ranking de pontos ainda não está ativo neste servidor. Peça ao suporte para concluir a ativação.')}
      </div>
    );
  }
  if (!situacao) return null;

  const salvarConfig = (dados) => executar(
    () => api.put(`/points-ranking/tournaments/${tournamentId}`, dados),
    t('pointsRanking.saved', 'Ranking do torneio salvo.'),
  );

  const oficializar = () => executar(
    () => api.post(`/points-ranking/tournaments/${tournamentId}/official`, {
      positions: posicoes.map((p) => ({ position: p.position, player_id: escolhas[p.position] || null })),
    }),
    t('pointsRanking.officialized', 'Resultados oficializados. Os pontos estão no ranking.'),
  );

  const reabrir = async () => {
    const ok = await executar(
      () => api.post(`/points-ranking/tournaments/${tournamentId}/reopen`, { reason: motivo }),
      t('pointsRanking.reopened', 'Resultados reabertos para correção.'),
    );
    if (ok) {
      setReabrindo(false);
      setMotivo('');
    }
  };

  const ROTULO_DA_ORIGEM = {
    premiacao: t('pointsRanking.sourcePrize', 'Premiação'),
    eliminacao: t('pointsRanking.sourceElimination', 'Eliminação'),
    oficial: t('pointsRanking.sourceOfficial', 'Oficial'),
  };

  return (
    <div className="rk-tab">
      <div className="rk-card">
        <div className="rk-card__head">
          <h3>{t('pointsRanking.tabTitle', 'Ranking de pontos')}</h3>
          <span className={`rk-status ${oficial ? 'rk-status--ok' : ''}`}>
            {oficial
              ? t('pointsRanking.officialAt', 'Oficializado em {{when}}', { when: dataHora(situacao.official_at) })
              : t('pointsRanking.notOfficial', 'Não oficializado')}
          </span>
        </div>

        <label className="rk-check">
          <input
            type="checkbox"
            checked={Boolean(situacao.scoring)}
            disabled={oficial || salvando}
            onChange={(e) => salvarConfig({ scoring: e.target.checked })}
          />
          <span>{t('pointsRanking.scoring', 'Torneio pontuável (está no calendário do ranking)')}</span>
        </label>

        <div className="rk-fatos">
          <div className="rk-fato">
            <span className="rk-fato__rotulo">{t('pointsRanking.uniquePlayers', 'Jogadores únicos (N)')}</span>
            <strong>{situacao.unique_players}</strong>
          </div>
          <div className="rk-fato">
            <span className="rk-fato__rotulo">{t('pointsRanking.paidPlaces', 'Posições premiadas (T)')}</span>
            <strong>{situacao.paid_places}</strong>
          </div>
          <div className="rk-fato">
            <span className="rk-fato__rotulo">{t('pointsRanking.factor', 'Fator (jogadores × buy-in)')}</span>
            <strong>
              {situacao.buy_in_factor != null
                ? (situacao.players_factor * situacao.buy_in_factor).toFixed(3)
                : '—'}
            </strong>
          </div>
        </div>

        <div className="rk-buyin form-group">
          <label htmlFor="rk-buyin">{t('pointsRanking.officialBuyIn', 'Buy-in oficial (B), sem a taxa')}</label>
          <div className="rk-buyin__linha">
            <input
              id="rk-buyin"
              type="number"
              min="0"
              step="any"
              value={buyIn}
              disabled={oficial || salvando}
              placeholder={situacao.buy_in_default != null ? String(situacao.buy_in_default) : ''}
              onChange={(e) => setBuyIn(e.target.value)}
            />
            {!oficial && (
              <Button
                size="small"
                variant="secondary"
                disabled={salvando}
                onClick={() => salvarConfig({ buy_in: buyIn === '' ? null : Number(buyIn) })}
              >
                {t('common.save', 'Salvar')}
              </Button>
            )}
          </div>
          <span className="rk-muted">
            {situacao.buy_in_default != null
              ? t('pointsRanking.buyInDefaultHint', 'Vazio = {{value}} (o meio de entrada de buy-in mais caro que vale 1 entrada).', {
                value: formatCurrency(situacao.buy_in_default),
              })
              : t('pointsRanking.buyInMissingHint', 'O torneio não tem meio de entrada de buy-in: informe o valor.')}
          </span>
        </div>

        {!oficial && situacao.rules_customized === false
          && referenciaEmOutraMoeda(situacao.rules_customized, currency) && (
          <p className="rk-card rk-aviso" role="status">
            {t('pointsRanking.currencyWarning', 'O buy-in de referência ainda é o padrão ({{ref}} soles) e o clube usa {{moeda}}. Ajuste em Ranking → Regras antes de oficializar: os pontos ficam congelados.', {
              ref: situacao.buy_in_reference, moeda: currency,
            })}
          </p>
        )}

        {(situacao.warnings || []).length > 0 && (
          <ul className="rk-avisos">
            {situacao.warnings.map((aviso) => (
              <li key={aviso}>
                {t(`pointsRanking.warning.${aviso}`, {
                  min: situacao.min_unique_players,
                  defaultValue: aviso,
                })}
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="rk-card">
        <div className="rk-card__head">
          <h3>{t('pointsRanking.positionsTitle', 'Posições premiadas')}</h3>
          {!oficial && (
            <span className="rk-muted">
              {t('pointsRanking.positionsHint', 'Confira quem ficou em cada posição antes de oficializar.')}
            </span>
          )}
        </div>

        {posicoes.length === 0 ? (
          <p className="rk-muted">{t('pointsRanking.noPrizes', 'Configure a premiação do torneio: só as posições premiadas pontuam.')}</p>
        ) : (
          <div className="table-container">
            <table className="rk-tabela">
              <thead>
                <tr>
                  <th className="rk-num">{t('pointsRanking.colPosition', 'Posição')}</th>
                  <th>{t('pointsRanking.colPlayer', 'Jogador')}</th>
                  <th>{t('pointsRanking.colSource', 'Origem')}</th>
                  <th className="rk-num">{t('pointsRanking.colPoints', 'Pontos')}</th>
                </tr>
              </thead>
              <tbody>
                {posicoes.map((p) => (
                  <tr key={p.position}>
                    <td className="rk-num">{p.position}º</td>
                    <td>
                      {oficial ? (p.player_name || '—') : (
                        <select
                          aria-label={t('pointsRanking.playerAt', 'Jogador da posição {{position}}', { position: p.position })}
                          value={escolhas[p.position] || ''}
                          disabled={salvando}
                          onChange={(e) => setEscolhas((atual) => ({ ...atual, [p.position]: e.target.value }))}
                        >
                          <option value="">{t('pointsRanking.choosePlayer', 'Escolha o jogador')}</option>
                          {situacao.players.map((j) => (
                            <option key={j.id} value={j.id}>{j.name}</option>
                          ))}
                        </select>
                      )}
                    </td>
                    <td className="rk-muted">{ROTULO_DA_ORIGEM[p.source] || '—'}</td>
                    <td className="rk-num"><strong>{p.points}</strong></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {!oficial && repetido && (
          <p className="rk-erro">{t('pointsRanking.duplicatePlayer', 'O mesmo jogador está em duas posições.')}</p>
        )}

        {situacao.reopen_reason && !oficial && (
          <p className="rk-muted">
            {t('pointsRanking.lastReopen', 'Última correção: {{reason}}', { reason: situacao.reopen_reason })}
          </p>
        )}

        <div className="rk-acoes">
          {!oficial && (
            <Button onClick={oficializar} disabled={!podeOficializar || salvando}>
              {t('pointsRanking.officialize', 'Oficializar resultados')}
            </Button>
          )}
          {oficial && !reabrindo && (
            <Button variant="secondary" onClick={() => setReabrindo(true)} disabled={salvando}>
              {t('pointsRanking.reopen', 'Reabrir para corrigir')}
            </Button>
          )}
        </div>

        {oficial && reabrindo && (
          <div className="rk-reabrir form-group">
            <label htmlFor="rk-motivo">{t('pointsRanking.reopenReason', 'Motivo da correção (fica registrado)')}</label>
            <textarea id="rk-motivo" rows={2} value={motivo} onChange={(e) => setMotivo(e.target.value)} />
            <div className="rk-acoes">
              <Button variant="secondary" onClick={() => { setReabrindo(false); setMotivo(''); }} disabled={salvando}>
                {t('common.cancel', 'Cancelar')}
              </Button>
              <Button onClick={reabrir} disabled={motivo.trim().length < 5 || salvando}>
                {t('pointsRanking.confirmReopen', 'Reabrir')}
              </Button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

export default RankingTab;
