import React, { useCallback, useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import api from '../config/api';
import Sidebar from '../components/Sidebar';
import Breadcrumb from '../components/Breadcrumb';
import EmptyState from '../components/EmptyState';
import CashboxBanner from '../components/CashboxBanner';
import BarTabPanel from '../components/BarTabPanel';
import { SkeletonStatCard } from '../components/SkeletonLoader';
import { usePermissions } from '../contexts/PermissionContext';
import { useBarShift } from '../contexts/BarShiftContext';
import useRealtimeRefresh from '../hooks/useRealtimeRefresh';
import './CashFloor.css';
import './Bar.css';

/**
 * Uma comanda em página inteira — o destino dos links do turno e do
 * histórico do jogador. Mesmo painel da POS, com as ações de gerente.
 */
const BarTabDetail = () => {
  const { id } = useParams();
  const { t } = useTranslation();
  const { hasPermission } = usePermissions();
  const { barShiftId } = useBarShift();
  const [detail, setDetail] = useState(null);
  const [loading, setLoading] = useState(true);
  const [myCashbox, setMyCashbox] = useState(undefined);
  const cashboxBlocked = myCashbox !== undefined && myCashbox !== null && myCashbox.status !== 'open';

  const load = useCallback(async () => {
    try {
      const res = await api.get(`/bar/tabs/${id}`, { _silentError: true });
      setDetail(res.data);
    } catch {
      setDetail(null);
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => { setLoading(true); load(); }, [load]);

  useRealtimeRefresh({
    canal: `bar-tab-${id}`,
    tabelas: [
      { table: 'bar_tab_items', filter: `tab_id=eq.${id}` },
      { table: 'bar_tab_payments', filter: `tab_id=eq.${id}` },
      { table: 'bar_tabs', filter: `id=eq.${id}` },
    ],
    aoMudar: () => load(),
    ativo: !!id,
  });

  const tab = detail?.tab;
  const mesmoTurno = tab && barShiftId && tab.bar_shift_id === barShiftId;

  return (
    <div className="app-container">
      <Sidebar />
      <main className="main-content">
        <Breadcrumb items={[
          { label: t('bar.title', 'Bar'), to: '/bar' },
          { label: t('bar.pos', 'Comandas'), to: '/bar' },
          { label: tab ? `#${tab.number}` : '…' },
        ]} />
        <div className="page-header">
          <div>
            <h1>{t('bar.tabTitle', 'Comanda #{{number}}', { number: tab?.number || '' })}</h1>
            <p className="subtitle">{tab?.player_name || ''}</p>
          </div>
        </div>

        {mesmoTurno && tab.status === 'open' && (
          <CashboxBanner barShiftId={barShiftId} onStateChange={setMyCashbox} />
        )}

        {loading ? (
          <div className="stats-grid"><SkeletonStatCard /><SkeletonStatCard /></div>
        ) : !detail ? (
          <EmptyState icon={null} title={t('bar.tabNotFound', 'Comanda não encontrada')} />
        ) : (
          <div style={{ maxWidth: 560 }}>
            <BarTabPanel
              detail={detail}
              canAdmin={hasPermission('bar.admin')}
              cashboxBlocked={cashboxBlocked}
              onChanged={setDetail}
              onClosed={() => load()}
            />
          </div>
        )}
      </main>
    </div>
  );
};

export default BarTabDetail;
