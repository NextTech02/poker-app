import React, { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import api from '../../config/api';
import Button from '../Button';
import { useToast } from '../../contexts/ToastContext';
import { useHistoricoDoJogador } from '../../hooks/useHistoricoDoJogador';
import { formatarPontos, previaDasMesas, resumoDasMesas } from '../../utils/equipes';
import { imprimirConferencia } from './conferencia';
import './Equipes.css';

const VIVOS = new Set(['registered', 'active']);

/**
 * Fase 1: sorteio das mesas (integrantes separados), pontos por mesa,
 * correções da direção, ranking das equipes, conferência dos capitães e a
 * oficialização. A eliminação em si continua sendo o ✕ da Gestão de Mesas.
 */
const Fase1Tab = ({ tournamentId, torneio, resumo, inscritosVivos = 0, onMudou }) => {
  const { t } = useTranslation();
  // O nome na mesa abre o histórico do jogador.
  const { podeVerHistorico } = useHistoricoDoJogador();
  const { toast, confirm } = useToast();
  const [ocupado, setOcupado] = useState(false);
  const [erro, setErro] = useState('');
  const [posicoes, setPosicoes] = useState(null); // { mesa, valores: { tp_id: pos } }

  const executar = async (acao, sucesso) => {
    setOcupado(true);
    setErro('');
    try {
      const res = await acao();
      const mensagem = typeof sucesso === 'function' ? sucesso(res) : sucesso;
      if (mensagem) toast.success(mensagem);
      if (onMudou) await onMudou();
    } catch (err) {
      setErro(err.userMessage || t('teams.actionError', 'Não foi possível concluir.'));
    } finally {
      setOcupado(false);
    }
  };

  const oficial = !!resumo?.official;
  const base = `/tournaments/${tournamentId}/teams`;
  const tamanhos = previaDasMesas(inscritosVivos);

  const sortear = (refazer = false) => executar(
    async () => {
      if (refazer) {
        const ok = await confirm(t('teams.redoConfirm', 'Refazer o sorteio tira TODOS do lugar e sorteia de novo. Continuar?'));
        if (!ok) return null;
      }
      return api.post(`${base}/seating`, { redo: refazer });
    },
    (res) => (res ? t('teams.seated', '{{n}} jogador(es) sentado(s).', { n: res?.data?.allocated ?? 0 }) : null),
  );

  const corrigir = (tpId, corpo) => executar(() => api.patch(`${base}/stage1/results/${tpId}`, corpo));

  const salvarPosicoes = () => executar(async () => {
    const valores = Object.fromEntries(
      Object.entries(posicoes.valores).map(([k, v]) => [k, parseInt(v, 10)]),
    );
    await api.put(`${base}/stage1/tables/${posicoes.mesa.table_id}/positions`, { positions: valores });
    setPosicoes(null);
  });

  const conferir = (equipe) => executar(() => api.post(`${base}/${equipe.team_id}/verify`, { verified: !equipe.verified }));

  // Desempate manual: move a equipe uma posição dentro do grupo empatado.
  const ranking = useMemo(() => resumo?.ranking || [], [resumo]);
  const mover = (indice, direcao) => {
    const alvo = ranking[indice];
    const vizinho = ranking[indice + direcao];
    if (!alvo || !vizinho) return;
    const grupo = ranking.filter((l) => l.points === alvo.points && l.captain_points === alvo.captain_points);
    const ordem = grupo.map((l) => l.team_id);
    const i = ordem.indexOf(alvo.team_id);
    const j = ordem.indexOf(vizinho.team_id);
    if (j < 0) return;
    [ordem[i], ordem[j]] = [ordem[j], ordem[i]];
    executar(() => api.put(`${base}/tiebreak`, { team_ids: ordem }));
  };

  const oficializar = () => executar(async () => {
    const emJogo = resumo?.tables_in_play || [];
    let forcar = false;
    if (emJogo.length) {
      forcar = await confirm(t('teams.officialForce', 'Ainda há mesas em jogo ({{mesas}}). Oficializar mesmo assim? Quem continua sentado nelas fica sem pontos.', { mesas: emJogo.join(', ') }));
      if (!forcar) return;
    } else if (!(await confirm(t('teams.officialConfirm', 'Oficializar a classificação da Fase 1? Depois disso os resultados não mudam mais.')))) {
      return;
    }
    await api.post(`${base}/stage1/official`, { force: forcar });
    toast.success(t('teams.officialDone', 'Classificação oficializada.'));
  });

  const desoficializar = () => executar(async () => {
    if (!(await confirm(t('teams.unofficialConfirm', 'Desfazer a oficialização? A classificação volta a ser calculada ao vivo.')))) return;
    await api.delete(`${base}/stage1/official`);
  });

  if (!resumo) return <div className="loading">{t('common.loading')}</div>;
  const criterio = resumo.tiebreak || 'best_individual';

  return (
    <div className="eq-fase1">
      {erro && <div className="eq-erro" role="alert">{erro}</div>}

      <div className="eq-bloco">
        <div className="eq-bloco-header">
          <h3>{t('teams.seatingTitle', 'Mesas da Fase 1')}</h3>
          <div className="eq-acoes">
            {resumo.day_id && (
              <Link className="eq-link" to={`/alocacao/dia/${resumo.day_id}`}>{t('teams.openTables', 'Abrir Gestão de Mesas')}</Link>
            )}
            <Button size="small" onClick={() => sortear(false)} disabled={ocupado || oficial}>
              {t('teams.drawSeats', 'Sortear mesas')}
            </Button>
            <Button size="small" variant="secondary" onClick={() => sortear(true)} disabled={ocupado || oficial}>
              {t('teams.redoDraw', 'Refazer sorteio')}
            </Button>
          </div>
        </div>
        <p className="eq-hint">
          {tamanhos.length
            ? t('teams.seatingPreview', '{{n}} jogadores → {{k}} mesas ({{tamanhos}}). Integrantes da mesma equipe sempre em mesas diferentes; no máximo 8 por mesa.', {
              n: inscritosVivos, k: tamanhos.length, tamanhos: resumoDasMesas(tamanhos),
            })
            : t('teams.seatingEmpty', 'Inscreva os jogadores (Caixa ou "Cobrar equipe") e crie as mesas do dia; depois sorteie.')}
        </p>
        <p className="eq-hint">
          {t('teams.simultaneousHint', 'Eliminação na mesma mão: elimine primeiro quem começou a mão com MENOS fichas. Com fichas iguais, marque "empate com o anterior" — os pontos se dividem.')}
        </p>
      </div>

      {resumo.warnings?.length > 0 && (
        <ul className="eq-avisos">
          {resumo.warnings.map((a) => (
            <li key={a.code}>{t(`teams.warning_${a.code}`, a.code, { count: a.count, teams: a.teams })}</li>
          ))}
        </ul>
      )}

      <div className="eq-mesas">
        {resumo.tables.map((mesa) => (
          <div className={`eq-mesa ${mesa.finished ? 'terminada' : ''}`} key={mesa.table_id}>
            <div className="eq-mesa-header">
              <strong>{t('teams.tableN', 'Mesa {{n}}', { n: mesa.table_number ?? '?' })}</strong>
              <span className="eq-mesa-status">
                {mesa.finished ? t('teams.tableFinished', 'Terminada') : t('teams.tableInPlay', 'Em jogo')}
                {' · '}{t('teams.tableSize', '{{n}} jogadores', { n: mesa.size })}
                {mesa.manual ? ` · ${t('teams.manualPositions', 'posições à mão')}` : ''}
              </span>
            </div>
            <table className="eq-tabela">
              <thead>
                <tr>
                  <th>{t('teams.position', 'Posição')}</th>
                  <th>{t('teams.player', 'Jogador')}</th>
                  <th>{t('teams.team', 'Equipe')}</th>
                  <th>{t('teams.points', 'Pontos')}</th>
                  {!oficial && !mesa.manual && <th aria-label={t('teams.corrections', 'Correções')} />}
                </tr>
              </thead>
              <tbody>
                {mesa.players.map((p, i) => {
                  const eliminado = !VIVOS.has(p.status);
                  const anterior = i < mesa.players.length - 1 ? mesa.players[i + 1] : null;
                  return (
                    <tr key={p.tp_id} className={eliminado ? '' : 'vivo'}>
                      <td>{p.position ? `${p.position}º${p.tie ? ' =' : ''}` : '—'}</td>
                      <td>
                        {podeVerHistorico && p.player_id ? (
                          <Link to={`/jogadores/${p.player_id}`} title={t('players.viewHistory', 'Ver histórico')}>
                            {p.name}
                          </Link>
                        ) : p.name}
                        {p.is_captain ? ` (${t('teams.captainShort', 'C')})` : ''}
                      </td>
                      <td>{p.team_name || t('teams.noTeam', 'sem equipe')}</td>
                      <td>{formatarPontos(p.points)}</td>
                      {!oficial && !mesa.manual && (
                        <td className="eq-correcoes">
                          {eliminado && p.eliminated_at && anterior && !VIVOS.has(anterior.status) && (
                            <>
                              <label className="eq-check" title={t('teams.tieHint', 'Caiu na mesma mão, com as mesmas fichas, que o anterior')}>
                                <input
                                  type="checkbox"
                                  checked={!!p.tie_with_previous}
                                  onChange={(e) => corrigir(p.tp_id, { tie_with_previous: e.target.checked })}
                                  disabled={ocupado}
                                />
                                {t('teams.tieWithPrevious', 'empate c/ anterior')}
                              </label>
                              <button
                                type="button"
                                className="eq-mini"
                                onClick={() => corrigir(p.tp_id, { swap_with_previous: true })}
                                disabled={ocupado}
                                title={t('teams.swapHint', 'Caiu ANTES do anterior (trocar a ordem)')}
                                aria-label={t('teams.swapLabel', 'Trocar a ordem de {{nome}} com o anterior', { nome: p.name })}
                              >
                                ⇅
                              </button>
                            </>
                          )}
                        </td>
                      )}
                    </tr>
                  );
                })}
              </tbody>
            </table>
            {!oficial && mesa.finished && (
              <div className="eq-mesa-acoes">
                {mesa.manual ? (
                  <button type="button" className="eq-link-btn" disabled={ocupado}
                    onClick={() => executar(() => api.delete(`${base}/stage1/tables/${mesa.table_id}/positions`))}>
                    {t('teams.clearPositions', 'Voltar à ordem das eliminações')}
                  </button>
                ) : (
                  <button type="button" className="eq-link-btn" disabled={ocupado}
                    onClick={() => setPosicoes({
                      mesa,
                      valores: Object.fromEntries(mesa.players.map((p) => [p.tp_id, String(p.position ?? '')])),
                    })}>
                    {t('teams.typePositions', 'Digitar posições')}
                  </button>
                )}
              </div>
            )}
          </div>
        ))}
        {resumo.tables.length === 0 && (
          <p className="eq-hint">{t('teams.noTablesYet', 'Ninguém sentado ainda.')}</p>
        )}
      </div>

      <div className="eq-bloco">
        <div className="eq-bloco-header">
          <h3>{t('teams.rankingTitle', 'Classificação das equipes')}</h3>
          <div className="eq-acoes">
            <Button size="small" variant="secondary"
              onClick={() => imprimirConferencia({ torneio: torneio?.name, ranking, t })}>
              {t('teams.printSheet', 'Imprimir conferência')}
            </Button>
            {oficial ? (
              <Button size="small" variant="secondary" onClick={desoficializar} disabled={ocupado || resumo.final_set_up}>
                {t('teams.unofficial', 'Desfazer oficialização')}
              </Button>
            ) : (
              <Button size="small" onClick={oficializar} disabled={ocupado || !ranking.length}>
                {t('teams.official', 'Oficializar')}
              </Button>
            )}
          </div>
        </div>
        {oficial && <p className="eq-ok">{t('teams.officialBadge', 'Classificação OFICIAL')}</p>}
        {resumo.cut_tie && (
          <div className="eq-erro" role="alert">
            {criterio === 'manual'
              ? t('teams.cutTieManual', 'Há equipes empatadas na linha de corte da final: use as setas para a ordem da direção.')
              : t('teams.cutTie', 'Há equipes empatadas na linha de corte da final.')}
          </div>
        )}
        <table className="eq-tabela eq-ranking">
          <thead>
            <tr>
              <th>#</th>
              <th>{t('teams.team', 'Equipe')}</th>
              <th>{t('teams.points', 'Pontos')}</th>
              <th>{t('teams.captainPoints', 'Capitão')}</th>
              <th>{t('teams.members', 'Integrantes')}</th>
              <th>{t('teams.verified', 'Conferido')}</th>
            </tr>
          </thead>
          <tbody>
            {ranking.map((linha, i) => (
              <tr key={linha.team_id} className={resumo.finalists && linha.rank <= resumo.finalists ? 'na-final' : ''}>
                <td>
                  {linha.rank}{linha.tied ? ' =' : ''}
                  {!oficial && criterio === 'manual' && linha.tied && (
                    <span className="eq-setas">
                      <button type="button" className="eq-mini" disabled={ocupado} onClick={() => mover(i, -1)}
                        aria-label={t('teams.moveUp', 'Subir {{nome}}', { nome: linha.name })}>↑</button>
                      <button type="button" className="eq-mini" disabled={ocupado} onClick={() => mover(i, 1)}
                        aria-label={t('teams.moveDown', 'Descer {{nome}}', { nome: linha.name })}>↓</button>
                    </span>
                  )}
                </td>
                <td>{linha.name}</td>
                <td><strong>{formatarPontos(linha.points)}</strong></td>
                <td>{formatarPontos(linha.captain_points)}</td>
                <td className="eq-membros">
                  {linha.members.map((m) => (
                    <span key={m.player_id}>
                      {m.name}{m.is_captain ? ` (${t('teams.captainShort', 'C')})` : ''}: {formatarPontos(m.points)}
                      {m.table_number != null ? ` · ${t('teams.tableShort', 'M{{n}}', { n: m.table_number })}` : ''}
                    </span>
                  ))}
                </td>
                <td>
                  <input
                    type="checkbox"
                    checked={!!linha.verified}
                    onChange={() => conferir(linha)}
                    disabled={ocupado}
                    aria-label={t('teams.verifiedBy', 'Capitão de {{nome}} conferiu', { nome: linha.name })}
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {posicoes && (
        <div className="eq-overlay" role="presentation">
          <div className="eq-modal" role="dialog" aria-modal="true" aria-label={t('teams.typePositions', 'Digitar posições')}>
            <div className="eq-modal-header">
              <h3>{t('teams.tableN', 'Mesa {{n}}', { n: posicoes.mesa.table_number })} — {t('teams.typePositions', 'Digitar posições')}</h3>
              <button type="button" className="eq-close" onClick={() => setPosicoes(null)} aria-label={t('common.close', 'Fechar')}>✕</button>
            </div>
            <p className="eq-hint">{t('teams.positionsHint', 'Posição na mesa (1 = vencedor). Posições iguais = empate: os pontos se dividem.')}</p>
            {posicoes.mesa.players.map((p) => (
              <div className="eq-field eq-field-linha" key={p.tp_id}>
                <label htmlFor={`pos-${p.tp_id}`}>{p.name}</label>
                <input
                  id={`pos-${p.tp_id}`}
                  type="number"
                  min="1"
                  max={posicoes.mesa.players.length}
                  value={posicoes.valores[p.tp_id]}
                  onChange={(e) => setPosicoes((atual) => ({ ...atual, valores: { ...atual.valores, [p.tp_id]: e.target.value } }))}
                />
              </div>
            ))}
            <div className="eq-modal-footer">
              <Button variant="secondary" onClick={() => setPosicoes(null)} disabled={ocupado}>{t('common.cancel', 'Cancelar')}</Button>
              <Button onClick={salvarPosicoes} disabled={ocupado}>{t('common.save', 'Salvar')}</Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default Fase1Tab;
