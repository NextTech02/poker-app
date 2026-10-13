import React, { useEffect, useState, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { useParams, useNavigate } from 'react-router-dom';
import Sidebar from '../components/Sidebar';
import Card from '../components/Card';
import Button from '../components/Button';
import api from '../config/api';
import { useRealtimeRefresh } from '../hooks/useRealtimeRefresh';
import { useCurrency } from '../contexts/CurrencyContext';
import './TournamentDashboard.css';

// Ordem das categorias na tabela de itens: entrada, recompra, add-on.
const ORDEM_DA_CATEGORIA = { buy_in: 0, rebuy: 1, addon: 2 };

const TournamentDashboard = ({ tournamentId: propTournamentId }) => {
  const { t } = useTranslation();
  const { id: paramId } = useParams();
  const navigate = useNavigate();

  // Use prop if provided, otherwise use URL param
  const tournamentId = propTournamentId || paramId;
  const isStandalone = !propTournamentId; // true if accessed directly via route

  const [tournament, setTournament] = useState(null);
  const [days, setDays] = useState([]);
  const [allPlayers, setAllPlayers] = useState([]);
  // Vendas do torneio, para a tabela de itens por MEIO de entrada. null =
  // não carregou (a tabela cai no agrupamento por categoria).
  const [transacoes, setTransacoes] = useState(null);
  const [loading, setLoading] = useState(true);
  const { formatCurrency } = useCurrency();

  const loadTournamentData = async () => {
    try {
      // Get tournament and all its days
      const [tournamentRes, daysRes] = await Promise.all([
        api.get(`/tournaments/${tournamentId}`),
        api.get(`/tournament-days/tournament/${tournamentId}`)
      ]);

      setTournament(tournamentRes.data);
      setDays(daysRes.data);
    } catch (err) {
      console.error('Error loading tournament:', err);
    } finally {
      setLoading(false);
    }
  };

  // Carrega TODOS os jogadores do torneio numa só chamada (antes era 1 por dia
  // = N+1 round-trips a cada 5s). Roda em paralelo ao loadTournamentData.
  const loadPlayers = async () => {
    try {
      const playersRes = await api.get(`/tournament-players/tournament/${tournamentId}`);
      setAllPlayers(playersRes.data || []);
    } catch (err) {
      console.error('Error loading players:', err);
    }
  };

  // Vendas do torneio: é delas que sai a tabela de itens por MEIO de entrada
  // (o nome gravado na venda: "Entrada normal", "Addon", "Bonus Dealer").
  // Falhando, a tabela cai no agrupamento por categoria, que vem dos inscritos.
  const loadTransacoes = async () => {
    try {
      const res = await api.get(`/transactions/tournament/${tournamentId}`);
      setTransacoes(Array.isArray(res.data) ? res.data : []);
    } catch (err) {
      console.error('Error loading transactions:', err);
      setTransacoes(null);
    }
  };

  const refresh = () => {
    loadTournamentData();
    loadPlayers();
    loadTransacoes();
  };

  useEffect(() => {
    if (tournamentId) refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tournamentId]);

  // Polling de 5s que pausa quando a aba está oculta (reduz carga em produção).
  useRealtimeRefresh({
    canal: `painel-torneio-${tournamentId}`,
    tabelas: [
      { table: 'tournament_players', filter: `tournament_id=eq.${tournamentId}` },
      { table: 'tournament_days', filter: `tournament_id=eq.${tournamentId}` },
      { table: 'transactions', filter: `tournament_id=eq.${tournamentId}` },
    ],
    aoMudar: () => refresh(),
    ativo: !!tournamentId,
  });

  // Financeiro do torneio — memoizado (só recalcula quando jogadores/dias mudam)
  // e usando um Map dia→jogadores (O(n)) em vez de filtrar por dia (O(n²)).
  // Considera apenas dias NÃO finais (os finais herdam dos classificatórios).
  const financials = useMemo(() => {
    const finalDayIds = new Set(days.filter(d => d.day_type === 'final').map(d => d.id));
    const players = allPlayers.filter(p => !finalDayIds.has(p.tournament_day_id));

    const totalBuyInsCount = players.reduce((sum, p) => sum + (p.buy_in_count || 0), 0);
    const totalRebuysCount = players.reduce((sum, p) => sum + (p.rebuy_count || 0), 0);
    const totalAddonsCount = players.reduce((sum, p) => sum + (p.addon_count || 0), 0);

    const totalBuyInsRevenue = players.reduce((sum, p) => sum + (p.total_buy_in_amount || 0), 0);
    const totalRebuysRevenue = players.reduce((sum, p) => sum + (p.total_rebuy_amount || 0), 0);
    const totalAddonsRevenue = players.reduce((sum, p) => sum + (p.total_addon_amount || 0), 0);

    const totalRevenue = totalBuyInsRevenue + totalRebuysRevenue + totalAddonsRevenue;

    // Agrupa jogadores por dia uma única vez (O(n)).
    const byDay = new Map();
    for (const p of players) {
      const arr = byDay.get(p.tournament_day_id);
      if (arr) arr.push(p); else byDay.set(p.tournament_day_id, [p]);
    }

    let weightedRakeSum = 0;
    let totalDayRevenue = 0;
    for (const day of days) {
      if (day.day_type === 'final') continue;
      const dayPlayers = byDay.get(day.id) || [];
      const dayRevenue = dayPlayers.reduce(
        (sum, p) => sum + (p.total_buy_in_amount || 0) + (p.total_rebuy_amount || 0) + (p.total_addon_amount || 0),
        0
      );
      weightedRakeSum += dayRevenue * (day.rake_percentage || 0);
      totalDayRevenue += dayRevenue;
    }

    const averageRakePercentage = totalDayRevenue > 0 ? (weightedRakeSum / totalDayRevenue) : 0;
    const rake = (totalRevenue * averageRakePercentage) / 100;
    const prizePool = totalRevenue - rake;

    return {
      totalRevenue,
      rake,
      prizePool,
      totalBuyInsCount,
      totalRebuysCount,
      totalAddonsCount,
      totalBuyInsRevenue,
      totalRebuysRevenue,
      totalAddonsRevenue,
      averageRakePercentage,
    };
  }, [allPlayers, days]);

  // Itens vendidos por MEIO de entrada — o nome gravado na venda, não a
  // categoria fixa: o clube quer ver "Addon" e "Bonus Dealer" separados,
  // cada um com a sua quantidade. Venda antiga, sem meio, entra pelo rótulo
  // da categoria. Só vendas ativas e fora dos dias finais — a mesma regra da
  // receita acima. null = sem vendas carregadas.
  const itensVendidos = useMemo(() => {
    if (!transacoes || transacoes.length === 0) return null;
    const rotuloDaCategoria = {
      buy_in: t('tournamentDashboard.tournamentBuyIn'),
      rebuy: t('tournamentDashboard.rebuy'),
      addon: t('tournamentDashboard.addon'),
    };
    const finalDayIds = new Set(days.filter(d => d.day_type === 'final').map(d => d.id));
    const diaDoInscrito = new Map(allPlayers.map(p => [p.id, p.tournament_day_id]));
    const grupos = new Map();
    for (const venda of transacoes) {
      if ((venda.status || 'active') !== 'active') continue;
      if (!(venda.type in ORDEM_DA_CATEGORIA)) continue; // prêmio não é item vendido
      if (finalDayIds.has(diaDoInscrito.get(venda.tournament_player_id))) continue;
      const chave = venda.buy_type_id || `categoria:${venda.type}`;
      const grupo = grupos.get(chave) || {
        key: chave,
        name: (venda.buy_type_name || '').trim() || rotuloDaCategoria[venda.type],
        category: venda.type,
        count: 0,
        amount: 0,
      };
      grupo.count += 1;
      grupo.amount += Number(venda.amount) || 0;
      grupos.set(chave, grupo);
    }
    return [...grupos.values()].sort((a, b) => (
      (ORDEM_DA_CATEGORIA[a.category] - ORDEM_DA_CATEGORIA[b.category])
      || a.name.localeCompare(b.name)
    ));
  }, [transacoes, allPlayers, days, t]);

  // Linhas da tabela de itens: por meio de entrada quando as vendas
  // carregaram; senão, por categoria (dos inscritos), como era.
  const linhasDeItens = itensVendidos || [
    { key: 'buy_in', name: t('tournamentDashboard.tournamentBuyIn'), count: financials.totalBuyInsCount, amount: financials.totalBuyInsRevenue },
    ...(financials.totalRebuysCount > 0
      ? [{ key: 'rebuy', name: t('tournamentDashboard.rebuy'), count: financials.totalRebuysCount, amount: financials.totalRebuysRevenue }]
      : []),
    ...(financials.totalAddonsCount > 0
      ? [{ key: 'addon', name: t('tournamentDashboard.addon'), count: financials.totalAddonsCount, amount: financials.totalAddonsRevenue }]
      : []),
  ];

  if (loading) {
    const content = <div className="loading">{t('common.loading')}</div>;

    if (isStandalone) {
      return (
        <div className="app-container">
          <Sidebar />
          <main className="main-content">
            {content}
          </main>
        </div>
      );
    }
    return content;
  }

  if (!tournament) {
    const content = (
      <Card>
        <p>{t('tournamentDashboard.tournamentNotFound')}</p>
        {isStandalone && <Button onClick={() => navigate('/torneios')}>{t('common.back')}</Button>}
      </Card>
    );

    if (isStandalone) {
      return (
        <div className="app-container">
          <Sidebar />
          <main className="main-content">
            {content}
          </main>
        </div>
      );
    }
    return content;
  }

  if (days.length === 0) {
    const content = (
      <div className="empty-days-professional">
        <div className="empty-days-line" />
        <h3>{t('tournamentDashboard.noDaysConfigured')}</h3>
        <p>{t('tournamentDashboard.noDaysHint')}</p>
      </div>
    );

    if (isStandalone) {
      return (
        <div className="app-container">
          <Sidebar />
          <main className="main-content">
            <div className="page-header">
              <div>
                <h1>{tournament.name}</h1>
                <p className="subtitle">{t('tournamentDashboard.subtitle')}</p>
              </div>
              <Button variant="secondary" onClick={() => navigate('/torneios')}>
                {t('common.back')}
              </Button>
            </div>
            {content}
          </main>
        </div>
      );
    }
    return content;
  }

  const dashboardContent = (
    <>
      {isStandalone && (
        <div className="page-header">
          <div>
            <h1>{tournament.name}</h1>
            <p className="subtitle">{t('tournamentDashboard.subtitle')}</p>
          </div>
          <Button variant="secondary" onClick={() => navigate('/torneios')}>
            {t('common.back')}
          </Button>
        </div>
      )}

      <div className="dashboard-grid">
        {/* Resultados do Torneio */}
        <Card className="results-card">
          <h3 className="card-title">{t('tournamentDashboard.tournamentResults')}</h3>
          <div className="financial-row">
            <span className="label">{t('tournamentDashboard.totalRevenue')}</span>
            <span className="value positive">{formatCurrency(financials.totalRevenue)}</span>
          </div>
          <div className="financial-row">
            <span className="label">
              {t('tournamentDashboard.adminFee', { rake: financials.averageRakePercentage.toFixed(1) })}
            </span>
            <span className="value negative">- {formatCurrency(financials.rake)}</span>
          </div>
          <div className="financial-row">
            <span className="label">{t('tournamentDashboard.tournamentBank')}</span>
            <span className="value positive">{formatCurrency(financials.prizePool)}</span>
          </div>
          <div className="financial-row">
            <span className="label">{t('tournamentDashboard.itemStake')}</span>
            <span className="value neutral">{formatCurrency(0)}</span>
          </div>
          <div className="financial-row total">
            <span className="label">{t('tournamentDashboard.prizeCost')}</span>
            <span className="value positive">{formatCurrency(financials.prizePool)}</span>
          </div>
        </Card>

        {/* Premiações e Rake */}
        <Card className="prizes-card">
          <h3 className="card-title">{t('tournamentDashboard.prizesAndRake')}</h3>
          <div className="financial-row">
            <span className="label">{t('tournamentDashboard.description')}</span>
            <span className="value">{t('tournamentDashboard.value')}</span>
          </div>
          <div className="financial-row">
            <span className="label">{t('tournamentDashboard.tournamentBalance')}</span>
            <span className="value positive">{formatCurrency(financials.totalRevenue)}</span>
          </div>
          <div className="financial-row">
            <span className="label">
              {t('tournamentDashboard.rakeAverage', { rake: financials.averageRakePercentage.toFixed(1) })}
            </span>
            <span className="value negative">- {formatCurrency(financials.rake)}</span>
          </div>
          <div className="financial-row total">
            <span className="label">{t('tournamentDashboard.prizePool')}</span>
            <span className="value positive">{formatCurrency(financials.prizePool)}</span>
          </div>
        </Card>
      </div>

      {/* Items Summary Section */}
      <div className="items-section">
        <h3 className="section-title">{t('tournamentDashboard.tournamentItems', { count: days.filter(d => d.day_type !== 'final').length, unit: days.filter(d => d.day_type !== 'final').length === 1 ? t('tournamentDashboard.day') : t('tournamentDashboard.days') })}</h3>

        <div className="players-details-table">
          <table className="details-table">
            <thead>
              <tr>
                <th>{t('tournamentDashboard.itemColumn')}</th>
                <th className="text-center">{t('tournamentDashboard.wonQty')}</th>
                <th className="text-right">{t('tournamentDashboard.value')}</th>
                <th className="text-right">{t('tournamentDashboard.fee')}</th>
                <th className="text-right">{t('tournamentDashboard.userNote')}</th>
                <th className="text-right">{t('common.total')}</th>
              </tr>
            </thead>
            <tbody>
              {linhasDeItens.map((item) => (
                <tr key={item.key} data-testid="linha-item">
                  <td>{item.name}</td>
                  <td className="text-center">{item.count}</td>
                  <td className="text-right">{formatCurrency(item.amount)}</td>
                  <td className="text-right">{formatCurrency(0)}</td>
                  <td className="text-right">{formatCurrency(item.amount)}</td>
                  <td className="text-right total-value">{formatCurrency(item.amount)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </>
  );

  if (isStandalone) {
    return (
      <div className="app-container">
        <Sidebar />
        <main className="main-content">
          {dashboardContent}
        </main>
      </div>
    );
  }

  return dashboardContent;
};

export default TournamentDashboard;
