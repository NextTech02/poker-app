import React, { useEffect, useState, useCallback } from 'react';
import { useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import Sidebar from '../components/Sidebar';
import Breadcrumb from '../components/Breadcrumb';
import api from '../config/api';
import { useCurrency } from '../contexts/CurrencyContext';
import './RelatorioTorneio.css';

const Stat = ({ label, value, hint }) => (
  <div className="rt-stat">
    <span className="rt-stat-label">{label}</span>
    <span className="rt-stat-value">{value}</span>
    {hint && <span className="rt-stat-hint">{hint}</span>}
  </div>
);

const RelatorioTorneio = () => {
  const { tournamentId } = useParams();
  const { t } = useTranslation();
  const { formatCurrency } = useCurrency();
  const [report, setReport] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const load = useCallback(async () => {
    try {
      setLoading(true);
      const res = await api.get(`/reports/tournament/${tournamentId}`);
      setReport(res.data);
    } catch (err) {
      setError(t('tournamentReport.loadError'));
    } finally {
      setLoading(false);
    }
  }, [tournamentId, t]);

  useEffect(() => { load(); }, [load]);

  return (
    <div className="app-layout">
      <Sidebar />
      <main className="main-content rt-page">
        <Breadcrumb items={[{ label: t('reports.title'), to: '/relatorios' }, { label: t('tournamentReport.breadcrumbTournament') }]} />

        {loading && <div className="rt-loading">{t('common.loading')}</div>}
        {error && <div className="error-banner">{error}</div>}

        {report && (
          <>
            <div className="rt-header">
              <div>
                <h1>{report.tournament_name}</h1>
                <div className="rt-subtitle">
                  {report.sponsor_name && <span>{t('tournamentReport.sponsor')}: {report.sponsor_name} · </span>}
                  {t('common.status')}: {report.status || '—'}
                  {report.has_qualifying && <span> · {t('tournamentReport.qualifying')}</span>}
                  {report.is_satellite && <span> · {t('tournamentReport.satellite')}</span>}
                </div>
              </div>
              <button type="button" className="rt-print-btn" onClick={() => window.print()}>{t('tournamentReport.printPdf')}</button>
            </div>

            <h3 className="rt-section-title">{t('tournamentReport.participation')}</h3>
            <div className="rt-stats-grid">
              <Stat label={t('tournamentReport.distinctPlayers')} value={report.total_players} />
              <Stat label={t('tournamentReport.totalEntries')} value={report.total_entries} hint={t('tournamentReport.entriesHint')} />
              <Stat label={t('tournamentReport.buyIns')} value={report.total_buy_ins} />
              <Stat label={t('tournamentReport.rebuys')} value={report.total_rebuys} />
              <Stat label={t('tournamentReport.addons')} value={report.total_addons} />
            </div>

            <h3 className="rt-section-title">{t('tournamentReport.financial')}</h3>
            <div className="rt-stats-grid">
              <Stat label={t('tournamentReport.revenue')} value={formatCurrency(report.total_revenue)} />
              <Stat label={t('tournamentReport.rake')} value={formatCurrency(report.rake_amount)} hint={`${report.rake_percentage.toFixed(0)}%`} />
              <Stat label={t('tournamentReport.guaranteed')} value={formatCurrency(report.guaranteed_prize)} />
              <Stat label={t('tournamentReport.availablePrizePool')} value={formatCurrency(report.available_prize_pool)} />
              <Stat label={t('tournamentReport.reserved')} value={formatCurrency(report.reserved_amount)} hint={`${report.reserved_prize_percentage.toFixed(0)}% · ${report.reserved_purpose || t('tournamentReport.noPurpose')}`} />
              <Stat label={t('tournamentReport.payablePool')} value={formatCurrency(report.payable_pool)} />
            </div>

            <h3 className="rt-section-title">{t('tournaments.prizePool')}</h3>
            <div className="rt-stats-grid">
              <Stat label={t('tournamentReport.totalAllocated')} value={formatCurrency(report.total_allocated)} />
              <Stat label={t('tournamentReport.distributed')} value={formatCurrency(report.total_distributed)} />
              <Stat label={t('tournamentReport.pendingRelease')} value={report.pending_release} />
              <Stat label={t('tournamentReport.seats')} value={report.vagas_count} hint={t('tournamentReport.ticketsGenerated', { count: report.vagas_generated })} />
            </div>

            {report.days?.length > 0 && (
              <>
                <h3 className="rt-section-title">{t('tournamentReport.days')}</h3>
                <table className="rt-table">
                  <thead>
                    <tr>
                      <th>{t('tournamentReport.day')}</th><th>{t('tournamentReport.type')}</th><th>{t('common.status')}</th><th>{t('tournaments.buyIn')}</th>
                      <th>{t('tournamentReport.players')}</th><th>{t('tournamentReport.buyIns')}</th><th>{t('tournamentReport.rebuys')}</th><th>{t('tournamentReport.addons')}</th><th>{t('tournamentReport.income')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {report.days.map((d) => (
                      <tr key={d.day_id}>
                        <td>{d.day_name}</td>
                        <td>{d.day_type || '—'}</td>
                        <td>{d.status || '—'}</td>
                        <td>{formatCurrency(d.buy_in)}</td>
                        <td>{d.players}</td>
                        <td>{d.buy_ins}</td>
                        <td>{d.rebuys}</td>
                        <td>{d.addons}</td>
                        <td>{formatCurrency(d.revenue)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </>
            )}

            {report.prizes?.length > 0 && (
              <>
                <h3 className="rt-section-title">{t('tournamentReport.prizeTiers')}</h3>
                <table className="rt-table">
                  <thead>
                    <tr>
                      <th>{t('tournamentReport.position')}</th><th>{t('tournamentReport.type')}</th><th>{t('tournamentReport.amount')}</th><th>{t('tournamentReport.player')}</th>
                      <th>{t('tournamentReport.released')}</th><th>{t('tournamentReport.paid')}</th><th>{t('tournamentReport.visible')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {report.prizes.map((p) => (
                      <tr key={p.position}>
                        <td>{p.position}º</td>
                        <td>{p.prize_type === 'vaga' ? t('tournamentReport.seatPrize') : t('tournamentReport.cashPrize')}</td>
                        <td>{formatCurrency(p.prize_amount)}</td>
                        <td>{p.player_name || '—'}</td>
                        <td>{p.released ? '✓' : '—'}</td>
                        <td>{p.paid ? '✓' : '—'}</td>
                        <td>{p.visible ? '👁' : '🚫'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </>
            )}
          </>
        )}
      </main>
    </div>
  );
};

export default RelatorioTorneio;
