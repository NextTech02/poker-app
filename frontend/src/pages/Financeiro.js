import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import Sidebar from '../components/Sidebar';
import Card from '../components/Card';
import Button from '../components/Button';
import EmptyState from '../components/EmptyState';
import CashboxAdminPanel from '../components/CashboxAdminPanel';
import CashboxDemonstrativo from '../components/CashboxDemonstrativo';
import { SkeletonStatCard, SkeletonTableRow } from '../components/SkeletonLoader';
import api from '../config/api';
import { useToast } from '../contexts/ToastContext';
import './Financeiro.css';

const fmt = (n) =>
  new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(n ?? 0);

const Financeiro = () => {
  const { toast } = useToast();
  const { t } = useTranslation();

  const [tab, setTab] = useState('dre'); // 'dre' | 'caixas'
  const [data, setData] = useState(null);
  const [stages, setStages] = useState([]);
  const [loading, setLoading] = useState(true);

  const [filters, setFilters] = useState({
    stage_id: '',
    start: new Date(new Date().setDate(1)).toISOString().split('T')[0],
    end: new Date().toISOString().split('T')[0],
  });

  // Extract filters
  const [txFilter, setTxFilter] = useState({ type: '', payment_source: '' });

  useEffect(() => {
    loadStages();
  }, []);

  useEffect(() => {
    loadData();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const loadStages = async () => {
    try {
      const res = await api.get('/stages');
      setStages(res.data || []);
    } catch (err) {
      console.error('Error loading stages:', err);
    }
  };

  const loadData = async () => {
    setLoading(true);
    try {
      const params = {};
      if (filters.stage_id) params.stage_id = filters.stage_id;
      if (filters.start) params.start = filters.start;
      if (filters.end) params.end = filters.end;
      const res = await api.get('/reports/financial', { params });
      setData(res.data);
    } catch (err) {
      toast.error('Erro ao carregar dados financeiros');
    } finally {
      setLoading(false);
    }
  };

  const handleFilter = () => {
    loadData();
  };

  const getTypeLabel = (type) => {
    const map = { buy_in: 'Buy-in', rebuy: 'Rebuy', addon: 'Add-on', prize: 'Premiacao' };
    return map[type] || type;
  };

  const getPaymentLabel = (src) => {
    const map = { cash: 'Dinheiro', credit: 'Credito', mixed: 'Misto', ticket: 'Ticket' };
    return map[src] || src || '--';
  };

  const getTypeBadgeClass = (type) => {
    const map = { buy_in: 'fn-badge--buyin', rebuy: 'fn-badge--rebuy', addon: 'fn-badge--addon', prize: 'fn-badge--prize' };
    return map[type] || '';
  };

  // Filter transactions
  const filteredTransactions = (data?.transactions || []).filter(tx => {
    if (txFilter.type && tx.type !== txFilter.type) return false;
    if (txFilter.payment_source && tx.payment_source !== txFilter.payment_source) return false;
    return true;
  });

  return (
    <div className="app-container">
      <Sidebar />
      <main className="main-content">
        {/* Header */}
        <div className="cx-header">
          <div className="cx-header-left">
            <div className="cx-header-icon">
              <svg viewBox="0 0 24 24" fill="currentColor">
                <path d="M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
            </div>
            <div>
              <h1 className="cx-title">Financeiro</h1>
              <p className="cx-subtitle">DRE e fechamento financeiro</p>
            </div>
          </div>
        </div>

        {/* Sub-abas */}
        <div className="fn-tabs">
          <button
            className={`fn-tab ${tab === 'dre' ? 'fn-tab--active' : ''}`}
            onClick={() => setTab('dre')}
          >
            {t('cashbox.tabDre')}
          </button>
          <button
            className={`fn-tab ${tab === 'caixas' ? 'fn-tab--active' : ''}`}
            onClick={() => setTab('caixas')}
          >
            {t('cashbox.tabCashboxes')}
          </button>
          <button
            className={`fn-tab ${tab === 'demonstrativo' ? 'fn-tab--active' : ''}`}
            onClick={() => setTab('demonstrativo')}
          >
            {t('cashbox.tabDemonstrativo')}
          </button>
        </div>

        {tab === 'caixas' && <CashboxAdminPanel />}

        {tab === 'demonstrativo' && <CashboxDemonstrativo />}

        {tab === 'dre' && (
        <>
        {/* Filters */}
        <Card className="fn-filters-card">
          <div className="fn-filters">
            <div className="form-group">
              <label>Etapa</label>
              <select value={filters.stage_id} onChange={(e) => setFilters(p => ({ ...p, stage_id: e.target.value }))}>
                <option value="">Todas</option>
                {stages.map(s => (
                  <option key={s.id} value={s.id}>{s.name}</option>
                ))}
              </select>
            </div>
            <div className="form-group">
              <label>Inicio</label>
              <input type="date" value={filters.start} onChange={(e) => setFilters(p => ({ ...p, start: e.target.value }))} />
            </div>
            <div className="form-group">
              <label>Fim</label>
              <input type="date" value={filters.end} onChange={(e) => setFilters(p => ({ ...p, end: e.target.value }))} />
            </div>
            <div className="fn-filter-actions">
              <Button onClick={handleFilter}>Gerar</Button>
            </div>
          </div>
        </Card>

        {/* KPI Cards */}
        <div className="stats-grid">
          {loading ? (
            <><SkeletonStatCard /><SkeletonStatCard /><SkeletonStatCard /><SkeletonStatCard /><SkeletonStatCard /><SkeletonStatCard /></>
          ) : data ? (
            <>
              <Card className="stat-card">
                <div className="stat-info">
                  <h3 className="fn-stat-revenue">{fmt(data.gross_revenue)}</h3>
                  <p>Receita Bruta</p>
                </div>
              </Card>
              <Card className="stat-card">
                <div className="stat-info">
                  <h3 className="fn-stat-prize">{fmt(data.prizes)}</h3>
                  <p>Premiacao Paga</p>
                </div>
              </Card>
              <Card className="stat-card">
                <div className="stat-info">
                  <h3 className="fn-stat-result">{fmt(data.operational_result)}</h3>
                  <p>Resultado Operacional</p>
                </div>
              </Card>
              <Card className="stat-card">
                <div className="stat-info">
                  <h3 className="fn-stat-rake">{fmt(data.rake)}</h3>
                  <p>Rake Acumulado</p>
                </div>
              </Card>
              <Card className="stat-card">
                <div className="stat-info">
                  <h3 className="fn-stat-credits">{fmt(data.pending_credits)}</h3>
                  <p>Creditos Pendentes</p>
                </div>
              </Card>
              <Card className="stat-card">
                <div className="stat-info">
                  <h3>{data.available_tickets}</h3>
                  <p>Tickets Disponiveis</p>
                </div>
              </Card>
            </>
          ) : null}
        </div>

        {/* DRE */}
        {!loading && data && (
          <Card title="Demonstrativo de Resultados" className="fn-dre-card">
            <div className="fn-dre">
              <div className="fn-dre-section">
                <div className="fn-dre-title">RECEITAS</div>
                <div className="fn-dre-row">
                  <span>Buy-ins</span>
                  <span>{fmt(data.revenue.buy_ins)}</span>
                </div>
                <div className="fn-dre-row">
                  <span>Rebuys</span>
                  <span>{fmt(data.revenue.rebuys)}</span>
                </div>
                <div className="fn-dre-row">
                  <span>Add-ons</span>
                  <span>{fmt(data.revenue.addons)}</span>
                </div>
                {data.tickets_redeemed_value > 0 && (
                  <div className="fn-dre-row fn-dre-row--muted">
                    <span>(-) Tickets resgatados</span>
                    <span>{fmt(data.tickets_redeemed_value)}</span>
                  </div>
                )}
                <div className="fn-dre-row fn-dre-row--total">
                  <span>= RECEITA BRUTA</span>
                  <span>{fmt(data.gross_revenue)}</span>
                </div>
              </div>

              <div className="fn-dre-section">
                <div className="fn-dre-title">DEDUCOES</div>
                <div className="fn-dre-row">
                  <span>Premiacao</span>
                  <span className="fn-dre-negative">{fmt(data.prizes)}</span>
                </div>
                <div className="fn-dre-row fn-dre-row--total">
                  <span>= RESULTADO OPERACIONAL</span>
                  <span className={data.operational_result >= 0 ? 'fn-dre-positive' : 'fn-dre-negative'}>
                    {fmt(data.operational_result)}
                  </span>
                </div>
              </div>

              <div className="fn-dre-section">
                <div className="fn-dre-title">RAKE</div>
                <div className="fn-dre-row">
                  <span>Rake acumulado</span>
                  <span>{fmt(data.rake)}</span>
                </div>
                <div className="fn-dre-row fn-dre-row--highlight">
                  <span>= RESULTADO LIQUIDO</span>
                  <span className={data.net_result >= 0 ? 'fn-dre-positive' : 'fn-dre-negative'}>
                    {fmt(data.net_result)}
                  </span>
                </div>
              </div>
            </div>
          </Card>
        )}

        {/* Per-Tournament Breakdown */}
        {!loading && data && data.by_tournament.length > 0 && (
          <Card title="Resumo por Torneio">
            <div className="table-container">
              <table className="transactions-table">
                <thead>
                  <tr>
                    <th>Torneio</th>
                    <th>Jogadores</th>
                    <th>Buy-ins</th>
                    <th>Rebuys</th>
                    <th>Add-ons</th>
                    <th>Receita</th>
                    <th>Premiacao</th>
                    <th>Liquido</th>
                  </tr>
                </thead>
                <tbody>
                  {data.by_tournament.map((t) => (
                    <tr key={t.tournament_id}>
                      <td>{t.tournament_name}</td>
                      <td>{t.players}</td>
                      <td>{t.buy_ins_count}</td>
                      <td>{t.rebuys_count}</td>
                      <td>{t.addons_count}</td>
                      <td>{fmt(t.revenue)}</td>
                      <td>{fmt(t.prizes)}</td>
                      <td className={t.net >= 0 ? 'fn-positive' : 'fn-negative'}>{fmt(t.net)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
        )}

        {/* Extrato Geral */}
        {!loading && data && (
          <Card title="Extrato Geral">
            {/* Inline filters */}
            <div className="fn-tx-filters">
              <div className="form-group">
                <label>Tipo</label>
                <select value={txFilter.type} onChange={(e) => setTxFilter(p => ({ ...p, type: e.target.value }))}>
                  <option value="">Todos</option>
                  <option value="buy_in">Buy-in</option>
                  <option value="rebuy">Rebuy</option>
                  <option value="addon">Add-on</option>
                  <option value="prize">Premiacao</option>
                </select>
              </div>
              <div className="form-group">
                <label>Forma Pgto</label>
                <select value={txFilter.payment_source} onChange={(e) => setTxFilter(p => ({ ...p, payment_source: e.target.value }))}>
                  <option value="">Todas</option>
                  <option value="cash">Dinheiro</option>
                  <option value="credit">Credito</option>
                  <option value="mixed">Misto</option>
                  <option value="ticket">Ticket</option>
                </select>
              </div>
            </div>

            {filteredTransactions.length === 0 ? (
              <EmptyState icon={null} title="Nenhuma transacao" subtitle="Nenhuma transacao encontrada com os filtros selecionados" />
            ) : (
              <div className="table-container">
                <table className="transactions-table">
                  <thead>
                    <tr>
                      <th>Data</th>
                      <th>Torneio</th>
                      <th>Jogador</th>
                      <th>Tipo</th>
                      <th>Forma Pgto</th>
                      <th>Valor</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filteredTransactions.map((tx) => (
                      <tr key={tx.id}>
                        <td>{new Date(tx.created_at).toLocaleDateString('pt-BR')}</td>
                        <td>{tx.tournament_name || '--'}</td>
                        <td>{tx.player_name || '--'}</td>
                        <td>
                          <span className={`fn-badge ${getTypeBadgeClass(tx.type)}`}>
                            {getTypeLabel(tx.type)}
                          </span>
                        </td>
                        <td>{getPaymentLabel(tx.payment_source)}</td>
                        <td className={tx.type === 'prize' ? 'fn-negative' : ''}>{fmt(tx.amount)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>
        )}
        </>
        )}
      </main>
    </div>
  );
};

export default Financeiro;
