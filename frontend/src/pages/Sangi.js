import React, { useEffect, useState, useCallback } from 'react';
import Sidebar from '../components/Sidebar';
import PlayerSelect from '../components/PlayerSelect';
import api from '../config/api';
import { usePermissions } from '../contexts/PermissionContext';
import { useToast } from '../contexts/ToastContext';
import './Sangi.css';

const fmt = (v) =>
  (parseFloat(v) || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const Sangi = () => {
  const { isAdmin, permissions } = usePermissions();
  const { toast, confirm } = useToast();

  const isManager = isAdmin
    || ['cashier', 'general_cash', 'cashbox.admin', 'employees'].some((p) => (permissions || []).includes(p));

  return (
    <div className="app-layout">
      <Sidebar />
      <main className="main-content sangi-page">
        <h1 className="sangi-title">Sangi — Venda de Fichas em Consignação</h1>
        {isManager ? <ManagerView toast={toast} confirm={confirm} /> : <SellerView toast={toast} />}
      </main>
    </div>
  );
};

// ── Seller (the sangi): sees own consignment + registers sales ───────────────
const SellerView = ({ toast }) => {
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
      toast.error('Informe o valor e o comprador.');
      return;
    }
    try {
      setSaving(true);
      await api.post(`/sangi/consignments/${cons.id}/sales`, {
        amount: parseFloat(amount),
        buyer_player_id: buyer,
      });
      toast.success('Venda registrada!');
      setAmount('');
      setBuyer('');
      await load();
    } catch (err) {
      toast.error(err.userMessage || err.response?.data?.detail || 'Erro ao registrar venda');
    } finally {
      setSaving(false);
    }
  };

  if (loading) return <div className="sangi-loading">Carregando…</div>;
  if (!cons) {
    return (
      <div className="sangi-empty">
        <h3>Nenhuma consignação aberta</h3>
        <p>Peça ao caixa para liberar um valor em fichas para você.</p>
      </div>
    );
  }

  return (
    <>
      <div className="sangi-stats">
        <div className="sangi-stat"><span>Liberado</span><strong>R$ {fmt(cons.released_amount)}</strong></div>
        <div className="sangi-stat"><span>Vendido</span><strong>R$ {fmt(cons.total_sold)}</strong></div>
        <div className="sangi-stat"><span>Em fichas (restante)</span><strong>R$ {fmt(cons.remaining)}</strong></div>
      </div>

      <form className="sangi-card" onSubmit={registerSale}>
        <h3>Registrar venda</h3>
        <div className="sangi-form-row">
          <div className="sangi-field">
            <label>Valor (R$)</label>
            <input type="number" min="0" step="0.01" value={amount}
              onChange={(e) => setAmount(e.target.value)} placeholder="0.00" required />
          </div>
          <div className="sangi-field">
            <label>Comprador (jogador)</label>
            <PlayerSelect value={buyer} onChange={(e) => setBuyer(e.target.value)} required />
          </div>
          <button type="submit" className="sangi-btn" disabled={saving}>
            {saving ? 'Salvando…' : 'Registrar'}
          </button>
        </div>
      </form>

      <SalesTable sales={cons.sales} />
    </>
  );
};

