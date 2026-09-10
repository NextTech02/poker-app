import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import api from '../config/api';
import Sidebar from '../components/Sidebar';
import EmptyState from '../components/EmptyState';
import { SkeletonBlock } from '../components/SkeletonLoader';
import { useToast } from '../contexts/ToastContext';
import { useCurrency } from '../contexts/CurrencyContext';
import { exportSections } from '../utils/reportExport';
import { primeiroDiaDoMes, hojeLocal } from '../utils/datasLocais';
import './CashFloor.css';
import './CashRelatorios.css';

/**
 * FATURAMENTO DO CASH GAME.
 *
 * Esta é a tela que motivou o módulo. A pergunta do cliente não era "quanto
 * entrou de dinheiro", era "quanto faturamos em cada dia, e qual dia rende
 * mais".
 *
 * A tela inteira é organizada para não confundir três números:
 *   FATURAMENTO = o rake contado na caixa das mesas — a receita da casa;
 *   GIRO        = buy-ins, troca de dinheiro por ficha, quase tudo volta ao
 *                 jogador no cash-out. Aparece, mas nunca chamado de receita;
 *   JACKPOT     = passivo, dinheiro dos jogadores retido para pagamento.
 */
const DIAS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];

const CashRelatorios = () => {
  const { t } = useTranslation();
  const { toast } = useToast();
  const { formatCurrency } = useCurrency();

  const [range, setRange] = useState({ from: primeiroDiaDoMes(), to: hojeLocal() });
  const [daily, setDaily] = useState([]);
  const [weekday, setWeekday] = useState([]);
  const [tables, setTables] = useState([]);
  const [players, setPlayers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [exporting, setExporting] = useState(false);

  const load = useCallback(async () => {
    const params = { date_from: range.from, date_to: range.to };
    const [d, w, m, j] = await Promise.all([
      api.get('/cash-game/reports/daily', { params, _silentError: true }).catch(() => ({ data: [] })),
      api.get('/cash-game/reports/weekday', { params, _silentError: true }).catch(() => ({ data: [] })),
      api.get('/cash-game/reports/tables', { params, _silentError: true }).catch(() => ({ data: [] })),
      api.get('/cash-game/reports/players', { params, _silentError: true }).catch(() => ({ data: [] })),
    ]);
    setDaily(d.data || []);
    setWeekday(w.data || []);
    setTables(m.data || []);
    setPlayers(j.data || []);
    setLoading(false);
  }, [range.from, range.to]);

  useEffect(() => { setLoading(true); load(); }, [load]);

  const totais = useMemo(() => daily.reduce((acc, l) => ({
    revenue: acc.revenue + (l.revenue || 0),
    jackpot: acc.jackpot + (l.jackpot || 0),
    buy_ins: acc.buy_ins + (l.buy_ins || 0),
    players: acc.players + (l.players_count || 0),
  }), { revenue: 0, jackpot: 0, buy_ins: 0, players: 0 }), [daily]);

  // Os melhores dias saem do MESMO array já carregado: pedir de novo ao
  // servidor só duplicaria a chamada para reordenar quatro linhas.
  const melhores = useMemo(
    () => [...daily].sort((a, b) => b.revenue - a.revenue).slice(0, 5),
    [daily],
  );

  const mediaPorDia = daily.length ? totais.revenue / daily.length : 0;

  const exportar = async (formato) => {
    setExporting(true);
    try {
      await exportSections([
        {
          kind: 'keyvalue',
          title: t('cashReports.summary', 'Resumo do período'),
          rows: [
            { label: t('cash.revenue', 'Faturamento (rake)'), value: totais.revenue, type: 'currency' },
            { label: t('cashReports.avgPerDay', 'Média por dia'), value: mediaPorDia, type: 'currency' },
            { label: t('cash.turnover', 'Giro (buy-ins)'), value: totais.buy_ins, type: 'currency' },
            { label: t('cashReports.jackpotCollected', 'Jackpot arrecadado (não é receita)'), value: totais.jackpot, type: 'currency' },
            { label: t('cashReports.daysOperated', 'Dias operados'), value: daily.length, type: 'int' },
          ],
        },
        {
          kind: 'table',
          title: t('cashReports.byDay', 'Faturamento por dia'),
          columns: [
            { key: 'business_date', label: t('cash.businessDate', 'Data'), type: 'date' },
            { key: 'revenue', label: t('cash.revenue', 'Faturamento (rake)'), type: 'currency' },
            { key: 'jackpot', label: t('cash.jackpot', 'Jackpot'), type: 'currency' },
            { key: 'buy_ins', label: t('cash.turnover', 'Giro (buy-ins)'), type: 'currency' },
            { key: 'cash_outs', label: t('cash.paid', 'Cash-outs'), type: 'currency' },
            { key: 'tables_count', label: t('cashReports.tables', 'Mesas'), type: 'int' },
            { key: 'players_count', label: t('cashReports.players', 'Jogadores'), type: 'int' },
          ],
          rows: daily,
        },
        {
          kind: 'table',
          title: t('cashReports.byTable', 'Por mesa'),
          columns: [
            { key: 'table_number', label: t('cashReports.table', 'Mesa'), type: 'int' },
            { key: 'game_type_name', label: t('cash.gameType', 'Modalidade'), type: 'text' },
            { key: 'revenue', label: t('cash.revenue', 'Faturamento (rake)'), type: 'currency' },
            { key: 'buy_ins', label: t('cash.turnover', 'Giro (buy-ins)'), type: 'currency' },
            { key: 'players_count', label: t('cashReports.players', 'Jogadores'), type: 'int' },
            { key: 'hours', label: t('cashReports.hours', 'Horas'), type: 'number' },
          ],
          rows: tables,
        },
        {
          kind: 'table',
          title: t('cashReports.byPlayer', 'Por jogador'),
          columns: [
            { key: 'player_name', label: t('cash.player', 'Jogador'), type: 'text' },
            { key: 'sessions', label: t('cashReports.sessions', 'Sessões'), type: 'int' },
            { key: 'buy_ins', label: t('cash.buyIn', 'Buy-in'), type: 'currency' },
            { key: 'cash_outs', label: t('cash.cashOut', 'Cash-out'), type: 'currency' },
            { key: 'result', label: t('cashReports.playerResult', 'Resultado do jogador'), type: 'currency' },
          ],
          rows: players,
        },
      ], {
        format: formato,
        filename: `cash-game-${range.from}-a-${range.to}`,
        meta: {
          title: t('cashReports.title', 'Faturamento do cash game'),
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

  const semDados = !loading && daily.length === 0;

  return (
    <div className="app-container">
      <Sidebar />
      <main className="main-content">
        <div className="page-header">
          <div>
            <h1>{t('cashReports.title', 'Faturamento do cash game')}</h1>
            <p className="subtitle">
              {t('cashReports.subtitle', 'Faturamento é o RAKE. O giro de buy-ins aparece porque é a movimentação da noite, mas quase tudo volta ao jogador no cash-out.')}
            </p>
          </div>
          <div className="cr-export">
            {['xlsx', 'csv', 'pdf'].map((f) => (
              <button key={f} type="button" className="btn btn-secondary btn-sm"
                      onClick={() => exportar(f)} disabled={exporting || semDados}>
                {f.toUpperCase()}
              </button>
            ))}
          </div>
        </div>

        <div className="cd-filters">
          <div className="form-group">
            <label htmlFor="cr-from">{t('common.from', 'De')}</label>
            <input id="cr-from" type="date" value={range.from}
                   onChange={(e) => setRange({ ...range, from: e.target.value })} />
          </div>
          <div className="form-group">
            <label htmlFor="cr-to">{t('common.to', 'Até')}</label>
            <input id="cr-to" type="date" value={range.to}
                   onChange={(e) => setRange({ ...range, to: e.target.value })} />
          </div>
        </div>

        {loading ? (
          <SkeletonBlock height="10rem" />
        ) : semDados ? (
          <EmptyState
            icon={null}
            title={t('cashReports.empty', 'Nenhuma operação no período')}
            subtitle={t('cashReports.emptyHint', 'Escolha outro período ou abra um dia de operação no Salão.')}
          />
        ) : (
          <>
            <div className="stats-grid">
              <div className="stat-card stat-card--highlight">
                <span className="stat-label">{t('cash.revenue', 'Faturamento (rake)')}</span>
                <span className="stat-value">{formatCurrency(totais.revenue)}</span>
                <span className="stat-hint">
                  {t('cashReports.avgPerDayHint', 'Média de {{value}} por dia', {
                    value: formatCurrency(mediaPorDia),
                  })}
                </span>
              </div>
              <div className="stat-card">
                <span className="stat-label">{t('cash.turnover', 'Giro (buy-ins)')}</span>
                <span className="stat-value">{formatCurrency(totais.buy_ins)}</span>
                {/* A frase impede a leitura errada mais provável da tela. */}
                <span className="stat-hint">{t('cashReports.turnoverHint', 'Movimentação, não receita')}</span>
              </div>
              <div className="stat-card">
                <span className="stat-label">{t('cashReports.daysOperated', 'Dias operados')}</span>
                <span className="stat-value">{daily.length}</span>
              </div>
              <div className="stat-card">
                <span className="stat-label">{t('cash.jackpot', 'Jackpot')}</span>
                <span className="stat-value">{formatCurrency(totais.jackpot)}</span>
                <span className="stat-hint">{t('cash.jackpotNotRevenue', 'Não é receita')}</span>
              </div>
            </div>

            <section className="cr-block">
              <h2>{t('cashReports.bestDays', 'Melhores dias')}</h2>
              {/* Ordenado por RAKE. Por giro responderia "qual noite
                  movimentou mais", que é outra pergunta — e levaria o clube a
                  repetir a noite que girou muito e rendeu pouco. */}
              <p className="cr-hint">
                {t('cashReports.bestDaysHint', 'Ordenado pelo que o clube ficou, não pelo que passou pela gaveta.')}
              </p>
              <ol className="cr-rank">
                {melhores.map((l) => (
                  <li key={l.cash_day_id}>
                    <span className="cr-rank-date">{l.business_date}</span>
                    <span className="cr-rank-bar" aria-hidden="true">
                      <span style={{
                        width: melhores[0].revenue
                          ? `${Math.round((l.revenue / melhores[0].revenue) * 100)}%`
                          : '0%',
                      }} />
                    </span>
                    <span className="cr-rank-value">{formatCurrency(l.revenue)}</span>
                  </li>
                ))}
              </ol>
            </section>

            <section className="cr-block">
              <h2>{t('cashReports.byWeekday', 'Por dia da semana')}</h2>
              <p className="cr-hint">
                {t('cashReports.byWeekdayHint', 'Média por dia operado — o total premiaria o dia que apareceu mais vezes no período.')}
              </p>
              <div className="cr-week">
                {weekday.map((w) => (
                  <div key={w.weekday_key} className={`cr-week-day ${w.days ? '' : 'off'}`}>
                    <span className="cr-week-name">
                      {t(`cashReports.weekday_${w.weekday_key}`, DIAS[w.weekday])}
                    </span>
                    <span className="cr-week-value">{formatCurrency(w.avg_revenue)}</span>
                    <span className="cr-week-days">
                      {w.days
                        ? t('cashReports.daysCount', '{{n}} dia(s)', { n: w.days })
                        : t('cashReports.noOperation', 'sem operação')}
                    </span>
                  </div>
                ))}
              </div>
            </section>

            <section className="cr-block">
              <h2>{t('cashReports.byDay', 'Faturamento por dia')}</h2>
              <div className="table-container">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>{t('cash.businessDate', 'Data')}</th>
                      <th>{t('cash.revenue', 'Faturamento (rake)')}</th>
                      <th>{t('cash.jackpot', 'Jackpot')}</th>
                      <th>{t('cash.turnover', 'Giro (buy-ins)')}</th>
                      <th>{t('cash.paid', 'Cash-outs')}</th>
                      <th>{t('cashReports.tables', 'Mesas')}</th>
                      <th>{t('cashReports.players', 'Jogadores')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {daily.map((l) => (
                      <tr key={l.cash_day_id}>
                        <td>{l.business_date}</td>
                        <td className="cd-revenue">{formatCurrency(l.revenue)}</td>
                        <td>{formatCurrency(l.jackpot)}</td>
                        <td>{formatCurrency(l.buy_ins)}</td>
                        <td>{formatCurrency(l.cash_outs)}</td>
                        <td>{l.tables_count}</td>
                        <td>{l.players_count}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>

            {tables.length > 0 && (
              <section className="cr-block">
                <h2>{t('cashReports.byTable', 'Por mesa')}</h2>
                <p className="cr-hint">
                  {t('cashReports.byTableHint', 'É o que diz qual stake vale a pena manter aberto.')}
                </p>
                <div className="table-container">
                  <table className="data-table">
                    <thead>
                      <tr>
                        <th>{t('cashReports.table', 'Mesa')}</th>
                        <th>{t('cash.gameType', 'Modalidade')}</th>
                        <th>{t('cash.revenue', 'Faturamento (rake)')}</th>
                        <th>{t('cashReports.players', 'Jogadores')}</th>
                        <th>{t('cashReports.hours', 'Horas')}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {tables.slice(0, 20).map((m) => (
                        <tr key={m.table_id}>
                          <td>{m.table_number}</td>
                          <td>{m.game_type_name || '—'}</td>
                          <td className="cd-revenue">{formatCurrency(m.revenue)}</td>
                          <td>{m.players_count}</td>
                          <td>{m.hours ? m.hours.toFixed(1) : '—'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </section>
            )}

            {players.length > 0 && (
              <section className="cr-block">
                <h2>{t('cashReports.byPlayer', 'Por jogador')}</h2>
                {/* O resultado é do JOGADOR, não despesa do clube: o dinheiro
                    veio dos outros jogadores da mesa, não do caixa. */}
                <p className="cr-hint">
                  {t('cashReports.byPlayerHint', 'O resultado é do jogador — o dinheiro que ele ganhou veio dos outros da mesa, não do caixa do clube.')}
                </p>
                <div className="table-container">
                  <table className="data-table">
                    <thead>
                      <tr>
                        <th>{t('cash.player', 'Jogador')}</th>
                        <th>{t('cashReports.sessions', 'Sessões')}</th>
                        <th>{t('cash.buyIn', 'Buy-in')}</th>
                        <th>{t('cash.cashOut', 'Cash-out')}</th>
                        <th>{t('cashReports.playerResult', 'Resultado do jogador')}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {players.slice(0, 20).map((p) => (
                        <tr key={p.player_id}>
                          <td>{p.player_name || '—'}</td>
                          <td>{p.sessions}</td>
                          <td>{formatCurrency(p.buy_ins)}</td>
                          <td>{formatCurrency(p.cash_outs)}</td>
                          <td className={p.result >= 0 ? 'cr-win' : 'cr-loss'}>
                            {formatCurrency(p.result)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </section>
            )}
          </>
        )}
      </main>
    </div>
  );
};

export default CashRelatorios;
