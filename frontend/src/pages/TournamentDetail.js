import React, { useEffect, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import Sidebar from '../components/Sidebar';
import Card from '../components/Card';
import Button from '../components/Button';
import Breadcrumb from '../components/Breadcrumb';
import api from '../config/api';
import { useToast } from '../contexts/ToastContext';
import { useCurrency } from '../contexts/CurrencyContext';
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
  const [dayTvCodes, setDayTvCodes] = useState({}); // { [dayId]: code }
  const [openTvDay, setOpenTvDay] = useState(null); // qual dia está com o card do código aberto
  const { toast, confirm } = useToast();
  const { formatCurrency } = useCurrency();

  // Código público de TV POR DIA (blinds por código). Busca/gera sob demanda.
  // Cada dia do torneio tem o seu próprio código único.
  const loadTvCode = async (dayId) => {
    // Alterna: se já está aberto neste dia, fecha.
    if (openTvDay === dayId) { setOpenTvDay(null); return; }
    try {
      let code = dayTvCodes[dayId];
      if (!code) {
        const res = await api.get(`/tournament-days/${dayId}/broadcast-code`);
        code = res.data.code;
        setDayTvCodes((prev) => ({ ...prev, [dayId]: code }));
      }
      setOpenTvDay(dayId);
    } catch (e) {
      toast.error(t('tv.codeError', 'Não foi possível gerar o código de TV.'));
    }
  };

  const loadTournamentData = async () => {
    try {
      const [tournamentRes, daysRes] = await Promise.all([
        api.get(`/tournaments/${id}`),
        api.get(`/tournament-days/tournament/${id}`)
      ]);
      setTournament(tournamentRes.data);
      setDays(daysRes.data);
    } catch (err) {
      // O estado de erro nunca era exibido na tela; o interceptor global do axios
      // ja avisa o usuario. Aqui so registramos no console.
      console.error('Error loading tournament:', err);
    } finally {
      setLoading(false);
    }
  };

  // loadTournamentData e recriada a cada render; incluir na lista de dependencias
  // causaria refetch infinito. So a troca de torneio deve recarregar.
  useEffect(() => {
    loadTournamentData();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  const handleCreateDay = () => {
    navigate(`/torneios/${id}/dia/novo`);
  };

  const handleEditDay = (day) => {
    navigate(`/torneios/${id}/dia/editar/${day.id}`);
  };

  const dayNameOf = (dayId) => {
    const d = days.find((x) => x.id === dayId);
    return d?.day_name || '';
  };

  // O dia é pai de inscrição e de venda igual ao torneio: apagá-lo leva junto
  // os jogadores daquele dia e, com eles, as vendas — sem estornar o caixa da
  // etapa. Por isso a recusa repete os números do que está em jogo.
  const textoDoBloqueioDoDia = (impacto) =>
    t(
      'tournamentDays.deleteBlocked',
      'Este dia não pode ser excluído: tem {{entries}} entrada(s) vendida(s) somando {{amount}} e {{players}} jogador(es) pago(s). Excluir apagaria a venda e o registro de quem pagou sem estornar o caixa da etapa. Cancele as vendas no Caixa antes de excluir.',
      {
        entries: impacto.entries || 0,
        amount: formatCurrency(impacto.entries_amount || 0),
        players: impacto.paying_players || 0,
      }
    );

  const handleDeleteDay = async (dayId) => {
    const name = dayNameOf(dayId);

    let impacto = null;
    try {
      const res = await api.get(`/tournament-days/${dayId}/delete-impact`);
      impacto = res?.data || null;
    } catch {
      // Backend ainda sem o endpoint ou rede caída: cai na confirmação
      // genérica. A recusa que vale é a do servidor.
      impacto = null;
    }

    if (impacto?.blocked) {
      toast.error(textoDoBloqueioDoDia(impacto), {
        title: t('tournamentDays.deleteBlockedTitle', 'Dia com movimento financeiro'),
        duration: 14000,
      });
      return;
    }

    const mensagem = impacto
      ? t(
          'tournamentDays.confirmDeleteImpact',
          'Excluir o dia "{{name}}"? Serão apagadas em cascata {{players}} inscrição(ões), {{cancelled}} venda(s) já cancelada(s), além das blinds e das mesas do dia. Não há como desfazer.',
          { name, players: impacto.players || 0, cancelled: impacto.cancelled_entries || 0 }
        )
      : t('tournamentDays.confirmDeleteMessage', 'O dia "{{name}}" e todos os seus dados serão removidos. Esta ação não pode ser desfeita.', { name });

    const ok = await confirm(mensagem, {
      title: t('tournamentDays.confirmDeleteTitle', 'Excluir dia do torneio?'),
      variant: 'danger',
      confirmText: t('common.delete'),
    });
    if (!ok) return;

    try {
      await api.delete(`/tournament-days/${dayId}`);
      loadTournamentData();
    } catch (err) {
      console.error('Error deleting day:', err);
      if (err?.response?.status === 409) {
        const impactoDaRecusa = err.response?.data?.detail?.impact;
        toast.error(
          impactoDaRecusa ? textoDoBloqueioDoDia(impactoDaRecusa) : err.userMessage,
          { title: t('tournamentDays.deleteBlockedTitle', 'Dia com movimento financeiro'), duration: 14000 }
        );
        return;
      }
      toast.error(t('common.error'));
    }
  };

  const handleStartDay = async (dayId) => {
    const name = dayNameOf(dayId);
    const ok = await confirm(
      t('tournamentDays.confirmStartMessage', { name }),
      {
        title: t('tournamentDays.confirmStartTitle'),
        confirmText: t('tournamentDays.startDay'),
      }
    );
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

  const handleBroadcastSettings = (dayId) => {
    navigate(`/torneios/${id}/dia/${dayId}/broadcast`);
  };

  const handleFinishDay = async (dayId) => {
    const name = dayNameOf(dayId);
    const ok = await confirm(
      t('tournamentDays.confirmFinishMessage', { name }),
      {
        title: t('tournamentDays.confirmFinishTitle'),
        confirmText: t('tournamentDays.finishDay'),
      }
    );
    if (!ok) return;

    try {
      await api.patch(`/tournament-days/${dayId}`, { status: 'completed' });
      loadTournamentData();
    } catch (err) {
      console.error('Error finishing day:', err);
      toast.error(t('common.error'));
    }
  };

  // resetTimer=true -> "Reiniciar dia": além de reativar, ZERA o timer (nível 1,
  // 00:00, pausado). Sem isso, o botão parecia "não fazer nada": o dia já estava
  // ativo e o relógio continuava no nível em que parou.
  // resetTimer=false -> "Reabrir dia" (dia concluído): só reativa, preservando o
  // estado do timer.
  const handleRestartDay = async (dayId, { resetTimer = false } = {}) => {
    const name = dayNameOf(dayId);
    const ok = await confirm(
      t('tournamentDays.confirmRestartMessage', { name }),
      {
        title: t('tournamentDays.confirmRestartTitle'),
        confirmText: t('tournamentDays.restartDay'),
      }
    );
    if (!ok) return;

    try {
      await api.patch(`/tournament-days/${dayId}`, {
        status: 'active',
        start_time: new Date().toISOString()
      });
      // Zera o relógio de fato — é o que faz o "reiniciar" reiniciar.
      if (resetTimer) {
        await api.post(`/tournament-days/${dayId}/timer/reset`);
      }
      loadTournamentData();
      toast.success(resetTimer
        ? t('tournamentDays.restarted', 'Dia reiniciado.')
        : t('tournamentDays.reopened', 'Dia reaberto.'));
    } catch (err) {
      console.error('Error restarting day:', err);
      toast.error(err.userMessage || t('common.error'));
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

  const handleChipCount = (dayId) => {
    navigate(`/torneios/dia/${dayId}/fichas`);
  };

  const handleAdvanceQualifiers = async (dayId) => {
    const day = days.find(d => d.id === dayId);
    if (!day) return;

    const linkedDayName = getLinkedDayName(day.qualifies_to_day_id);

    // Prévia do que vai acontecer: quantos passam e com quanto no total. É a
    // última chance de perceber que faltou registrar a ficha de alguém — depois
    // do avanço, os stacks já estão criados no dia final.
    let previa = '';
    try {
      const survivorsRes = await api.get(`/tournament-days/${dayId}/survivors`);
      const sobreviventes = survivorsRes.data || [];
      const totalFichas = sobreviventes.reduce(
        (soma, s) => soma + Number(s.final_chip_count || 0), 0
      );
      previa = ` (${sobreviventes.length} ${t('tournamentDays.survivors', 'Classificados').toLowerCase()}, ${totalFichas.toLocaleString()} ${t('tournamentDays.chipsWord', 'fichas')})`;
    } catch (e) {
      // Sem a prévia dá para seguir: ela é informação extra, não pré-requisito.
      console.error('Error loading survivors preview:', e);
    }

    const ok = await confirm(`${t('tournamentDays.advanceQualifiers')} ${linkedDayName}?${previa}`);
    if (!ok) return;

    try {
      const response = await api.post(`/tournament-days/${dayId}/advance-qualifiers`);
      toast.success(`${response.data.advanced_count} ${t('tournamentDays.survivors').toLowerCase()} → ${response.data.final_day_name}!`);
      loadTournamentData();
    } catch (err) {
      console.error('Error advancing qualifiers:', err);
      const errorMessage = err.response?.data?.detail || t('common.error');
      toast.error(errorMessage);
      // Esse 400 tem conserto numa tela específica; levar o operador até ela
      // evita que ele fique repetindo o mesmo botão sem entender o bloqueio.
      if (/fichas/i.test(errorMessage)) {
        const irParaFichas = await confirm(
          t('tournamentDays.goToChipCount', 'Quer abrir agora a tela de fichas dos classificados?'),
          { confirmText: t('tournamentDays.chipCountTitle', 'Fichas dos Classificados') }
        );
        if (irParaFichas) handleChipCount(dayId);
      }
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
                onClick={() => handleRestartDay(day.id, { resetTimer: true })}
              >
                {t('tournamentDays.restartDay')}
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
          {/* As fichas são digitadas com o dia ainda ativo (na última mão) ou
              logo depois de encerrado — por isso o botão existe nos dois
              estados. Vem ANTES de "Avançar Classificados" porque o avanço
              agora exige as fichas registradas. */}
          {day.day_type === 'qualifying' && day.qualifies_to_day_id &&
            (day.status === 'active' || day.status === 'completed') && (
            <Button
              size="small"
              variant="secondary"
              onClick={() => handleChipCount(day.id)}
            >
              {t('tournamentDays.chipCountTitle', 'Fichas dos Classificados')}
            </Button>
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
            title={t('tournamentDetail.manageTablesTitle', 'Gerenciar mesas e alocação de jogadores')}
          >
            {t('tables.title')}
          </Button>
          {(day.day_type === 'final' || day.day_type === 'regular' || !day.day_type) && (
            <Button
              size="small"
              variant="secondary"
              onClick={() => navigate(`/premiacao/${id}`)}
              title={t('tournamentDetail.prizeSettingsTitle', 'Configurar e pagar premiações')}
            >
              {t('rankings.prize')}
            </Button>
          )}
          <Button
            size="small"
            variant="secondary"
            onClick={() => handleBroadcastSettings(day.id)}
            title={t('tournamentDetail.broadcastSettingsTitle', 'Configurar aparência do broadcast')}
          >
            {t('tournamentDetail.broadcast', 'Broadcast')}
          </Button>
          <Button
            size="small"
            variant="secondary"
            onClick={() => loadTvCode(day.id)}
            title={t('tv.codeButtonTitle', 'Código para exibir os blinds deste dia numa TV')}
          >
            {t('tv.codeButton', 'Código TV')}
          </Button>
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

      {openTvDay === day.id && dayTvCodes[day.id] && (
        <div className="tv-code-card" style={{
          display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 14,
          background: 'rgba(114,51,248,0.08)', border: '1px solid rgba(114,51,248,0.4)',
          borderRadius: 10, padding: '12px 16px', margin: '0 0 14px',
        }}>
          <span style={{ color: '#9ca3af' }}>{t('tv.codeLabel', 'Código da TV')}:</span>
          <strong style={{ fontSize: '1.6rem', letterSpacing: 4, color: '#7233f8', fontFamily: 'monospace' }}>
            {dayTvCodes[day.id]}
          </strong>
          <span style={{ color: '#9ca3af' }}>
            {t('tv.instruction', 'Na TV, acesse')} <code>{window.location.origin}/tv</code> {t('tv.andType', 'e digite o código')}
          </span>
          <Button size="small" variant="secondary" onClick={() => navigate(`/tv/${dayTvCodes[day.id]}`)}>
            {t('tv.openHere', 'Abrir aqui')}
          </Button>
        </div>
      )}

      <div className="day-info-grid">
        {day.day_type !== 'final' && (
          <>
            <div className="day-info-item">
              <span className="day-info-label">{t('tournaments.buyIn')}</span>
              <span className="day-info-value">{formatCurrency(day.buy_in)}</span>
            </div>
            <div className="day-info-item">
              <span className="day-info-label">{t('tournaments.rebuy')}</span>
              <span className="day-info-value">
                {day.rebuy_amount ? formatCurrency(day.rebuy_amount) : '-'}
              </span>
            </div>
            <div className="day-info-item">
              <span className="day-info-label">{t('tournaments.addon')}</span>
              <span className="day-info-value">
                {day.addon_amount ? formatCurrency(day.addon_amount) : '-'}
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
        {day.day_type !== 'final' && (day.total_reentries || 0) > 0 && (
          // Recompra e add-on ficam num campo proprio: elas nao criam jogador
          // novo, e juntar tudo num numero so inflava a contagem do torneio.
          <div className="day-info-item">
            <span className="day-info-label">
              {t('tournamentDays.reentries', 'Reentradas')}
            </span>
            <span className="day-info-value">{day.total_reentries}</span>
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
          <h3>{t('tournamentDetail.noDaysConfigured', 'Nenhum dia configurado')}</h3>
          <p>{t('tournamentDetail.noDaysConfiguredHint', 'Crie o primeiro dia para configurar o torneio')}</p>
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
        {/* A6.4: Breadcrumb */}
        <Breadcrumb items={[
          { label: t('common.home'), to: '/' },
          { label: t('tournaments.title'), to: '/torneios' },
          { label: tournament.name },
        ]} />

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

        {/* Days List - Top section.
            Sem guarda de tamanho: `renderDaysList` ja trata a lista vazia, e a
            guarda tornava o estado vazio ("Nenhum dia configurado") inalcancavel
            — um torneio recem-criado nao mostrava orientacao nenhuma. */}
        {renderDaysList(false)}

        {/* Dashboard */}
        <TournamentDashboard tournamentId={id} />

      </main>
    </div>
  );
};

export default TournamentDetail;
