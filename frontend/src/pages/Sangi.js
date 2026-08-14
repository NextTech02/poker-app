import React, { useEffect, useState, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import Sidebar from '../components/Sidebar';
import PlayerSelect from '../components/PlayerSelect';
import api from '../config/api';
import { usePermissions } from '../contexts/PermissionContext';
import { useToast } from '../contexts/ToastContext';
import { useCurrency } from '../contexts/CurrencyContext';
import './Sangi.css';

const Sangi = () => {
  const { t } = useTranslation();
  const { isAdmin, permissions } = usePermissions();
  const { toast, confirm } = useToast();

  const isManager = isAdmin
    || ['cashier', 'general_cash', 'cashbox.admin', 'employees'].some((p) => (permissions || []).includes(p));

  return (
    <div className="app-layout">
      <Sidebar />
      <main className="main-content sangi-page">
        <h1 className="sangi-title">{t('sangi.pageTitle')}</h1>
        {isManager ? <ManagerView toast={toast} confirm={confirm} /> : <SellerView toast={toast} />}
      </main>
    </div>
  );
};

// ── Seller (the sangi): sees own consignment + registers sales ───────────────
const SellerView = ({ toast }) => {
  const { t } = useTranslation();
  const { formatCurrency } = useCurrency();
  const [cons, setCons] = useState(null);
  const [loading, setLoading] = useState(true);
  const [amount, setAmount] = useState('');
  const [buyer, setBuyer] = useState('');
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    try {
      setLoading(true);
      const res = await api.get('/sangi/me');
      setCons(res.data || null);
    } catch (err) {
      // ignore
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const registerSale = async (e) => {
    e.preventDefault();
    if (!cons) return;
    if (!amount || !buyer) {
      toast.error(t('sangi.errorAmountBuyer'));
      return;
    }
    try {
      setSaving(true);
      await api.post(`/sangi/consignments/${cons.id}/sales`, {
        amount: parseFloat(amount),
        buyer_player_id: buyer,
      });
      toast.success(t('sangi.saleRegistered'));
      setAmount('');
      setBuyer('');
      await load();
    } catch (err) {
      toast.error(err.userMessage || err.response?.data?.detail || t('sangi.errorRegisterSale'));
    } finally {
      setSaving(false);
    }
  };

  if (loading) return <div className="sangi-loading">{t('common.loading')}</div>;
  if (!cons) {
    return (
      <div className="sangi-empty">
        <h3>{t('sangi.noConsignmentOpen')}</h3>
        <p>{t('sangi.noConsignmentHint')}</p>
      </div>
    );
  }

  return (
    <>
      <div className="sangi-stats">
        <div className="sangi-stat"><span>{t('sangi.released')}</span><strong>{formatCurrency(cons.released_amount)}</strong></div>
        <div className="sangi-stat"><span>{t('sangi.sold')}</span><strong>{formatCurrency(cons.total_sold)}</strong></div>
        <div className="sangi-stat"><span>{t('sangi.remainingInChips')}</span><strong>{formatCurrency(cons.remaining)}</strong></div>
      </div>

      <form className="sangi-card" onSubmit={registerSale}>
        <h3>{t('sangi.registerSale')}</h3>
        <div className="sangi-form-row">
          <div className="sangi-field">
            <label>{t('sangi.amountLabel')}</label>
            <input type="number" min="0" step="0.01" value={amount}
              onChange={(e) => setAmount(e.target.value)} placeholder="0.00" required />
          </div>
          <div className="sangi-field">
            <label>{t('sangi.buyerLabel')}</label>
            <PlayerSelect value={buyer} onChange={(e) => setBuyer(e.target.value)} required />
          </div>
          <button type="submit" className="sangi-btn" disabled={saving}>
            {saving ? t('sangi.saving') : t('sangi.registerBtn')}
          </button>
        </div>
      </form>

      <SalesTable sales={cons.sales} />
    </>
  );
};

// ── Manager (cashier): release + reconcile ───────────────────────────────────
const ManagerView = ({ toast, confirm }) => {
  const { t } = useTranslation();
  const { formatCurrency } = useCurrency();
  const [staff, setStaff] = useState([]);
  const [list, setList] = useState([]);
  const [loading, setLoading] = useState(true);
  const [sangiId, setSangiId] = useState('');
  const [releaseAmount, setReleaseAmount] = useState('');
  const [saving, setSaving] = useState(false);
  const [expanded, setExpanded] = useState(null);

  const load = useCallback(async () => {
    try {
      setLoading(true);
      const [staffRes, listRes] = await Promise.all([
        api.get('/staff'),
        api.get('/sangi/consignments'),
      ]);
      // Only staff classified as "sangi" (sellers) can receive chip consignments.
      // Excludes Caixa / other roles — a sangi is distinct from the cashbox.
      setStaff((staffRes.data || []).filter((s) => s.active && (s.permissions || []).includes('sangi')));
      setList(listRes.data || []);
    } catch (err) {
      toast.error(t('sangi.errorLoadConsignments'));
    } finally {
      setLoading(false);
    }
  }, [toast, t]);

  useEffect(() => { load(); }, [load]);

  const release = async (e) => {
    e.preventDefault();
    if (!sangiId || !releaseAmount) {
      toast.error(t('sangi.errorSelectSangi'));
      return;
    }
    try {
      setSaving(true);
      await api.post('/sangi/consignments', {
        sangi_staff_id: sangiId,
        released_amount: parseFloat(releaseAmount),
      });
      toast.success(t('sangi.valueReleased'));
      setSangiId('');
      setReleaseAmount('');
      await load();
    } catch (err) {
      toast.error(err.userMessage || err.response?.data?.detail || t('sangi.errorRelease'));
    } finally {
      setSaving(false);
    }
  };

  const openDetail = async (id) => {
    if (expanded?.id === id) { setExpanded(null); return; }
    try {
      const res = await api.get(`/sangi/consignments/${id}`);
      setExpanded(res.data);
    } catch (err) {
      toast.error(t('sangi.errorOpenConsignment'));
    }
  };

  const reconcile = async (id) => {
    const ok = await confirm(t('sangi.confirmReconcile'), { confirmText: t('sangi.confirmReconcileBtn') });
    if (!ok) return;
    try {
      const res = await api.post(`/sangi/consignments/${id}/reconcile`, {});
      const div = res.data.divergence;
      if (Math.abs(div) < 0.001) toast.success(t('sangi.reconcileSuccess'));
      else toast.warning(t('sangi.reconcileDivergence', { value: formatCurrency(div) }));
      setExpanded(res.data);
      await load();
    } catch (err) {
      toast.error(err.userMessage || err.response?.data?.detail || t('sangi.errorReconcile'));
    }
  };

  if (loading) return <div className="sangi-loading">{t('common.loading')}</div>;

  return (
    <>
      <form className="sangi-card" onSubmit={release}>
        <h3>{t('sangi.releaseChipsTitle')}</h3>
        <div className="sangi-form-row">
          <div className="sangi-field">
            <label>{t('sangi.sangiLabel')}</label>
            <select value={sangiId} onChange={(e) => setSangiId(e.target.value)} required>
              <option value="">{t('sangi.selectPlaceholder')}</option>
              {staff.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}{s.permission_group_name ? ` — ${s.permission_group_name}` : ''}
                </option>
              ))}
            </select>
          </div>
          <div className="sangi-field">
            <label>{t('sangi.chipsAmountLabel')}</label>
            <input type="number" min="0" step="0.01" value={releaseAmount}
              onChange={(e) => setReleaseAmount(e.target.value)} placeholder={t('sangi.chipsAmountPlaceholder')} required />
          </div>
          <button type="submit" className="sangi-btn" disabled={saving}>
            {saving ? t('sangi.releasing') : t('sangi.releaseBtn')}
          </button>
        </div>
      </form>

      <h3 className="sangi-section">{t('sangi.consignmentsSection')}</h3>
      {list.length === 0 ? (
        <div className="sangi-empty"><p>{t('sangi.noConsignmentsInStage')}</p></div>
      ) : (
        <table className="sangi-table">
          <thead>
            <tr>
              <th>{t('sangi.colSangi')}</th><th>{t('sangi.colReleased')}</th><th>{t('sangi.colSold')}</th><th>{t('sangi.colRemaining')}</th>
              <th>{t('sangi.colStatus')}</th><th>{t('sangi.colDivergence')}</th><th></th>
            </tr>
          </thead>
          <tbody>
            {list.map((c) => (
              <React.Fragment key={c.id}>
                <tr>
                  <td>{c.sangi_name || '—'}</td>
                  <td>{formatCurrency(c.released_amount)}</td>
                  <td>{formatCurrency(c.total_sold)}</td>
                  <td>{formatCurrency(c.remaining)}</td>
                  <td>
                    <span className={`sangi-badge ${c.status}`}>
                      {c.status === 'open' ? t('sangi.statusOpen') : t('sangi.statusReconciled')}
                    </span>
                  </td>
                  <td>{c.divergence == null ? '—' : formatCurrency(c.divergence)}</td>
                  <td className="sangi-actions">
                    <button className="sangi-link" onClick={() => openDetail(c.id)}>
                      {expanded?.id === c.id ? t('sangi.closeDetail') : t('sangi.viewSales')}
                    </button>
                    {c.status === 'open' && (
                      <button className="sangi-link danger" onClick={() => reconcile(c.id)}>{t('sangi.reconcileAction')}</button>
                    )}
                  </td>
                </tr>
                {expanded?.id === c.id && (
                  <tr className="sangi-detail-row">
                    <td colSpan={7}>
                      <SalesTable sales={expanded.sales} />
                    </td>
                  </tr>
                )}
              </React.Fragment>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
};

const SalesTable = ({ sales }) => {
  const { t } = useTranslation();
  const { formatCurrency } = useCurrency();
  if (!sales || sales.length === 0) return <p className="sangi-muted">{t('sangi.noSalesYet')}</p>;
  return (
    <table className="sangi-table compact">
      <thead>
        <tr><th>{t('sangi.colBuyer')}</th><th>{t('sangi.colValue')}</th><th>{t('sangi.colWhen')}</th></tr>
      </thead>
      <tbody>
        {sales.map((s) => (
          <tr key={s.id}>
            <td>{s.buyer_player_name || s.buyer_player_id}</td>
            <td>{formatCurrency(s.amount)}</td>
            <td>{new Date(s.created_at).toLocaleString('pt-BR')}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
};

export default Sangi;
