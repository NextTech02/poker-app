import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import Sidebar from '../components/Sidebar';
import Card from '../components/Card';
import Button from '../components/Button';
import EmptyState from '../components/EmptyState';
import CashboxAdminPanel from '../components/CashboxAdminPanel';
import CashboxDemonstrativo from '../components/CashboxDemonstrativo';
import { SkeletonStatCard } from '../components/SkeletonLoader';
import api from '../config/api';
import { useToast } from '../contexts/ToastContext';
import { useCurrency } from '../contexts/CurrencyContext';
import { usePaymentMethods } from '../contexts/PaymentMethodsContext';
import PaymentMethodsManager from '../components/PaymentMethodsManager';
import BuyTypesManager from '../components/BuyTypesManager';
import ExpensesManager from '../components/ExpensesManager';
import RevenuesManager from '../components/RevenuesManager';
import './Financeiro.css';

const Financeiro = () => {
  const { toast } = useToast();
  const { t } = useTranslation();
  const { currency, setCurrency, currencies, formatCurrency } = useCurrency();
  const { labelFor: paymentLabelFor } = usePaymentMethods();
  const fmt = formatCurrency;

  const [tab, setTab] = useState('dre'); // 'dre' | 'caixas'
  const [data, setData] = useState(null);
  const [stages, setStages] = useState([]);
  const [tournaments, setTournaments] = useState([]);
  const [loading, setLoading] = useState(true);

  const [filters, setFilters] = useState({
    stage_id: '',
    tournament_id: '',
    start: new Date(new Date().setDate(1)).toISOString().split('T')[0],
    end: new Date().toISOString().split('T')[0],
  });

  // Extract filters
  const [txFilter, setTxFilter] = useState({ type: '', payment_source: '' });

  useEffect(() => {
    loadStages();
    loadTournaments();
  }, []);

  const loadTournaments = async () => {
    try {
      const res = await api.get('/tournaments');
      setTournaments(res.data || []);
    } catch (err) {
      console.error('Error loading tournaments:', err);
    }
  };

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
      if (filters.tournament_id) params.tournament_id = filters.tournament_id;
      if (filters.start) params.start = filters.start;
      if (filters.end) params.end = filters.end;
      const res = await api.get('/reports/financial', { params });
      setData(res.data);
    } catch (err) {
      toast.error(t('financial.loadDataError'));
    } finally {
      setLoading(false);
    }
  };

  const handleFilter = () => {
    loadData();
  };

  const getTypeLabel = (type) => {
    const map = { buy_in: t('financial.typeBuyIn'), rebuy: t('financial.typeRebuy'), addon: t('financial.typeAddon'), prize: t('financial.typePrize') };
    return map[type] || type;
  };

  const getPaymentLabel = (value) => {
    const map = {
      // Forma de pagamento (payment_method)
      cash: t('financial.paymentCash'),
      pix: t('financial.paymentPix', 'PIX'),
      card: t('financial.paymentCard', 'Cartão'),
      transfer: t('financial.paymentTransfer', 'Transferência'),
      // Origem do pagamento (payment_source)
      credit: t('financial.paymentCredit'),
      mixed: t('financial.paymentMixed'),
      ticket: t('financial.paymentTicket'),
    };
    return map[value] || value || '--';
  };

  // Mostra a forma de pagamento real (PIX/Cartão/Transferência). Quando o método
  // é "dinheiro" ou ausente (registros antigos), cai para a origem (crédito/misto/
  // ticket/dinheiro), preservando o comportamento anterior.
  // Resolve um código para rótulo. Códigos embutidos (cash/pix/card/transfer e
  // credit/mixed/ticket) usam i18n (traduzem com o idioma); os personalizados
  // usam o rótulo salvo em payment_methods; por fim, o próprio código.
  const BUILTIN_CODES = new Set(['cash', 'pix', 'card', 'transfer', 'credit', 'mixed', 'ticket']);
  const resolveLabel = (code) => {
    if (!code) return '--';
    if (BUILTIN_CODES.has(code)) return getPaymentLabel(code);
    return paymentLabelFor(code) || code;
  };

  const getPaymentDisplay = (tx) => {
    const method = tx.payment_method;
    if (method && method !== 'cash') return resolveLabel(method);
    return resolveLabel(tx.payment_source);
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
              <h1 className="cx-title">{t('financial.title')}</h1>
              <p className="cx-subtitle">{t('financial.subtitle')}</p>
            </div>
          </div>
          <div className="fn-currency-setting">
            <label htmlFor="fn-currency">{t('financial.currency', 'Moeda do sistema')}</label>
            <select
              id="fn-currency"
              value={currency}
              onChange={(e) => setCurrency(e.target.value)}
              className="fn-currency-select"
            >
              {Object.values(currencies).map((c) => (
                <option key={c.code} value={c.code}>{c.name}</option>
              ))}
            </select>
          </div>
        </div>

        {/* Sub-abas */}
        <div className="fn-tabs">
          <button
            type="button"
            className={`fn-tab ${tab === 'dre' ? 'fn-tab--active' : ''}`}
            onClick={() => setTab('dre')}
          >
            {t('cashbox.tabDre')}
          </button>
          <button
            type="button"
            className={`fn-tab ${tab === 'caixas' ? 'fn-tab--active' : ''}`}
            onClick={() => setTab('caixas')}
          >
            {t('cashbox.tabCashboxes')}
          </button>
          <button
            type="button"
            className={`fn-tab ${tab === 'demonstrativo' ? 'fn-tab--active' : ''}`}
            onClick={() => setTab('demonstrativo')}
          >
            {t('cashbox.tabDemonstrativo')}
          </button>
          <button
            type="button"
            className={`fn-tab ${tab === 'despesas' ? 'fn-tab--active' : ''}`}
            onClick={() => setTab('despesas')}
          >
            {t('financial.expensesTab', 'Despesas')}
          </button>
          <button
            type="button"
            className={`fn-tab ${tab === 'receitas' ? 'fn-tab--active' : ''}`}
            onClick={() => setTab('receitas')}
          >
            {t('financial.revenuesTab', 'Outras receitas')}
          </button>
          <button
            type="button"
            className={`fn-tab ${tab === 'metodos' ? 'fn-tab--active' : ''}`}
            onClick={() => setTab('metodos')}
          >
            {t('financial.paymentMethodsTab', 'Métodos de Pagamento')}
          </button>
          <button
            type="button"
            className={`fn-tab ${tab === 'buytypes' ? 'fn-tab--active' : ''}`}
            onClick={() => setTab('buytypes')}
          >
            {t('financial.buyTypesTab', 'Tipos de Buy')}
          </button>
        </div>

        {tab === 'caixas' && <CashboxAdminPanel />}

        {tab === 'demonstrativo' && <CashboxDemonstrativo />}

        {tab === 'despesas' && <ExpensesManager />}

        {tab === 'receitas' && <RevenuesManager />}

        {tab === 'metodos' && <PaymentMethodsManager />}

        {tab === 'buytypes' && <BuyTypesManager />}

        {tab === 'dre' && (
        <>
        {/* Filters */}
        <Card className="fn-filters-card">
          <div className="fn-filters">
            <div className="form-group">
              <label>{t('financial.filterStage')}</label>
              <select value={filters.stage_id} onChange={(e) => setFilters(p => ({ ...p, stage_id: e.target.value, tournament_id: '' }))}>
                <option value="">{t('financial.filterAllStages')}</option>
                {stages.map(s => (
                  <option key={s.id} value={s.id}>{s.name}</option>
                ))}
              </select>
            </div>
            <div className="form-group">
              <label>{t('financial.filterTournament', 'Torneio')}</label>
              <select value={filters.tournament_id} onChange={(e) => setFilters(p => ({ ...p, tournament_id: e.target.value }))}>
                <option value="">{t('financial.filterAllTournaments', 'Todos os torneios')}</option>
                {tournaments
                  .filter(tr => !filters.stage_id || tr.stage_id === filters.stage_id)
                  .map(tr => (
                    <option key={tr.id} value={tr.id}>{tr.name}</option>
                  ))}
              </select>
            </div>
            <div className="form-group">
              <label>{t('financial.filterStart')}</label>
              <input type="date" value={filters.start} onChange={(e) => setFilters(p => ({ ...p, start: e.target.value }))} />
            </div>
            <div className="form-group">
              <label>{t('financial.filterEnd')}</label>
              <input type="date" value={filters.end} onChange={(e) => setFilters(p => ({ ...p, end: e.target.value }))} />
            </div>
            <div className="fn-filter-actions">
              <Button onClick={handleFilter}>{t('common.generate')}</Button>
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
                  <p>{t('financial.grossRevenue')}</p>
                </div>
              </Card>
              <Card className="stat-card">
                <div className="stat-info">
                  <h3 className="fn-stat-prize">{fmt(data.prizes)}</h3>
                  <p>{t('financial.prizesPaid')}</p>
                </div>
              </Card>
              <Card className="stat-card">
                <div className="stat-info">
                  <h3 className="fn-stat-result">{fmt(data.operational_result)}</h3>
                  <p>{t('financial.operationalResult')}</p>
                </div>
              </Card>
              <Card className="stat-card">
                <div className="stat-info">
                  <h3 className="fn-stat-expense">{fmt(data.expenses || 0)}</h3>
                  <p>{t('financial.expensesTotal', 'Despesas')}</p>
                </div>
              </Card>
              <Card className="stat-card">
                <div className="stat-info">
                  <h3 className={(data.net_result || 0) >= 0 ? 'fn-dre-positive' : 'fn-dre-negative'}>
                    {fmt(data.net_result)}
                  </h3>
                  <p>{t('financial.netResult', 'Resultado líquido')}</p>
                </div>
              </Card>
              <Card className="stat-card">
                <div className="stat-info">
                  <h3 className="fn-stat-rake">{fmt(data.rake)}</h3>
                  <p>{t('financial.accumulatedRake')}</p>
                </div>
              </Card>
              <Card className="stat-card">
                <div className="stat-info">
                  <h3 className="fn-stat-credits">{fmt(data.pending_credits)}</h3>
                  <p>{t('financial.pendingCredits')}</p>
                </div>
              </Card>
              <Card className="stat-card">
                <div className="stat-info">
                  <h3>{data.available_tickets}</h3>
                  <p>{t('financial.availableTickets')}</p>
                </div>
              </Card>
            </>
          ) : null}
        </div>

        {/* DRE */}
        {!loading && data && (
          <Card title={t('financial.incomeStatementTitle')} className="fn-dre-card">
            <div className="fn-dre">
              <div className="fn-dre-section">
                <div className="fn-dre-title">{t('financial.dreRevenues')}</div>
                <div className="fn-dre-row">
                  <span>{t('financial.dreBuyIns')}</span>
                  <span>{fmt(data.revenue?.buy_ins)}</span>
                </div>
                <div className="fn-dre-row">
                  <span>{t('financial.dreRebuys')}</span>
                  <span>{fmt(data.revenue?.rebuys)}</span>
                </div>
                <div className="fn-dre-row">
                  <span>{t('financial.dreAddons')}</span>
                  <span>{fmt(data.revenue?.addons)}</span>
                </div>
                {data.tickets_redeemed_value > 0 && (
                  <div className="fn-dre-row fn-dre-row--muted">
                    <span>{t('financial.dreTicketsRedeemed')}</span>
                    <span>{fmt(data.tickets_redeemed_value)}</span>
                  </div>
                )}
                <div className="fn-dre-row fn-dre-row--total">
                  <span>{t('financial.dreGrossRevenue')}</span>
                  <span>{fmt(data.gross_revenue)}</span>
                </div>
              </div>

              <div className="fn-dre-section">
                <div className="fn-dre-title">{t('financial.dreDeductions')}</div>
                <div className="fn-dre-row">
                  <span>{t('financial.drePrize')}</span>
                  <span className="fn-dre-negative">{fmt(data.prizes)}</span>
                </div>
                <div className="fn-dre-row fn-dre-row--total">
                  <span>{t('financial.dreOperationalResult')}</span>
                  <span className={data.operational_result >= 0 ? 'fn-dre-positive' : 'fn-dre-negative'}>
                    {fmt(data.operational_result)}
                  </span>
                </div>
              </div>

              {/* Outras receitas: bar, patrocínio, aluguel — faturamento que
                  não passa pelo caixa de torneio. */}
              {(data.other_revenue || 0) > 0 && (
                <div className="fn-dre-section">
                  <div className="fn-dre-title">{t('financial.dreOtherRevenue', 'Outras receitas')}</div>
                  {(data.other_revenue_by_source || []).map((s) => (
                    <div className="fn-dre-row" key={s.category}>
                      <span>{s.category}</span>
                      <span className="fn-dre-positive">{fmt(s.amount)}</span>
                    </div>
                  ))}
                  <div className="fn-dre-row fn-dre-row--total">
                    <span>{t('financial.dreOtherRevenueTotal', 'Total de outras receitas')}</span>
                    <span className="fn-dre-positive">{fmt(data.other_revenue)}</span>
                  </div>
                  {(data.other_revenue_pending || 0) > 0 && (
                    <div className="fn-dre-row fn-dre-row--muted">
                      <span>{t('financial.dreOtherRevenuePending', 'Sendo a receber')}</span>
                      <span>{fmt(data.other_revenue_pending)}</span>
                    </div>
                  )}
                </div>
              )}

              {/* Despesas da etapa — abertas por categoria. Sem elas o
                  "resultado líquido" era só o operacional. */}
              <div className="fn-dre-section">
                <div className="fn-dre-title">{t('financial.dreExpenses', 'Despesas')}</div>
                {(data.expenses_by_category || []).length === 0 ? (
                  <div className="fn-dre-row fn-dre-row--muted">
                    <span>{t('financial.dreNoExpenses', 'Nenhuma despesa lançada no período')}</span>
                    <span>{fmt(0)}</span>
                  </div>
                ) : (
                  (data.expenses_by_category || []).map((c) => (
                    <div className="fn-dre-row" key={c.category}>
                      <span>{c.category}</span>
                      <span className="fn-dre-negative">{fmt(c.amount)}</span>
                    </div>
                  ))
                )}
                <div className="fn-dre-row fn-dre-row--total">
                  <span>{t('financial.dreExpensesTotal', 'Total de despesas')}</span>
                  <span className="fn-dre-negative">{fmt(data.expenses || 0)}</span>
                </div>
                {(data.expenses_pending || 0) > 0 && (
                  <div className="fn-dre-row fn-dre-row--muted">
                    <span>{t('financial.dreExpensesPending', 'Sendo a pagar')}</span>
                    <span>{fmt(data.expenses_pending)}</span>
                  </div>
                )}
                {/* Informativo: esse aporte sai como prêmio e já está subtraído
                    na linha de premiação. Somar aqui contaria duas vezes. */}
                {(data.guarantee_committed || 0) > 0 && (
                  <div className="fn-dre-row fn-dre-row--muted">
                    <span>{t('financial.dreGuarantee', 'Garantia aportada pela casa (já na premiação)')}</span>
                    <span>{fmt(data.guarantee_committed)}</span>
                  </div>
                )}
              </div>

              <div className="fn-dre-section">
                <div className="fn-dre-title">{t('financial.dreRake')}</div>
                <div className="fn-dre-row">
                  <span>{t('financial.dreRakeAccumulated')}</span>
                  <span>{fmt(data.rake)}</span>
                </div>
                <div className="fn-dre-row fn-dre-row--highlight">
                  <span>{t('financial.dreNetResult')}</span>
                  <span className={data.net_result >= 0 ? 'fn-dre-positive' : 'fn-dre-negative'}>
                    {fmt(data.net_result)}
                  </span>
                </div>
              </div>
            </div>
          </Card>
        )}

        {/* Per-Tournament Breakdown */}
        {/* Acesso protegido: um relatorio sem `by_tournament` (payload antigo
            ou parcial) derrubava a tela INTEIRA em vez de so omitir o quadro.
            O mesmo vale para `revenue` logo acima. */}
        {!loading && data && (data.by_tournament?.length || 0) > 0 && (
          <Card title={t('financial.byTournamentTitle')}>
            <div className="table-container">
              <table className="transactions-table">
                <thead>
                  <tr>
                    <th>{t('financial.colTournament')}</th>
                    <th>{t('financial.colPlayers')}</th>
                    <th>{t('financial.colBuyIns')}</th>
                    <th>{t('financial.colRebuys')}</th>
                    <th>{t('financial.colAddons')}</th>
                    <th>{t('financial.colRevenue')}</th>
                    <th>{t('financial.colPrize')}</th>
                    <th>{t('financial.colNet')}</th>
                  </tr>
                </thead>
                <tbody>
                  {(data.by_tournament || []).map((t) => (
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
          <Card title={t('financial.generalStatementTitle')}>
            {/* Inline filters */}
            <div className="fn-tx-filters">
              <div className="form-group">
                <label>{t('financial.filterTypeLabel')}</label>
                <select value={txFilter.type} onChange={(e) => setTxFilter(p => ({ ...p, type: e.target.value }))}>
                  <option value="">{t('financial.filterAllTypes')}</option>
                  <option value="buy_in">{t('financial.optBuyIn')}</option>
                  <option value="rebuy">{t('financial.optRebuy')}</option>
                  <option value="addon">{t('financial.optAddon')}</option>
                  <option value="prize">{t('financial.optPrize')}</option>
                </select>
              </div>
              <div className="form-group">
                <label>{t('financial.filterPaymentLabel')}</label>
                <select value={txFilter.payment_source} onChange={(e) => setTxFilter(p => ({ ...p, payment_source: e.target.value }))}>
                  <option value="">{t('financial.filterAllPayments')}</option>
                  <option value="cash">{t('financial.payCash')}</option>
                  <option value="credit">{t('financial.payCredit')}</option>
                  <option value="mixed">{t('financial.payMixed')}</option>
                  <option value="ticket">{t('financial.payTicket')}</option>
                </select>
              </div>
            </div>

            {filteredTransactions.length === 0 ? (
              <EmptyState icon={null} title={t('financial.noTransactions')} subtitle={t('financial.noTransactionsHint')} />
            ) : (
              <div className="table-container">
                <table className="transactions-table">
                  <thead>
                    <tr>
                      <th>{t('financial.colDate')}</th>
                      <th>{t('financial.colTournament')}</th>
                      <th>{t('financial.colPlayer')}</th>
                      <th>{t('financial.colType')}</th>
                      <th>{t('financial.colPaymentMethod')}</th>
                      <th>{t('financial.colAmount')}</th>
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
                        <td>{getPaymentDisplay(tx)}</td>
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
