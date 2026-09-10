import React, { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import api from '../config/api';
import Sidebar from '../components/Sidebar';
import EmptyState from '../components/EmptyState';
import PlayerSelect from '../components/PlayerSelect';
import { SkeletonBlock } from '../components/SkeletonLoader';
import { useToast } from '../contexts/ToastContext';
import { useCashDay } from '../contexts/CashDayContext';
import usePolling from '../hooks/usePolling';
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
 * A POSIÇÃO NÃO É RECICLADA: quem senta ou desiste sai da fila, mas os que
 * estão atrás mantêm o número. É o registro de quem chegou quando — e é
 * exatamente isso que o jogador contesta no balcão.
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
  usePolling(load, 5000);

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

  const esperando = entries.filter((e) => e.status === 'waiting' || e.status === 'called');
  const encerrados = entries.filter((e) => e.status !== 'waiting' && e.status !== 'called');

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
              {t('cashWaitlist.subtitle', '{{count}} na fila. A ordem é a de chegada e não é renumerada — quem sai não faz os outros subirem de número.', {
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
          <ol className="cw-list">
            {esperando.map((e) => (
              <li key={e.id} className={`cw-item ${e.status}`}>
                <span className="cw-position" aria-hidden="true">{e.position}</span>
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
        )}

        {encerrados.length > 0 && (
          <details className="cw-history">
            <summary>
              {t('cashWaitlist.history', 'Já saíram da fila ({{count}})', { count: encerrados.length })}
            </summary>
            <ul className="cw-list cw-list--past">
              {encerrados.map((e) => (
                <li key={e.id} className="cw-item past">
                  <span className="cw-position" aria-hidden="true">{e.position}</span>
                  <div className="cw-info">
                    <span className="cw-name">{e.player_name}</span>
                    <span className="cw-meta">
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
