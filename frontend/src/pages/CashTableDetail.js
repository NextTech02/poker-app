import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import api from '../config/api';
import Sidebar from '../components/Sidebar';
import Breadcrumb from '../components/Breadcrumb';
import CashboxBanner from '../components/CashboxBanner';
import PlayerSelect from '../components/PlayerSelect';
import { SkeletonBlock } from '../components/SkeletonLoader';
import { useToast } from '../contexts/ToastContext';
import { useCurrency } from '../contexts/CurrencyContext';
import { usePaymentMethods } from '../contexts/PaymentMethodsContext';
import { useCashDay } from '../contexts/CashDayContext';
import useRealtimeRefresh from '../hooks/useRealtimeRefresh';
import { useEscapeKey } from '../hooks/useEscapeKey';
import { methodLabel } from '../utils/paymentMethodLabels';
import { avisarQueOCaixaMudou } from '../utils/eventosDoCaixa';
import { useHistoricoDoJogador } from '../hooks/useHistoricoDoJogador';
import { usePermissions } from '../contexts/PermissionContext';
import ReceberFiadoModal from '../components/fiado/ReceberFiadoModal';
import {
  FIADO, buscarContaFiado, detalheDoErro, imprimirCupomDeFiado, novoIdDeOperacao,
} from '../utils/fiado';
import './CashFloor.css';
import './CashTableDetail.css';

/**
 * A MESA: onde o dinheiro entra e sai.
 *
 * O mapa de assentos é a tela inteira porque é assim que o operador pensa —
 * ele não procura "a sessão do jogador X", procura "a cadeira 5". Cada cadeira
 * carrega o que ele precisa decidir sem abrir nada: quem está lá e quanto já
 * comprou.
 *
 * SENTAR E PAGAR SÃO UM PASSO SÓ. Cadeira ocupada por alguém que ainda não
 * pagou é um estado que não existe na mesa real, e criá-lo aqui produziria
 * jogador sentado sem fichas na tela e fichas sem dono no caixa.
 */
