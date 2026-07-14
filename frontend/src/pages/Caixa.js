import React, { useEffect, useState, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import Sidebar from '../components/Sidebar';
import Card from '../components/Card';
import Button from '../components/Button';
import PlayerSelect from '../components/PlayerSelect';
import SeatTicket from '../components/SeatTicket';
import EmptyState from '../components/EmptyState';
import CashboxBanner from '../components/CashboxBanner';
import { SkeletonStatCard, SkeletonTableRow } from '../components/SkeletonLoader';
import api from '../config/api';
import { useToast } from '../contexts/ToastContext';
import { useCurrency } from '../contexts/CurrencyContext';
import { usePaymentMethods } from '../contexts/PaymentMethodsContext';
import { useBuyTypes } from '../contexts/BuyTypesContext';
import { methodLabel } from '../utils/paymentMethodLabels';
import { usePolling } from '../hooks/usePolling';
import { offlineWrite, offlineRead } from '../offline/apiOffline';
import { applyRegister, applyRebuy, applyAddon } from '../offline/domainRules';
import { uuid, putEntities, getEntity, getAllByTable } from '../offline/db';
import { isOnline } from '../offline/connectivity';
import './Caixa.css';

const Caixa = () => {
  const { t } = useTranslation();
  const { formatCurrency } = useCurrency();
  const { activeMethods } = usePaymentMethods();
  const { activeBuyTypes } = useBuyTypes();

  const buyCategoryLabel = (c) =>
    c === 'rebuy' ? t('cashRegister.rebuy', 'Rebuy') : c === 'addon' ? t('cashRegister.addon', 'Add-on') : t('cashRegister.buyIn', 'Buy-in');

  // Ao escolher um tipo de buy, ele define a categoria (type) e o rake. O VALOR
  // da entrada vem da configuração do dia do torneio, não do tipo.
  const handleBuyTypeChange = (e) => {
    const id = e.target.value;
    const bt = activeBuyTypes.find((b) => b.id === id);
    if (bt) {
      setFormData((prev) => ({ ...prev, buy_type_id: id, type: bt.category }));
    } else {
      setFormData((prev) => ({ ...prev, buy_type_id: '' }));
    }
  };
  const [transactions, setTransactions] = useState([]);
  const [tournaments, setTournaments] = useState([]);
  const [tournamentDays, setTournamentDays] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showModal, setShowModal] = useState(false);
  const [showTicketModal, setShowTicketModal] = useState(false);
  const [allocationData, setAllocationData] = useState(null);
  const { toast } = useToast();
  const [playerCredit, setPlayerCredit] = useState(0);
  // Caixa modular do operador: undefined=carregando, null=super-admin/sem caixa, obj=caixa
  const [myCashbox, setMyCashbox] = useState(undefined);
  // ID da transação cujo bilhete está sendo rebuscado para reimpressão (null = nenhum)
  const [reprintingId, setReprintingId] = useState(null);

  // Bloqueia novas transações se o operador tem um caixa que não está aberto.
  // myCashbox null (super-admin/sem caixa) ou undefined (carregando) → não bloqueia.
  const cashboxBlocked = !!myCashbox && myCashbox.status !== 'open';
  const [formData, setFormData] = useState({
    tournament_id: '',
    tournament_day_id: '',
    player_id: '',
    type: 'buy_in',
    amount: '',
    payment_method: 'cash',
    payment_source: 'cash',
    rebuy_quantity: 1,
    buy_type_id: '',
  });

  useEffect(() => {
    loadData();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Polling que pausa quando a aba está oculta (reduz carga em produção).
  usePolling(() => loadData(), 5000);

  // Hidrata os tipos de buy na réplica offline (definem o rake).
  useEffect(() => {
    if (activeBuyTypes?.length) putEntities('buy_types', activeBuyTypes);
  }, [activeBuyTypes]);

  // Mantém o método de pagamento selecionado válido conforme a lista configurada
  // (ex.: se "Dinheiro" foi removido, cai para o primeiro método ativo).
  useEffect(() => {
    if (activeMethods.length === 0) return;
    setFormData((prev) =>
      activeMethods.some((m) => m.code === prev.payment_method)
        ? prev
        : { ...prev, payment_method: activeMethods[0].code }
    );
  }, [activeMethods]);

  const loadData = async () => {
    try {
      // ISSUE-004 fix: use separate calls so one failure doesn't block the other
      const [transactionsRes, tournamentsRes, playersRes] = await Promise.all([
        api.get('/transactions').catch(() => ({ data: [] })),
        api.get('/tournaments?status=active,pending').catch(() => ({ data: [] })),
        api.get('/players').catch(() => ({ data: null })),
      ]);
      setTransactions(transactionsRes.data || []);
      setTournaments(tournamentsRes.data || []);
      // Hidrata a réplica offline (para registrar/consultar sem internet)
      if (tournamentsRes.data?.length) putEntities('tournaments', tournamentsRes.data);
      if (playersRes.data?.length) putEntities('players', playersRes.data);
    } catch (error) {
      console.error('Erro ao carregar dados:', error);
    } finally {
      setLoading(false);
    }
  };

  const loadTournamentDays = async (tournamentId) => {
    if (!tournamentId) {
      setTournamentDays([]);
      return;
    }
    try {
      const response = await api.get(`/tournament-days/tournament/${tournamentId}`);
      // Filter only active/pending days and exclude final days (no buy-ins for finals)
      const activeDays = response.data.filter(day =>
        (day.status === 'active' || day.status === 'pending') && day.day_type !== 'final'
      );
      setTournamentDays(activeDays);
      // Hidrata os dias na réplica (buy_in/rake/chips/registered_players offline)
      if (response.data?.length) putEntities('tournament_days', response.data);
    } catch (error) {
      console.error('Erro ao carregar dias do torneio:', error);
      setTournamentDays([]);
    }
  };

  const handleSubmit = async (e) => {
    e.preventDefault();

    // Caixa modular: bloqueia se o operador não abriu o caixa
    if (cashboxBlocked) {
      toast.warning(t('cashbox.blockedHint'));
      return;
    }

    // Validate that a day is selected if days exist
    if (tournamentDays.length > 0 && !formData.tournament_day_id) {
      toast.warning(t('cashRegister.selectDayWarning'));
      return;
    }

    try {
      // If it's a buy_in, register the player in the tournament day
      if (formData.type === 'buy_in') {
        // Camada offline: online chama o backend; sem rede, aplica na réplica e
        // enfileira (com id gerado no cliente p/ idempotência e p/ rebuy referenciar).
        const clientTpId = uuid();
        const clientMutId = uuid();
        const regBody = {
          tournament_id: formData.tournament_id,
          tournament_day_id: formData.tournament_day_id || null,
          player_id: formData.player_id,
          buy_in_count: 1,
          payment_source: formData.payment_source || 'cash',
          payment_method: formData.payment_method || 'cash',
          buy_type_id: formData.buy_type_id || null,
          notes: `Registrado via Caixa - ${formData.payment_method}`,
          client_id: clientTpId,
          client_mutation_id: clientMutId,
        };
        const reg = await offlineWrite({
          kind: 'register', method: 'post', url: '/tournament-players', body: regBody,
          clientEntityIds: { tournament_players: clientTpId },
          clientMutationId: clientMutId,
          meta: { kind: 'register', player_id: formData.player_id, tournament_id: formData.tournament_id },
          synthetic: { id: clientTpId },
          applyLocal: () => applyRegister(regBody),
        });

        // Check allocation: prefer day-scoped if a day is selected
        const tournament = tournaments.find(t => t.id === formData.tournament_id);
        const selectedDay = tournamentDays.find(d => d.id === formData.tournament_day_id);

        if (reg.offline) {
          // Offline: sem auto-assento (o servidor aloca no sync) — bilhete de alternado.
          const pInfo = await offlineRead(`/players/${formData.player_id}`, {
            fromReplica: () => getEntity('players', formData.player_id),
          });
          setAllocationData({
            player_name: (pInfo && pInfo.name) || '—',
            tournament_name: tournament?.name || '',
            day_name: selectedDay?.day_name || '',
            is_alternate: true,
            offline: true,
            created_at: new Date().toISOString(),
            id: formData.player_id,
          });
          setShowTicketModal(true);
          toast.success(t('offline.savedOffline', 'Salvo offline — será enviado ao sincronizar'));
        }

        const allocationTypeToUse = selectedDay?.allocation_type || tournament?.allocation_type;
        const tablesLocked = selectedDay?.tables_locked ?? false;

        if (!reg.offline && allocationTypeToUse === 'automatic') {
          if (tablesLocked) {
            // Tables are locked — player becomes alternate, show alternate ticket
            setAllocationData({
              player_name: null, // filled below
              tournament_name: tournament?.name || '',
              day_name: selectedDay?.day_name || '',
              is_alternate: true,
              created_at: new Date().toISOString(),
              id: formData.player_id,
            });
            // Fetch player name for ticket
            try {
              const pRes = await api.get(`/players/${formData.player_id}`);
              setAllocationData(prev => ({ ...prev, player_name: pRes.data.name }));
            } catch (_) {
              setAllocationData(prev => ({ ...prev, player_name: '—' }));
            }
            setShowTicketModal(true);
          } else {
            try {
              let allocationResponse;
              if (formData.tournament_day_id) {
                // Day-scoped auto-allocation
                allocationResponse = await api.post(
                  `/allocations/day/${formData.tournament_day_id}/auto?player_id=${formData.player_id}`
                );
              } else {
                // Tournament-scoped fallback
                allocationResponse = await api.post(
                  `/allocations/tournament/${formData.tournament_id}/auto?player_id=${formData.player_id}`
                );
              }
              setAllocationData({
                ...allocationResponse.data,
                day_name: selectedDay?.day_name || allocationResponse.data.day_name || '',
              });
              setShowTicketModal(true);
            } catch (allocationError) {
              console.error('Erro ao alocar jogador:', allocationError);
              const errDetail = allocationError.response?.data?.detail || '';
              const noSeats = errDetail.toLowerCase().includes('tables are full')
                || errDetail.toLowerCase().includes('no active tables');
              if (noSeats) {
                // No seats available — player becomes alternate
                const baseData = {
                  player_name: null,
                  tournament_name: tournament?.name || '',
                  day_name: selectedDay?.day_name || '',
                  is_alternate: true,
                  created_at: new Date().toISOString(),
                  id: formData.player_id,
                };
                setAllocationData(baseData);
                try {
                  const pRes = await api.get(`/players/${formData.player_id}`);
                  setAllocationData(prev => ({ ...prev, player_name: pRes.data.name }));
                } catch (_) {
                  setAllocationData(prev => ({ ...prev, player_name: '—' }));
                }
                setShowTicketModal(true);
              } else {
                const errorMsg = errDetail || 'Erro desconhecido';
                toast.warning(t('cashRegister.allocationManualWarning', { reason: errorMsg }));
              }
            }
          }
        }
      } else if (formData.type === 'rebuy') {
        // Resolve o jogador (online: backend; offline: réplica) e hidrata a réplica.
        const tpList = await offlineRead(`/tournament-players/tournament/${formData.tournament_id}`, {
          fromReplica: async () => (await getAllByTable('tournament_players')).filter(p => p.tournament_id === formData.tournament_id),
        });
        if (tpList?.length) putEntities('tournament_players', tpList);
        const tournamentPlayer = (tpList || []).find(p => p.player_id === formData.player_id);
        if (tournamentPlayer) {
          // If player was eliminated, remove from ranking first (só online)
          if (tournamentPlayer.status === 'eliminated' && isOnline()) {
            try {
              await api.delete(`/rankings/tournament-player/${tournamentPlayer.id}/ranking`);
            } catch (rankingError) {
              console.error('Error removing from ranking:', rankingError);
            }
          }

          // Process the rebuy(s) — supports multiple rebuys at once ("recompra dupla").
          const rebuyQty = Math.max(1, parseInt(formData.rebuy_quantity, 10) || 1);
          let rebuyOffline = false;
          for (let i = 0; i < rebuyQty; i++) {
            const cmid = uuid();
            const rbBody = {
              tournament_player_id: tournamentPlayer.id,
              payment_source: formData.payment_source || 'cash',
              payment_method: formData.payment_method || 'cash',
              buy_type_id: formData.buy_type_id || null,
              client_mutation_id: cmid,
            };
            const rr = await offlineWrite({
              kind: 'rebuy', method: 'post',
              url: `/tournament-players/${tournamentPlayer.id}/rebuy`,
              params: { payment_source: rbBody.payment_source, payment_method: rbBody.payment_method, ...(formData.buy_type_id ? { buy_type_id: formData.buy_type_id } : {}) },
              body: rbBody,
              clientMutationId: cmid,
              meta: { kind: 'rebuy', player_id: formData.player_id },
              synthetic: { ok: true },
              applyLocal: () => applyRebuy(rbBody),
            });
            if (rr.offline) rebuyOffline = true;
          }

          const tournament = tournaments.find(t => t.id === formData.tournament_id);
          const selectedDay = tournamentDays.find(d => d.id === formData.tournament_day_id);

          if (rebuyOffline) {
            const pInfo = await offlineRead(`/players/${formData.player_id}`, { fromReplica: () => getEntity('players', formData.player_id) });
            setAllocationData({ player_name: (pInfo && pInfo.name) || '—', tournament_name: tournament?.name || '', day_name: selectedDay?.day_name || '', is_alternate: true, offline: true, created_at: new Date().toISOString(), id: formData.player_id });
            setShowTicketModal(true);
            toast.success(t('offline.savedOffline', 'Salvo offline — será enviado ao sincronizar'));
          }

          const allocationTypeToUse = selectedDay?.allocation_type || tournament?.allocation_type;
          const tablesLocked = selectedDay?.tables_locked ?? false;

          if (!rebuyOffline && allocationTypeToUse === 'automatic') {
            if (tablesLocked) {
              setAllocationData({
                player_name: null,
                tournament_name: tournament?.name || '',
                day_name: selectedDay?.day_name || '',
                is_alternate: true,
                created_at: new Date().toISOString(),
                id: formData.player_id,
              });
              try {
                const pRes = await api.get(`/players/${formData.player_id}`);
                setAllocationData(prev => ({ ...prev, player_name: pRes.data.name }));
              } catch (_) {
                setAllocationData(prev => ({ ...prev, player_name: '—' }));
              }
              setShowTicketModal(true);
            } else {
              try {
                let allocationResponse;
                if (formData.tournament_day_id) {
                  allocationResponse = await api.post(
                    `/allocations/day/${formData.tournament_day_id}/auto?player_id=${formData.player_id}`
                  );
                } else {
                  allocationResponse = await api.post(
                    `/allocations/tournament/${formData.tournament_id}/auto?player_id=${formData.player_id}`
                  );
                }
                setAllocationData({
                  ...allocationResponse.data,
                  day_name: selectedDay?.day_name || allocationResponse.data.day_name || '',
                });
                setShowTicketModal(true);
              } catch (allocationError) {
                console.error('Erro ao alocar jogador após rebuy:', allocationError);
                const errDetail = allocationError.response?.data?.detail || '';
                const noSeats = errDetail.toLowerCase().includes('tables are full')
                  || errDetail.toLowerCase().includes('no active tables');
                if (noSeats) {
                  const baseData = {
                    player_name: null,
                    tournament_name: tournament?.name || '',
                    day_name: selectedDay?.day_name || '',
                    is_alternate: true,
                    created_at: new Date().toISOString(),
                    id: formData.player_id,
                  };
                  setAllocationData(baseData);
                  try {
                    const pRes = await api.get(`/players/${formData.player_id}`);
                    setAllocationData(prev => ({ ...prev, player_name: pRes.data.name }));
                  } catch (_) {
                    setAllocationData(prev => ({ ...prev, player_name: '—' }));
                  }
                  setShowTicketModal(true);
                } else {
                  const errorMsg = errDetail || 'Erro desconhecido';
                  toast.warning(t('cashRegister.rebuyAllocationManualWarning', { reason: errorMsg }));
                }
              }
            }
          }
        } else {
          toast.error(t('cashRegister.playerNotRegistered'));
          return;
        }
      } else if (formData.type === 'addon') {
        // Resolve o jogador (online: backend; offline: réplica) e hidrata a réplica.
        const tpList = await offlineRead(`/tournament-players/tournament/${formData.tournament_id}`, {
          fromReplica: async () => (await getAllByTable('tournament_players')).filter(p => p.tournament_id === formData.tournament_id),
        });
        if (tpList?.length) putEntities('tournament_players', tpList);
        const tournamentPlayer = (tpList || []).find(p => p.player_id === formData.player_id);
        if (tournamentPlayer) {
          const cmid = uuid();
          const adBody = {
            tournament_player_id: tournamentPlayer.id,
            payment_source: formData.payment_source || 'cash',
            payment_method: formData.payment_method || 'cash',
            buy_type_id: formData.buy_type_id || null,
            client_mutation_id: cmid,
          };
          const ar = await offlineWrite({
            kind: 'addon', method: 'post',
            url: `/tournament-players/${tournamentPlayer.id}/addon`,
            params: { payment_source: adBody.payment_source, payment_method: adBody.payment_method, ...(formData.buy_type_id ? { buy_type_id: formData.buy_type_id } : {}) },
            body: adBody,
            clientMutationId: cmid,
            meta: { kind: 'addon', player_id: formData.player_id },
            synthetic: { ok: true },
            applyLocal: () => applyAddon(adBody),
          });
          if (ar.offline) toast.success(t('offline.savedOffline', 'Salvo offline — será enviado ao sincronizar'));
        } else {
          toast.error(t('cashRegister.playerNotRegistered'));
          return;
        }
      }

      setShowModal(false);
      setFormData({
        tournament_id: '',
        tournament_day_id: '',
        player_id: '',
        type: 'buy_in',
        amount: '',
        payment_method: 'cash',
        payment_source: 'cash',
        rebuy_quantity: 1,
        buy_type_id: '',
      });
      setPlayerCredit(0);
      setTournamentDays([]);
      loadData();
    } catch (error) {
      // ISSUE-004 fix: use userMessage from global interceptor for readable error
      const errorMessage =
        error.userMessage ||
        error.response?.data?.detail ||
        t('cashRegister.registerError');
      toast.error(typeof errorMessage === 'string' ? errorMessage : t('cashRegister.registerError'));
    }
  };

  // Reimprime o bilhete de um jogador a partir de uma transação já registrada.
  // Útil quando a impressora falha ou o jogador perde o bilhete após fechar o
  // pop-up. Busca a alocação atual (mesa/assento) do jogador; se não houver
  // assento, reimprime como alternate.
  const handleReprint = async (transaction) => {
    setReprintingId(transaction.id);
    try {
      const res = await api
        .get(`/allocations/tournament/${transaction.tournament_id}`)
        .catch(() => ({ data: [] }));
      const alloc = (res.data || []).find(a => a.player_id === transaction.player_id);

      if (alloc) {
        setAllocationData({
          id: alloc.id,
          player_name: transaction.player_name || alloc.players?.name || '—',
          tournament_name: transaction.tournament_name || '',
          day_name: alloc.day_name || '',
          table_number: alloc.tournament_tables?.table_number,
          seat_number: alloc.seat_number,
          created_at: alloc.created_at || transaction.created_at,
          is_alternate: false,
          is_reprint: true,
        });
      } else {
        // Sem assento alocado → jogador é alternate (ou torneio com alocação manual)
        setAllocationData({
          id: transaction.player_id,
          player_name: transaction.player_name || '—',
          tournament_name: transaction.tournament_name || '',
          day_name: '',
          is_alternate: true,
          created_at: transaction.created_at,
          is_reprint: true,
        });
      }
      setShowTicketModal(true);
    } catch (error) {
      toast.error(t('cashRegister.reprintError'));
    } finally {
      setReprintingId(null);
    }
  };

  const loadPlayerCredit = async (playerId) => {
    if (!playerId) {
      setPlayerCredit(0);
      return;
    }
    try {
      const res = await api.get(`/player-credits/player/${playerId}/balance`);
      setPlayerCredit(res.data.available_credit || 0);
    } catch (err) {
      setPlayerCredit(0);
    }
  };

  const handleChange = async (e) => {
    const { name, value } = e.target;

    let newFormData = {
      ...formData,
      [name]: value,
    };

    // When player changes, load their available credit
    if (name === 'player_id') {
      loadPlayerCredit(value);
      newFormData.payment_source = 'cash'; // Reset to cash when changing player
    }

    // When tournament changes, load days and reset day selection
    if (name === 'tournament_id') {
      newFormData.tournament_day_id = '';
      loadTournamentDays(value);
    }

    // Auto-fill amount based on tournament day or tournament and transaction type
    if (name === 'tournament_id' || name === 'tournament_day_id' || name === 'type') {
      const tournamentId = name === 'tournament_id' ? value : formData.tournament_id;
      const dayId = name === 'tournament_day_id' ? value : newFormData.tournament_day_id;
      const transactionType = name === 'type' ? value : formData.type;

      // Try to get values from day first, then fallback to tournament
      let amount = 0;
      const selectedDay = tournamentDays.find(d => d.id === dayId);
      const tournament = tournaments.find(t => t.id === tournamentId);

      if (selectedDay) {
        // Use day-specific values
        switch (transactionType) {
          case 'buy_in':
            amount = selectedDay.buy_in;
            break;
          case 'rebuy':
            amount = selectedDay.rebuy_amount || selectedDay.buy_in;
            break;
          case 'addon':
            amount = selectedDay.addon_amount || selectedDay.buy_in;
            break;
          default:
            amount = selectedDay.buy_in;
        }
      } else if (tournament) {
        // Fallback to tournament values
        switch (transactionType) {
          case 'buy_in':
            amount = tournament.buy_in;
            break;
          case 'rebuy':
            amount = tournament.rebuy || tournament.buy_in;
            break;
          case 'addon':
            amount = tournament.addon || tournament.buy_in;
            break;
          default:
            amount = tournament.buy_in;
        }
      }

      newFormData.amount = amount;
    }

    setFormData(newFormData);
  };

  const getTransactionTypeBadge = (type) => {
    const types = {
      buy_in: { label: 'Buy-in', className: 'badge-success' },
      rebuy: { label: 'Rebuy', className: 'badge-warning' },
      addon: { label: 'Add-on', className: 'badge-info' },
    };
    const badge = types[type] || types.buy_in;
    return <span className={`badge ${badge.className}`}>{badge.label}</span>;
  };

  // Memoizado: só recalcula quando a lista de transações muda (não a cada render).
  const totals = useMemo(() => {
    const acc = { buy_in: 0, rebuy: 0, addon: 0, total: 0 };
    transactions.forEach(t => {
      const v = parseFloat(t.amount) || 0;
      if (acc[t.type] !== undefined) acc[t.type] += v;
      acc.total += v;
    });
    return acc;
  }, [transactions]);

  const handleNewTransaction = () => {
    if (cashboxBlocked) {
      toast.warning(t('cashbox.blockedHint'));
      return;
    }
    setShowModal(true);
  };

  return (
    <div className="app-container">
      <Sidebar />
      <main className="main-content">
        {/* ── Page header (A9) ── */}
        <div className="cx-header">
          <div className="cx-header-left">
            <div className="cx-header-icon">
              <svg viewBox="0 0 24 24" fill="currentColor">
                <path d="M11.8 10.9c-2.27-.59-3-1.2-3-2.15 0-1.09 1.01-1.85 2.7-1.85 1.78 0 2.44.85 2.5 2.1h2.21c-.07-1.72-1.12-3.3-3.21-3.81V3h-3v2.16c-1.94.42-3.5 1.68-3.5 3.61 0 2.31 1.91 3.46 4.7 4.13 2.5.6 3 1.48 3 2.41 0 .69-.49 1.79-2.7 1.79-2.06 0-2.87-.92-2.98-2.1h-2.2c.12 2.19 1.76 3.42 3.68 3.83V21h3v-2.15c1.95-.37 3.5-1.5 3.5-3.55 0-2.84-2.43-3.81-4.7-4.4z"/>
              </svg>
            </div>
            <div>
              <h1 className="cx-title">{t('cashRegister.title')}</h1>
              <p className="cx-subtitle">{t('cashRegister.subtitle')}</p>
            </div>
          </div>
          <Button onClick={handleNewTransaction} disabled={cashboxBlocked}>
            {t('cashRegister.newTransaction')}
          </Button>
        </div>

        {/* Caixa modular do operador (banner + abrir/fechar) */}
        <CashboxBanner onStateChange={setMyCashbox} />

        {/* B1: Skeleton nos KPI cards enquanto carrega */}
        <div className="stats-grid">
          {loading ? (
            <>
              <SkeletonStatCard />
              <SkeletonStatCard />
              <SkeletonStatCard />
              <SkeletonStatCard />
            </>
          ) : (
            <>
              <Card className="stat-card">
                <div className="cx-stat-icon">
                  <svg viewBox="0 0 24 24" fill="currentColor"><path d="M11.8 10.9c-2.27-.59-3-1.2-3-2.15 0-1.09 1.01-1.85 2.7-1.85 1.78 0 2.44.85 2.5 2.1h2.21c-.07-1.72-1.12-3.3-3.21-3.81V3h-3v2.16c-1.94.42-3.5 1.68-3.5 3.61 0 2.31 1.91 3.46 4.7 4.13 2.5.6 3 1.48 3 2.41 0 .69-.49 1.79-2.7 1.79-2.06 0-2.87-.92-2.98-2.1h-2.2c.12 2.19 1.76 3.42 3.68 3.83V21h3v-2.15c1.95-.37 3.5-1.5 3.5-3.55 0-2.84-2.43-3.81-4.7-4.4z"/></svg>
                </div>
                <div className="stat-info">
                  <h3>{formatCurrency(totals.buy_in)}</h3>
                  <p>{t('cashRegister.totalBuyIns')}</p>
                </div>
              </Card>
              <Card className="stat-card">
                <div className="cx-stat-icon">
                  <svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-6h2v6zm0-8h-2V7h2v2z"/></svg>
                </div>
                <div className="stat-info">
                  <h3>{formatCurrency(totals.rebuy)}</h3>
                  <p>{t('cashRegister.totalRebuys')}</p>
                </div>
              </Card>
              <Card className="stat-card">
                <div className="cx-stat-icon">
                  <svg viewBox="0 0 24 24" fill="currentColor"><path d="M19 3H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm-7 3c1.93 0 3.5 1.57 3.5 3.5S13.93 13 12 13s-3.5-1.57-3.5-3.5S10.07 6 12 6zm7 13H5v-.23c0-.62.28-1.2.76-1.58C7.47 15.82 9.64 15 12 15s4.53.82 6.24 2.19c.48.38.76.97.76 1.58V19z"/></svg>
                </div>
                <div className="stat-info">
                  <h3>{formatCurrency(totals.addon)}</h3>
                  <p>{t('cashRegister.totalAddons')}</p>
                </div>
              </Card>
              <Card className="stat-card">
                <div className="cx-stat-icon cx-stat-icon--total">
                  <svg viewBox="0 0 24 24" fill="currentColor"><path d="M3 13h2v-2H3v2zm0 4h2v-2H3v2zm0-8h2V7H3v2zm4 4h14v-2H7v2zm0 4h14v-2H7v2zM7 7v2h14V7H7z"/></svg>
                </div>
                <div className="stat-info">
                  <h3 className="cx-stat-total">{formatCurrency(totals.total)}</h3>
                  <p>{t('cashRegister.totalGeneral')}</p>
                </div>
              </Card>
            </>
          )}
        </div>

        <Card title={t('cashRegister.recentTransactions')}>
          {loading ? (
            /* B1: Skeleton table rows */
            <table className="transactions-table">
              <thead>
                <tr>
                  <th>{t('common.date','Data')}</th><th>{t('cashRegister.player','Jogador')}</th><th>{t('cashRegister.tournament','Torneio')}</th><th>{t('cashRegister.type','Tipo')}</th><th>{t('cashRegister.amount','Valor')}</th><th>{t('cashRegister.actions','Ações')}</th>
                </tr>
              </thead>
              <tbody>
                <SkeletonTableRow cols={6} />
                <SkeletonTableRow cols={6} />
                <SkeletonTableRow cols={6} />
                <SkeletonTableRow cols={6} />
              </tbody>
            </table>
          ) : transactions.length === 0 ? (
            /* A2: EmptyState unificado */
            <EmptyState
              icon={null}
              title={t('cashRegister.noTransactions')}
              subtitle={t('cashRegister.noTransactionsHint')}
            />
          ) : (
            <div className="table-container">
              <table className="transactions-table">
                <thead>
                  <tr>
                    <th>{t('common.date','Data')}</th>
                    <th>{t('cashRegister.player','Jogador')}</th>
                    <th>{t('cashRegister.tournament','Torneio')}</th>
                    <th>{t('cashRegister.type','Tipo')}</th>
                    <th>{t('cashRegister.amount','Valor')}</th>
                    <th>{t('cashRegister.actions','Ações')}</th>
                  </tr>
                </thead>
                <tbody>
                  {transactions.map((transaction) => (
                    <tr key={transaction.id}>
                      <td>{new Date(transaction.created_at).toLocaleString('pt-BR')}</td>
                      <td>
                        {transaction.player_name}
                        {transaction.player_nickname && (
                          <span className="player-nickname"> ({transaction.player_nickname})</span>
                        )}
                      </td>
                      <td>{transaction.tournament_name}</td>
                      <td>{getTransactionTypeBadge(transaction.type)}</td>
                      <td className="amount">{formatCurrency(transaction.amount)}</td>
                      <td>
                        {(transaction.type === 'buy_in' || transaction.type === 'rebuy') && (
                          <button
                            type="button"
                            className="reprint-btn"
                            title={t('cashRegister.reprintTooltip')}
                            disabled={reprintingId === transaction.id}
                            onClick={() => handleReprint(transaction)}
                          >
                            <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden="true">
                              <path d="M19 8H5c-1.66 0-3 1.34-3 3v6h4v4h12v-4h4v-6c0-1.66-1.34-3-3-3zm-3 11H8v-5h8v5zm3-7c-.55 0-1-.45-1-1s.45-1 1-1 1 .45 1 1-.45 1-1 1zm-1-9H6v4h12V3z"/>
                            </svg>
                            <span>{reprintingId === transaction.id ? '…' : t('cashRegister.reprint')}</span>
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>

        {showModal && (
          <div className="modal-overlay" onClick={() => setShowModal(false)}>
            <div className="modal" onClick={(e) => e.stopPropagation()}>
              <div className="modal-header">
                <h2>{t('cashRegister.newTransaction')}</h2>
                <button className="close-btn" onClick={() => setShowModal(false)} aria-label="Fechar">
                  <span className="close-icon"></span>
                </button>
              </div>
              <form onSubmit={handleSubmit}>
                <div className="form-group">
                  <label htmlFor="tournament_id">{t('cashRegister.tournament')}</label>
                  <select
                    id="tournament_id"
                    name="tournament_id"
                    value={formData.tournament_id}
                    onChange={handleChange}
                    required
                  >
                    <option value="">{t('cashRegister.selectTournament')}</option>
                    {tournaments.map((tournament) => (
                      <option key={tournament.id} value={tournament.id}>
                        {tournament.name}
                      </option>
                    ))}
                  </select>
                </div>

                {tournamentDays.length > 0 && (
                  <div className="form-group">
                    <label htmlFor="tournament_day_id">{t('cashRegister.day')}</label>
                    <select
                      id="tournament_day_id"
                      name="tournament_day_id"
                      value={formData.tournament_day_id}
                      onChange={handleChange}
                      required
                    >
                      <option value="">{t('cashRegister.selectDay')}</option>
                      {tournamentDays.map((day) => (
                        <option key={day.id} value={day.id}>
                          {day.day_name} - {formatCurrency(day.buy_in)} ({day.registered_players}/{day.max_players} jogadores)
                        </option>
                      ))}
                    </select>
                  </div>
                )}

                <div className="form-group">
                  <label htmlFor="player_id">{t('cashRegister.player')}</label>
                  <PlayerSelect
                    value={formData.player_id}
                    onChange={handleChange}
                    required
                    name="player_id"
                  />
                </div>

                {activeBuyTypes.length > 0 && (
                  <div className="form-group">
                    <label htmlFor="buy_type_id">{t('cashRegister.buyType', 'Tipo de Buy')}</label>
                    <select
                      id="buy_type_id"
                      name="buy_type_id"
                      value={formData.buy_type_id}
                      onChange={handleBuyTypeChange}
                    >
                      <option value="">{t('cashRegister.buyTypeNone', 'Manual (valor do dia)')}</option>
                      {activeBuyTypes.map((b) => (
                        <option key={b.id} value={b.id}>
                          {b.name} — {buyCategoryLabel(b.category)} · {Number(b.rake_percentage)}% rake
                        </option>
                      ))}
                    </select>
                  </div>
                )}

                <div className="form-row">
                  <div className="form-group">
                    <label htmlFor="type">{t('cashRegister.type')}</label>
                    <select
                      id="type"
                      name="type"
                      value={formData.type}
                      onChange={handleChange}
                      required
                    >
                      <option value="buy_in">{t('cashRegister.buyIn')}</option>
                      <option value="rebuy">{t('cashRegister.rebuy')}</option>
                      <option value="addon">{t('cashRegister.addon')}</option>
                    </select>
                  </div>

                  <div className="form-group">
                    <label htmlFor="amount">{t('cashRegister.amount')}</label>
                    <input
                      id="amount"
                      name="amount"
                      type="number"
                      step="0.01"
                      value={formData.amount}
                      onChange={handleChange}
                      required
                      placeholder="0.00"
                    />
                  </div>
                </div>

                {formData.type === 'rebuy' && (
                  <div className="form-group">
                    <label htmlFor="rebuy_quantity">{t('cashRegister.rebuyQuantity', 'Quantidade de rebuys')}</label>
                    <input
                      id="rebuy_quantity"
                      name="rebuy_quantity"
                      type="number"
                      min="1"
                      max="20"
                      step="1"
                      value={formData.rebuy_quantity}
                      onChange={handleChange}
                    />
                  </div>
                )}

                <div className="form-group">
                  <label htmlFor="payment_method">{t('cashRegister.paymentMethod')}</label>
                  <select
                    id="payment_method"
                    name="payment_method"
                    value={formData.payment_method}
                    onChange={handleChange}
                  >
                    {activeMethods.length === 0 && (
                      <option value="cash">{t('cashRegister.cash')}</option>
                    )}
                    {activeMethods.map((m) => (
                      <option key={m.id} value={m.code}>{methodLabel(t, m)}</option>
                    ))}
                  </select>
                </div>

                {/* Credit payment option - only visible when player has credit */}
                {playerCredit > 0 && formData.player_id && (
                  <div className="form-group cx-credit-option">
                    <label>{t('cashRegister.paymentSource')}</label>
                    <div className="cx-credit-info">
                      <span className="cx-credit-available">
                        {t('cashRegister.availableCredit', { value: formatCurrency(playerCredit) })}
                      </span>
                    </div>
                    <select
                      name="payment_source"
                      value={formData.payment_source}
                      onChange={handleChange}
                    >
                      <option value="cash">{t('cashRegister.paymentSourceCash')}</option>
                      <option value="credit">{t('cashRegister.paymentSourceCredit')}</option>
                      {formData.amount > playerCredit && (
                        <option value="mixed">{t('cashRegister.paymentSourceMixed')}</option>
                      )}
                    </select>
                    {formData.payment_source === 'credit' && formData.amount > playerCredit && (
                      <p className="cx-credit-warning">
                        {t('cashRegister.insufficientCreditWarning')}
                      </p>
                    )}
                  </div>
                )}

                <div className="modal-actions">
                  <Button type="button" variant="secondary" onClick={() => setShowModal(false)}>
                    {t('common.cancel')}
                  </Button>
                  <Button type="submit">{t('cashRegister.register')}</Button>
                </div>
              </form>
            </div>
          </div>
        )}

        {showTicketModal && allocationData && (
          <div className="modal-overlay" onClick={() => { setShowTicketModal(false); loadData(); }}>
            <div className="modal" onClick={(e) => e.stopPropagation()}>
              <div className="modal-header">
                <h2>
                  {allocationData.is_reprint
                    ? t('cashRegister.reprintTitle')
                    : allocationData.is_alternate
                      ? t('cashRegister.registeredAsAlternate')
                      : t('cashRegister.registeredAndAllocated')}
                </h2>
                <button className="close-btn" onClick={() => { setShowTicketModal(false); loadData(); }} aria-label="Fechar">
                  <span className="close-icon"></span>
                </button>
              </div>
              <div className="modal-body">
                <SeatTicket
                  allocation={{
                    id: allocationData.id,
                    player_name: allocationData.player_name,
                    tournament_name: allocationData.tournament_name,
                    day_name: allocationData.day_name,
                    table_number: allocationData.table_number,
                    seat_number: allocationData.seat_number,
                    created_at: allocationData.created_at,
                    is_alternate: allocationData.is_alternate,
                  }}
                  onPrint={() => {
                    setShowTicketModal(false);
                    loadData();
                  }}
                />
              </div>
              <div className="modal-actions">
                <Button onClick={() => { setShowTicketModal(false); loadData(); }}>
                  {t('common.close')}
                </Button>
              </div>
            </div>
          </div>
        )}
      </main>
    </div>
  );
};

export default Caixa;
