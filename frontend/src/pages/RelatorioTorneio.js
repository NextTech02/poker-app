import React, { useEffect, useState, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
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
  const navigate = useNavigate();
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
      setError('Erro ao carregar relatório do torneio');
    } finally {
      setLoading(false);
    }
  }, [tournamentId]);

  useEffect(() => { load(); }, [load]);

  return (
    <div className="app-layout">
      <Sidebar />
      <main className="main-content rt-page">
        <Breadcrumb items={[{ label: 'Relatórios', to: '/relatorios' }, { label: 'Torneio' }]} />

        {loading && <div className="rt-loading">Carregando…</div>}
        {error && <div className="error-banner">{error}</div>}

        {report && (
          <>
            <div className="rt-header">
              <div>
                <h1>{report.tournament_name}</h1>
                <div className="rt-subtitle">
                  {report.sponsor_name && <span>Patrocinador: {report.sponsor_name} · </span>}
                  Status: {report.status || '—'}
                  {report.has_qualifying && <span> · Classificatório</span>}
                  {report.is_satellite && <span> · Satélite</span>}
                </div>
              </div>
              <button className="rt-print-btn" onClick={() => window.print()}>Imprimir / PDF</button>
            </div>

            <h3 className="rt-section-title">Participação</h3>
            <div className="rt-stats-grid">
              <Stat label="Jogadores (distintos)" value={report.total_players} />
              <Stat label="Entradas totais" value={report.total_entries} hint="buy-ins + rebuys + add-ons" />
              <Stat label="Buy-ins" value={report.total_buy_ins} />
              <Stat label="Rebuys" value={report.total_rebuys} />
              <Stat label="Add-ons" value={report.total_addons} />
            </div>

            <h3 className="rt-section-title">Financeiro</h3>
            <div className="rt-stats-grid">
              <Stat label="Arrecadação" value={formatCurrency(report.total_revenue)} />
              <Stat label="Rake" value={formatCurrency(report.rake_amount)} hint={`${report.rake_percentage.toFixed(0)}%`} />
              <Stat label="Garantido" value={formatCurrency(report.guaranteed_prize)} />
              <Stat label="Prizepool disponível" value={formatCurrency(report.available_prize_pool)} />
              <Stat label="Reservado" value={formatCurrency(report.reserved_amount)} hint={`${report.reserved_prize_percentage.toFixed(0)}% · ${report.reserved_purpose || 'sem destino'}`} />
              <Stat label="Pool pagável" value={formatCurrency(report.payable_pool)} />
            </div>

            <h3 className="rt-section-title">Premiação</h3>
            <div className="rt-stats-grid">
              <Stat label="Total alocado" value={formatCurrency(report.total_allocated)} />
              <Stat label="Distribuído (pago)" value={formatCurrency(report.total_distributed)} />
              <Stat label="Aguardando liberação" value={report.pending_release} />
              <Stat label="Vagas" value={report.vagas_count} hint={`${report.vagas_generated} ticket(s) gerado(s)`} />
            </div>

            {report.days?.length > 0 && (
              <>
                <h3 className="rt-section-title">Dias</h3>
                <table className="rt-table">
                  <thead>
                    <tr>
                      <th>Dia</th><th>Tipo</th><th>Status</th><th>Buy-in</th>
                      <th>Jogadores</th><th>Buy-ins</th><th>Rebuys</th><th>Add-ons</th><th>Receita</th>
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
                <h3 className="rt-section-title">Faixas de premiação</h3>
                <table className="rt-table">
                  <thead>
                    <tr>
                      <th>Posição</th><th>Tipo</th><th>Valor</th><th>Jogador</th>
                      <th>Liberada</th><th>Paga</th><th>Pública</th>
                    </tr>
                  </thead>
                  <tbody>
                    {report.prizes.map((p) => (
                      <tr key={p.position}>
                        <td>{p.position}º</td>
                        <td>{p.prize_type === 'vaga' ? 'Vaga' : 'Dinheiro'}</td>
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