const CashTableDetail = () => {
  const { tableId } = useParams();
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { toast } = useToast();
  const { formatCurrency } = useCurrency();
  const { activeMethods } = usePaymentMethods();
  const { cashDayId } = useCashDay();
  const { staffName, organizationName } = usePermissions();
  // O nome na cadeira abre o histórico do jogador.
  const { podeVerHistorico, propsDoHistorico } = useHistoricoDoJogador();

  const [table, setTable] = useState(null);
  const [seats, setSeats] = useState([]);
  const [rakeEntries, setRakeEntries] = useState([]);
  const [outrasMesas, setOutrasMesas] = useState([]);
  const [loading, setLoading] = useState(true);
  const [myCashbox, setMyCashbox] = useState(undefined);
  const [modal, setModal] = useState(null); // {kind, seat?, session?}
  const [submitting, setSubmitting] = useState(false);
  const [form, setForm] = useState({});
  // FIADO: a conta do jogador do modal aberto, as dívidas de quem está sentado
  // (selo na cadeira), o vale a imprimir depois de uma venda fiada e o
  // recebimento em andamento.
  const [fiado, setFiado] = useState(null);
  const [dividas, setDividas] = useState({});
  const [vale, setVale] = useState(null);
  const [recebendo, setRecebendo] = useState(null);

  const bloqueado = myCashbox !== undefined && myCashbox !== null && myCashbox.status !== 'open';
  const fechada = table?.status === 'closed';
  // O cash-out sai da gaveta em dinheiro vivo: não pode passar do que ela tem.
  // O backend recusa do mesmo jeito; aqui o operador vê antes de tentar.
  // Super-admin não tem gaveta (null) — sem limite na tela.
  const saldoDaGaveta = myCashbox && myCashbox.status === 'open'
    ? Number(myCashbox.current_balance ?? 0)
    : null;

  // Cash-out de quem deve: a dívida é abatida das fichas PRIMEIRO e a gaveta
  // paga só o líquido. O padrão é abater tudo o que der; abater menos é
  // decisão do operador, com motivo.
  const fichas = parseFloat(form.cash_out_amount || 0) || 0;
  const divida = modal?.kind === 'stand' ? Number(fiado?.balance || 0) : 0;
  const proposto = Math.min(divida, fichas);
  const abatido = divida > 0
    ? (form.offsetEdited ? (parseFloat(form.debt_offset_amount || 0) || 0) : proposto)
    : 0;
  const liquido = Math.max(fichas - abatido, 0);
  const abatimentoInvalido = abatido > proposto + 0.004;
  const faltaMotivo = divida > 0 && abatido + 0.004 < proposto && !(form.debt_offset_reason || '').trim();
  const cashOutAcimaDoSaldo = modal?.kind === 'stand' && saldoDaGaveta !== null
    && liquido > saldoDaGaveta;

  useEscapeKey(!!modal, () => { if (!submitting) setModal(null); });

  const load = useCallback(async () => {
    const [mesa, cadeiras, apuracoes] = await Promise.all([
      api.get(`/cash-game/tables/${tableId}`, { _silentError: true }).catch(() => null),
      api.get(`/cash-game/tables/${tableId}/seats`, { _silentError: true }).catch(() => ({ data: [] })),
      api.get(`/cash-game/tables/${tableId}/rake-entries`, { _silentError: true }).catch(() => ({ data: [] })),
    ]);
    if (mesa) setTable(mesa.data);
    setSeats(cadeiras.data || []);
    setRakeEntries(apuracoes.data || []);
    setLoading(false);

    // Quem está sentado e deve fiado: uma consulta para a mesa inteira.
    const sentados = (cadeiras.data || []).map((s) => s.player_id).filter(Boolean);
    if (sentados.length) {
      api.get('/house-credit/balances', { params: { player_ids: sentados.join(',') }, _silentError: true })
        .then(({ data }) => setDividas(Object.fromEntries((data || []).map((b) => [b.player_id, b]))))
        .catch(() => setDividas({}));
    } else {
      setDividas({});
    }

    // As outras mesas abertas do dia: é para onde o jogador pode ir.
    const dia = mesa?.data?.cash_day_id;
    if (dia) {
      const todas = await api
        .get('/cash-game/tables', { params: { cash_day_id: dia, status: 'open' }, _silentError: true })
        .catch(() => ({ data: [] }));
      setOutrasMesas((todas.data || []).filter((m) => m.id !== tableId));
    }
  }, [tableId]);

  useEffect(() => { setLoading(true); load(); }, [load]);
  // A mesa é estado compartilhado: outro caixa senta ou levanta alguém aqui.
  // Tudo aqui é da MESA: assento, sessão do jogador, compra de fichas e
  // contagem de rake. O filtro corta os eventos das outras mesas do salão
  // antes de chegarem ao navegador.
  useRealtimeRefresh({
    canal: `cash-mesa-${tableId}`,
    tabelas: [
      { table: 'cash_seats', filter: `table_id=eq.${tableId}` },
      { table: 'cash_player_sessions', filter: `table_id=eq.${tableId}` },
      { table: 'cash_transactions', filter: `table_id=eq.${tableId}` },
      { table: 'cash_rake_entries', filter: `table_id=eq.${tableId}` },
    ],
    aoMudar: () => load(),
    ativo: !!tableId,
  });

  const abrir = (kind, seat) => {
    const padrao = activeMethods[0]?.code || 'cash';
    setForm({
      player_id: '',
      amount: kind === 'sit' ? String(table?.min_buy_in ?? '') : '',
      cash_out_amount: '',
      payment_method: padrao,
      rake_amount: '',
      jackpot_amount: '',
      reason: '',
      notes: '',
      to_table_id: outrasMesas[0]?.id || '',
      to_seat: '',
      debt_offset_amount: '',
      debt_offset_reason: '',
      offsetEdited: false,
      // Um id por ABERTURA do modal (não por clique): o retry depois de uma
      // resposta perdida devolve a mesma operação em vez de repeti-la.
      cmid: novoIdDeOperacao(),
    });
    setFiado(null);
    setModal({ kind, seat });
    if (seat?.player_id && (kind === 'rebuy' || kind === 'stand')) {
      buscarContaFiado(seat.player_id).then(setFiado);
    }
  };

  const escolherJogador = (playerId) => {
    setForm((f) => ({
      ...f,
      player_id: playerId,
      // Trocar de jogador não pode carregar o "fiado" do anterior.
      payment_method: f.payment_method === FIADO ? (activeMethods[0]?.code || 'cash') : f.payment_method,
    }));
    setFiado(null);
    buscarContaFiado(playerId).then(setFiado);
  };

  // Venda: fiado não é meio de pagamento — vai como ORIGEM, sem meio e sem
  // gaveta (o servidor e o banco garantem as duas coisas).
  const pagamento = () => (form.payment_method === FIADO
    ? { payment_source: FIADO, payment_method: null }
    : { payment_method: form.payment_method });

  const aposVenda = async (mensagem, jogador, valor) => {
    const foiFiado = form.payment_method === FIADO;
    await depois(mensagem);
    if (foiFiado) {
      const conta = await buscarContaFiado(jogador.id);
      setVale({ jogador, valor, saldo: conta?.balance ?? null });
    }
  };

  const imprimirVale = () => {
    if (!vale) return;
    imprimirCupomDeFiado({
      titulo: t('fiado.voucherTitle', 'VALE — FICHAS NO FIADO'),
      clube: organizationName,
      jogador: vale.jogador.name,
      valor: formatCurrency(vale.valor),
      linhas: [
        { rotulo: t('cash.tableN', 'Mesa {{n}}', { n: table?.table_number }), valor: table?.game_type_name || '' },
        { rotulo: t('fiado.balanceAfter', 'Saldo devedor após'), valor: vale.saldo !== null ? formatCurrency(vale.saldo) : '' },
      ],
      assinatura: t('fiado.voucherSignature', 'Assinatura do jogador — reconheço o valor acima'),
      atendente: staffName ? { rotulo: t('fiado.attendant', 'Atendente'), valor: staffName } : null,
      quando: { rotulo: t('fiado.when', 'Data'), valor: new Date().toLocaleString() },
    });
  };

  const depois = async (mensagem) => {
    toast.success(mensagem);
    setModal(null);
    await load();
    // O saldo do banner do caixa muda com a venda; sem o aviso ele mostraria o
    // valor da abertura a noite inteira.
    avisarQueOCaixaMudou();
  };

  const erro = (err, padrao) => toast.error(err.userMessage || padrao);

  const sentar = async (e) => {
    e.preventDefault();
    if (!form.player_id) {
      toast.warning(t('cash.pickPlayer', 'Escolha o jogador'));
      return;
    }
    setSubmitting(true);
    try {
      const valor = parseFloat(form.amount);
      const { data } = await api.post(`/cash-game/tables/${tableId}/seats/${modal.seat.seat_number}/sit`, {
        player_id: form.player_id,
        buy_in_amount: valor,
        ...pagamento(),
        client_mutation_id: form.cmid,
      });
      await aposVenda(
        t('cash.playerSeated', 'Jogador sentado'),
        { id: form.player_id, name: data?.player_session?.player_name || fiado?.player_name || '' },
        valor,
      );
    } catch (err) {
      erro(err, t('cash.sitError', 'Não foi possível sentar o jogador'));
    } finally {
      setSubmitting(false);
    }
  };

  const recomprar = async (e) => {
    e.preventDefault();
    setSubmitting(true);
    try {
      const valor = parseFloat(form.amount);
      await api.post(`/cash-game/player-sessions/${modal.seat.player_session_id}/rebuy`, {
        amount: valor,
        ...pagamento(),
        client_mutation_id: form.cmid,
      });
      await aposVenda(
        t('cash.rebuyDone', 'Recompra registrada'),
        { id: modal.seat.player_id, name: modal.seat.player_name },
        valor,
      );
    } catch (err) {
      erro(err, t('cash.rebuyError', 'Não foi possível registrar a recompra'));
    } finally {
      setSubmitting(false);
    }
  };

  const levantar = async (e) => {
    e.preventDefault();
    setSubmitting(true);
    try {
      await api.post(`/cash-game/player-sessions/${modal.seat.player_session_id}/stand`, {
        // Zero é válido: quem perdeu tudo levanta do mesmo jeito.
        cash_out_amount: fichas,
        payment_method: form.payment_method,
        client_mutation_id: form.cmid,
        // Quem deve: o abatimento vai SEMPRE explícito (inclusive 0) — o
        // servidor recusa o cash-out de devedor sem ele.
        ...(divida > 0 ? {
          debt_offset_amount: Math.round(abatido * 100) / 100,
          debt_offset_reason: (form.debt_offset_reason || '').trim() || null,
        } : {}),
      });
      await depois(t('cash.playerStood', 'Jogador levantou'));
    } catch (err) {
      const d = detalheDoErro(err);
      if (d.code === 'jogador_com_fiado') {
        // A tela não sabia da dívida (conta não carregou, ou surgiu agora):
        // mostra o quadro do abatimento para o operador confirmar.
        setFiado((f) => ({ ...(f || {}), balance: d.divida }));
        toast.warning(err.userMessage);
      } else {
        erro(err, t('cash.standError', 'Não foi possível levantar o jogador'));
      }
    } finally {
      setSubmitting(false);
    }
  };

  const mover = async (e) => {
    e.preventDefault();
    setSubmitting(true);
    try {
      await api.post(`/cash-game/player-sessions/${modal.seat.player_session_id}/move`, {
        to_table_id: form.to_table_id,
        to_seat: parseInt(form.to_seat, 10),
      });
      // Sem `avisarQueOCaixaMudou`: a troca NÃO move dinheiro — o jogador
      // levou as fichas com ele, e nada entrou nem saiu da gaveta.
      toast.success(t('cash.playerMoved', 'Jogador movido'));
      setModal(null);
      await load();
    } catch (err) {
      erro(err, t('cash.moveError', 'Não foi possível mover o jogador'));
    } finally {
      setSubmitting(false);
    }
  };

  const apurar = async (e) => {
    e.preventDefault();
    setSubmitting(true);
    try {
      await api.post(`/cash-game/tables/${tableId}/rake-entries`, {
        rake_amount: parseFloat(form.rake_amount || 0),
        jackpot_amount: parseFloat(form.jackpot_amount || 0),
        notes: form.notes || null,
      });
      await depois(t('cash.rakeCounted', 'Apuração registrada'));
    } catch (err) {
      erro(err, t('cash.rakeError', 'Não foi possível registrar a apuração'));
    } finally {
      setSubmitting(false);
    }
  };

  const fecharMesa = async (e) => {
    e.preventDefault();
    setSubmitting(true);
    try {
      await api.post(`/cash-game/tables/${tableId}/close`, {
        rake_amount: parseFloat(form.rake_amount || 0),
        jackpot_amount: parseFloat(form.jackpot_amount || 0),
        notes: form.notes || null,
      });
      toast.success(t('cash.tableClosed', 'Mesa fechada'));
      navigate('/cash');
    } catch (err) {
      erro(err, t('cash.tableCloseError', 'Não foi possível fechar a mesa'));
    } finally {
      setSubmitting(false);
    }
  };

  const ocupados = useMemo(() => seats.filter((s) => s.status === 'occupied'), [seats]);

  if (loading) {
    return (
      <div className="app-container">
        <Sidebar />
        <main className="main-content"><SkeletonBlock height="10rem" /></main>
      </div>
    );
  }

  return (
    <div className="app-container">
      <Sidebar />
      <main className="main-content">
        <Breadcrumb items={[
          { label: t('cash.floor', 'Salão'), to: '/cash' },
          { label: t('cash.tableN', 'Mesa {{n}}', { n: table?.table_number }) },
        ]} />

        <div className="page-header">
          <div>
            <h1>{t('cash.tableN', 'Mesa {{n}}', { n: table?.table_number })}</h1>
            <p className="subtitle">
              {table?.game_type_name} · {formatCurrency(table?.small_blind)}/{formatCurrency(table?.big_blind)} ·{' '}
              {t('cash.minMax', 'buy-in {{min}}–{{max}}', {
                min: formatCurrency(table?.min_buy_in),
                max: table?.max_buy_in ? formatCurrency(table.max_buy_in) : '∞',
              })}
            </p>
          </div>
          {!fechada && (
            <button
              type="button"
              className="btn btn-danger"
              onClick={() => abrir('close')}
              disabled={ocupados.length > 0}
              title={ocupados.length > 0
                ? t('cash.closeBlockedHint', 'Levante todos os jogadores antes de fechar')
                : undefined}
            >
              {t('cash.closeTable', 'Fechar mesa')}
            </button>
          )}
        </div>

        {cashDayId && <CashboxBanner cashDayId={cashDayId} onStateChange={setMyCashbox} />}

        {fechada && (
          <div className="cf-warning" role="status">
            {t('cash.tableClosedInfo', 'Mesa fechada. Rake apurado: {{rake}} · Jackpot: {{jackpot}}', {
              rake: formatCurrency(table?.rake_counted || 0),
              jackpot: formatCurrency(table?.jackpot_counted || 0),
            })}
          </div>
        )}

        <div className="ctd-grid">
          <section className="ctd-seats" aria-label={t('cash.seats', 'Lugares')}>
            {seats.map((s) => {
              const livre = s.status === 'free';
              return (
                <div key={s.id} className={`ctd-seat ${s.status}`}>
                  <span className="ctd-seat-number">{s.seat_number}</span>
                  {livre ? (
                    <>
                      <span className="ctd-seat-empty">{t('cash.seatFree', 'Livre')}</span>
                      <button
                        type="button"
                        className="btn btn-primary btn-sm"
                        onClick={() => abrir('sit', s)}
                        disabled={bloqueado || fechada}
                      >
                        {t('cash.sit', 'Sentar')}
                      </button>
                    </>
                  ) : (
                    <>
                      <span
                        className={`ctd-seat-player${podeVerHistorico && s.player_id ? ' ctd-seat-player--link' : ''}`}
                        {...propsDoHistorico(s.player_id)}
                      >
                        {s.player_name || '—'}
                      </span>
                      <span className="ctd-seat-amount">
                        {t('cash.boughtIn', 'Comprou {{value}}', {
                          value: formatCurrency(s.total_buy_in || 0),
                        })}
                      </span>
                      {Number(dividas[s.player_id]?.balance || 0) > 0 && (
                        <button
                          type="button"
                          className={`ctd-seat-debt${dividas[s.player_id].overdue ? ' overdue' : ''}`}
                          onClick={() => setRecebendo(s)}
                          disabled={bloqueado || !cashDayId}
                          title={t('fiado.receive', 'Receber')}
                        >
                          {t('fiado.owesShort', 'Deve {{value}}', {
                            value: formatCurrency(dividas[s.player_id].balance),
                          })}
                        </button>
                      )}
                      <div className="ctd-seat-actions">
                        <button
                          type="button"
                          className="btn btn-secondary btn-sm"
                          onClick={() => abrir('rebuy', s)}
                          disabled={bloqueado || fechada}
                        >
                          {t('cash.rebuy', 'Recompra')}
                        </button>
                        <button
                          type="button"
                          className="btn btn-primary btn-sm"
                          onClick={() => abrir('stand', s)}
                          disabled={bloqueado || fechada}
                        >
                          {t('cash.stand', 'Levantar')}
                        </button>
                      </div>
                      {outrasMesas.length > 0 && !fechada && (
                        <button
                          type="button"
                          className="btn btn-secondary btn-sm ctd-move"
                          onClick={() => abrir('move', s)}
                          disabled={bloqueado}
                        >
                          {t('cash.move', 'Mover de mesa')}
                        </button>
                      )}
                    </>
                  )}
                </div>
              );
            })}
          </section>

          <aside className="ctd-rake" aria-label={t('cash.rake', 'Rake')}>
            <div className="ctd-rake-head">
              <h2>{t('cash.rake', 'Rake')}</h2>
              {!fechada && (
                <button type="button" className="btn btn-secondary btn-sm" onClick={() => abrir('rake')}>
                  {t('cash.countRake', 'Apurar')}
                </button>
              )}
            </div>
            {/* A explicação evita o erro de leitura mais provável desta tela:
                achar que o rake apurado precisa "sair" de algum lugar. */}
            <p className="ctd-rake-hint">
              {t('cash.rakeHint', 'O rake é CONTADO na caixa da mesa, não calculado. Ele já está no caixa como a diferença entre o que entrou e o que saiu — por isso lançar a apuração não move o saldo.')}
            </p>
            {rakeEntries.length === 0 ? (
              <p className="ctd-empty">{t('cash.noRakeYet', 'Nenhuma apuração ainda')}</p>
            ) : (
              <ul className="ctd-rake-list">
                {rakeEntries.map((r) => (
                  <li key={r.id}>
                    <span className={`ctd-kind ${r.kind}`}>
                      {r.kind === 'closing'
                        ? t('cash.rakeClosing', 'Fechamento')
                        : t('cash.rakePartial', 'Parcial')}
                    </span>
                    <span>{formatCurrency(r.rake_amount)}</span>
                    {r.jackpot_amount > 0 && (
                      <span className="ctd-jackpot">
                        + {formatCurrency(r.jackpot_amount)} {t('cash.jackpot', 'Jackpot')}
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            )}
            <div className="ctd-rake-total">
              <span>{t('cash.rakeTotal', 'Total apurado')}</span>
              <strong>{formatCurrency(table?.rake_partial || 0)}</strong>
            </div>
          </aside>
        </div>

        {modal && (
          <div
            className="modal-overlay"
            onClick={(e) => { if (e.target === e.currentTarget && !submitting) setModal(null); }}
          >
            <div className="modal" role="dialog" aria-modal="true">
              {modal.kind === 'sit' && (
                <>
                  <h2>{t('cash.sitAtSeat', 'Sentar no lugar {{n}}', { n: modal.seat.seat_number })}</h2>
                  <form onSubmit={sentar}>
                    <div className="form-group">
                      <label htmlFor="ctd-player">{t('cash.player', 'Jogador')}</label>
                      <PlayerSelect
                        value={form.player_id}
                        onChange={(e) => escolherJogador(e.target.value)}
                        required
                      />
                      {SituacaoDoFiado({ t, fiado, formatCurrency })}
                    </div>
                    <div className="form-group">
                      <label htmlFor="ctd-amount">{t('cash.buyIn', 'Buy-in')}</label>
                      <input
                        id="ctd-amount" type="number" step="0.01"
                        min={table?.min_buy_in} max={table?.max_buy_in || undefined}
                        value={form.amount}
                        onChange={(e) => setForm({ ...form, amount: e.target.value })}
                        required
                      />
                      <small className="form-hint">
                        {t('cash.minMax', 'buy-in {{min}}–{{max}}', {
                          min: formatCurrency(table?.min_buy_in),
                          max: table?.max_buy_in ? formatCurrency(table.max_buy_in) : '∞',
                        })}
                      </small>
                    </div>
                    {MetodoDePagamento({ t, form, setForm, activeMethods, fiado, formatCurrency })}
                    {Acoes({
                      t, submitting, setModal, rotulo: t('cash.sit', 'Sentar'),
                      bloqueado: FiadoAcimaDoDisponivel(form, fiado),
                    })}
                  </form>
                </>
              )}

              {modal.kind === 'rebuy' && (
                <>
                  <h2>{t('cash.rebuyFor', 'Recompra — {{name}}', { name: modal.seat.player_name })}</h2>
                  <form onSubmit={recomprar}>
                    <div className="form-group">
                      <label htmlFor="ctd-rebuy">{t('cash.amount', 'Valor')}</label>
                      <input
                        id="ctd-rebuy" type="number" step="0.01" min="0.01"
                        value={form.amount}
                        onChange={(e) => setForm({ ...form, amount: e.target.value })}
                        required autoFocus
                      />
                      {/* O teto da mesa vale para SENTAR; a recompra repõe
                          fichas perdidas e não é limitada por ele. */}
                      <small className="form-hint">
                        {t('cash.rebuyHint', 'A recompra repõe fichas perdidas e não é limitada pelo teto da mesa.')}
                      </small>
                      {SituacaoDoFiado({ t, fiado, formatCurrency })}
                    </div>
                    {MetodoDePagamento({ t, form, setForm, activeMethods, fiado, formatCurrency })}
                    {Acoes({
                      t, submitting, setModal, rotulo: t('cash.rebuy', 'Recompra'),
                      bloqueado: FiadoAcimaDoDisponivel(form, fiado),
                    })}
                  </form>
                </>
              )}

              {modal.kind === 'stand' && (
                <>
                  <h2>{t('cash.standFor', 'Levantar — {{name}}', { name: modal.seat.player_name })}</h2>
                  <form onSubmit={levantar}>
                    <div className="form-group">
                      <label htmlFor="ctd-out">{t('cash.cashOut', 'Cash-out')}</label>
                      <input
                        id="ctd-out" type="number" step="0.01" min="0"
                        value={form.cash_out_amount}
                        onChange={(e) => setForm({ ...form, cash_out_amount: e.target.value })}
                        required autoFocus
                      />
                      <small className="form-hint">
                        {t('cash.cashOutHint', 'Comprou {{value}}. Zero é válido — quem perdeu tudo levanta do mesmo jeito.', {
                          value: formatCurrency(modal.seat.total_buy_in || 0),
                        })}
                      </small>
                      {saldoDaGaveta !== null && (
                        <small className="form-hint">
                          {t('cash.cashOutDrawerBalance', 'Saldo do seu caixa: {{value}}', {
                            value: formatCurrency(saldoDaGaveta),
                          })}
                        </small>
                      )}
                      {cashOutAcimaDoSaldo && (
                        <small className="form-hint form-hint--danger" role="alert">
                          {t('cash.cashOutOverBalance', 'O cash-out passa do saldo do seu caixa. Faça um reforço antes de pagar.')}
                        </small>
                      )}
                    </div>
                    {divida > 0 && (
                      <div className="ctd-fiado-box" role="group" aria-label={t('fiado.title', 'Fiado')}>
                        <div className="ctd-fiado-line">
                          <span>{t('fiado.chips', 'Fichas')}</span>
                          <strong>{formatCurrency(fichas)}</strong>
                        </div>
                        <div className="ctd-fiado-line">
                          <span>{t('fiado.openDebt', 'Fiado em aberto')}</span>
                          <strong>{formatCurrency(divida)}</strong>
                        </div>
                        <div className="form-group">
                          <label htmlFor="ctd-offset">{t('fiado.offset', 'Abater do cash-out')}</label>
                          <input
                            id="ctd-offset" type="number" step="0.01" min="0" max={proposto}
                            value={form.offsetEdited ? form.debt_offset_amount : String(proposto)}
                            onChange={(e) => setForm({ ...form, debt_offset_amount: e.target.value, offsetEdited: true })}
                          />
                          {abatimentoInvalido && (
                            <small className="form-hint form-hint--danger" role="alert">
                              {t('fiado.offsetTooHigh', 'O abatimento passa da dívida ou das fichas.')}
                            </small>
                          )}
                        </div>
                        {abatido + 0.004 < proposto && (
                          <div className="form-group">
                            <label htmlFor="ctd-offset-reason">{t('fiado.offsetReason', 'Motivo para abater menos')}</label>
                            <input
                              id="ctd-offset-reason" type="text" required
                              value={form.debt_offset_reason}
                              onChange={(e) => setForm({ ...form, debt_offset_reason: e.target.value })}
                            />
                          </div>
                        )}
                        <div className="ctd-fiado-line ctd-fiado-total">
                          <span>{t('fiado.payPlayer', 'Pagar ao jogador')}</span>
                          <strong>{formatCurrency(liquido)}</strong>
                        </div>
                      </div>
                    )}
                    {MetodoDePagamento({ t, form, setForm, activeMethods })}
                    {Acoes({
                      t, submitting, setModal, rotulo: t('cash.stand', 'Levantar'),
                      bloqueado: cashOutAcimaDoSaldo || abatimentoInvalido || faltaMotivo,
                    })}
                  </form>
                </>
              )}

              {modal.kind === 'move' && (
                <>
                  <h2>{t('cash.moveFor', 'Mover de mesa — {{name}}', { name: modal.seat.player_name })}</h2>
                  <form onSubmit={mover}>
                    {/* A frase existe para o operador NÃO fazer cash-out +
                        buy-in: isso inflaria o giro do dia com dinheiro que
                        nunca passou pela gaveta. */}
                    <p className="ctd-close-hint">
                      {t('cash.moveHint', 'O jogador leva as fichas com ele. Nada entra nem sai do caixa, e o resultado da noite dele continua o mesmo.')}
                    </p>
                    <div className="form-group">
                      <label htmlFor="ctd-to-table">{t('cash.toTable', 'Mesa de destino')}</label>
                      <select
                        id="ctd-to-table" required
                        value={form.to_table_id || ''}
                        onChange={(ev) => setForm({ ...form, to_table_id: ev.target.value, to_seat: '' })}
                      >
                        {outrasMesas.map((m) => (
                          <option key={m.id} value={m.id}>
                            {t('cash.tableN', 'Mesa {{n}}', { n: m.table_number })} — {m.game_type_name}
                            {' · '}
                            {t('cash.seatsFree', '{{free}} de {{total}} livres', {
                              free: m.free_seats, total: m.seats,
                            })}
                          </option>
                        ))}
                      </select>
                    </div>
                    <div className="form-group">
                      <label htmlFor="ctd-to-seat">{t('cash.toSeat', 'Lugar')}</label>
                      <select
                        id="ctd-to-seat" required
                        value={form.to_seat || ''}
                        onChange={(ev) => setForm({ ...form, to_seat: ev.target.value })}
                      >
                        <option value="">{t('cashWaitlist.pickSeat', 'Escolha o lugar')}</option>
                        {Array.from(
                          { length: outrasMesas.find((m) => m.id === form.to_table_id)?.seats || 0 },
                          (_, i) => i + 1,
                        ).map((n) => (
                          <option key={n} value={n}>{n}</option>
                        ))}
                      </select>
                    </div>
                    {Acoes({ t, submitting, setModal, rotulo: t('cash.move', 'Mover de mesa') })}
                  </form>
                </>
              )}

              {modal.kind === 'rake' && (
                <>
                  <h2>{t('cash.countRakeTitle', 'Apurar a caixa da mesa')}</h2>
                  <form onSubmit={apurar}>
                    {ApuracaoCampos({ t, form, setForm, table })}
                    {Acoes({ t, submitting, setModal, rotulo: t('cash.countRake', 'Apurar') })}
                  </form>
                </>
              )}

              {modal.kind === 'close' && (
                <>
                  <h2>{t('cash.closeTable', 'Fechar mesa')}</h2>
                  <form onSubmit={fecharMesa}>
                    <p className="ctd-close-hint">
                      {t('cash.closeHint', 'A contagem final encerra a apuração desta mesa. O total da noite soma as parciais já lançadas ({{parcial}}).', {
                        parcial: formatCurrency(table?.rake_partial || 0),
                      })}
                    </p>
                    {ApuracaoCampos({ t, form, setForm, table })}
                    {Acoes({ t, submitting, setModal, rotulo: t('cash.closeTable', 'Fechar mesa') })}
                  </form>
                </>
              )}
            </div>
          </div>
        )}

        {vale && (
          <div className="modal-overlay" onClick={(e) => { if (e.target === e.currentTarget) setVale(null); }}>
            <div className="modal" role="dialog" aria-modal="true" aria-labelledby="ctd-vale-titulo">
              <h2 id="ctd-vale-titulo">{t('fiado.voucherReady', 'Venda no fiado registrada')}</h2>
              <p>
                {t('fiado.voucherSummary', '{{name}} levou {{value}} em fichas no fiado. Deve agora {{balance}}.', {
                  name: vale.jogador.name,
                  value: formatCurrency(vale.valor),
                  balance: vale.saldo !== null ? formatCurrency(vale.saldo) : '—',
                })}
              </p>
              <p className="form-hint">
                {t('fiado.voucherHint', 'Imprima o vale e peça a assinatura do jogador.')}
              </p>
              <div className="modal-actions">
                <button type="button" className="btn btn-secondary" onClick={imprimirVale}>
                  {t('fiado.printVoucher', 'Imprimir vale')}
                </button>
                <button type="button" className="btn btn-primary" onClick={() => setVale(null)}>
                  {t('common.close', 'Fechar')}
                </button>
              </div>
            </div>
          </div>
        )}

        {recebendo && (
          <ReceberFiadoModal
            player={{ id: recebendo.player_id, name: recebendo.player_name }}
            conta={dividas[recebendo.player_id]}
            ancora={cashDayId ? { cash_day_id: cashDayId } : null}
            onClose={() => setRecebendo(null)}
            onDone={() => load()}
          />
        )}
      </main>
    </div>
  );
};

/* Fiado escolhido acima do que o jogador ainda pode levar: o servidor recusa
   do mesmo jeito, mas o operador vê antes de tentar. */
function FiadoAcimaDoDisponivel(form, fiado) {
  return form.payment_method === FIADO
    && (parseFloat(form.amount || 0) || 0) > Number(fiado?.available || 0) + 0.004;
}

function SituacaoDoFiado({ t, fiado, formatCurrency }) {
  if (!fiado || (!fiado.exists && !Number(fiado.balance || 0))) return null;
  const deve = Number(fiado.balance || 0);
  return (
    <small className={`form-hint${fiado.blocked ? ' form-hint--danger' : ''}`}>
      {deve > 0 && t('fiado.owes', 'Deve {{value}}', { value: formatCurrency(deve) })}
      {deve > 0 && fiado.enabled && ' · '}
      {fiado.enabled && !fiado.blocked && t('fiado.available', 'Fiado disponível: {{value}}', {
        value: formatCurrency(fiado.available || 0),
      })}
      {fiado.blocked && ` · ${t('fiado.overdueBlocked', 'Fiado vencido há {{days}} dias — receba antes de vender de novo.', {
        days: fiado.days_open,
      })}`}
    </small>
  );
}

/* Trechos repetidos entre os cinco formulários. Funções e não componentes de
   verdade: componentes novos remontariam a árvore a cada digitação e o campo
   perderia o foco no meio do valor. */
function MetodoDePagamento({ t, form, setForm, activeMethods, fiado = null, formatCurrency }) {
  // "Fiado" só aparece na COMPRA de fichas e só para quem tem conta liberada,
  // não vencida e com saldo — é o gerente quem libera, não o caixa.
  const podeFiado = !!fiado?.enabled && !fiado.blocked && Number(fiado.available || 0) > 0;
  return (
    <div className="form-group">
      <label htmlFor="ctd-method">{t('cash.paymentMethod', 'Meio de pagamento')}</label>
      <select
        id="ctd-method"
        value={form.payment_method || ''}
        onChange={(e) => setForm({ ...form, payment_method: e.target.value })}
      >
        {activeMethods.map((m) => (
          <option key={m.code} value={m.code}>{methodLabel(t, m)}</option>
        ))}
        {podeFiado && (
          <option value={FIADO}>
            {t('fiado.optionLabel', 'Fiado (disponível {{value}})', { value: formatCurrency(fiado.available) })}
          </option>
        )}
      </select>
      {form.payment_method === FIADO && (
        <small className="form-hint">
          {t('fiado.notInDrawer', 'No fiado, nada entra no seu caixa: o jogador fica devendo ao clube.')}
        </small>
      )}
    </div>
  );
}

function ApuracaoCampos({ t, form, setForm, table }) {
  return (
    <>
      <div className="form-group">
        <label htmlFor="ctd-rake">{t('cash.rakeCounted2', 'Rake contado')}</label>
        <input
          id="ctd-rake" type="number" step="0.01" min="0"
          value={form.rake_amount}
          onChange={(e) => setForm({ ...form, rake_amount: e.target.value })}
          required autoFocus
        />
      </div>
      <div className="form-group">
        <label htmlFor="ctd-jackpot">{t('cash.jackpotCounted', 'Jackpot contado')}</label>
        <input
          id="ctd-jackpot" type="number" step="0.01" min="0"
          value={form.jackpot_amount}
          onChange={(e) => setForm({ ...form, jackpot_amount: e.target.value })}
        />
        {/* O jackpot é dinheiro dos JOGADORES retido para pagamento futuro.
            Se entrasse na receita, o clube contabilizaria como lucro algo que
            vai devolver. */}
        <small className="form-hint">
          {t('cash.jackpotHint', 'O jackpot não é receita do clube: acumula em fundo próprio até ser pago.')}
          {table?.jackpot_per_pot > 0 && ` (${t('cash.jackpotPerPot', 'configurado: {{v}} por pote', { v: table.jackpot_per_pot })})`}
        </small>
      </div>
      <div className="form-group">
        <label htmlFor="ctd-notes">{t('cash.notes', 'Observação')}</label>
        <input
          id="ctd-notes" type="text"
          value={form.notes}
          onChange={(e) => setForm({ ...form, notes: e.target.value })}
        />
      </div>
    </>
  );
}

function Acoes({ t, submitting, setModal, rotulo, bloqueado = false }) {
  return (
    <div className="modal-actions">
      <button type="button" className="btn btn-secondary" onClick={() => setModal(null)} disabled={submitting}>
        {t('common.cancel', 'Cancelar')}
      </button>
      <button type="submit" className="btn btn-primary" disabled={submitting || bloqueado}>
        {submitting ? t('common.saving', 'Salvando...') : rotulo}
      </button>
    </div>
  );
}

export default CashTableDetail;
