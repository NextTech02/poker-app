import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import api from '../config/api';
import Sidebar from '../components/Sidebar';
import EmptyState from '../components/EmptyState';
import { SkeletonStatCard } from '../components/SkeletonLoader';
import { useToast } from '../contexts/ToastContext';
import { useBarShift } from '../contexts/BarShiftContext';
import useRealtimeRefresh from '../hooks/useRealtimeRefresh';
import './CashFloor.css';
import './Bar.css';
import './BarOrders.css';

/**
 * PEDIDOS: o que foi lançado e ainda não saiu do balcão/cozinha.
 *
 * Um card por comanda, com os itens pendentes em ordem de chegada. Entregar
 * um item ou a comanda inteira. Realtime em bar_tab_items: o barman lança na
 * POS e o pedido aparece aqui sem ninguém apertar nada.
 */
const BarOrders = () => {
  const { t } = useTranslation();
  const { toast } = useToast();
  const { barShiftId, isOpen, loading: shiftLoading } = useBarShift();
  const [orders, setOrders] = useState([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(null);

  const load = useCallback(async () => {
    if (!barShiftId) { setOrders([]); setLoading(false); return; }
    try {
      const res = await api.get('/bar/orders', { params: { bar_shift_id: barShiftId }, _silentError: true });
      setOrders(res.data || []);
    } catch {
      setOrders([]);
    } finally {
      setLoading(false);
    }
  }, [barShiftId]);

  useEffect(() => { if (!shiftLoading) load(); }, [shiftLoading, load]);

  useRealtimeRefresh({
    canal: `bar-orders-${barShiftId || 'sem-turno'}`,
    tabelas: [{ table: 'bar_tab_items', filter: `bar_shift_id=eq.${barShiftId}` }],
    aoMudar: () => load(),
    ativo: !!barShiftId,
  });

  const porComanda = useMemo(() => {
    const grupos = new Map();
    orders.forEach((o) => {
      if (!grupos.has(o.tab_id)) {
        grupos.set(o.tab_id, { tab_id: o.tab_id, number: o.tab_number, player: o.player_name, items: [] });
      }
      grupos.get(o.tab_id).items.push(o);
    });
    return Array.from(grupos.values());
  }, [orders]);

  const entregar = async (item) => {
    setBusy(item.item_id);
    try {
      await api.post(`/bar/tabs/${item.tab_id}/items/${item.item_id}/deliver`);
      setOrders((prev) => prev.filter((o) => o.item_id !== item.item_id));
    } catch (err) {
      toast.error(err.userMessage || t('bar.actionError', 'Não foi possível concluir'));
    } finally {
      setBusy(null);
    }
  };

  const entregarTodos = async (grupo) => {
    setBusy(grupo.tab_id);
    try {
      await api.post(`/bar/tabs/${grupo.tab_id}/deliver-all`);
      setOrders((prev) => prev.filter((o) => o.tab_id !== grupo.tab_id));
    } catch (err) {
      toast.error(err.userMessage || t('bar.actionError', 'Não foi possível concluir'));
    } finally {
      setBusy(null);
    }
  };

  const hora = (iso) => {
    try {
      return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    } catch {
      return '';
    }
  };

  return (
    <div className="app-container">
      <Sidebar />
      <main className="main-content">
        <div className="page-header">
          <div>
            <h1>{t('bar.orders', 'Pedidos')}</h1>
            <p className="subtitle">
              {t('bar.ordersSubtitle', '{{count}} item(ns) aguardando entrega', { count: orders.length })}
            </p>
          </div>
          <Link className="btn btn-secondary" to="/bar">{t('bar.pos', 'Comandas')}</Link>
        </div>

        {shiftLoading || loading ? (
          <div className="stats-grid"><SkeletonStatCard /><SkeletonStatCard /></div>
        ) : !isOpen ? (
          <EmptyState icon={null} title={t('bar.noShiftTitle', 'O bar está fechado')} />
        ) : porComanda.length === 0 ? (
          <EmptyState icon="✅" title={t('bar.noPendingOrders', 'Tudo entregue')}
                      subtitle={t('bar.noPendingOrdersHint', 'Os itens lançados na POS aparecem aqui até serem entregues.')} />
        ) : (
          <div className="bo-grid">
            {porComanda.map((g) => (
              <article key={g.tab_id} className="bo-card">
                <header className="bo-card__header">
                  <strong>#{g.number} · {g.player || '—'}</strong>
                  <button type="button" className="btn btn-primary btn-sm" disabled={busy === g.tab_id}
                          onClick={() => entregarTodos(g)}>
                    {t('bar.deliverAll', 'Entregar todos')}
                  </button>
                </header>
                <ul className="bo-items">
                  {g.items.map((i) => (
                    <li key={i.item_id} className="bo-item">
                      <span className="bo-item__qty">{i.quantity}×</span>
                      <span className="bo-item__name">
                        {i.product_name}
                        {i.notes && <small className="bar-muted"> · {i.notes}</small>}
                      </span>
                      <span className="bar-muted">{hora(i.created_at)}</span>
                      <button type="button" className="btn btn-secondary btn-sm" disabled={busy === i.item_id}
                              onClick={() => entregar(i)}>
                        {t('bar.deliver', 'Entregar')}
                      </button>
                    </li>
                  ))}
                </ul>
              </article>
            ))}
          </div>
        )}
      </main>
    </div>
  );
};

export default BarOrders;
