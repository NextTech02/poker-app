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
import { useStage } from '../contexts/StageContext';
import { usePermissions } from '../contexts/PermissionContext';
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
  const { activeBuyTypes, stageId, tiposCarregados } = useBuyTypes();
  const { selectedStage } = useStage();
  const { isAdmin, hasPermission } = usePermissions();

  const buyCategoryLabel = (c) =>
    c === 'rebuy' ? t('cashRegister.rebuy', 'Rebuy') : c === 'addon' ? t('cashRegister.addon', 'Add-on') : t('cashRegister.buyIn', 'Buy-in');
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
  // Estado do bloqueio de vendas da ETAPA (chave-mestra do diretor). Vem do
  // servidor, e não do StageContext: aquele é uma cópia guardada no navegador
  // quando a etapa foi escolhida, e pode ser de horas atrás.
  const [stageBlock, setStageBlock] = useState(null);
  // Venda sendo cancelada / tendo a forma de pagamento trocada (null = nenhuma)
  const [cancelling, setCancelling] = useState(null);
  const [cancelReason, setCancelReason] = useState('');
  // Avisos que o estorno devolveu (cancel_warnings). Ficam num painel que só
  // sai da tela quando o admin fecha: são tarefas MANUAIS (acertar caixa geral,
  // rake ou crédito do jogador). Num toast de 3 segundos eles somem antes de
  // serem lidos, e o clube só descobre a pendência quando a sangria seguinte
  // for recusada por saldo insuficiente.
  const [avisosDoEstorno, setAvisosDoEstorno] = useState([]);
  const [changingMethod, setChangingMethod] = useState(null);
  const [newMethod, setNewMethod] = useState('cash');
  const [saving, setSaving] = useState(false);
  const [formData, setFormData] = useState({
    tournament_id: '',
    tournament_day_id: '',
    player_id: '',
    // Sem categoria implícita: ela passa a vir SEMPRE do tipo de buy escolhido,
    // que é o único lugar onde o financeiro homologou nome, categoria e rake.
    type: '',
    amount: '',
    payment_method: 'cash',
    payment_source: 'cash',
    rebuy_quantity: 1,
    buy_type_id: '',
  });

  // Sem tipo de buy à mão a venda NÃO para: cai no modo categoria (buy-in /
  // rebuy / add-on com o rake do dia), que é como o clube operava antes dos
  // tipos de buy. Travar aqui matava a operação em três cenários reais — o
  // primeiro render, a sessão expirada e, principalmente, o modo OFFLINE —,
  // com uma mensagem mandando cadastrar o que já estava cadastrado.
  const semTiposDeBuy = activeBuyTypes.length === 0;
  // "A etapa realmente não cadastrou nenhum tipo" só pode ser afirmado com a
  // resposta do servidor em mãos. Lista vazia por falha de consulta é outra
  // coisa, e merece outro aviso.
  const nenhumTipoCadastrado = semTiposDeBuy && tiposCarregados && !!stageId;
  const salesBlockedStage = !!stageBlock?.sales_blocked;
  const diaSelecionado = tournamentDays.find((d) => d.id === formData.tournament_day_id);
  const salesBlockedDay = !!diaSelecionado?.sales_blocked;
  const podeCancelar = isAdmin || hasPermission('cashbox.admin');

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

  // Bloqueio de vendas da etapa: lido do servidor uma vez por etapa (e de novo
  // ao abrir o formulário). Fora do polling de 5s de propósito — é uma decisão
  // do diretor, não muda a cada segundo, e não vale mais uma requisição por
  // ciclo no meio do evento.
  const loadStageBlock = async (id) => {
    if (!id) {
      setStageBlock(null);
      return;
    }
    try {
      const res = await api.get(`/stages/${id}`);
      setStageBlock(res.data || null);
    } catch (error) {
      // Sem a informação, não bloqueia nada: o servidor ainda recusa a venda.
      setStageBlock(null);
    }
  };

  useEffect(() => {
    loadStageBlock(selectedStage?.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedStage?.id]);

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

    // Vendas encerradas pelo diretor. Mensagem diferente da do caixa fechado
    // de propósito: são problemas diferentes e a solução também é.
    if (salesBlockedStage || salesBlockedDay) {
      toast.warning(
        (salesBlockedStage ? stageBlock?.sales_blocked_reason : diaSelecionado?.sales_blocked_reason)
        || t('sales.blockedHint', 'Vendas encerradas para este dia/etapa.')
      );
      return;
    }

    // Validate that a day is selected if days exist
    if (tournamentDays.length > 0 && !formData.tournament_day_id) {
      toast.warning(t('cashRegister.selectDayWarning'));
      return;
    }

    // Com tipos disponíveis, exige o tipo (é ele que carrega o rake). No modo
    // categoria, exige ao menos a categoria — sem ela não dá para saber o que
    // está sendo vendido.
    if (!formData.type || (!semTiposDeBuy && !formData.buy_type_id)) {
      toast.warning(
        semTiposDeBuy
          ? t('cashRegister.categoryRequired', 'Escolha a categoria da entrada.')
          : t('cashRegister.buyTypeRequired', 'Escolha o tipo de buy.')
      );
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
                const errorMsg = errDetail || t('cashRegister.unknownError');
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
                  const errorMsg = errDetail || t('cashRegister.unknownError');
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
        type: '',
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

  // O VALOR cobrado vem sempre da configuração do DIA (e do torneio como
  // reserva, quando o dia não foi escolhido) — nunca do tipo de buy, que só
  // define categoria e rake. Cobrar os 500 do torneio num Dia 1A de 1000 é
  // cobrar errado do jogador na frente dele.
  const valorDaCategoria = (categoria, dayId, tournamentId) => {
    const dia = tournamentDays.find((d) => d.id === dayId);
    const torneio = tournaments.find((tr) => tr.id === tournamentId);
    if (dia) {
      if (categoria === 'rebuy') return dia.rebuy_amount || dia.buy_in;
      if (categoria === 'addon') return dia.addon_amount || dia.buy_in;
      return dia.buy_in;
    }
    if (torneio) {
      if (categoria === 'rebuy') return torneio.rebuy || torneio.buy_in;
      if (categoria === 'addon') return torneio.addon || torneio.buy_in;
      return torneio.buy_in;
    }
    return 0;
  };

  // Ao escolher um tipo de buy, ele define a categoria (type) e o rake, e o
  // valor precisa ser recalculado junto — um tipo de rebuy num dia de rebuy
  // mais barato cobraria o valor do buy-in se não recalculasse aqui.
  const handleBuyTypeChange = (e) => {
    const id = e.target.value;
    const bt = activeBuyTypes.find((b) => b.id === id);
    setFormData((prev) => ({
      ...prev,
      buy_type_id: bt ? id : '',
      type: bt ? bt.category : '',
      amount: bt
        ? valorDaCategoria(bt.category, prev.tournament_day_id, prev.tournament_id)
        : prev.amount,
    }));
  };

  // Modo sem tipos de buy: a categoria é escolhida direto e o rake fica sendo o
  // do dia (comportamento anterior aos tipos de buy).
  const handleCategoriaChange = (e) => {
    const categoria = e.target.value;
    setFormData((prev) => ({
      ...prev,
      buy_type_id: '',
      type: categoria,
      amount: valorDaCategoria(categoria, prev.tournament_day_id, prev.tournament_id),
    }));
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

    // Recobra o valor ao trocar de torneio ou de dia. A categoria não muda por
    // aqui: ela vem do tipo de buy (handleBuyTypeChange), que recalcula sozinho.
    if (name === 'tournament_id' || name === 'tournament_day_id') {
      const tournamentId = name === 'tournament_id' ? value : formData.tournament_id;
      const dayId = name === 'tournament_day_id' ? value : newFormData.tournament_day_id;

      newFormData.amount = valorDaCategoria(formData.type, dayId, tournamentId);
    }

    setFormData(newFormData);
  };

  // Mostra o NOME do tipo vendido (é o que o financeiro cadastrou e o que o
  // operador reconhece); cai no rótulo da categoria para vendas antigas,
  // anteriores aos tipos de buy.
  const getTransactionTypeBadge = (transaction) => {
    const classes = { buy_in: 'badge-success', rebuy: 'badge-warning', addon: 'badge-info' };
    const bt = activeBuyTypes.find((b) => b.id === transaction.buy_type_id);
    const label = bt ? bt.name : buyCategoryLabel(transaction.type);
    return <span className={`badge ${classes[transaction.type] || 'badge-success'}`}>{label}</span>;
  };

  // MESMA regra do backend (transaction_filters.esta_cancelada): estornada é
  // tudo que não está 'active' — o estorno tem DOIS estados, 'cancelling' (em
  // andamento) e 'cancelled' (concluído). Reconhecer só o segundo faria a tela
  // somar uma venda que o caixa da etapa, o DRE, a sangria e os relatórios já
  // tiraram das contas: dois totais diferentes para a mesma noite.
  const estaCancelada = (transaction) => (transaction.status || 'active') !== 'active';

  // Estorno que parou no meio (a venda saiu das somas, mas faltam passos).
  // Precisa de AÇÃO: clicar em cancelar de novo retoma o que faltou.
  const estornoIncompleto = (transaction) => transaction.status === 'cancelling';

  // Memoizado: só recalcula quando a lista de transações muda (não a cada render).
  // Venda cancelada fica FORA dos totais: o dinheiro voltou para o jogador, e
  // contá-la faria o operador procurar na gaveta um valor que não está lá.
  const totals = useMemo(() => {
    const acc = { buy_in: 0, rebuy: 0, addon: 0, total: 0 };
    transactions.forEach(t => {
      if ((t.status || 'active') !== 'active') return;
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
    if (salesBlockedStage) {
      toast.warning(
        stageBlock?.sales_blocked_reason
        || t('sales.blockedStageHint', 'Vendas encerradas para esta etapa.')
      );
      return;
    }
    // Relê o bloqueio da etapa: o diretor pode ter travado a venda enquanto a
    // tela estava aberta.
    loadStageBlock(selectedStage?.id);
    setShowModal(true);
  };

  // ── Cancelar venda (estorno) e trocar forma de pagamento ──────────────────
  // As duas exigem rede: a fila offline só conhece registro/rebuy/addon, e um
  // cancelamento reexecutado fora de ordem em relação à venda original deixaria
  // o caixa em estado inconsistente.

  const abrirCancelamento = (transaction) => {
    if (!isOnline()) {
      toast.warning(t('cashRegister.cancelOnlineOnly', 'Cancelar uma venda exige conexão.'));
      return;
    }
    if ((transaction.payment_source || 'cash') !== 'cash') {
      toast.warning(t(
        'cashRegister.cancelBlockedCredit',
        'Venda paga com crédito ou ticket ainda não pode ser cancelada aqui.'
      ));
      return;
    }
    // Na retomada o motivo original volta preenchido: o admin vê POR QUE a
    // venda estava sendo cancelada antes de concluir o estorno.
    setCancelReason(estornoIncompleto(transaction) ? (transaction.cancel_reason || '') : '');
    setCancelling(transaction);
  };

  const confirmarCancelamento = async () => {
    // Retomada = a venda já está em 'cancelling': o motivo foi gravado no
    // primeiro clique e o backend nem o reaproveita. Exigir digitar de novo só
    // atrasaria a conclusão de um estorno que já está pela metade.
    const retomada = estornoIncompleto(cancelling);
    const motivo = cancelReason.trim() || (retomada ? (cancelling.cancel_reason || '').trim() : '');
    if (!motivo && !retomada) {
      toast.warning(t('cashRegister.cancelReasonRequired', 'Informe o motivo do cancelamento.'));
      return;
    }
    setSaving(true);
    try {
      const resposta = await api.post(`/transactions/${cancelling.id}/cancel`, {
        // O backend exige 3 caracteres; na retomada sem motivo salvo mandamos
        // um texto que se explica sozinho na auditoria.
        reason: motivo || t('cashRegister.cancelResumeReason', 'Retomada do estorno interrompido'),
      });
      // O que o estorno NÃO conseguiu desfazer sozinho vem aqui. Descartar esta
      // resposta (como se fazia antes) escondia do admin tarefas manuais de
      // dinheiro: acertar o caixa geral, o rake acumulado ou o crédito do jogador.
      const avisos = Array.isArray(resposta?.data?.cancel_warnings)
        ? resposta.data.cancel_warnings.filter(Boolean)
        : [];
      setCancelling(null);
      if (avisos.length) {
        setAvisosDoEstorno(avisos);
      } else {
        toast.success(t('cashRegister.cancelDone', 'Venda cancelada e valores estornados'));
      }
      loadData();
    } catch (error) {
      toast.error(
        error.userMessage || error.response?.data?.detail
        || t('cashRegister.cancelError', 'Não foi possível cancelar a venda')
      );
    } finally {
      setSaving(false);
    }
  };

  const abrirTrocaDeMetodo = (transaction) => {
    if (!isOnline()) {
      toast.warning(t('cashRegister.cancelOnlineOnly', 'Cancelar uma venda exige conexão.'));
      return;
    }
    setNewMethod(transaction.payment_method || activeMethods[0]?.code || 'cash');
    setChangingMethod(transaction);
  };

  const confirmarTrocaDeMetodo = async () => {
    setSaving(true);
    try {
      await api.patch(`/transactions/${changingMethod.id}/payment-method`, {
        payment_method: newMethod,
      });
      toast.success(t('cashRegister.paymentMethodChanged', 'Forma de pagamento atualizada'));
      setChangingMethod(null);
      loadData();
    } catch (error) {
      toast.error(
        error.userMessage || error.response?.data?.detail
        || t('cashRegister.paymentMethodError', 'Não foi possível trocar a forma de pagamento')
      );
    } finally {
      setSaving(false);
    }
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
          <Button
            onClick={handleNewTransaction}
            disabled={cashboxBlocked || salesBlockedStage}
          >
            {t('cashRegister.newTransaction')}
          </Button>
        </div>

        {/* Caixa modular do operador (banner + abrir/fechar) */}
        <CashboxBanner onStateChange={setMyCashbox} />

        {/* Vendas encerradas na etapa inteira (chave-mestra do diretor) */}
        {salesBlockedStage && (
          <div className="cx-warning" role="alert">
            <strong>{t('sales.blocked', 'Vendas encerradas')}</strong>
            <span>
              {stageBlock?.sales_blocked_reason
                || t('sales.blockedStageHint', 'Vendas encerradas para esta etapa.')}
            </span>
          </div>
        )}

        {/* Sem tipo de buy a venda CONTINUA: o aviso é informativo, não uma
            trava. O que muda é a origem do rake — passa a ser o do dia. */}
        {nenhumTipoCadastrado && (
          <div className="cx-warning" role="alert">
            <strong>{t('cashRegister.noBuyTypesTitle', 'Nenhum tipo de buy cadastrado')}</strong>
            <span>
              {t(
                'cashRegister.noBuyTypes',
                'Esta etapa não tem tipos de buy. As vendas usam a categoria e o rake do dia; cadastre em Financeiro → Tipos de Buy para controlar o rake por entrada.'
              )}
            </span>
            {hasPermission('financial') && (
              <a className="cx-warning-link" href="/financeiro">
                {t('cashRegister.goToFinanceiro', 'Ir para o Financeiro')}
              </a>
            )}
          </div>
        )}
        {semTiposDeBuy && !stageId && (
          <div className="cx-warning" role="alert">
            <span>
              {t('cashRegister.noStageSelected', 'Selecione uma etapa para vender.')}
            </span>
          </div>
        )}

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
                    <tr
                      key={transaction.id}
                      className={[
                        estaCancelada(transaction) ? 'cx-row-cancelled' : '',
                        estornoIncompleto(transaction) ? 'cx-row-cancelling' : '',
                      ].filter(Boolean).join(' ') || undefined}
                    >
                      <td>{new Date(transaction.created_at).toLocaleString('pt-BR')}</td>
                      <td>
                        {transaction.player_name}
                        {transaction.player_nickname && (
                          <span className="player-nickname"> ({transaction.player_nickname})</span>
                        )}
                      </td>
                      <td>{transaction.tournament_name}</td>
                      <td>
                        {getTransactionTypeBadge(transaction)}
                        {estaCancelada(transaction) && (
                          <span
                            className={
                              estornoIncompleto(transaction)
                                ? 'badge badge-warning cx-badge-cancelled'
                                : 'badge badge-danger cx-badge-cancelled'
                            }
                          >
                            {estornoIncompleto(transaction)
                              ? t('cashRegister.cancelIncomplete', 'Estorno incompleto')
                              : t('cashRegister.cancelled', 'Cancelada')}
                          </span>
                        )}
                      </td>
                      <td className="amount">{formatCurrency(transaction.amount)}</td>
                      <td>
                        {/* Estorno pela metade: a venda já saiu das somas, mas
                            ainda falta desfazer algum passo (caixa da etapa,
                            caixa do operador, contadores ou fidelidade). Enquanto
                            não terminar, o fechamento da noite não bate — por
                            isso a linha PEDE a ação em vez de só ficar riscada. */}
                        {estornoIncompleto(transaction) && (
                          <>
                            <span className="cx-cancelling-hint">
                              {t(
                                'cashRegister.cancelIncompleteHint',
                                'O estorno parou no meio. Conclua para o caixa fechar certo.'
                              )}
                            </span>
                            {podeCancelar && (
                              <button
                                type="button"
                                className="reprint-btn cx-cancel-btn"
                                onClick={() => abrirCancelamento(transaction)}
                              >
                                {t('cashRegister.finishCancel', 'Concluir estorno')}
                              </button>
                            )}
                          </>
                        )}
                        {/* Venda cancelada não tem mais ação: reimprimir daria
                            bilhete a quem não está mais inscrito, e trocar a
                            forma de pagamento o backend recusa com 400. */}
                        {!estaCancelada(transaction) && (
                          <>
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
                            <button
                              type="button"
                              className="reprint-btn"
                              onClick={() => abrirTrocaDeMetodo(transaction)}
                            >
                              {t('cashRegister.changePaymentMethod', 'Trocar pagamento')}
                            </button>
                            {podeCancelar && transaction.type !== 'prize' && (
                              <button
                                type="button"
                                className="reprint-btn cx-cancel-btn"
                                onClick={() => abrirCancelamento(transaction)}
                              >
                                {t('cashRegister.cancelSale', 'Cancelar venda')}
                              </button>
                            )}
                          </>
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
                <button className="close-btn" onClick={() => setShowModal(false)} aria-label={t('common.close')}>
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
                          {day.day_name} - {formatCurrency(day.buy_in)} ({day.registered_players}/{day.max_players} {t('cashRegister.playersLabel')})
                        </option>
                      ))}
                    </select>
                    {/* O dia só é escolhido aqui dentro, então o bloqueio por
                        DIA só pode ser avisado depois da escolha. */}
                    {salesBlockedDay && (
                      <p className="cx-credit-warning" role="alert">
                        {diaSelecionado?.sales_blocked_reason
                          || t('sales.blockedDayHint', 'Vendas encerradas para este dia.')}
                      </p>
                    )}
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

                {/* Com tipos disponíveis, o tipo é a ÚNICA fonte da categoria e
                    do rake — sem opção "Manual" nem categoria solta ao lado.
                    Sem nenhum tipo à mão (etapa sem cadastro, sessão caída ou
                    offline), o seletor vira o de CATEGORIA: melhor vender com o
                    rake do dia do que não vender. */}
                {semTiposDeBuy ? (
                  <div className="form-group">
                    <label htmlFor="type">{t('cashRegister.type', 'Categoria')}</label>
                    <select
                      id="type"
                      name="type"
                      value={formData.type}
                      onChange={handleCategoriaChange}
                      required
                    >
                      <option value="" disabled>
                        {t('cashRegister.selectType', 'Selecione a categoria')}
                      </option>
                      <option value="buy_in">{buyCategoryLabel('buy_in')}</option>
                      <option value="rebuy">{buyCategoryLabel('rebuy')}</option>
                      <option value="addon">{buyCategoryLabel('addon')}</option>
                    </select>
                  </div>
                ) : (
                  <div className="form-group">
                    <label htmlFor="buy_type_id">{t('cashRegister.buyType', 'Tipo de Buy')}</label>
                    <select
                      id="buy_type_id"
                      name="buy_type_id"
                      value={formData.buy_type_id}
                      onChange={handleBuyTypeChange}
                      required
                    >
                      <option value="" disabled>
                        {t('cashRegister.selectBuyType', 'Selecione o tipo de buy')}
                      </option>
                      {activeBuyTypes.map((b) => (
                        <option key={b.id} value={b.id}>
                          {b.name} — {buyCategoryLabel(b.category)} · {Number(b.rake_percentage)}% rake
                        </option>
                      ))}
                    </select>
                  </div>
                )}

                <div className="form-group">
                  <label htmlFor="amount">{t('cashRegister.amount')}</label>
                  {/* Somente leitura: o backend IGNORA o que for digitado aqui —
                      o valor vem sempre da configuração do dia. Editável, o
                      campo prometia um desconto que nunca aconteceria. */}
                  <input
                    id="amount"
                    name="amount"
                    type="number"
                    step="0.01"
                    value={formData.amount}
                    readOnly
                    placeholder="0.00"
                  />
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

        {/* Cancelamento: o motivo é obrigatório porque é ele que explica a
            diferença no fechamento do caixa no fim da noite. */}
        {cancelling && (
          <div className="modal-overlay" onClick={() => setCancelling(null)}>
            <div className="modal" onClick={(e) => e.stopPropagation()}>
              <div className="modal-header">
                <h2>
                  {estornoIncompleto(cancelling)
                    ? t('cashRegister.finishCancel', 'Concluir estorno')
                    : t('cashRegister.cancelSale', 'Cancelar venda')}
                </h2>
                <button className="close-btn" onClick={() => setCancelling(null)} aria-label={t('common.close')}>
                  <span className="close-icon"></span>
                </button>
              </div>
              <div className="modal-body">
                <p>
                  {estornoIncompleto(cancelling)
                    ? t(
                      'cashRegister.cancelResumeConfirm',
                      'Este estorno parou no meio: a venda já saiu de todas as somas, mas faltou desfazer algum passo. Confirmar retoma SÓ o que faltou — nada é debitado duas vezes.'
                    )
                    : t(
                      'cashRegister.cancelConfirm',
                      'A venda será estornada: sai do caixa da etapa, do caixa do operador, da premiação e dos pontos de fidelidade. O registro fica na base para auditoria.'
                    )}
                </p>
                <div className="form-group">
                  <label htmlFor="cancel_reason">
                    {t('cashRegister.cancelReason', 'Motivo do cancelamento')}
                  </label>
                  <input
                    id="cancel_reason"
                    type="text"
                    value={cancelReason}
                    onChange={(e) => setCancelReason(e.target.value)}
                    placeholder={t('cashRegister.cancelReasonPlaceholder', 'Ex.: cobrança em duplicidade')}
                  />
                </div>
              </div>
              <div className="modal-actions">
                <Button type="button" variant="secondary" onClick={() => setCancelling(null)}>
                  {t('common.cancel')}
                </Button>
                <Button type="button" variant="danger" onClick={confirmarCancelamento} disabled={saving}>
                  {estornoIncompleto(cancelling)
                    ? t('cashRegister.confirmFinishCancel', 'Concluir o estorno')
                    : t('cashRegister.confirmCancelSale', 'Cancelar a venda')}
                </Button>
              </div>
            </div>
          </div>
        )}

        {/* Avisos do estorno: o que o cancelamento NÃO conseguiu desfazer
            sozinho. É uma lista de tarefas de dinheiro para o admin fazer na
            mão, então o painel NÃO fecha ao clicar fora nem sozinho — só no
            botão. Some daqui e a próxima sangria é recusada sem ninguém
            entender por quê. */}
        {avisosDoEstorno.length > 0 && (
          <div className="modal-overlay">
            <div className="modal cx-avisos" role="alertdialog" aria-labelledby="cx-avisos-titulo">
              <div className="modal-header">
                <h2 id="cx-avisos-titulo">
                  {t('cashRegister.cancelWarningsTitle', 'Venda cancelada — falta acertar na mão')}
                </h2>
              </div>
              <div className="modal-body">
                <p className="cx-avisos-intro">
                  {t(
                    'cashRegister.cancelWarningsIntro',
                    'O dinheiro foi estornado, mas os itens abaixo o sistema não conseguiu corrigir sozinho. Resolva cada um antes de fechar a noite:'
                  )}
                </p>
                <ul className="cx-avisos-lista">
                  {avisosDoEstorno.map((aviso) => (
                    <li key={aviso}>{aviso}</li>
                  ))}
                </ul>
              </div>
              <div className="modal-actions">
                <Button type="button" onClick={() => setAvisosDoEstorno([])}>
                  {t('cashRegister.cancelWarningsAck', 'Entendi, vou acertar')}
                </Button>
              </div>
            </div>
          </div>
        )}

        {/* Troca da forma de pagamento: só o rótulo, nenhum valor se move. */}
        {changingMethod && (
          <div className="modal-overlay" onClick={() => setChangingMethod(null)}>
            <div className="modal" onClick={(e) => e.stopPropagation()}>
              <div className="modal-header">
                <h2>{t('cashRegister.changePaymentMethod', 'Trocar pagamento')}</h2>
                <button className="close-btn" onClick={() => setChangingMethod(null)} aria-label={t('common.close')}>
                  <span className="close-icon"></span>
                </button>
              </div>
              <div className="modal-body">
                <div className="form-group">
                  <label htmlFor="new_payment_method">{t('cashRegister.paymentMethod')}</label>
                  <select
                    id="new_payment_method"
                    value={newMethod}
                    onChange={(e) => setNewMethod(e.target.value)}
                  >
                    {activeMethods.length === 0 && (
                      <option value="cash">{t('cashRegister.cash')}</option>
                    )}
                    {activeMethods.map((m) => (
                      <option key={m.id} value={m.code}>{methodLabel(t, m)}</option>
                    ))}
                  </select>
                </div>
              </div>
              <div className="modal-actions">
                <Button type="button" variant="secondary" onClick={() => setChangingMethod(null)}>
                  {t('common.cancel')}
                </Button>
                <Button type="button" onClick={confirmarTrocaDeMetodo} disabled={saving}>
                  {t('common.save', 'Salvar')}
                </Button>
              </div>
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
                <button className="close-btn" onClick={() => { setShowTicketModal(false); loadData(); }} aria-label={t('common.close')}>
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
