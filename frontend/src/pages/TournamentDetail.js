import React, { useEffect, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import Sidebar from '../components/Sidebar';
import Card from '../components/Card';
import Button from '../components/Button';
import api from '../config/api';
import { useToast } from '../contexts/ToastContext';
import './TournamentDetail.css';

// Import the Dashboard component (we'll adapt it later)
import TournamentDashboard from './TournamentDashboard';

const TournamentDetail = () => {
  const { t } = useTranslation();
  const { id } = useParams();
  const navigate = useNavigate();
  const [tournament, setTournament] = useState(null);
  const [days, setDays] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const { toast, confirm } = useToast();

  const loadTournamentData = async () => {
    try {
      const [tournamentRes, daysRes] = await Promise.all([
        api.get(`/tournaments/${id}`),
        api.get(`/tournament-days/tournament/${id}`)
      ]);
      setTournament(tournamentRes.data);
      setDays(daysRes.data);
    } catch (err) {
      console.error('Error loading tournament:', err);
      setError(t('common.error'));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadTournamentData();
  }, [id]);

  const handleCreateDay = () => {
    navigate(`/torneios/${id}/dia/novo`);
  };

  const handleEditDay = (day) => {
    navigate(`/torneios/${id}/dia/editar/${day.id}`);
  };

  const handleDeleteDay = async (dayId) => {
    const ok = await confirm(t('common.confirm') + '?', { variant: 'danger', confirmText: t('common.delete') });
    if (!ok) return;

    try {
      await api.delete(`/tournament-days/${dayId}`);
      loadTournamentData();
    } catch (err) {
      console.error('Error deleting day:', err);
      toast.error(t('common.error'));
    }
  };

  const handleStartDay = async (dayId) => {
    const ok = await confirm(t('common.confirm') + '?');
    if (!ok) return;

    try {
      await api.patch(`/tournament-days/${dayId}`, { status: 'active' });
      loadTournamentData();
    } catch (err) {
      console.error('Error starting day:', err);
      toast.error(t('common.error'));
    }
  };

  const handleViewBroadcast = (dayId) => {
    navigate(`/broadcast/${dayId}`);
  };

  const handleConfigureBlinds = (dayId) => {
    navigate(`/blinds/${dayId}`);
  };

  const handleManageTables = (dayId) => {
    navigate(`/alocacao/dia/${dayId}`);
  };

  const handleFinishDay = async (dayId) => {
    const ok = await confirm(t('common.confirm') + '?');
    if (!ok) return;

    try {
      await api.patch(`/tournament-days/${dayId}`, { status: 'completed' });
      loadTournamentData();
    } catch (err) {
      console.error('Error finishing day:', err);
      toast.error(t('common.error'));
    }
  };

  const handleRestartDay = async (dayId) => {
    const ok = await confirm(t('common.confirm') + '?');
    if (!ok) return;

    try {
      await api.patch(`/tournament-days/${dayId}`, {
        status: 'active',
        start_time: new Date().toISOString()
      });
      loadTournamentData();
    } catch (err) {
      console.error('Error restarting day:', err);
      toast.error(t('common.error'));
    }
  };

  const getStatusBadge = (status) => {
    const labels = {
      pending: t('common.pending'),
      active: t('common.active'),
      completed: t('common.completed'),
      cancelled: t('common.cancelled'),
    };
    return <span className={`day-status-badge ${status}`}>{labels[status] || status}</span>;
  };

  const getDayTypeBadge = (dayType) => {
    const labels = {
      regular: null,
      qualifying: t('tournamentDays.qualifying'),
      final: t('tournamentDays.final'),
    };
    if (!labels[dayType]) return null;
    return <span className={`day-type-badge ${dayType}`}>{labels[dayType]}</span>;
  };

  const getLinkedDayName = (qualifiesToDayId) => {
    const linkedDay = days.find(d => d.id === qualifiesToDayId);
    return linkedDay ? linkedDay.day_name : null;
  };

  const handleAdvanceQualifiers = async (dayId) => {
    const day = days.find(d => d.id === dayId);
    if (!day) return;

    const linkedDayName = getLinkedDayName(day.qualifies_to_day_id);
    const ok = await confirm(`${t('tournamentDays.advanceQualifiers')} ${linkedDayName}?`);
    if (!ok) return;

    try {
      const response = await api.post(`/tournament-days/${dayId}/advance-qualifiers`);
      toast.success(`${response.data.advanced_count} ${t('tournamentDays.survivors').toLowerCase()} → ${response.data.final_day_name}!`);
      loadTournamentData();
    } catch (err) {
      console.error('Error advancing qualifiers:', err);
      const errorMessage = err.response?.data?.detail || t('common.error');
      toast.error(errorMessage);
    }
  };

  const handleViewStats = (dayId) => {
    navigate(`/torneios/dia/${dayId}/estatisticas`);
  };

  const handleControlPanel = (dayId) => {
    navigate(`/control/${dayId}`);
  };

  // ============================================
  // Extracted renderDayCard to avoid duplication
  // ============================================
  const renderDayCard = (day) => (
    <Card key={day.id} className="day-card">
      <div className="day-card-header">
        <div className="day-card-title">
          <h3>{day.day_name}</h3>
          {getDayTypeBadge(day.day_type)}
          {getStatusBadge(day.status)}
        </div>
        <div className="day-card-actions">
          {day.status === 'pending' && (
            <Button
              size="small"
              variant="primary"
              onClick={() => handleStartDay(day.id)}
            >
              {t('tournamentDays.startDay')}
            </Button>
          )}
          {day.status === 'active' && (
            <>
              <Button
                size="small"
                variant="primary"
                onClick={() => handleViewBroadcast(day.id)}
              >
                {t('common.view')}
              </Button>
              <Button
                size="small"
                variant="primary"
                onClick={() => handleControlPanel(day.id)}
              >
                {t('control.title')}
              </Button>
              <Button
                size="small"
                variant="secondary"
                onClick={() => handleRestartDay(day.id)}
              >
                {t('common.actions')}
              </Button>
              <Button
                size="small"
                variant="secondary"
                onClick={() => handleFinishDay(day.id)}
              >
                {t('tournamentDays.finishDay')}
              </Button>
            </>
          )}
          {day.status === 'completed' && (
            <>
              <Button
                size="small"
                variant="primary"
                onClick={() => handleRestartDay(day.id)}
              >
                {t('tournamentDays.reopenDay')}
              </Button>
              {day.day_type === 'qualifying' && day.qualifies_to_day_id && (
                <Button
                  size="small"
                  variant="secondary"
                  onClick={() => handleAdvanceQualifiers(day.id)}
                >
                  {t('tournamentDays.advanceQualifiers')}
                </Button>
              )}
            </>
          )}
          <Button
            size="small"
            variant="secondary"
            onClick={() => handleViewStats(day.id)}
          >
            {t('common.details')}
          </Button>
          <Button
            size="small"
            variant="secondary"
            onClick={() => handleConfigureBlinds(day.id)}
          >
            {t('blinds.title')}
          </Button>
          <Button
            size="small"
            variant="secondary"
            onClick={() => handleManageTables(day.id)}
            title="Gerenciar mesas e alocação de jogadores"
          >
            Mesas
          </Button>
          {(day.day_type === 'final' || day.day_type === 'regular' || !day.day_type) && (
            <Button
              size="small"
              variant="secondary"
              onClick={() => navigate(`/premiacao/${id}`)}
              title="Configurar e pagar premiações"
            >
              {t('rankings.prize')}
            </Button>
          )}
          <Button
            size="small"
            variant="secondary"
            onClick={() => handleEditDay(day)}
          >
            {t('common.edit')}
          </Button>
          <Button
            size="small"
            variant="secondary"
            onClick={() => handleDeleteDay(day.id)}
            disabled={day.status !== 'pending'}
          >
            {t('common.delete')}
          </Button>
        </div>
      </div>

      <div className="day-info-grid">
        {day.day_type !== 'final' && (
          <>
            <div className="day-info-item">
              <span className="day-info-label">{t('tournaments.buyIn')}</span>
              <span className="day-info-value">R$ {day.buy_in.toFixed(2)}</span>
            </div>
            <div className="day-info-item">
              <span className="day-info-label">{t('tournaments.rebuy')}</span>
              <span className="day-info-value">
                {day.rebuy_amount ? `R$ ${day.rebuy_amount.toFixed(2)}` : '-'}
              </span>
            </div>
            <div className="day-info-item">
              <span className="day-info-label">{t('tournaments.addon')}</span>
              <span className="day-info-value">
                {day.addon_amount ? `R$ ${day.addon_amount.toFixed(2)}` : '-'}
              </span>
            </div>
            <div className="day-info-item">
              <span className="day-info-label">{t('tournaments.maxPlayers')}</span>
              <span className="day-info-value">
                {day.registered_players} / {day.max_players}
              </span>
            </div>
            <div className="day-info-item">
              <span className="day-info-label">{t('cashRegister.rake')}</span>
              <span className="day-info-value">{day.rake_percentage}%</span>
            </div>
          </>
        )}
        {day.day_type === 'final' && (
          <div className="day-info-item">
            <span className="day-info-label">{t('tournaments.registeredPlayers')}</span>
            <span className="day-info-value">{day.registered_players || 0}</span>
          </div>
        )}
        <div className="day-info-item">
          <span className="day-info-label">{t('tournaments.startingChips')}</span>
          <span className="day-info-value">{day.starting_chips.toLocaleString()}</span>
        </div>
        {day.day_type !== 'final' && (
          <div className="day-info-item">
            <span className="day-info-label">{t('tournamentDays.entries')}</span>
            <span className="day-info-value">{day.total_entries || 0}</span>
          </div>
        )}
        {day.day_type === 'qualifying' && day.qualifies_to_day_id && (
          <div className="day-info-item qualifying-info">
            <span className="day-info-label">{t('tournamentDays.qualifiesTo')}</span>
            <span className="day-info-value">{getLinkedDayName(day.qualifies_to_day_id)}</span>
          </div>
        )}
      </div>
    </Card>
  );

  // Filtered day lists for split layout
  const qualifyingDays = days.filter(d => d.day_type === 'qualifying');
  const finalDays = days.filter(d => d.day_type === 'final');
  const regularDays = days.filter(d => d.day_type === 'regular' || !d.day_type);
  const isQualifyingTournament = tournament?.has_qualifying;

  // Renders the days list in either split or flat mode
  const renderDaysList = (showCreateButton) => {
    if (days.length === 0) {
      return (
        <div className="empty-days-professional">
          <div className="empty-days-line" />
          <h3>Nenhum dia configurado</h3>
          <p>Crie o primeiro dia para configurar o torneio</p>
          <Button onClick={handleCreateDay}>
            {t('tournamentDayForm.createDay')}
          </Button>
        </div>
      );
    }

    if (isQualifyingTournament) {
      return (
        <>
          {/* Qualifying Days Section */}
          <div className="days-list-section">
            <h2 className="section-title">
              {t('tournamentDays.qualifyingDays')} ({qualifyingDays.length})
            </h2>
            {qualifyingDays.length > 0 ? (
              <div className="days-list">
                {qualifyingDays.map(renderDayCard)}
              </div>
            ) : (
              <div className="empty-days-hint">
                <p>{t('tournamentDays.noQualifyingDays')}</p>
              </div>
            )}
          </div>

          {/* Final Day Section */}
          <div className="days-list-section days-list-section-final">
            <h2 className="section-title section-title-final">
              {t('tournamentDays.finalDay')} ({finalDays.length})
            </h2>
            {finalDays.length > 0 ? (
              <div className="days-list">
                {finalDays.map(renderDayCard)}
              </div>
            ) : (
              <div className="empty-days-hint">
                <p>{t('tournamentDays.noFinalDay')}</p>
              </div>
            )}
          </div>

          {/* Regular days fallback (shouldn't exist in qualifying tournament) */}
          {regularDays.length > 0 && (
            <div className="days-list-section">
              <h2 className="section-title">
                {t('tournamentDays.title')} ({regularDays.length})
              </h2>
              <div className="days-list">
                {regularDays.map(renderDayCard)}
              </div>
            </div>
          )}
        </>
      );
    }

    // Flat layout (non-qualifying tournament)
    return (
      <div className="days-list-section">
        <h2 className="section-title">{t('tournamentDays.title')} ({days.length})</h2>
        <div className="days-list">
          {days.map(renderDayCard)}
        </div>
      </div>
    );
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

  if (!tournament) {
    return (
      <div className="app-container">
        <Sidebar />
        <main className="main-content">
          <Card>
            <p>{t('common.noData')}</p>
            <Button onClick={() => navigate('/torneios')}>{t('common.back')}</Button>
          </Card>
        </main>
      </div>
    );
  }

  return (
    <div className="app-container">
      <Sidebar />
      <main className="main-content">
        <div className="page-header">
          <div>
            <h1>{tournament.name}</h1>
            <p className="subtitle">{t('tournaments.subtitle')}</p>
          </div>
          <div className="header-actions">
            {!isQualifyingTournament && (
              <Button onClick={() => navigate(`/premiacao/${id}`)}>
                {t('rankings.prize')}
              </Button>
            )}
            <Button onClick={handleCreateDay}>
              {t('common.add')} {t('tournamentDays.title')}
            </Button>
            <Button variant="secondary" onClick={() => navigate('/torneios')}>
              {t('common.back')}
            </Button>
          </div>
        </div>

        {/* Days List - Top section */}
        {days.length > 0 && renderDaysList(false)}

        {/* Dashboard */}
        <TournamentDashboard tournamentId={id} />

      </main>
    </div>
  );
};

export default TournamentDetail;
