import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import api from '../../config/api';
import Button from '../Button';
import { useToast } from '../../contexts/ToastContext';
import { MAX_FINALISTAS } from '../../utils/equipes';
import './Equipes.css';

/**
 * Final por revezamento: classificar as equipes (uma inscrição por equipe no
 * dia final, com o stack novo), a ordem dos 4 de cada equipe e a
 * classificação final. Quem joga em cada nível aparece no Controle e no telão.
 */
const FinalTab = ({ tournamentId, dados, relay, onMudou }) => {
  const { t } = useTranslation();
  const { toast, confirm } = useToast();
  const [finalistas, setFinalistas] = useState(
    String(dados?.tournament?.team_finalists || Math.min(MAX_FINALISTAS, dados?.teams?.length || 0) || ''),
  );
  const [fichas, setFichas] = useState('');
  const [ocupado, setOcupado] = useState(false);
  const [erro, setErro] = useState('');
  const base = `/tournaments/${tournamentId}/teams`;

  const executar = async (acao) => {
    setOcupado(true);
    setErro('');
    try {
      await acao();
      if (onMudou) await onMudou();
    } catch (err) {
      setErro(err.userMessage || t('teams.actionError', 'Não foi possível concluir.'));
    } finally {
      setOcupado(false);
    }
  };

  const oficial = !!dados?.tournament?.team_results_official_at;
  const montada = !!relay?.teams?.length;

  const montar = () => executar(async () => {
    await api.post(`${base}/final`, {
      finalists: parseInt(finalistas, 10),
      ...(fichas ? { chips: parseInt(fichas, 10) } : {}),
    });
    toast.success(t('teams.finalReady', 'Final montada.'));
  });

  const desfazer = () => executar(async () => {
    if (!(await confirm(t('teams.finalUndoConfirm', 'Desfazer a final? As inscrições das equipes no dia final são apagadas.')))) return;
    await api.delete(`${base}/final`);
  });

  const moverIntegrante = (equipe, indice, direcao) => executar(async () => {
    const ordem = equipe.members.map((m) => m.player_id);
    const j = indice + direcao;
    if (j < 0 || j >= ordem.length) return;
    [ordem[indice], ordem[j]] = [ordem[j], ordem[indice]];
    let forcar = false;
    if (relay?.final_started) {
      forcar = await confirm(t('teams.relayLockedConfirm', 'A final já começou. Mudar a ordem do revezamento mesmo assim?'));
      if (!forcar) return;
    }
    await api.put(`${base}/${equipe.team_id}/relay-order`, { player_ids: ordem, force: forcar });
  });

  if (!oficial && !montada) {
    return <p className="eq-hint">{t('teams.finalNeedsOfficial', 'Oficialize a classificação da Fase 1 (aba Fase 1) para montar a final.')}</p>;
  }

  return (
    <div className="eq-final">
      {erro && <div className="eq-erro" role="alert">{erro}</div>}
      {!montada ? (
        <div className="eq-bloco">
          <h3>{t('teams.setupFinal', 'Montar a final')}</h3>
          <p className="eq-hint">
            {t('teams.setupFinalHint', 'As melhores equipes da Fase 1 vão à mesa final, cada uma com um stack novo e igual (os pontos não passam). Cada equipe vira uma inscrição no dia final, no nome do capitão.')}
          </p>
          <div className="eq-linha-campos">
            <div className="eq-field">
              <label htmlFor="eq-finalistas">{t('teams.finalists', 'Equipes na final')}</label>
              <input id="eq-finalistas" type="number" min="1" max={MAX_FINALISTAS} value={finalistas}
                onChange={(e) => setFinalistas(e.target.value)} disabled={ocupado} />
            </div>
            <div className="eq-field">
              <label htmlFor="eq-fichas">{t('teams.finalChips', 'Stack de cada equipe')}</label>
              <input id="eq-fichas" type="number" min="1" value={fichas} onChange={(e) => setFichas(e.target.value)}
                placeholder={t('teams.finalChipsPlaceholder', 'Fichas iniciais do dia final')} disabled={ocupado} />
            </div>
          </div>
          <Button onClick={montar} disabled={ocupado || !(parseInt(finalistas, 10) >= 1)}>
            {t('teams.setupFinal', 'Montar a final')}
          </Button>
        </div>
      ) : (
        <>
          <div className="eq-bloco">
            <div className="eq-bloco-header">
              <h3>{t('teams.relayTitle', 'Ordem do revezamento')}</h3>
              <div className="eq-acoes">
                {relay.final_day_id && (
                  <Link className="eq-link" to={`/control/${relay.final_day_id}`}>{t('teams.openControl', 'Abrir Controle da final')}</Link>
                )}
                {!relay.final_started && (
                  <Button size="small" variant="secondary" onClick={desfazer} disabled={ocupado}>
                    {t('teams.undoFinal', 'Desfazer final')}
                  </Button>
                )}
              </div>
            </div>
            <p className="eq-hint">
              {t('teams.relayHint', 'A cada nível de blinds entra o próximo da ordem; todos jogam antes de alguém repetir. Quem está jogando termina a mão. Ausente não muda a ordem: o stack da equipe paga blinds e antes.')}
            </p>
            <div className="eq-equipes-final">
              {relay.teams.map((equipe) => (
                <div className={`eq-equipe-final ${equipe.status === 'eliminated' ? 'caiu' : ''}`} key={equipe.team_id}>
                  <strong>{equipe.name}</strong>
                  <ol>
                    {equipe.members.map((m, i) => (
                      <li key={m.player_id}>
                        <span>{m.name}{m.is_captain ? ` (${t('teams.captainShort', 'C')})` : ''}</span>
                        <span className="eq-setas">
                          <button type="button" className="eq-mini" disabled={ocupado || i === 0}
                            onClick={() => moverIntegrante(equipe, i, -1)}
                            aria-label={t('teams.moveUp', 'Subir {{nome}}', { nome: m.name })}>↑</button>
                          <button type="button" className="eq-mini" disabled={ocupado || i === equipe.members.length - 1}
                            onClick={() => moverIntegrante(equipe, i, 1)}
                            aria-label={t('teams.moveDown', 'Descer {{nome}}', { nome: m.name })}>↓</button>
                        </span>
                      </li>
                    ))}
                  </ol>
                </div>
              ))}
            </div>
          </div>

          <div className="eq-bloco">
            <h3>{t('teams.standingsTitle', 'Classificação final')}</h3>
            <table className="eq-tabela">
              <thead>
                <tr>
                  <th>#</th>
                  <th>{t('teams.team', 'Equipe')}</th>
                  <th>{t('teams.status', 'Situação')}</th>
                </tr>
              </thead>
              <tbody>
                {(relay.standings || []).map((linha) => (
                  <tr key={linha.team_id}>
                    <td>{linha.position ?? '—'}</td>
                    <td>{linha.name}</td>
                    <td>{t(`teams.standing_${linha.status}`, linha.status)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
};

export default FinalTab;
