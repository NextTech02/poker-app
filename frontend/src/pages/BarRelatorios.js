import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import api from '../config/api';
import Sidebar from '../components/Sidebar';
import Card from '../components/Card';
import EmptyState from '../components/EmptyState';
import { SkeletonBlock } from '../components/SkeletonLoader';
import { useToast } from '../contexts/ToastContext';
import { useCurrency } from '../contexts/CurrencyContext';
import { exportSections } from '../utils/reportExport';
import { primeiroDiaDoMes, hojeLocal } from '../utils/datasLocais';
import './CashFloor.css';
import './CashRelatorios.css';
import './Bar.css';

/**
 * FATURAMENTO DO BAR, por período.
 *
 * Três números que a tela não deixa confundir:
 *   VENDAS  = Σ total das comandas FECHADAS (depois do desconto) — a receita;
 *   MARGEM  = vendas − CMV (custo das mercadorias, cortesia inclusa);
 *   RECEBIDO POR FORMA = como o dinheiro entrou (crédito do jogador é cobrado
 *             do patrocinador, não passou pela gaveta).
 */
const BarRelatorios = () => {
  const { t } = useTranslation();
  const { toast } = useToast();
  const { formatCurrency } = useCurrency();

  const [range, setRange] = useState({ from: primeiroDiaDoMes(), to: hojeLocal() });
  const [summary, setSummary] = useState(null);
  const [players, setPlayers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [exporting, setExporting] = useState(false);

  const load = useCallback(async () => {
    const params = { date_from: range.from, date_to: range.to };
    const [s, j] = await Promise.all([
      api.get('/bar/reports/summary', { params, _silentError: true }).catch(() => ({ data: null })),
      api.get('/bar/reports/players', { params, _silentError: true }).catch(() => ({ data: [] })),
    ]);
    setSummary(s.data);
    setPlayers(j.data || []);
    setLoading(false);
  }, [range.from, range.to]);

  useEffect(() => { setLoading(true); load(); }, [load]);

  const daily = useMemo(() => summary?.daily || [], [summary]);
  const melhores = useMemo(() => [...daily].sort((a, b) => b.net - a.net).slice(0, 5), [daily]);
  const maiorNet = melhores[0]?.net || 0;
  const semDados = !loading && (!summary || summary.tabs === 0);

  const exportar = async (formato) => {
    setExporting(true);
    try {
      await exportSections([
        {
          kind: 'keyvalue',
          title: t('barReports.summary', 'Resumo do período'),
          rows: [
            { label: t('bar.netSales', 'Vendas'), value: summary.net, type: 'currency' },
            { label: t('barReports.gross', 'Bruto (antes de descontos)'), value: summary.gross, type: 'currency' },
            { label: t('barReports.discountsAndCourtesy', 'Descontos e cortesias'), value: (summary.discounts || 0) + (summary.courtesy || 0), type: 'currency' },
            { label: t('barReports.cogs', 'Custo das mercadorias (CMV)'), value: summary.cogs, type: 'currency' },
            { label: t('bar.margin', 'Margem'), value: summary.margin, type: 'currency' },
            { label: t('barReports.paidCash', 'Recebido em dinheiro/PIX/cartão'), value: summary.paid_cash, type: 'currency' },
            { label: t('barReports.paidCredit', 'Recebido em crédito do jogador'), value: summary.paid_credit, type: 'currency' },
            { label: t('bar.tabsCount', 'Comandas'), value: summary.tabs, type: 'int' },
            { label: t('barReports.averageTab', 'Ticket médio'), value: summary.average_tab, type: 'currency' },
            { label: t('barReports.shifts', 'Turnos'), value: summary.shifts, type: 'int' },
          ],
        },
        {
          kind: 'table',
          title: t('barReports.byDay', 'Vendas por dia'),
          columns: [
            { key: 'business_date', label: t('bar.businessDate', 'Data'), type: 'date' },
            { key: 'net', label: t('bar.netSales', 'Vendas'), type: 'currency' },
            { key: 'discounts', label: t('bar.discounts', 'Descontos'), type: 'currency' },
            { key: 'courtesy', label: t('bar.courtesy', 'Cortesia'), type: 'currency' },
            { key: 'cogs', label: t('barReports.cogsShort', 'CMV'), type: 'currency' },
            { key: 'margin', label: t('bar.margin', 'Margem'), type: 'currency' },
            { key: 'tabs', label: t('bar.tabsCount', 'Comandas'), type: 'int' },
            { key: 'items', label: t('barReports.items', 'Itens'), type: 'int' },
          ],
          rows: daily,
        },
        {
          kind: 'table',
          title: t('barReports.byProduct', 'Por produto'),
          columns: [
            { key: 'product_name', label: t('bar.product', 'Produto'), type: 'text' },
            { key: 'category_name', label: t('bar.category', 'Categoria'), type: 'text' },
            { key: 'quantity', label: t('bar.quantity', 'Quantidade'), type: 'int' },
            { key: 'courtesy_quantity', label: t('barReports.courtesyQty', 'Cortesias'), type: 'int' },
            { key: 'revenue', label: t('bar.netSales', 'Vendas'), type: 'currency' },
            { key: 'cogs', label: t('barReports.cogsShort', 'CMV'), type: 'currency' },
            { key: 'margin', label: t('bar.margin', 'Margem'), type: 'currency' },
          ],
          rows: summary.top_products || [],
        },
        {
          kind: 'table',
          title: t('barReports.byMethod', 'Por forma de pagamento'),
          columns: [
            { key: 'payment_method', label: t('bar.paymentMethod', 'Forma de pagamento'), type: 'text' },
            { key: 'amount', label: t('bar.amount', 'Valor'), type: 'currency' },
            { key: 'count', label: t('barReports.payments', 'Pagamentos'), type: 'int' },
          ],
          rows: summary.by_method || [],
        },
        {
          kind: 'table',
          title: t('barReports.byPlayer', 'Por jogador'),
          columns: [
            { key: 'player_name', label: t('bar.player', 'Jogador'), type: 'text' },
            { key: 'tabs', label: t('bar.tabsCount', 'Comandas'), type: 'int' },
            { key: 'items', label: t('barReports.items', 'Itens'), type: 'int' },
            { key: 'spent', label: t('barReports.spent', 'Gasto'), type: 'currency' },
          ],
          rows: players,
        },
      ], {
        format: formato,
        filename: `bar-${range.from}-a-${range.to}`,
        meta: {
          title: t('barReports.title', 'Faturamento do bar'),
          subtitle: `${range.from} — ${range.to}`,
        },
        formatCurrency,
      });
    } catch {
      toast.error(t('cashReports.exportError', 'Não foi possível exportar'));
    } finally {
      setExporting(false);
    }
  };

  return (
    <div className="app-container">
      <Sidebar />
      <main className="main-content">
        <div className="page-header">
          <div>
            <h1>{t('barReports.title', 'Faturamento do bar')}</h1>
            <p>
              {t('barReports.subtitle', 'Vendas são as comandas fechadas, depois do desconto. A margem desconta o custo das mercadorias — cortesia inclusa, porque a bebida saiu do estoque.')}
            </p>
          </div>
          <div className="cr-export">
            {['xlsx', 'csv', 'pdf'].map((f) => (
              <button key={f} type="button" className="btn btn-secondary btn-small"
                      onClick={() => exportar(f)} disabled={exporting || semDados}>
                {f.toUpperCase()}
              </button>
            ))}
          </div>
        </div>

        <div className="bar-filters">
          <div className="form-group">
            <label htmlFor="br-from">{t('common.from', 'De')}</label>
            <input id="br-from" type="date" value={range.from}
                   onChange={(e) => setRange({ ...range, from: e.target.value })} />
          </div>
          <div className="form-group">
            <label htmlFor="br-to">{t('common.to', 'Até')}</label>
            <input id="br-to" type="date" value={range.to}
                   onChange={(e) => setRange({ ...range, to: e.target.value })} />
          </div>
        </div>

        {loading ? (
          <SkeletonBlock height="10rem" />
        ) : semDados ? (
          <EmptyState
            icon={null}
            title={t('barReports.empty', 'Nenhuma comanda fechada no período')}
            subtitle={t('barReports.emptyHint', 'Escolha outro período ou feche comandas na POS.')}
          />
        ) : (
          <>
            <div className="stats-grid">
              <div className="stat-card stat-card--highlight">
                <span className="stat-label">{t('bar.netSales', 'Vendas')}</span>
                <span className="stat-value">{formatCurrency(summary.net)}</span>
                <span className="stat-hint">
                  {t('barReports.averageTabHint', 'Ticket médio {{value}} · {{count}} comanda(s)', {
                    value: formatCurrency(summary.average_tab), count: summary.tabs,
                  })}
                </span>
              </div>
              <div className="stat-card">
                <span className="stat-label">{t('bar.margin', 'Margem')}</span>
                <span className="stat-value">{formatCurrency(summary.margin)}</span>
                <span className="stat-hint">
                  {t('barReports.cogsHint', 'CMV {{value}} (cortesia inclusa)', { value: formatCurrency(summary.cogs) })}
                </span>
              </div>
              <div className="stat-card">
                <span className="stat-label">{t('barReports.discountsAndCourtesy', 'Descontos e cortesias')}</span>
                <span className="stat-value">{formatCurrency((summary.discounts || 0) + (summary.courtesy || 0))}</span>
                <span className="stat-hint">
                  {t('barReports.grossHint', 'bruto {{value}}', { value: formatCurrency(summary.gross) })}
                </span>
              </div>
              <div className="stat-card">
                <span className="stat-label">{t('barReports.received', 'Recebido')}</span>
                <span className="stat-value">{formatCurrency(summary.paid)}</span>
                <span className="stat-hint">
                  {t('bar.paidBreakdown', 'dinheiro {{cash}} · crédito {{credit}}', {
                    cash: formatCurrency(summary.paid_cash), credit: formatCurrency(summary.paid_credit),
                  })}
                </span>
              </div>
            </div>

            <section className="cr-block">
              <h2>{t('barReports.bestDays', 'Melhores dias')}</h2>
              <p className="cr-hint">{t('barReports.bestDaysHint', 'Ordenado pelas vendas, depois do desconto.')}</p>
              <ol className="cr-rank">
                {melhores.map((l) => (
                  <li key={l.business_date}>
                    <span className="cr-rank-date">{l.business_date}</span>
                    <span className="cr-rank-bar" aria-hidden="true">
                      <span style={{ width: `${maiorNet ? Math.round((l.net / maiorNet) * 100) : 0}%` }} />
                    </span>
                    <span className="cr-rank-value">{formatCurrency(l.net)}</span>
                  </li>
                ))}
              </ol>
            </section>

            <section className="cr-block">
              <h2>{t('barReports.byDay', 'Vendas por dia')}</h2>
              <Card className="bar-card">
                <table className="bar-table">
                  <thead>
                    <tr>
                      <th>{t('bar.businessDate', 'Data')}</th>
                      <th className="bar-num">{t('bar.netSales', 'Vendas')}</th>
                      <th className="bar-num">{t('barReports.discountsAndCourtesy', 'Descontos e cortesias')}</th>
                      <th className="bar-num">{t('barReports.cogsShort', 'CMV')}</th>
                      <th className="bar-num">{t('bar.margin', 'Margem')}</th>
                      <th className="bar-num">{t('bar.tabsCount', 'Comandas')}</th>
                      <th className="bar-num">{t('barReports.items', 'Itens')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {daily.map((l) => (
                      <tr key={l.business_date}>
                        <td className="bar-nw">{l.business_date}</td>
                        <td className="bar-num bar-revenue">{formatCurrency(l.net)}</td>
                        <td className="bar-num">{formatCurrency((l.discounts || 0) + (l.courtesy || 0))}</td>
                        <td className="bar-num">{formatCurrency(l.cogs)}</td>
                        <td className="bar-num">{formatCurrency(l.margin)}</td>
                        <td className="bar-num">{l.tabs}</td>
                        <td className="bar-num">{l.items}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </Card>
            </section>

            <section className="cr-block">
              <h2>{t('barReports.byProduct', 'Por produto')}</h2>
              <Card className="bar-card">
                <table className="bar-table">
                  <thead>
                    <tr>
                      <th>{t('bar.product', 'Produto')}</th>
                      <th>{t('bar.category', 'Categoria')}</th>
                      <th className="bar-num">{t('bar.quantity', 'Quantidade')}</th>
                      <th className="bar-num">{t('barReports.courtesyQty', 'Cortesias')}</th>
                      <th className="bar-num">{t('bar.netSales', 'Vendas')}</th>
                      <th className="bar-num">{t('bar.margin', 'Margem')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(summary.top_products || []).map((p) => (
                      <tr key={p.product_id}>
                        <td><strong>{p.product_name}</strong></td>
                        <td>{p.category_name || '—'}</td>
                        <td className="bar-num">{p.quantity}</td>
                        <td className="bar-num">{p.courtesy_quantity || 0}</td>
                        <td className="bar-num">{formatCurrency(p.revenue)}</td>
                        <td className="bar-num">{formatCurrency(p.margin)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </Card>
            </section>

            <section className="cr-block">
              <h2>{t('barReports.byMethod', 'Por forma de pagamento')}</h2>
              <ul className="bar-kpi-list">
                {(summary.by_method || []).map((m) => (
                  <li key={m.payment_method}>
                    <span className="bar-muted">{m.payment_method}</span>
                    <strong>{formatCurrency(m.amount)}</strong>
                    <span className="bar-muted"> · {m.count}</span>
                  </li>
                ))}
              </ul>
            </section>

            {players.length > 0 && (
              <section className="cr-block">
                <h2>{t('barReports.byPlayer', 'Por jogador')}</h2>
                <Card className="bar-card">
                  <table className="bar-table">
                    <thead>
                      <tr>
                        <th>{t('bar.player', 'Jogador')}</th>
                        <th className="bar-num">{t('bar.tabsCount', 'Comandas')}</th>
                        <th className="bar-num">{t('barReports.items', 'Itens')}</th>
                        <th className="bar-num">{t('barReports.spent', 'Gasto')}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {players.map((p) => (
                        <tr key={p.player_id}>
                          <td>{p.player_name || '—'}</td>
                          <td className="bar-num">{p.tabs}</td>
                          <td className="bar-num">{p.items}</td>
                          <td className="bar-num">{formatCurrency(p.spent)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </Card>
              </section>
            )}
          </>
        )}
      </main>
    </div>
  );
};

export default BarRelatorios;
