import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import api from '../config/api';
import Sidebar from '../components/Sidebar';
import EmptyState from '../components/EmptyState';
import CashboxBanner from '../components/CashboxBanner';
import PlayerSelect from '../components/PlayerSelect';
import BarProductGrid from '../components/BarProductGrid';
import BarTabPanel from '../components/BarTabPanel';
import { SkeletonStatCard } from '../components/SkeletonLoader';
import { useToast } from '../contexts/ToastContext';
import { useCurrency } from '../contexts/CurrencyContext';
import { useBarShift } from '../contexts/BarShiftContext';
import { usePermissions } from '../contexts/PermissionContext';
import { useEscapeKey } from '../hooks/useEscapeKey';
import useRealtimeRefresh from '../hooks/useRealtimeRefresh';
import { aoMudarOCaixa } from '../utils/eventosDoCaixa';
import { hojeLocal } from '../utils/datasLocais';
import { novoId, saldoDaComanda } from '../utils/barTotais';
import './CashFloor.css';
import './Bar.css';
import './BarPOS.css';
import Icon from '../components/Icon';

/**
 * A POS do bar — a tela-mãe do módulo.
 *
 * Sem turno aberto não há operação: a tela oferece abrir. Com turno, o
 * barman vê a gaveta (CashboxBanner ancorado no turno), as comandas abertas,
 * a grade de produtos e a comanda selecionada. Um toque num produto lança
 * UMA unidade na comanda selecionada.
 *
 * A GAVETA FECHADA SÓ TRAVA O DINHEIRO. Lançar item não é movimento de caixa —
 * o barman continua atendendo; o que ele não faz é RECEBER em dinheiro/PIX/
 * cartão até abrir a gaveta (crédito do jogador continua valendo).
 */
