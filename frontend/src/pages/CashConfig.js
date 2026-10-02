import React, { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import api from '../config/api';
import Sidebar from '../components/Sidebar';
import EmptyState from '../components/EmptyState';
import { SkeletonTableRow } from '../components/SkeletonLoader';
import { useToast } from '../contexts/ToastContext';
import { useCurrency } from '../contexts/CurrencyContext';
import { useEscapeKey } from '../hooks/useEscapeKey';
import './CashFloor.css';
import './CashConfig.css';

/**
 * MODALIDADES: os stakes que o clube oferece.
 *
 * É o catálogo — o equivalente dos meios de entrada do torneio. Vive na
 * organização, não no dia: a mesa de R$1/2 é a mesma todo dia, e recadastrá-la
 * a cada noite seria trabalho puro e fonte de divergência entre dias.
 *
 * O QUE A MESA FAZ COM ISTO É COPIAR. Ao abrir, ela guarda um retrato dos
 * valores. Mudar o rake aqui amanhã não reescreve a apuração da mesa de ontem —
 * e é por isso que editar uma modalidade em uso é seguro.
 */
const VARIANTES = ['nlh', 'plo', 'plo5', 'loh', 'mixed', 'other'];

const VAZIO = {
  name: '', game_variant: 'nlh', small_blind: '', big_blind: '', ante: '0',
  min_buy_in: '', max_buy_in: '', default_seats: '9',
  rake_percent: '5', rake_cap: '0', jackpot_per_pot: '0', active: true,
};

const CashConfig = () => {
  const { t } = useTranslation();
  const { toast } = useToast();
  const { formatCurrency } = useCurrency();

  const [types, setTypes] = useState([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState(null); // {id?} | null
  const [form, setForm] = useState(VAZIO);
  const [submitting, setSubmitting] = useState(false);

  useEscapeKey(!!editing, () => { if (!submitting) setEditing(null); });

  const load = useCallback(async () => {
    try {
      const res = await api.get('/cash-game/game-types', { _silentError: true });
      setTypes(res.data || []);
    } catch {
      setTypes([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { setLoading(true); load(); }, [load]);

  const abrirNovo = () => { setForm(VAZIO); setEditing({}); };

  const abrirEdicao = (g) => {
    setForm({
      name: g.name, game_variant: g.game_variant,
      small_blind: String(g.small_blind), big_blind: String(g.big_blind),
      ante: String(g.ante ?? 0),
      min_buy_in: String(g.min_buy_in),
      max_buy_in: g.max_buy_in == null ? '' : String(g.max_buy_in),
      default_seats: String(g.default_seats),
      rake_percent: String(g.rake_percent), rake_cap: String(g.rake_cap ?? 0),
      jackpot_per_pot: String(g.jackpot_per_pot ?? 0), active: g.active,
    });
    setEditing(g);
  };

  const salvar = async (e) => {
    e.preventDefault();
    setSubmitting(true);
    const corpo = {
      name: form.name,
      game_variant: form.game_variant,
      small_blind: parseFloat(form.small_blind),
      big_blind: parseFloat(form.big_blind),
      ante: parseFloat(form.ante || 0),
      min_buy_in: parseFloat(form.min_buy_in),
      // Vazio = SEM TETO, e não zero: um teto de zero impediria qualquer
      // buy-in e travaria a mesa no primeiro jogador.
      max_buy_in: form.max_buy_in === '' ? null : parseFloat(form.max_buy_in),
      default_seats: parseInt(form.default_seats, 10),
      rake_percent: parseFloat(form.rake_percent || 0),
      rake_cap: parseFloat(form.rake_cap || 0),
      jackpot_per_pot: parseFloat(form.jackpot_per_pot || 0),
      active: form.active,
    };
    try {
      if (editing?.id) {
        await api.patch(`/cash-game/game-types/${editing.id}`, corpo);
      } else {
        await api.post('/cash-game/game-types', corpo);
      }
      toast.success(t('cash.gameTypeSaved', 'Modalidade salva'));
      setEditing(null);
      await load();
    } catch (err) {
      toast.error(err.userMessage || t('cash.gameTypeError', 'Não foi possível salvar'));
    } finally {
      setSubmitting(false);
    }
  };

  const remover = async (g) => {
    try {
      const res = await api.delete(`/cash-game/game-types/${g.id}`);
      // Modalidade já usada por uma mesa é DESATIVADA: apagar deixaria o
      // histórico sem o nome pelo qual o clube chama aquela mesa.
      toast.success(res.data?.deactivated
        ? t('cash.gameTypeDeactivated', 'Modalidade desativada (já usada em mesas)')
        : t('cash.gameTypeRemoved', 'Modalidade removida'));
      await load();
    } catch (err) {
      toast.error(err.userMessage || t('cash.gameTypeError', 'Não foi possível salvar'));
    }
  };

  return (
    <div className="app-container">
      <Sidebar />
      <main className="main-content">
        <div className="page-header">
          <div>
            <h1>{t('cash.config', 'Modalidades')}</h1>
            <p className="subtitle">
              {t('cash.configSubtitle', 'Stakes, buy-in e rake das mesas. A mesa guarda um retrato destes valores na abertura — editar aqui não muda mesas já abertas.')}
            </p>
          </div>
          <button type="button" className="btn btn-primary" onClick={abrirNovo}>
            {t('cash.newGameType', 'Nova modalidade')}
          </button>
        </div>

        {loading ? (
          <table className="data-table"><tbody>
            <SkeletonTableRow cols={6} /><SkeletonTableRow cols={6} />
          </tbody></table>
        ) : types.length === 0 ? (
          <EmptyState
            icon={null}
            title={t('cash.noGameTypesTitle', 'Nenhuma modalidade cadastrada')}
            subtitle={t('cash.noGameTypes', 'Cadastre uma modalidade (stakes, buy-in e rake) antes de abrir a primeira mesa.')}
            ctaLabel={t('cash.newGameType', 'Nova modalidade')}
            onCta={abrirNovo}
          />
        ) : (
          <div className="table-container">
            <table className="data-table">
              <thead>
                <tr>
                  <th>{t('cash.gameType', 'Modalidade')}</th>
                  <th>{t('cash.blinds', 'Blinds')}</th>
                  <th>{t('cash.buyInRange', 'Buy-in')}</th>
                  <th>{t('cash.rake', 'Rake')}</th>
                  <th>{t('cash.jackpot', 'Jackpot')}</th>
                  <th>{t('common.status', 'Status')}</th>
                  <th aria-label={t('common.actions', 'Ações')} />
                </tr>
              </thead>
              <tbody>
                {types.map((g) => (
                  <tr key={g.id} className={g.active ? '' : 'cc-inactive'}>
                    <td>
                      <strong>{g.name}</strong>
                      <div className="cc-variant">{g.game_variant.toUpperCase()}</div>
                    </td>
                    <td>{formatCurrency(g.small_blind)}/{formatCurrency(g.big_blind)}</td>
                    <td>
                      {formatCurrency(g.min_buy_in)}
                      {' – '}
                      {g.max_buy_in == null
                        ? t('cash.noCap', 'sem teto')
                        : formatCurrency(g.max_buy_in)}
                    </td>
                    <td>
                      {g.rake_percent}%
                      {g.rake_cap > 0 && (
                        <span className="cc-cap"> ({t('cash.cap', 'cap {{v}}', { v: formatCurrency(g.rake_cap) })})</span>
                      )}
                    </td>
                    <td>{g.jackpot_per_pot > 0 ? formatCurrency(g.jackpot_per_pot) : '—'}</td>
                    <td>
                      <span className={`status-badge ${g.active ? 'active' : 'cancelled'}`}>
                        {g.active ? t('common.active', 'Ativa') : t('common.inactive', 'Inativa')}
                      </span>
                    </td>
                    <td className="cc-actions">
                      <button type="button" className="btn btn-secondary btn-sm" onClick={() => abrirEdicao(g)}>
                        {t('common.edit', 'Editar')}
                      </button>
                      <button type="button" className="btn btn-danger btn-sm" onClick={() => remover(g)}>
                        {t('common.delete', 'Excluir')}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {editing && (
          <div className="modal-overlay"
               onClick={(e) => { if (e.target === e.currentTarget && !submitting) setEditing(null); }}>
            <div className="modal" role="dialog" aria-modal="true">
              <h2>{editing.id
                ? t('cash.editGameType', 'Editar modalidade')
                : t('cash.newGameType', 'Nova modalidade')}</h2>
              <form onSubmit={salvar}>
                <div className="form-group">
                  <label htmlFor="cc-name">{t('cash.gameTypeName', 'Nome')}</label>
                  <input id="cc-name" type="text" value={form.name} required
                         placeholder="NLH 1/2"
                         onChange={(e) => setForm({ ...form, name: e.target.value })} />
                </div>
                <div className="cc-row">
                  <div className="form-group">
                    <label htmlFor="cc-variant">{t('cash.variant', 'Jogo')}</label>
                    <select id="cc-variant" value={form.game_variant}
                            onChange={(e) => setForm({ ...form, game_variant: e.target.value })}>
                      {VARIANTES.map((v) => (
                        <option key={v} value={v}>{v.toUpperCase()}</option>
                      ))}
                    </select>
                  </div>
                  <div className="form-group">
                    <label htmlFor="cc-seats">{t('cash.defaultSeats', 'Lugares')}</label>
                    <input id="cc-seats" type="number" min="2" max="10" value={form.default_seats}
                           onChange={(e) => setForm({ ...form, default_seats: e.target.value })} />
                  </div>
                </div>
                <div className="cc-row">
                  <div className="form-group">
                    <label htmlFor="cc-sb">{t('cash.smallBlind', 'Small blind')}</label>
                    <input id="cc-sb" type="number" step="0.01" min="0.01" required value={form.small_blind}
                           onChange={(e) => setForm({ ...form, small_blind: e.target.value })} />
                  </div>
                  <div className="form-group">
                    <label htmlFor="cc-bb">{t('cash.bigBlind', 'Big blind')}</label>
                    <input id="cc-bb" type="number" step="0.01" min="0.01" required value={form.big_blind}
                           onChange={(e) => setForm({ ...form, big_blind: e.target.value })} />
                  </div>
                  <div className="form-group">
                    <label htmlFor="cc-ante">{t('cash.ante', 'Ante')}</label>
                    <input id="cc-ante" type="number" step="0.01" min="0" value={form.ante}
                           onChange={(e) => setForm({ ...form, ante: e.target.value })} />
                  </div>
                </div>
                <div className="cc-row">
                  <div className="form-group">
                    <label htmlFor="cc-min">{t('cash.minBuyIn', 'Buy-in mínimo')}</label>
                    <input id="cc-min" type="number" step="0.01" min="0.01" required value={form.min_buy_in}
                           onChange={(e) => setForm({ ...form, min_buy_in: e.target.value })} />
                    <small className="form-hint">
                      {t('cash.minBuyInHint', 'A prática do mercado é 50 a 100 big blinds.')}
                    </small>
                  </div>
                  <div className="form-group">
                    <label htmlFor="cc-max">{t('cash.maxBuyIn', 'Buy-in máximo')}</label>
                    <input id="cc-max" type="number" step="0.01" min="0" value={form.max_buy_in}
                           placeholder={t('cash.noCap', 'sem teto')}
                           onChange={(e) => setForm({ ...form, max_buy_in: e.target.value })} />
                    <small className="form-hint">
                      {t('cash.maxBuyInHint', 'Vazio = sem teto. O teto vale para SENTAR; a recompra repõe fichas e não é limitada por ele.')}
                    </small>
                  </div>
                </div>
                <div className="cc-row">
                  <div className="form-group">
                    <label htmlFor="cc-rake">{t('cash.rakePercent', 'Rake (%)')}</label>
                    <input id="cc-rake" type="number" step="0.01" min="0" max="100" value={form.rake_percent}
                           onChange={(e) => setForm({ ...form, rake_percent: e.target.value })} />
                  </div>
                  <div className="form-group">
                    <label htmlFor="cc-cap">{t('cash.rakeCap', 'Cap por pote')}</label>
                    <input id="cc-cap" type="number" step="0.01" min="0" value={form.rake_cap}
                           onChange={(e) => setForm({ ...form, rake_cap: e.target.value })} />
                  </div>
                  <div className="form-group">
                    <label htmlFor="cc-jp">{t('cash.jackpotPerPotLabel', 'Jackpot por pote')}</label>
                    <input id="cc-jp" type="number" step="0.01" min="0" value={form.jackpot_per_pot}
                           onChange={(e) => setForm({ ...form, jackpot_per_pot: e.target.value })} />
                  </div>
                </div>
                {/* O rake configurado ORIENTA o sangeur; o que vira receita é o
                    que ele conta na caixa da mesa. Sem este aviso o clube
                    esperaria que o sistema calculasse sozinho. */}
                <p className="cc-note">
                  {t('cash.rakeConfigNote', 'Estes valores orientam quem corta na mesa. A receita registrada é a que for CONTADA na caixa da mesa ao fechar — o sistema não vê mão a mão.')}
                </p>
                <button type="button" role="switch" aria-checked={!!form.active}
                        disabled={submitting}
                        className={`cc-toggle ${form.active ? 'on' : ''}`}
                        onClick={() => setForm({ ...form, active: !form.active })}>
                  <span className="cc-toggle-text">
                    <span className="cc-toggle-title">{t('common.active', 'Ativa')}</span>
                    <span className="cc-toggle-hint">{t('cash.activeHint', 'Inativa some da abertura de mesas, mas segue no histórico.')}</span>
                  </span>
                  <span className="cc-switch"><span className="cc-knob" /></span>
                </button>
                <div className="modal-actions">
                  <button type="button" className="btn btn-secondary" onClick={() => setEditing(null)} disabled={submitting}>
                    {t('common.cancel', 'Cancelar')}
                  </button>
                  <button type="submit" className="btn btn-primary" disabled={submitting}>
                    {submitting ? t('common.saving', 'Salvando...') : t('common.save', 'Salvar')}
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

export default CashConfig;