// ── Manager (cashier): release + reconcile ───────────────────────────────────
const ManagerView = ({ toast, confirm }) => {
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
      toast.error('Erro ao carregar consignações');
    } finally {
      setLoading(false);
    }
  }, [toast]);

  useEffect(() => { load(); }, [load]);

  const release = async (e) => {
    e.preventDefault();
    if (!sangiId || !releaseAmount) {
      toast.error('Selecione a sangi e informe o valor.');
      return;
    }
    try {
      setSaving(true);
      await api.post('/sangi/consignments', {
        sangi_staff_id: sangiId,
        released_amount: parseFloat(releaseAmount),
      });
      toast.success('Valor liberado para a sangi!');
      setSangiId('');
      setReleaseAmount('');
      await load();
    } catch (err) {
      toast.error(err.userMessage || err.response?.data?.detail || 'Erro ao liberar');
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
      toast.error('Erro ao abrir consignação');
    }
  };

  const reconcile = async (id) => {
    const ok = await confirm('Fazer o abate desta consignação? Isso fecha o ciclo e calcula a divergência.', { confirmText: 'Abater' });
    if (!ok) return;
    try {
      const res = await api.post(`/sangi/consignments/${id}/reconcile`, {});
      const div = res.data.divergence;
      if (Math.abs(div) < 0.001) toast.success('Abate concluído — sem divergência.');
      else toast.warning(`Abate concluído — divergência de R$ ${fmt(div)}.`);
      setExpanded(res.data);
      await load();
    } catch (err) {
      toast.error(err.userMessage || err.response?.data?.detail || 'Erro no abate');
    }
  };

  if (loading) return <div className="sangi-loading">Carregando…</div>;

  return (
    <>
      <form className="sangi-card" onSubmit={release}>
        <h3>Liberar fichas para uma sangi</h3>
        <div className="sangi-form-row">
          <div className="sangi-field">
            <label>Sangi</label>
            <select value={sangiId} onChange={(e) => setSangiId(e.target.value)} required>
              <option value="">Selecione…</option>
              {staff.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}{s.permission_group_name ? ` — ${s.permission_group_name}` : ''}
                </option>
              ))}
            </select>
          </div>
          <div className="sangi-field">
            <label>Valor em fichas (R$)</label>
            <input type="number" min="0" step="0.01" value={releaseAmount}
              onChange={(e) => setReleaseAmount(e.target.value)} placeholder="Ex: 10000.00" required />
          </div>
          <button type="submit" className="sangi-btn" disabled={saving}>
            {saving ? 'Liberando…' : 'Liberar'}
          </button>
        </div>
      </form>

      <h3 className="sangi-section">Consignações</h3>
      {list.length === 0 ? (
        <div className="sangi-empty"><p>Nenhuma consignação registrada nesta etapa.</p></div>
      ) : (
        <table className="sangi-table">
          <thead>
            <tr>
              <th>Sangi</th><th>Liberado</th><th>Vendido</th><th>Restante</th>
              <th>Status</th><th>Divergência</th><th></th>
            </tr>
          </thead>
          <tbody>
            {list.map((c) => (
              <React.Fragment key={c.id}>
                <tr>
                  <td>{c.sangi_name || '—'}</td>
                  <td>R$ {fmt(c.released_amount)}</td>
                  <td>R$ {fmt(c.total_sold)}</td>
                  <td>R$ {fmt(c.remaining)}</td>
                  <td>
                    <span className={`sangi-badge ${c.status}`}>
                      {c.status === 'open' ? 'Aberta' : 'Reconciliada'}
                    </span>
                  </td>
                  <td>{c.divergence == null ? '—' : `R$ ${fmt(c.divergence)}`}</td>
                  <td className="sangi-actions">
                    <button className="sangi-link" onClick={() => openDetail(c.id)}>
                      {expanded?.id === c.id ? 'Fechar' : 'Ver vendas'}
                    </button>
                    {c.status === 'open' && (
                      <button className="sangi-link danger" onClick={() => reconcile(c.id)}>Abater</button>
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
  if (!sales || sales.length === 0) return <p className="sangi-muted">Nenhuma venda registrada ainda.</p>;
  return (
    <table className="sangi-table compact">
      <thead>
        <tr><th>Comprador</th><th>Valor</th><th>Quando</th></tr>
      </thead>
      <tbody>
        {sales.map((s) => (
          <tr key={s.id}>
            <td>{s.buyer_player_name || s.buyer_player_id}</td>
            <td>R$ {fmt(s.amount)}</td>
            <td>{new Date(s.created_at).toLocaleString('pt-BR')}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
};

export default Sangi;
