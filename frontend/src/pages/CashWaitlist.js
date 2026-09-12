import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import api from '../config/api';
import Sidebar from '../components/Sidebar';
import EmptyState from '../components/EmptyState';
import PlayerSelect from '../components/PlayerSelect';
import { SkeletonBlock } from '../components/SkeletonLoader';
import { useToast } from '../contexts/ToastContext';
import { useCashDay } from '../contexts/CashDayContext';
import useRealtimeRefresh from '../hooks/useRealtimeRefresh';
import { useEscapeKey } from '../hooks/useEscapeKey';
import './CashFloor.css';
import './CashWaitlist.css';

/**
 * A FILA DE ESPERA.
 *
 * Numa noite cheia há mais gente do que cadeira, e quem decide a ordem é um
 * papel na mão de alguém — que se perde, some, e vira discussão na frente da
 * mesa. Esta tela existe para essa ordem ser a mesma para todo mundo que olhar.
 *
 * O NÚMERO NA TELA É O LUGAR NA FILA (1, 2, 3...), recalculado a cada carga.
 * Não é a posição de chegada: essa continua gravada no banco, imutável, e é
 * ela que ORDENA a fila — é o registro de quem chegou quando. A tela mostra a
 * resposta à pergunta que o jogador faz ("sou o quantos?"); o banco guarda a
 * resposta à pergunta que ele contesta ("quem chegou antes?").
 *
 * A FILA É POR MODALIDADE, não por mesa física. Quem espera pelo NLH 1/2 pode
 * sentar em qualquer mesa que rode NLH 1/2 — agrupar por mesa faria a mesma
 * pessoa aparecer em três listas ao mesmo tempo.
 *
 * O visitante entra só com o NOME. Exigir cadastro com cinco pessoas esperando
 * faria o operador voltar para o papel, que é o que a fila veio substituir.
 */
