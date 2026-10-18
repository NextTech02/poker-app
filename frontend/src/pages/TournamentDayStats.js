import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useParams, useNavigate } from 'react-router-dom';
import Sidebar from '../components/Sidebar';
import Card from '../components/Card';
import Button from '../components/Button';
import api from '../config/api';
import { useCurrency } from '../contexts/CurrencyContext';
import './TournamentDayStats.css';

const TournamentDayStats = () => {
  const { t } = useTranslation();
  const { dayId } = useParams();
  const navigate = useNavigate();
  const { formatCurrency } = useCurrency();

  const [day, setDay] = useState(null);
  const [tournament, setTournament] = useState(null);
  const [stats, setStats] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  // loadStats e recriada a cada render; incluir na lista de dependencias causaria
  // refetch infinito. So a troca de dia deve disparar o recarregamento.
  useEffect(() => {
    loadStats();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dayId]);

  const loadStats = async () => {
    try {
      setLoading(true);

      // O dia precisa vir primeiro: dele saem o torneio e qual endpoint de
      // estatística usar. As duas chamadas seguintes, porém, não dependem uma
      // da outra — em paralelo, são 2 idas ao servidor em vez de 3.
      const dayRes = await api.get(`/tournament-days/${dayId}`);
      const dayData = dayRes.data;
      setDay(dayData);

      const isFinalDay = dayData.day_type === 'final';
      const [tournamentRes, statsRes] = await Promise.all([
        api.get(`/tournaments/${dayData.tournament_id}`),
        api.get(`/tournament-days/${dayId}/${isFinalDay ? 'aggregated-stats' : 'stats'}`),
      ]);

      setTournament(tournamentRes.data);
      setStats({ ...statsRes.data, isFinalDay });
    } catch (err) {
      console.error('Error loading stats:', err);
      setError(t('dayStats.loadError'));
    } finally {
      setLoading(false);
    }
  };

  const handleBack = () => {
    if (tournament) {
      navigate(`/torneios/${tournament.id}`);
    } else {
      navigate(-1);
    }
  };

  if (loading) {
    return (
      <div className="app-container">
        <Sidebar />
        <main className="main-content">
          <div className="loading">{t('common.loading')}</div>
        </main>
      </div>
    );
  }

  if (error) {
    return (
      <div className="app-container">
        <Sidebar />
        <main className="main-content">
          <div className="error-message">{error}</div>
          <Button onClick={handleBack}>{t('common.back')}</Button>
        </main>
      </div>
    );
  }

  const isFinalDay = stats?.isFinalDay;

  return (
    <div className="app-container">
      <Sidebar />
      <main className="main-content">
        <div className="page-header">
          <div>
            <h1>
              {isFinalDay ? t('dayStats.aggregatedStats') : t('dayStats.dayStats')}
            </h1>
            <p className="subtitle">
              {tournament?.name} - {day?.day_name}
            </p>
          </div>
          <Button variant="secondary" onClick={handleBack}>
            {t('common.back')}
          </Button>
        </div>

        {/* Day Type Badge */}
        <div className="day-type-badges">
          {day?.day_type === 'qualifying' && (
            <span className="day-type-badge qualifying">{t('dayStats.qualifyingDay')}</span>
          )}
          {day?.day_type === 'final' && (
            <span className="day-type-badge final">{t('dayStats.finalDay')}</span>
          )}
          {day?.day_type === 'regular' && (
            <span className="day-type-badge regular">{t('dayStats.regularDay')}</span>
          )}
          <span className={`status-badge ${day?.status}`}>
            {day?.status === 'pending' && t('dayStats.statusPending')}
            {day?.status === 'active' && t('dayStats.statusActive')}
            {day?.status === 'completed' && t('dayStats.statusCompleted')}
            {day?.status === 'cancelled' && t('dayStats.statusCancelled')}
          </span>
        </div>

        {isFinalDay ? (
          // Final Day Aggregated Stats View
          <>
            {/* Combined Totals */}
            <Card className="stats-card">
              <h2 className="stats-card-title">{t('dayStats.combinedTotals')}</h2>
              <div className="stats-grid large">
                <div className="stat-box highlight">
                  <span className="stat-box-label">{t('dayStats.prizePoolTotal')}</span>
                  <span className="stat-box-value">{formatCurrency(stats.combined_prize_pool || 0)}</span>
                </div>
                <div className="stat-box highlight">
                  <span className="stat-box-label">{t('dayStats.totalCollected')}</span>
                  <span className="stat-box-value">{formatCurrency(stats.combined_total_collected || 0)}</span>
                </div>
                <div className="stat-box">
                  <span className="stat-box-label">{t('dayStats.playersAtFinal')}</span>
                  <span className="stat-box-value">{stats.total_players || 0}</span>
                </div>
                <div className="stat-box">
                  <span className="stat-box-label">{t('dayStats.qualified')}</span>
                  <span className="stat-box-value">{stats.total_qualified_players || 0}</span>
                </div>
                <div className="stat-box">
                  <span className="stat-box-label">{t('dayStats.directBuyIns')}</span>
                  <span className="stat-box-value">{stats.direct_buy_in_players || 0}</span>
                </div>
              </div>
            </Card>

            {/* Qualifying Days Breakdown */}
            {stats.qualifying_days && stats.qualifying_days.length > 0 && (
              <Card className="stats-card">
                <h2 className="stats-card-title">
                  {t('dayStats.qualifyingDaysCount', { count: stats.qualifying_days.length })}
                </h2>
                <div className="qualifying-days-list">
                  {stats.qualifying_days.map((qDay, index) => (
                    <div key={qDay.day_id || index} className="qualifying-day-card">
                      <h3 className="qualifying-day-name">{qDay.day_name}</h3>
                      <div className="stats-grid compact">
                        <div className="stat-box small">
                          <span className="stat-box-label">{t('dayStats.players')}</span>
                          <span className="stat-box-value">{qDay.total_players || 0}</span>
                        </div>
                        <div className="stat-box small">
                          <span className="stat-box-label">{t('dayStats.eliminated')}</span>
                          <span className="stat-box-value">{qDay.eliminated_players || 0}</span>
                        </div>
                        <div className="stat-box small">
                          <span className="stat-box-label">{t('dayStats.qualified')}</span>
                          <span className="stat-box-value">{qDay.qualified_players || 0}</span>
                        </div>
                        <div className="stat-box small">
                          <span className="stat-box-label">{t('dayStats.buyIns')}</span>
                          <span className="stat-box-value">{qDay.total_buy_ins || 0}</span>
                        </div>
                        <div className="stat-box small">
                          <span className="stat-box-label">{t('dayStats.rebuys')}</span>
                          <span className="stat-box-value">{qDay.total_rebuys || 0}</span>
                        </div>
                        <div className="stat-box small">
                          <span className="stat-box-label">{t('dayStats.addons')}</span>
                          <span className="stat-box-value">{qDay.total_addons || 0}</span>
                        </div>
                        <div className="stat-box small">
                          <span className="stat-box-label">{t('dayStats.totalEntries')}</span>
                          <span className="stat-box-value">{qDay.total_entries || 0}</span>
                        </div>
                        <div className="stat-box small">
                          <span className="stat-box-label">{t('dayStats.buyInAmount')}</span>
                          <span className="stat-box-value">{formatCurrency(qDay.buy_in_amount || 0)}</span>
                        </div>
                        <div className="stat-box small">
                          <span className="stat-box-label">{t('dayStats.rebuyAmount')}</span>
                          <span className="stat-box-value">{formatCurrency(qDay.rebuy_amount || 0)}</span>
                        </div>
                        <div className="stat-box small">
                          <span className="stat-box-label">{t('dayStats.addonAmount')}</span>
                          <span className="stat-box-value">{formatCurrency(qDay.addon_amount || 0)}</span>
                        </div>
                        <div className="stat-box small highlight-blue">
                          <span className="stat-box-label">{t('dayStats.totalCollected')}</span>
                          <span className="stat-box-value">{formatCurrency(qDay.total_collected || 0)}</span>
                        </div>
                        <div className="stat-box small highlight-blue">
                          <span className="stat-box-label">{t('tournaments.prizePool')}</span>
                          <span className="stat-box-value">{formatCurrency(qDay.prize_pool || 0)}</span>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              </Card>
            )}

            {/* Aggregated Totals from all Qualifying Days */}
            {stats.qualifying_days && stats.qualifying_days.length > 1 && (
              <Card className="stats-card">
                <h2 className="stats-card-title">{t('dayStats.qualifyingDaysSum')}</h2>
                <div className="stats-grid">
                  <div className="stat-box">
                    <span className="stat-box-label">{t('dayStats.totalBuyIns')}</span>
                    <span className="stat-box-value">{stats.total_qualifying_buy_ins || 0}</span>
                  </div>
                  <div className="stat-box">
                    <span className="stat-box-label">{t('dayStats.totalRebuys')}</span>
                    <span className="stat-box-value">{stats.total_qualifying_rebuys || 0}</span>
                  </div>
                  <div className="stat-box">
                    <span className="stat-box-label">{t('dayStats.totalAddons')}</span>
                    <span className="stat-box-value">{stats.total_qualifying_addons || 0}</span>
                  </div>
                  <div className="stat-box">
                    <span className="stat-box-label">{t('dayStats.totalEntries')}</span>
                    <span className="stat-box-value">{stats.total_qualifying_entries || 0}</span>
                  </div>
                  <div className="stat-box highlight">
                    <span className="stat-box-label">{t('dayStats.totalCollected')}</span>
                    <span className="stat-box-value">{formatCurrency(stats.total_qualifying_collected || 0)}</span>
                  </div>
                  <div className="stat-box highlight">
                    <span className="stat-box-label">{t('dayStats.qualifyingPrizePool')}</span>
                    <span className="stat-box-value">{formatCurrency(stats.total_qualifying_prize_pool || 0)}</span>
                  </div>
                </div>
              </Card>
            )}

            {/* Final Day Specific Stats */}
            {(stats.final_day_buy_ins > 0 || stats.final_day_rebuys > 0 || stats.final_day_addons > 0) && (
              <Card className="stats-card">
                <h2 className="stats-card-title">{t('dayStats.finalDayEntries')}</h2>
                <div className="stats-grid">
                  <div className="stat-box">
                    <span className="stat-box-label">{t('dayStats.directBuyIns')}</span>
                    <span className="stat-box-value">{stats.final_day_buy_ins || 0}</span>
                  </div>
                  <div className="stat-box">
                    <span className="stat-box-label">{t('dayStats.rebuysAtFinal')}</span>
                    <span className="stat-box-value">{stats.final_day_rebuys || 0}</span>
                  </div>
                  <div className="stat-box">
                    <span className="stat-box-label">{t('dayStats.addonsAtFinal')}</span>
                    <span className="stat-box-value">{stats.final_day_addons || 0}</span>
                  </div>
                  <div className="stat-box highlight">
                    <span className="stat-box-label">{t('dayStats.collectedAtFinal')}</span>
                    <span className="stat-box-value">{formatCurrency(stats.final_day_collected || 0)}</span>
                  </div>
                </div>
              </Card>
            )}
          </>
        ) : (
          // Single Day Stats View
          <>
            <Card className="stats-card">
              <h2 className="stats-card-title">{t('dayStats.dayTotals')}</h2>
              <div className="stats-grid large">
                <div className="stat-box highlight">
                  <span className="stat-box-label">{t('tournaments.prizePool')}</span>
                  <span className="stat-box-value">{formatCurrency(stats.prize_pool || 0)}</span>
                </div>
                <div className="stat-box highlight">
                  <span className="stat-box-label">{t('dayStats.totalCollected')}</span>
                  <span className="stat-box-value">{formatCurrency(stats.total_collected || 0)}</span>
                </div>
              </div>
            </Card>

            <Card className="stats-card">
              <h2 className="stats-card-title">{t('dayStats.players')}</h2>
              <div className="stats-grid">
                <div className="stat-box">
                  <span className="stat-box-label">{t('dayStats.totalPlayers')}</span>
                  <span className="stat-box-value">{stats.total_players || 0}</span>
                </div>
                <div className="stat-box">
                  <span className="stat-box-label">{t('dayStats.eliminated')}</span>
                  <span className="stat-box-value">{stats.eliminated_players || 0}</span>
                </div>
                <div className="stat-box">
                  <span className="stat-box-label">{t('dayStats.qualifiedActive')}</span>
                  <span className="stat-box-value">{stats.qualified_players || 0}</span>
                </div>
              </div>
            </Card>

            <Card className="stats-card">
              <h2 className="stats-card-title">{t('dayStats.entries')}</h2>
              <div className="stats-grid">
                <div className="stat-box">
                  <span className="stat-box-label">{t('dayStats.buyIns')}</span>
                  <span className="stat-box-value">{stats.total_buy_ins || 0}</span>
                </div>
                <div className="stat-box">
                  <span className="stat-box-label">{t('dayStats.rebuys')}</span>
                  <span className="stat-box-value">{stats.total_rebuys || 0}</span>
                </div>
                <div className="stat-box">
                  <span className="stat-box-label">{t('dayStats.addons')}</span>
                  <span className="stat-box-value">{stats.total_addons || 0}</span>
                </div>
                <div className="stat-box">
                  <span className="stat-box-label">{t('dayStats.totalEntries')}</span>
                  <span className="stat-box-value">{stats.total_entries || 0}</span>
                </div>
              </div>
            </Card>

            <Card className="stats-card">
              <h2 className="stats-card-title">{t('dayStats.amounts')}</h2>
              <div className="stats-grid">
                <div className="stat-box">
                  <span className="stat-box-label">{t('dayStats.buyInAmount')}</span>
                  <span className="stat-box-value">{formatCurrency(stats.buy_in_amount || 0)}</span>
                </div>
                <div className="stat-box">
                  <span className="stat-box-label">{t('dayStats.rebuyAmount')}</span>
                  <span className="stat-box-value">{formatCurrency(stats.rebuy_amount || 0)}</span>
                </div>
                <div className="stat-box">
                  <span className="stat-box-label">{t('dayStats.addonAmount')}</span>
                  <span className="stat-box-value">{formatCurrency(stats.addon_amount || 0)}</span>
                </div>
                {/* Taxa (ex.: Bono Dealer): sem este quadro os importes não
                    fechavam com o total recaudado. */}
                {Number(stats.fee_amount) > 0 && (
                  <div className="stat-box">
                    <span className="stat-box-label">{t('dayStats.feeAmount', 'Importe taxas')}</span>
                    <span className="stat-box-value">{formatCurrency(stats.fee_amount || 0)}</span>
                  </div>
                )}
              </div>
            </Card>

            {/* Cada meio de entrada cadastrado ("Buy-in", "Doble", "Bono
                Dealer"…), com quantidade e valor — a categoria sozinha não diz
                qual foi vendido. */}
            {(stats.by_buy_type || []).length > 0 && (
              <Card className="stats-card">
                <h2 className="stats-card-title">{t('dayStats.byBuyType', 'Por meio de entrada')}</h2>
                <div className="stats-table-wrap">
                  <table className="stats-table">
                    <thead>
                      <tr>
                        <th>{t('dayStats.buyTypeName', 'Meio de entrada')}</th>
                        <th>{t('dayStats.buyTypeCategory', 'Categoria')}</th>
                        <th className="num">{t('dayStats.buyTypeCount', 'Quantidade')}</th>
                        <th className="num">{t('dayStats.buyTypeAmount', 'Valor')}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {stats.by_buy_type.map((m, i) => (
                        <tr key={`${m.name}-${m.category}-${i}`}>
                          <td>{m.name}</td>
                          <td>{t(`dayStats.category_${m.category}`, m.category)}</td>
                          <td className="num">{m.count}</td>
                          <td className="num">{formatCurrency(m.amount || 0)}</td>
                        </tr>
                      ))}
                    </tbody>
                    <tfoot>
                      <tr>
                        <td colSpan={2}>{t('dayStats.buyTypeTotal', 'Total')}</td>
                        <td className="num">{stats.by_buy_type.reduce((s, m) => s + (Number(m.count) || 0), 0)}</td>
                        <td className="num">{formatCurrency(stats.by_buy_type.reduce((s, m) => s + (Number(m.amount) || 0), 0))}</td>
                      </tr>
                    </tfoot>
                  </table>
                </div>
              </Card>
            )}
          </>
        )}
      </main>
    </div>
  );
};

export default TournamentDayStats;
