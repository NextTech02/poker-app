import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import api from '../../config/api';
import { useCurrency } from '../../contexts/CurrencyContext';
import { useToast } from '../../contexts/ToastContext';
import EliminadorModal from '../ko/EliminadorModal';
import { imprimirBilheteKo } from '../ko/bilheteKo';
import '../ko/Ko.css';

const VIVOS = new Set(['registered', 'active', 'winner']);
const num = (v) => Number(v || 0);

/**
 * Aba KO da Premiação: o caixa paga aqui o que ficou pendente, o floor corrige
 * quem eliminou, inicia a fase Mystery e encerra os bounties no fim.
 *
 * O dinheiro sai do CAIXA GERAL: sem saldo (sem sangria), o pagamento é
 * recusado com o motivo — por isso o saldo aparece ao lado do pendente.
 */
const KoTab = ({ tournamentId, torneio, inscritos = [], onMudou }) => {
  const { t, i18n } = useTranslation();
  const { formatCurrency = (v) => String(v) } = useCurrency() || {};
  const { toast, confirm } = useToast();
  const [resumo, setResumo] = useState(null);
  const [saldoGeral, setSaldoGeral] = useState(null);
  const [erro, setErro] = useState('');
  const [ocupado, setOcupado] = useState(false);
  const [envelopes, setEnvelopes] = useState([{ value: '', quantity: '' }]);
  const [campeao, setCampeao] = useState('');
  const [corrigindo, setCorrigindo] = useState(null);

  const carregar = useCallback(async () => {
    try {
      const [r, g] = await Promise.all([
        api.get(`/tournaments/${tournamentId}/knockouts/summary`),
        api.get('/cash/general', { _silentError: true }).catch(() => null),
      ]);
      setResumo(r.data);
      setSaldoGeral(g?.data ? num(g.data.current_balance) : null);
      setErro('');
    } catch (err) {
      setErro(err.userMessage || t('ko.loadError', 'Não foi possível carregar os KOs.'));
    }
  }, [tournamentId, t]);

  useEffect(() => { carregar(); }, [carregar]);

  const vivos = useMemo(() => inscritos.filter((i) => VIVOS.has(i.status || 'active')), [inscritos]);
  const nomePorInscrito = useMemo(() => new Map(inscritos.map((i) => [i.id, i.player_name])), [inscritos]);

  const executar = async (acao, sucesso) => {
    setOcupado(true);
    setErro('');
    try {
      await acao();
      if (sucesso) toast.success(sucesso);
      await carregar();
      if (onMudou) onMudou();
    } catch (err) {
      setErro(err.userMessage || t('ko.actionError', 'Não foi possível concluir.'));
    } finally {
      setOcupado(false);
    }
  };

  if (!resumo) {
    return erro ? <div className="ko-erro" role="alert">{erro}</div> : <div className="loading">{t('common.loading')}</div>;
  }

  const formato = resumo.ko_format;
  const encerrado = !!resumo.closed_at;
  const pendentes = resumo.knockouts
    .filter((k) => k.status === 'active')
    .flatMap((k) => k.payouts.filter((p) => !p.paid).map((p) => ({ ...p, knockout: k })));
  const totalPendente = num(resumo.pending);
  const semSaldo = saldoGeral != null && saldoGeral < totalPendente;

  const pagar = (ids) => executar(
    () => (ids.length === 1
      ? api.post(`/tournaments/${tournamentId}/knockouts/payouts/${ids[0]}/pay`, {})
      : api.post(`/tournaments/${tournamentId}/knockouts/payouts/pay-batch`, { payout_ids: ids })),
    t('ko.paidSuccess', { count: ids.length, defaultValue: 'Pagamento registrado.' }),
  );

  const imprimir = (p) => imprimirBilheteKo({
    jogador: p.eliminator_name,
    valor: num(p.cash_amount),
    vitima: p.knockout?.eliminated_name,
    formato: p.knockout?.format,
    torneio: torneio?.name,
    idioma: i18n?.language,
    formatarValor: formatCurrency,
  });

  // ── Mystery: editor de envelopes ───────────────────────────────────────
  const mystery = resumo.mystery;
  const linhasValidas = envelopes.filter((e) => num(e.value) > 0 && parseInt(e.quantity, 10) > 0);
  const qtdEnvelopes = linhasValidas.reduce((s, e) => s + parseInt(e.quantity, 10), 0);
  const somaEnvelopes = Math.round(linhasValidas.reduce((s, e) => s + num(e.value) * parseInt(e.quantity, 10), 0) * 100) / 100;
  const pozo = num(resumo.ko_pool);
  const fechaQtd = qtdEnvelopes === vivos.length;
  const fechaSoma = Math.abs(somaEnvelopes - pozo) < 0.005;

  const iniciarMystery = async () => {
    const ok = await confirm(t('ko.confirmStartMystery', {
      count: vivos.length, defaultValue: `Iniciar a fase Mystery com ${vivos.length} jogadores? As vendas deste torneio serão encerradas.`,
    }));
    if (!ok) return;
    executar(
      () => api.post(`/tournaments/${tournamentId}/mystery/start`, {
        envelopes: linhasValidas.map((e) => ({ value: num(e.value), quantity: parseInt(e.quantity, 10) })),
      }),
      t('ko.mysteryStarted', 'Fase Mystery iniciada.'),
    );
  };

  const encerrar = async () => {
    if (!campeao) return;
    const ok = await confirm(t('ko.confirmClose', {
      name: nomePorInscrito.get(campeao) || '', defaultValue: `Encerrar os bounties com ${nomePorInscrito.get(campeao) || ''} como campeão?`,
    }), { variant: 'danger' });
    if (!ok) return;
    executar(() => api.post(`/tournaments/${tournamentId}/knockouts/close`, { champion_tp_id: campeao }),
      t('ko.closedSuccess', 'Bounties encerrados.'));
  };

  const formatoLabel = {
    ko: t('ko.formatKo', 'KO fixo'), pko: t('ko.formatPko', 'PKO'), mystery: t('ko.formatMystery', 'Mystery Bounty'),
  }[formato] || formato;

  return (
    <div className="ko-tab">
      <div className="ko-cards">
        <div className="ko-card">
          <span className="ko-card-label">{t('ko.pool', 'Pool KO')} · {formatoLabel}</span>
          <span className="ko-card-valor">{formatCurrency(pozo)}</span>
        </div>
        <div className="ko-card">
          <span className="ko-card-label">{t('ko.paidTotal', 'Pago')}</span>
          <span className="ko-card-valor">{formatCurrency(num(resumo.paid))}</span>
        </div>
        <div className="ko-card">
          <span className="ko-card-label">{t('ko.pendingTotal', 'Pendente')}</span>
          <span className="ko-card-valor">{formatCurrency(totalPendente)}</span>
        </div>
        {num(resumo.unclaimed) > 0 && (
          <div className="ko-card">
            <span className="ko-card-label">{t('ko.unclaimed', 'Sem autor (vai ao campeão)')}</span>
            <span className="ko-card-valor">{formatCurrency(num(resumo.unclaimed))}</span>
          </div>
        )}
        {saldoGeral != null && (
          <div className={`ko-card ${semSaldo ? 'alerta' : ''}`}>
            <span className="ko-card-label">{t('ko.generalCash', 'Saldo do caixa geral')}</span>
            <span className="ko-card-valor">{formatCurrency(saldoGeral)}</span>
            {semSaldo && <span className="ko-hint">{t('ko.needSangria', 'Saldo menor que o pendente: faça uma sangria para pagar os KOs.')}</span>}
          </div>
        )}
      </div>

      {erro && <div className="ko-erro" role="alert">{erro}</div>}

      {formato === 'mystery' && (
        <section className="ko-secao" aria-labelledby="ko-mystery-titulo">
          <h4 id="ko-mystery-titulo">{t('ko.mysteryPhase', 'Fase Mystery')}</h4>
          {mystery?.started_at ? (
            <>
              <p className="ko-hint">
                {t('ko.mysteryRunning', {
                  remaining: mystery.envelopes_remaining, total: mystery.envelopes_total,
                  defaultValue: `Restam ${mystery.envelopes_remaining} de ${mystery.envelopes_total} envelopes.`,
                })}
              </p>
              <div className="ko-chips" aria-label={t('ko.remainingEnvelopes', 'Envelopes restantes')}>
                {(mystery.remaining || []).map((g) => (
                  <span key={g.value} className="ko-chip">{g.count} × {formatCurrency(num(g.value))}</span>
                ))}
              </div>
              {mystery.envelopes_remaining === mystery.envelopes_total && !encerrado && (
                <div className="ko-actions">
                  <button type="button" className="ko-btn-secondary" disabled={ocupado}
                    onClick={() => executar(() => api.delete(`/tournaments/${tournamentId}/mystery/start`),
                      t('ko.mysteryUndone', 'Início da fase desfeito.'))}>
                    {t('ko.undoMystery', 'Desfazer início da fase')}
                  </button>
                </div>
              )}
            </>
          ) : (
            <div className="ko-envelopes-editor">
              <p className="ko-hint">{t('ko.mysteryEditorHint', 'Cadastre os envelopes: um por jogador vivo, somando exatamente o pool KO. Ao iniciar, as vendas do torneio são encerradas.')}</p>
              {envelopes.map((linha, i) => (
                // eslint-disable-next-line react/no-array-index-key -- linhas sem id até serem gravadas
                <div key={i} className="ko-envelope-linha">
                  <input type="number" min="0" step="0.01" value={linha.value}
                    aria-label={t('ko.envelopeValueLabel', 'Valor do envelope')}
                    placeholder={t('ko.envelopeValueLabel', 'Valor do envelope')}
                    onChange={(e) => setEnvelopes((l) => l.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)))} />
                  <span>×</span>
                  <input type="number" min="1" step="1" value={linha.quantity}
                    aria-label={t('ko.envelopeQtyLabel', 'Quantidade')}
                    placeholder={t('ko.envelopeQtyLabel', 'Quantidade')}
                    onChange={(e) => setEnvelopes((l) => l.map((x, j) => (j === i ? { ...x, quantity: e.target.value } : x)))} />
                  {envelopes.length > 1 && (
                    <button type="button" className="ko-btn-secondary" aria-label={t('common.remove', 'Remover')}
                      onClick={() => setEnvelopes((l) => l.filter((_, j) => j !== i))}>✕</button>
                  )}
                </div>
              ))}
              <div>
                <button type="button" className="ko-btn-secondary"
                  onClick={() => setEnvelopes((l) => [...l, { value: '', quantity: '' }])}>
                  {t('ko.addEnvelope', '+ Valor de envelope')}
                </button>
              </div>
              <div className="ko-conferencia" data-testid="ko-conferencia">
                <div className={fechaQtd ? 'ok' : 'falta'}>
                  {t('ko.envelopeCount', { have: qtdEnvelopes, need: vivos.length, defaultValue: `Envelopes: ${qtdEnvelopes} de ${vivos.length} jogadores vivos` })}
                </div>
                <div className={fechaSoma ? 'ok' : 'falta'}>
                  {t('ko.envelopeSum', { have: formatCurrency(somaEnvelopes), need: formatCurrency(pozo), defaultValue: `Soma: ${formatCurrency(somaEnvelopes)} de ${formatCurrency(pozo)}` })}
                </div>
              </div>
              <div className="ko-actions">
                <button type="button" className="ko-btn-primary" disabled={ocupado || !fechaQtd || !fechaSoma || vivos.length === 0}
                  onClick={iniciarMystery}>
                  {t('ko.startMystery', 'Iniciar fase Mystery')}
                </button>
              </div>
            </div>
          )}
        </section>
      )}

      {resumo.bounties.length > 0 && (
        <section className="ko-secao" aria-labelledby="ko-bounties-titulo">
          <h4 id="ko-bounties-titulo">{t('ko.currentBounties', 'Bounties atuais')}</h4>
          <table className="ko-tabela">
            <thead><tr><th>{t('ko.player', 'Jogador')}</th><th className="num">{t('ko.bounty', 'Bounty')}</th></tr></thead>
            <tbody>
              {resumo.bounties.map((b) => (
                <tr key={b.tournament_player_id}><td>{b.player_name}</td><td className="num">{formatCurrency(num(b.bounty))}</td></tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      <section className="ko-secao" aria-labelledby="ko-pend-titulo">
        <h4 id="ko-pend-titulo">{t('ko.pendingPayments', 'Pagamentos pendentes')}</h4>
        {pendentes.length === 0 ? (
          <p className="ko-vazio">{t('ko.nothingPending', 'Nada pendente.')}</p>
        ) : (
          <>
            <table className="ko-tabela">
              <thead>
                <tr>
                  <th>{t('ko.winner', 'Recebe')}</th>
                  <th>{t('ko.victim', 'Eliminado')}</th>
                  <th className="num">{t('ko.value', 'Valor')}</th>
                  <th className="num">{t('ko.actions', 'Ações')}</th>
                </tr>
              </thead>
              <tbody>
                {pendentes.map((p) => (
                  <tr key={p.id}>
                    <td>{p.eliminator_name}</td>
                    <td>{p.knockout.kind === 'elimination' ? p.knockout.eliminated_name : t('ko.closingRow', 'Encerramento')}</td>
                    <td className="num">{formatCurrency(num(p.cash_amount))}</td>
                    <td>
                      <div className="ko-linha-acoes">
                        <button type="button" className="ko-btn-secondary" onClick={() => imprimir(p)}>{t('ko.printTicket', 'Imprimir bilhete')}</button>
                        {p.knockout.kind === 'elimination' && p.knockout.payouts.every((x) => !x.paid) && (
                          <button type="button" className="ko-btn-secondary" disabled={ocupado}
                            onClick={() => setCorrigindo(p.knockout)}>{t('ko.fixEliminator', 'Corrigir')}</button>
                        )}
                        <button type="button" className="ko-btn-primary" disabled={ocupado || num(p.cash_amount) <= 0}
                          onClick={() => pagar([p.id])}>{t('ko.pay', 'Pagar')}</button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {pendentes.length > 1 && (
              <div className="ko-actions">
                <button type="button" className="ko-btn-primary" disabled={ocupado}
                  onClick={() => pagar(pendentes.filter((p) => num(p.cash_amount) > 0).map((p) => p.id))}>
                  {t('ko.payAll', 'Pagar todos')}
                </button>
              </div>
            )}
          </>
        )}
      </section>

      <section className="ko-secao" aria-labelledby="ko-hist-titulo">
        <h4 id="ko-hist-titulo">{t('ko.history', 'Eliminações com KO')}</h4>
        {resumo.knockouts.length === 0 ? (
          <p className="ko-vazio">{t('ko.noKnockouts', 'Nenhum KO registrado ainda.')}</p>
        ) : (
          <table className="ko-tabela">
            <thead>
              <tr>
                <th>{t('ko.victim', 'Eliminado')}</th>
                <th>{t('ko.eliminators', 'Quem eliminou')}</th>
                <th className="num">{t('ko.value', 'Valor')}</th>
                <th>{t('ko.status', 'Situação')}</th>
              </tr>
            </thead>
            <tbody>
              {resumo.knockouts.map((k) => {
                const pagos = k.payouts.filter((p) => p.paid).length;
                let situacao = t('ko.statusPending', 'Pendente');
                if (k.status === 'undone') situacao = t('ko.statusUndone', 'Desfeito');
                else if (k.payouts.length === 0) situacao = t('ko.statusNoEliminator', 'Sem eliminador');
                else if (pagos === k.payouts.length) situacao = t('ko.paid', 'Pago');
                return (
                  <tr key={k.id} className={k.status === 'undone' ? 'desfeito' : ''}>
                    <td>{k.kind === 'elimination' ? k.eliminated_name : t('ko.closingRow', 'Encerramento')}</td>
                    <td>{k.payouts.map((p) => p.eliminator_name).join(', ') || '—'}</td>
                    <td className="num">{formatCurrency(num(k.bounty_value))}</td>
                    <td>{situacao}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </section>

      <section className="ko-secao" aria-labelledby="ko-fim-titulo">
        <h4 id="ko-fim-titulo">{t('ko.closeTitle', 'Encerrar bounties')}</h4>
        {encerrado ? (
          <div className="ko-encerrar">
            <span className="ko-pago">{t('ko.closedAlready', 'Bounties encerrados.')}</span>
            <button type="button" className="ko-btn-secondary" disabled={ocupado}
              onClick={() => executar(() => api.delete(`/tournaments/${tournamentId}/knockouts/close`),
                t('ko.closeUndone', 'Encerramento desfeito.'))}>
              {t('ko.undoClose', 'Desfazer encerramento')}
            </button>
          </div>
        ) : (
          <>
            <p className="ko-hint">{t('ko.closeHint', 'No fim do torneio: cada jogador vivo recebe o próprio bounty, e o que ficou sem dono vai para o campeão.')}</p>
            <div className="ko-encerrar">
              <select value={campeao} onChange={(e) => setCampeao(e.target.value)} aria-label={t('ko.champion', 'Campeão')}>
                <option value="">{t('ko.chooseChampion', 'Escolha o campeão')}</option>
                {vivos.map((v) => <option key={v.id} value={v.id}>{v.player_name}</option>)}
              </select>
              <button type="button" className="ko-btn-danger" disabled={!campeao || ocupado} onClick={encerrar}>
                {t('ko.closeButton', 'Encerrar bounties')}
              </button>
            </div>
          </>
        )}
      </section>

      {corrigindo && (
        <EliminadorModal
          vitima={corrigindo.eliminated_name}
          formato={formato}
          titulo={t('ko.fixTitle', { name: corrigindo.eliminated_name, defaultValue: `Quem eliminou ${corrigindo.eliminated_name}?` })}
          textoConfirmar={t('ko.saveFix', 'Salvar correção')}
          inicial={corrigindo.payouts.map((p) => p.eliminator_tp_id)}
          candidatos={inscritos
            .filter((i) => i.id !== corrigindo.eliminated_tp_id)
            .map((i) => ({ id: i.id, nome: i.player_name, mesa: null }))
            .sort((a, b) => String(a.nome).localeCompare(String(b.nome)))}
          enviando={ocupado}
          onFechar={() => setCorrigindo(null)}
          onConfirmar={(corpo) => executar(async () => {
            await api.patch(`/tournaments/${tournamentId}/knockouts/${corrigindo.id}/eliminators`, corpo);
            setCorrigindo(null);
          }, t('ko.fixSaved', 'Correção salva.'))}
        />
      )}
    </div>
  );
};

export default KoTab;
