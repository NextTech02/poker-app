import React, { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import api from '../config/api';
import Card from './Card';
import EmptyState from './EmptyState';
import { SkeletonStatCard } from './SkeletonLoader';
import { useCurrency } from '../contexts/CurrencyContext';

/**
 * A aba "Bar" do Financeiro: o resumo do bar no MESMO período do DRE.
 *
 * O bar não tem etapa (é por turno), então só as datas do filtro valem — a
 * etapa e o torneio selecionados não escondem nem filtram nada aqui.
 *
 * @param {{start: string, end: string}} period  as datas do filtro do DRE
 */
const BarSummaryCard = ({ period }) => {
  const { t } = useTranslation();
  const { formatCurrency } = useCurrency();
  const [summary, setSummary] = useState(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.get('/bar/reports/summary', {
        params: { date_from: period?.start, date_to: period?.end },
        _silentError: true,
      });
      setSummary(res.data);
    } catch {
      setSummary(null);
    } finally {
      setLoading(false);
    }
  }, [period?.start, period?.end]);

  useEffect(() => { load(); }, [load]);

  if (loading) {
    return <div className="stats-grid"><SkeletonStatCard /><SkeletonStatCard /><SkeletonStatCard /></div>;
  }
  if (!summary || !summary.tabs) {
    return (
      <EmptyState
        icon={null}
        title={t('barReports.empty', 'Nenhuma comanda fechada no período')}
        subtitle={t('financial.barTabHint', 'O bar é por turno, não por etapa: só as datas do filtro valem aqui.')}
      />
    );
  }

  return (
    <Card title={t('financial.barTab', 'Bar')} className="fn-bar-card">
      <p className="fn-muted">
        {t('financial.barTabHint', 'O bar é por turno, não por etapa: só as datas do filtro valem aqui.')}
      </p>
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
      <p className="fn-muted">
        <Link to="/bar/relatorios">{t('financial.barFullReport', 'Relatório completo do bar →')}</Link>
      </p>
    </Card>
  );
};

export default BarSummaryCard;