const CashWaitlist = () => {
  const { t } = useTranslation();
  const { toast } = useToast();
  const { cashDayId, isOpen, loading: dayLoading } = useCashDay();

  const [entries, setEntries] = useState([]);
  const [tables, setTables] = useState([]);
  const [gameTypes, setGameTypes] = useState([]);
  const [loading, setLoading] = useState(true);
  const [modal, setModal] = useState(null); // {kind, entry?}
  const [submitting, setSubmitting] = useState(false);
  const [form, setForm] = useState({});

  useEscapeKey(!!modal, () => { if (!submitting) setModal(null); });

  const load = useCallback(async () => {
    if (!cashDayId) { setEntries([]); setLoading(false); return; }
    const [fila, mesas, tipos] = await Promise.all([
      api.get('/cash-game/waitlist', { params: { cash_day_id: cashDayId }, _silentError: true })
        .catch(() => ({ data: [] })),
      api.get('/cash-game/tables', { params: { cash_day_id: cashDayId, status: 'open' }, _silentError: true })
        .catch(() => ({ data: [] })),
      api.get('/cash-game/game-types', { params: { active: true }, _silentError: true })
        .catch(() => ({ data: [] })),
    ]);
    setEntries(fila.data || []);
    setTables(mesas.data || []);
    setGameTypes(tipos.data || []);
    setLoading(false);
  }, [cashDayId]);

  useEffect(() => { setLoading(true); load(); }, [load]);
  // A fila é estado compartilhado: outro operador chama alguém e esta tela
  // precisa saber antes de o mesmo nome ser chamado duas vezes.
  useRealtimeRefresh({
    canal: `cash-fila-${cashDayId || 'sem-dia'}`,
    tabelas: [
      { table: 'cash_waitlist', filter: cashDayId ? `cash_day_id=eq.${cashDayId}` : undefined },
      { table: 'cash_seats' },
    ],
    aoMudar: () => load(),
    ativo: !!cashDayId,
  });

  const agir = async (fn, mensagem, erroPadrao) => {
    setSubmitting(true);
    try {
      await fn();
      toast.success(mensagem);
      setModal(null);
      await load();
    } catch (err) {
      toast.error(err.userMessage || erroPadrao);
    } finally {
      setSubmitting(false);
    }
  };

  const entrar = (e) => {
    e.preventDefault();
    if (!form.player_id && !(form.guest_name || '').trim()) {
      toast.warning(t('cashWaitlist.needName', 'Escolha o jogador ou digite um nome'));
      return;
    }
    return agir(
      () => api.post('/cash-game/waitlist', {
        player_id: form.player_id || null,
        guest_name: form.guest_name || null,
        game_type_id: form.game_type_id || null,
      }, { params: { cash_day_id: cashDayId } }),
      t('cashWaitlist.added', 'Adicionado à fila'),
      t('cashWaitlist.addError', 'Não foi possível adicionar à fila'),
    );
  };

  const reservar = (e) => {
    e.preventDefault();
    return agir(
      () => api.post(`/cash-game/waitlist/${modal.entry.id}/seat`, {
        table_id: form.table_id,
        seat_number: parseInt(form.seat_number, 10),
        minutes: parseInt(form.minutes, 10) || 10,
      }),
      t('cashWaitlist.reserved', 'Lugar reservado'),
      t('cashWaitlist.reserveError', 'Não foi possível reservar o lugar'),
    );
  };

  const chamar = (entry) => agir(
    () => api.post(`/cash-game/waitlist/${entry.id}/call`),
    t('cashWaitlist.called', 'Jogador chamado'),
    t('cashWaitlist.callError', 'Não foi possível chamar'),
  );

  const naoApareceu = (entry) => agir(
    () => api.post(`/cash-game/waitlist/${entry.id}/no-show`),
    t('cashWaitlist.noShowDone', 'Marcado como não compareceu'),
    t('cashWaitlist.actionError', 'Não foi possível concluir'),
  );

  const desistir = (entry) => agir(
    () => api.delete(`/cash-game/waitlist/${entry.id}`),
    t('cashWaitlist.gaveUpDone', 'Removido da fila'),
    t('cashWaitlist.actionError', 'Não foi possível concluir'),
  );

  const sentou = (entry) => agir(
    () => api.post(`/cash-game/waitlist/${entry.id}/seated`),
    t('cashWaitlist.seatedDone', 'Espera encerrada'),
    t('cashWaitlist.actionError', 'Não foi possível concluir'),
  );

  const esperando = useMemo(
    () => entries.filter((e) => e.status === 'waiting' || e.status === 'called'),
    [entries],
  );
  const encerrados = useMemo(
    () => entries.filter((e) => e.status !== 'waiting' && e.status !== 'called'),
    [entries],
  );

  /**
   * A fila, dividida por modalidade.
   *
   * Cada pessoa aparece UMA vez: ela espera por um stake, não por uma mesa. O
   * cabeçalho do grupo diz quais mesas rodam aquele stake e quantos lugares
   * estão livres entre elas — é o que o operador precisa para decidir se tem
   * quem chamar agora.
   *
   * Quem entrou como "qualquer mesa" fica num grupo próprio, no fim: essa
   * pessoa serve para qualquer lugar que abrir, então ela não pertence a
   * stake nenhum.
   *
   * `entries` já vem do servidor ordenado por posição de chegada, e agrupar
   * preserva essa ordem — por isso o índice dentro do grupo JÁ É o lugar na
   * fila, sem precisar reordenar nada aqui.
   */
  const grupos = useMemo(() => {
    // Índice das mesas abertas por modalidade. Sem ele seria uma varredura da
    // lista de mesas por pessoa na fila.
    const mesasPorTipo = new Map();
    let livresNoSalao = 0;
    tables.forEach((m) => {
      livresNoSalao += m.free_seats || 0;
      if (!m.game_type_id) return;
      const atual = mesasPorTipo.get(m.game_type_id) || { numeros: [], livres: 0 };
      atual.numeros.push(m.table_number);
      atual.livres += m.free_seats || 0;
      mesasPorTipo.set(m.game_type_id, atual);
    });

    const porTipo = new Map();
    esperando.forEach((e) => {
      const chave = e.game_type_id || 'qualquer';
      if (!porTipo.has(chave)) {
        const mesas = e.game_type_id ? mesasPorTipo.get(e.game_type_id) : null;
        porTipo.set(chave, {
          chave,
          qualquerMesa: !e.game_type_id,
          titulo: e.game_type_name || null,
          // "Qualquer mesa" enxerga o salão inteiro, porque é isso que ela é.
          numeros: e.game_type_id ? (mesas?.numeros || []) : tables.map((m) => m.table_number),
          livres: e.game_type_id ? (mesas?.livres || 0) : livresNoSalao,
          itens: [],
        });
      }
      porTipo.get(chave).itens.push(e);
    });

    // Quem espera há mais tempo aparece em cima: é o grupo que tem alguém
    // prestes a reclamar. "Qualquer mesa" entra nessa ordem como os outros.
    return [...porTipo.values()].sort(
      (a, b) => (a.itens[0]?.position || 0) - (b.itens[0]?.position || 0),
    );
  }, [esperando, tables]);

  const abrirEntrada = () => {
    setForm({ player_id: '', guest_name: '', game_type_id: '' });
    setModal({ kind: 'add' });
  };

  const abrirReserva = (entry) => {
    const mesa = tables[0];
    setForm({
      table_id: mesa?.id || '',
      seat_number: '',
      minutes: '10',
    });
    setModal({ kind: 'seat', entry });
  };

  const assentosLivres = (tableId) => {
    const mesa = tables.find((m) => m.id === tableId);
    if (!mesa) return [];
    // Aproximação pela contagem: a lista exata de cadeiras livres é da tela da
    // mesa. Aqui basta oferecer números válidos — o servidor recusa o que
    // estiver ocupado, e é ele quem decide a corrida.
    return Array.from({ length: mesa.seats }, (_, i) => i + 1);
  };

  return (
    <div className="app-container">
      <Sidebar />
      <main className="main-content">
        <div className="page-header">
          <div>
            <h1>{t('cash.waitlist', 'Fila de espera')}</h1>
            <p className="subtitle">
              {t('cashWaitlist.subtitle', '{{count}} na fila, por modalidade. A ordem é a de chegada; o número é o lugar na fila e sobe sozinho quando alguém senta.', {
                count: esperando.length,
              })}
            </p>
          </div>
          {isOpen && (
            <button type="button" className="btn btn-primary" onClick={abrirEntrada}>
              {t('cashWaitlist.add', 'Adicionar à fila')}
            </button>
          )}
        </div>

        {dayLoading || loading ? (
          <SkeletonBlock height="8rem" />
        ) : !isOpen ? (
          <EmptyState
            icon={null}
            title={t('cash.noDayOpen', 'Nenhum dia de operação aberto')}
            subtitle={t('cashWaitlist.noDayHint', 'A fila é do dia. Abra o dia no Salão para começar a anotar.')}
          />
        ) : esperando.length === 0 ? (
          <EmptyState
            icon={null}
            title={t('cashWaitlist.empty', 'Ninguém na fila')}
            subtitle={t('cashWaitlist.emptyHint', 'Quando a sala encher, anote aqui quem está esperando lugar.')}
            ctaLabel={t('cashWaitlist.add', 'Adicionar à fila')}
            onCta={abrirEntrada}
          />
        ) : (
          grupos.map((grupo) => (
            <section key={grupo.chave} className="cw-group">
              <header className="cw-group-head">
                <h2 className="cw-group-title">
                  {grupo.qualquerMesa
                    ? t('cashWaitlist.anyGame', 'Qualquer mesa')
                    : grupo.titulo}
                </h2>
                <span className="cw-group-meta">
                  {/* O que o operador precisa saber para decidir se chama
                      alguém agora: onde essa gente pode sentar, e se há lugar. */}
                  {grupo.numeros.length === 0
                    ? t('cashWaitlist.noTableForGame', 'Nenhuma mesa aberta')
                    : t('cashWaitlist.tablesRunning', 'Mesas {{lista}}', {
                        lista: grupo.numeros.join(', '),
                      })}
                  {grupo.numeros.length > 0 && (
                    <>
                      {' · '}
                      <span className={grupo.livres > 0 ? 'cw-free' : undefined}>
                        {t('cashWaitlist.freeSeats', '{{count}} lugares livres', {
                          count: grupo.livres,
                        })}
                      </span>
                    </>
                  )}
                  {' · '}
                  {t('cashWaitlist.waitingCount', '{{count}} esperando', {
                    count: grupo.itens.length,
                  })}
                </span>
              </header>
              <ol className="cw-list">
                {grupo.itens.map((e, indice) => (
              <li key={e.id} className={`cw-item ${e.status}`}>
                {/* O LUGAR na fila, não o número de chegada: é a resposta à
                    pergunta que o jogador faz no balcão ("sou o quantos?").
                    A chegada continua gravada, e é ela que ordena esta lista. */}
                <span className="cw-position" aria-hidden="true">{indice + 1}</span>
                <div className="cw-info">
                  <span className="cw-name">{e.player_name}</span>
                  <span className="cw-meta">
                    {e.game_type_name || t('cashWaitlist.anyGame', 'Qualquer mesa')}
                    {e.status === 'called' && (
                      <span className="cw-badge">{t('cashWaitlist.calledBadge', 'Chamado')}</span>
                    )}
                    {e.table_number != null && (
                      <span className="cw-badge cw-badge--seat">
                        {t('cashWaitlist.reservedAt', 'Mesa {{n}}', { n: e.table_number })}
                      </span>
                    )}
                    {/* O visitante ainda sem cadastro não pode ter cadeira
                        reservada: a reserva prende o lugar para uma pessoa
                        identificada. O aviso evita o clique que sempre falha. */}
                    {!e.player_id && (
                      <span className="cw-badge cw-badge--guest">
                        {t('cashWaitlist.guest', 'Sem cadastro')}
                      </span>
                    )}
                  </span>
                </div>
                <div className="cw-actions">
                  {e.status === 'waiting' && (
                    <button type="button" className="btn btn-secondary btn-sm"
                            onClick={() => chamar(e)} disabled={submitting}>
                      {t('cashWaitlist.call', 'Chamar')}
                    </button>
                  )}
                  <button type="button" className="btn btn-secondary btn-sm"
                          onClick={() => abrirReserva(e)}
                          disabled={submitting || !e.player_id || tables.length === 0}
                          title={!e.player_id
                            ? t('cashWaitlist.guestCannotReserve', 'Cadastre o jogador para reservar o lugar')
                            : undefined}>
                    {t('cashWaitlist.reserve', 'Reservar lugar')}
                  </button>
                  <button type="button" className="btn btn-primary btn-sm"
                          onClick={() => sentou(e)} disabled={submitting}>
                    {t('cashWaitlist.seated', 'Sentou')}
                  </button>
                  {e.status === 'called' && (
                    <button type="button" className="btn btn-secondary btn-sm"
                            onClick={() => naoApareceu(e)} disabled={submitting}>
                      {t('cashWaitlist.noShow', 'Não veio')}
                    </button>
                  )}
                  <button type="button" className="btn btn-danger btn-sm"
                          onClick={() => desistir(e)} disabled={submitting}>
                    {t('cashWaitlist.giveUp', 'Saiu')}
                  </button>
                </div>
              </li>
                ))}
              </ol>
            </section>
          ))
        )}

        {encerrados.length > 0 && (
          <details className="cw-history">
            <summary>
              {t('cashWaitlist.history', 'Já saíram da fila ({{count}})', { count: encerrados.length })}
            </summary>
            <ul className="cw-list cw-list--past">
              {encerrados.map((e) => (
                <li key={e.id} className="cw-item past">
                  <div className="cw-info">
                    <span className="cw-name">{e.player_name}</span>
                    <span className="cw-meta">
                      {e.game_type_name && <>{e.game_type_name}{' · '}</>}
                      {e.status === 'seated' && t('cashWaitlist.statusSeated', 'Sentou')}
                      {e.status === 'no_show' && t('cashWaitlist.statusNoShow', 'Não compareceu')}
                      {e.status === 'cancelled' && t('cashWaitlist.statusCancelled', 'Desistiu')}
                    </span>
                  </div>
                </li>
              ))}
            </ul>
          </details>
        )}

        {modal?.kind === 'add' && (
          <div className="modal-overlay"
               onClick={(ev) => { if (ev.target === ev.currentTarget && !submitting) setModal(null); }}>
            <div className="modal" role="dialog" aria-modal="true">
              <h2>{t('cashWaitlist.add', 'Adicionar à fila')}</h2>
              <form onSubmit={entrar}>
                <div className="form-group">
                  <label htmlFor="cw-player">{t('cash.player', 'Jogador')}</label>
                  <PlayerSelect
                    value={form.player_id}
                    onChange={(ev) => setForm({ ...form, player_id: ev.target.value, guest_name: '' })}
                  />
                </div>
                <div className="form-group">
                  <label htmlFor="cw-guest">{t('cashWaitlist.guestName', 'Ou apenas o nome')}</label>
                  <input id="cw-guest" type="text" value={form.guest_name || ''}
                         disabled={!!form.player_id}
                         onChange={(ev) => setForm({ ...form, guest_name: ev.target.value })} />
                  {/* A razão de existir o campo: quem chega pela primeira vez
                      não pode ficar esperando um cadastro para ser anotado. */}
                  <small className="form-hint">
                    {t('cashWaitlist.guestHint', 'Para quem ainda não é cadastrado. O cadastro pode ser feito depois, na hora de sentar.')}
                  </small>
                </div>
                <div className="form-group">
                  <label htmlFor="cw-type">{t('cashWaitlist.wants', 'Quer jogar')}</label>
                  <select id="cw-type" value={form.game_type_id || ''}
                          onChange={(ev) => setForm({ ...form, game_type_id: ev.target.value })}>
                    <option value="">{t('cashWaitlist.anyGame', 'Qualquer mesa')}</option>
                    {gameTypes.map((g) => (
                      <option key={g.id} value={g.id}>{g.name}</option>
                    ))}
                  </select>
                </div>
                <div className="modal-actions">
                  <button type="button" className="btn btn-secondary"
                          onClick={() => setModal(null)} disabled={submitting}>
                    {t('common.cancel', 'Cancelar')}
                  </button>
                  <button type="submit" className="btn btn-primary" disabled={submitting}>
                    {submitting ? t('common.saving', 'Salvando...') : t('cashWaitlist.add', 'Adicionar à fila')}
                  </button>
                </div>
              </form>
            </div>
          </div>
        )}

        {modal?.kind === 'seat' && (
          <div className="modal-overlay"
               onClick={(ev) => { if (ev.target === ev.currentTarget && !submitting) setModal(null); }}>
            <div className="modal" role="dialog" aria-modal="true">
              <h2>{t('cashWaitlist.reserveFor', 'Reservar lugar — {{name}}', { name: modal.entry.player_name })}</h2>
              <form onSubmit={reservar}>
                {/* Reservar não é sentar: sentar é vender fichas e passa pelo
                    caixa. Sem este aviso o operador acha que já registrou a
                    entrada e o jogador senta sem ter pago. */}
                <p className="ctd-close-hint">
                  {t('cashWaitlist.reserveHint', 'A reserva segura a cadeira enquanto o jogador vem. A compra das fichas continua sendo feita no caixa, na tela da mesa.')}
                </p>
                <div className="form-group">
                  <label htmlFor="cw-table">{t('cashWaitlist.table', 'Mesa')}</label>
                  <select id="cw-table" value={form.table_id || ''} required
                          onChange={(ev) => setForm({ ...form, table_id: ev.target.value, seat_number: '' })}>
                    {tables.map((m) => (
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
                  <label htmlFor="cw-seat">{t('cashWaitlist.seatNumber', 'Lugar')}</label>
                  <select id="cw-seat" value={form.seat_number || ''} required
                          onChange={(ev) => setForm({ ...form, seat_number: ev.target.value })}>
                    <option value="">{t('cashWaitlist.pickSeat', 'Escolha o lugar')}</option>
                    {assentosLivres(form.table_id).map((n) => (
                      <option key={n} value={n}>{n}</option>
                    ))}
                  </select>
                </div>
                <div className="form-group">
                  <label htmlFor="cw-minutes">{t('cashWaitlist.minutes', 'Segurar por (minutos)')}</label>
                  <input id="cw-minutes" type="number" min="1" max="120"
                         value={form.minutes || ''}
                         onChange={(ev) => setForm({ ...form, minutes: ev.target.value })} />
                  {/* O prazo é obrigatório: uma chamada esquecida travaria a
                      cadeira a noite inteira, e numa sala cheia isso é um
                      lugar que não gira. */}
                  <small className="form-hint">
                    {t('cashWaitlist.minutesHint', 'Passado o prazo a cadeira volta sozinha para a sala.')}
                  </small>
                </div>
                <div className="modal-actions">
                  <button type="button" className="btn btn-secondary"
                          onClick={() => setModal(null)} disabled={submitting}>
                    {t('common.cancel', 'Cancelar')}
                  </button>
                  <button type="submit" className="btn btn-primary" disabled={submitting}>
                    {submitting ? t('common.saving', 'Salvando...') : t('cashWaitlist.reserve', 'Reservar lugar')}
                  </button>
                </div>
              </form>
            </div>
          </div>
        )}
      </main>
    </div>
  );
};

export default CashWaitlist;