const BarPOS = () => {
  const { t } = useTranslation();
  const { toast } = useToast();
  const { formatCurrency } = useCurrency();
  const { shift, barShiftId, isOpen, loading: shiftLoading, reload: reloadShift } = useBarShift();
  const { hasPermission } = usePermissions();
  const canAdmin = hasPermission('bar.admin');

  const [tabs, setTabs] = useState([]);
  const [products, setProducts] = useState([]);
  const [categories, setCategories] = useState([]);
  const [loading, setLoading] = useState(true);
  const [selectedId, setSelectedId] = useState(null);
  const [detail, setDetail] = useState(null);
  const [playerId, setPlayerId] = useState('');
  const [opening, setOpening] = useState(false);
  const [openForm, setOpenForm] = useState({ business_date: hojeLocal(), label: '' });
  const [submitting, setSubmitting] = useState(false);
  const [myCashbox, setMyCashbox] = useState(undefined);
  const cashboxBlocked = myCashbox !== undefined && myCashbox !== null && myCashbox.status !== 'open';

  useEscapeKey(opening, () => { if (!submitting) setOpening(false); });

  const loadCatalog = useCallback(async () => {
    const [p, c] = await Promise.all([
      api.get('/bar/products', { params: { active: true }, _silentError: true }).catch(() => ({ data: [] })),
      api.get('/bar/categories', { params: { active: true }, _silentError: true }).catch(() => ({ data: [] })),
    ]);
    setProducts(p.data || []);
    setCategories(c.data || []);
  }, []);

  const loadTabs = useCallback(async () => {
    if (!barShiftId) { setTabs([]); return; }
    try {
      const res = await api.get('/bar/tabs', { params: { bar_shift_id: barShiftId, status: 'open' }, _silentError: true });
      setTabs(res.data || []);
    } catch {
      setTabs([]);
    }
  }, [barShiftId]);

  const loadDetail = useCallback(async (id) => {
    if (!id) { setDetail(null); return; }
    try {
      const res = await api.get(`/bar/tabs/${id}`, { _silentError: true });
      setDetail(res.data);
    } catch {
      setDetail(null);
    }
  }, []);

  useEffect(() => {
    if (shiftLoading) return;
    setLoading(true);
    Promise.all([loadCatalog(), loadTabs()]).finally(() => setLoading(false));
  }, [shiftLoading, loadCatalog, loadTabs]);

  useEffect(() => { loadDetail(selectedId); }, [selectedId, loadDetail]);

  const recarregar = useCallback(() => {
    loadTabs();
    loadDetail(selectedId);
    loadCatalog();
  }, [loadTabs, loadDetail, loadCatalog, selectedId]);

  useRealtimeRefresh({
    canal: `bar-pos-${barShiftId || 'sem-turno'}`,
    tabelas: [
      { table: 'bar_tabs', filter: `bar_shift_id=eq.${barShiftId}` },
      { table: 'bar_tab_items', filter: `bar_shift_id=eq.${barShiftId}` },
      { table: 'bar_tab_payments', filter: `bar_shift_id=eq.${barShiftId}` },
    ],
    aoMudar: recarregar,
    ativo: !!barShiftId,
  });
  useEffect(() => aoMudarOCaixa(() => loadTabs()), [loadTabs]);

  // ── Turno ──
  const abrirTurno = async (e) => {
    e.preventDefault();
    setSubmitting(true);
    try {
      await api.post('/bar/shifts', { business_date: openForm.business_date, label: openForm.label || null });
      toast.success(t('bar.shiftOpened', 'Turno aberto'));
      setOpening(false);
      await reloadShift();
    } catch (err) {
      toast.error(err.userMessage || t('bar.shiftOpenError', 'Não foi possível abrir o turno'));
    } finally {
      setSubmitting(false);
    }
  };

  // ── Comanda ──
  const abrirComanda = async (e) => {
    e.preventDefault();
    if (!playerId) {
      toast.warning(t('bar.pickPlayer', 'Escolha o jogador'));
      return;
    }
    setSubmitting(true);
    try {
      const res = await api.post('/bar/tabs/open', { player_id: playerId, client_mutation_id: novoId() });
      setPlayerId('');
      await loadTabs();
      setSelectedId(res.data.id);
    } catch (err) {
      toast.error(err.userMessage || t('bar.openTabError', 'Não foi possível abrir a comanda'));
    } finally {
      setSubmitting(false);
    }
  };

  const lancar = async (product) => {
    if (!selectedId) return;
    try {
      const res = await api.post(`/bar/tabs/${selectedId}/items`, {
        product_id: product.id, quantity: 1, client_mutation_id: novoId(),
      });
      setDetail(res.data);
      loadTabs();
      if (product.track_stock) loadCatalog();
    } catch (err) {
      toast.error(err.userMessage || t('bar.addItemError', 'Não foi possível lançar o item'));
    }
  };

  const aoMudarComanda = (novo) => {
    setDetail(novo);
    loadTabs();
  };
  const aoFecharComanda = () => {
    setSelectedId(null);
    setDetail(null);
    loadTabs();
  };

  const totalEmAberto = useMemo(() => tabs.reduce((s, c) => s + saldoDaComanda(c), 0), [tabs]);
  const pendentes = useMemo(() => tabs.reduce((s, c) => s + (c.pending_count || 0), 0), [tabs]);

  return (
    <div className="app-container">
      <Sidebar />
      <main className="main-content">
        <div className="page-header">
          <div>
            <h1>{t('bar.pos', 'Comandas')}</h1>
            <p>
              {isOpen
                ? t('bar.posSubtitle', 'Turno de {{date}}{{label}} · {{count}} comanda(s) aberta(s) · {{due}} a receber', {
                  date: shift?.business_date, label: shift?.label ? ` · ${shift.label}` : '',
                  count: tabs.length, due: formatCurrency(totalEmAberto),
                })
                : t('bar.posClosedSubtitle', 'Nenhum turno aberto.')}
            </p>
          </div>
          {isOpen && pendentes > 0 && (
            <Link className="btn btn-secondary" to="/bar/pedidos">
              {t('bar.pendingOrders', '{{count}} pedido(s) pendente(s)', { count: pendentes })}
            </Link>
          )}
        </div>

        {shiftLoading ? (
          <div className="stats-grid"><SkeletonStatCard /><SkeletonStatCard /></div>
        ) : !isOpen ? (
          <EmptyState
            icon={<Icon name="cocktail" />}
            title={t('bar.noShiftTitle', 'O bar está fechado')}
            subtitle={t('bar.noShiftHint', 'Abra o turno para começar a lançar comandas. A data é a do turno — a noite que vira meia-noite é um turno só.')}
            ctaLabel={hasPermission('bar.shift') ? t('bar.openShift', 'Abrir turno') : undefined}
            onCta={hasPermission('bar.shift') ? () => { setOpenForm({ business_date: hojeLocal(), label: '' }); setOpening(true); } : undefined}
          />
        ) : (
          <>
            <CashboxBanner barShiftId={barShiftId} onStateChange={setMyCashbox} />
            {cashboxBlocked && (
              <p className="bar-warning">
                {t('bar.cashboxClosedHint', 'Seu caixa está fechado. Você pode lançar itens; para RECEBER em dinheiro, PIX ou cartão, abra o caixa acima.')}
              </p>
            )}

            {/* `pos-shell` é o container das consultas de largura: as colunas
                dependem do espaço que SOBRA ao lado do menu, não da janela. */}
            <div className="pos-shell">
            <div className="pos">
              <section className="pos-side">
                <form className="pos-open" onSubmit={abrirComanda}>
                  <PlayerSelect value={playerId} onChange={(e) => setPlayerId(e.target.value)} />
                  <button type="submit" className="btn btn-primary" disabled={submitting}>
                    {t('bar.openTab', 'Abrir comanda')}
                  </button>
                </form>
                <p className="bar-muted pos-open__hint">
                  {t('bar.openTabHint', 'Cada jogador tem UMA comanda aberta por vez: abrir de novo traz a mesma.')}
                </p>

                <ul className="pos-tabs" aria-label={t('bar.openTabs', 'Comandas abertas')}>
                  {tabs.length === 0 && (
                    <li className="bar-muted pos-tabs__empty">{t('bar.noOpenTabs', 'Nenhuma comanda aberta.')}</li>
                  )}
                  {tabs.map((c) => (
                    <li key={c.id}>
                      <button
                        type="button"
                        className={`pos-tab ${c.id === selectedId ? 'active' : ''}`}
                        onClick={() => setSelectedId(c.id)}
                      >
                        <span className="pos-tab__number">#{c.number}</span>
                        <span className="pos-tab__name">{c.player_name || '—'}</span>
                        <span className="pos-tab__due">{formatCurrency(saldoDaComanda(c))}</span>
                        {c.pending_count > 0 && (
                          <span className="pos-tab__pending" title={t('bar.itemPending', 'Pendente')}>{c.pending_count}</span>
                        )}
                      </button>
                    </li>
                  ))}
                </ul>
              </section>

              <section className="pos-main">
                {loading ? (
                  <div className="stats-grid"><SkeletonStatCard /><SkeletonStatCard /><SkeletonStatCard /></div>
                ) : (
                  <BarProductGrid products={products} categories={categories} onPick={lancar} disabled={!selectedId} />
                )}
              </section>

              <section className="pos-detail">
                {detail ? (
                  <BarTabPanel
                    detail={detail}
                    canAdmin={canAdmin}
                    cashboxBlocked={cashboxBlocked}
                    onChanged={aoMudarComanda}
                    onClosed={aoFecharComanda}
                  />
                ) : (
                  <p className="bar-muted pos-detail__empty">{t('bar.noTabSelected', 'Selecione uma comanda à esquerda, ou abra uma nova.')}</p>
                )}
              </section>
            </div>
            </div>
          </>
        )}

        {opening && (
          <div className="modal-overlay" onClick={(e) => { if (e.target === e.currentTarget && !submitting) setOpening(false); }}>
            <div className="modal" role="dialog" aria-modal="true">
              <h2>{t('bar.openShift', 'Abrir turno')}</h2>
              <form onSubmit={abrirTurno}>
                <div className="form-group">
                  <label htmlFor="pos-date">{t('bar.businessDate', 'Data')}</label>
                  <input id="pos-date" type="date" required value={openForm.business_date}
                         onChange={(e) => setOpenForm({ ...openForm, business_date: e.target.value })} />
                </div>
                <div className="form-group">
                  <label htmlFor="pos-label">{t('bar.shiftLabel', 'Rótulo')}</label>
                  <input id="pos-label" type="text" value={openForm.label}
                         placeholder={t('bar.shiftLabelPlaceholder', 'Noite, Tarde...')}
                         onChange={(e) => setOpenForm({ ...openForm, label: e.target.value })} />
                </div>
                <div className="modal-actions">
                  <button type="button" className="btn btn-secondary" onClick={() => setOpening(false)} disabled={submitting}>
                    {t('common.cancel', 'Cancelar')}
                  </button>
                  <button type="submit" className="btn btn-primary" disabled={submitting}>
                    {submitting ? t('common.saving', 'Salvando...') : t('bar.openShift', 'Abrir turno')}
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

export default BarPOS;
