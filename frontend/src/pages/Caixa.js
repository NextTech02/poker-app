import React, { useEffect, useState, useMemo, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import Sidebar from '../components/Sidebar';
import Icon from '../components/Icon';
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
import { useRealtimeRefresh } from '../hooks/useRealtimeRefresh';
import { useEscapeKey } from '../hooks/useEscapeKey';
import { offlineWrite, offlineRead } from '../offline/apiOffline';
import { applyRegister, applyRebuy, applyAddon } from '../offline/domainRules';
import { uuid, putEntities, getEntity, getAllByTable } from '../offline/db';
import { isOnline, subscribe as assinarConectividade } from '../offline/connectivity';
import { avisarQueOCaixaMudou } from '../utils/eventosDoCaixa';
import { MODO_MESA, modoDoTorneio } from '../hooks/useModoDeEliminacao';
import {
  alternarItem, eEntrada, fichasDoDia, fichasDoTipo, linhasDaMesmaVenda, montarItens, totaisDosItens,
} from '../utils/vendaComposta';
import CobrarEquipeModal from '../components/equipes/CobrarEquipeModal';
import './Caixa.css';

// Fecha só quando o clique caiu no próprio fundo, não em um filho. Substitui o
// `onClick={stopPropagation}` que ficava no conteúdo do modal — aquele era um
// clique sem equivalente de teclado, e o fundo em si não é um controle.
const aoClicarNoFundo = (aoFechar) => (evento) => {
  if (evento.target === evento.currentTarget) aoFechar();
};

// Inscritos do DIA da venda (online: backend; offline: réplica), e a réplica
// hidratada com eles. Pelo TORNEIO, quem jogou o 1A e o 1B achava a linha de
// outro dia — e a reentrada caía no dia errado. Sem dia escolhido (torneio de
// dia único antigo), vale o torneio.
const lerInscritos = async (tournamentId, dayId) => {
  const tpList = dayId
    ? await offlineRead(`/tournament-players/day/${dayId}`, {
      fromReplica: async () => (await getAllByTable('tournament_players'))
        .filter((p) => p.tournament_day_id === dayId),
    })
    : await offlineRead(`/tournament-players/tournament/${tournamentId}`, {
      fromReplica: async () => (await getAllByTable('tournament_players'))
        .filter((p) => p.tournament_id === tournamentId),
    });
  if (tpList?.length) putEntities('tournament_players', tpList);
  return tpList || [];
};

const Caixa = () => {
  const { t, i18n } = useTranslation();
  const { formatCurrency } = useCurrency();
  const formatarFichas = (n) => Number(n || 0).toLocaleString(i18n?.language || 'pt-BR');
  const { activeMethods } = usePaymentMethods();
  const { activeBuyTypes: todosOsMeios, tournamentId: torneioDosMeios, tiposCarregados, selectTournament } = useBuyTypes();
  // Torneio por equipes: o meio "por equipe" tem o preço da EQUIPE inteira e
  // nunca é vendido a um jogador só — sai da venda e vira o "Cobrar equipe".
  const activeBuyTypes = useMemo(() => (todosOsMeios || []).filter((b) => !b.per_team), [todosOsMeios]);
  const temMeioPorEquipe = useMemo(() => (todosOsMeios || []).some((b) => b.per_team), [todosOsMeios]);
  const [cobrarEquipeDe, setCobrarEquipeDe] = useState(null);
  const { selectedStage } = useStage();
  const { isAdmin, hasPermission } = usePermissions();

  // Prêmio pago também aparece no extrato: sem rótulo próprio, ele caía em
  // "Buy-in" e o operador lia uma VENDA onde houve uma saída de dinheiro.
  const buyCategoryLabel = (c) => {
    if (c === 'rebuy') return t('cashRegister.rebuy', 'Rebuy');
    if (c === 'addon') return t('cashRegister.addon', 'Add-on');
    if (c === 'fee') return t('cashRegister.fee', 'Taxa');
    if (c === 'prize') return t('cashRegister.prize', 'Prêmio');
    return t('cashRegister.buyIn', 'Buy-in');
  };

  // Título do bilhete: reimpressão, etapa sem mesa cadastrada, alternado de
  // verdade ou alocado. Um caso por linha — encadeados em ternário, o operador
  // lia "alternado" onde na verdade faltava cadastrar mesa.
  const tituloDoBilhete = (dados) => {
    if (dados.is_reprint) return t('cashRegister.reprintTitle');
    if (dados.motivo_alternate === 'sem-mesas') {
      return t('cashRegister.registeredNoTables', 'Registrado — nenhuma mesa cadastrada');
    }
    if (dados.is_alternate) return t('cashRegister.registeredAsAlternate');
    // Sem assento a mostrar: só add-on (o jogador já está sentado) ou alocação
    // feita pelo staff. Dizer "alocado" aqui mandaria procurar uma mesa no papel.
    if (dados.so_fichas) return t('cashRegister.chipsSoldTitle', 'Fichas vendidas');
    if (dados.sem_assento) return t('cashRegister.registeredNoSeat', 'Venda registrada — o staff define o assento');
    return t('cashRegister.registeredAndAllocated');
  };
  const [transactions, setTransactions] = useState([]);
  // Filtro do extrato (torneio e dia). '' = todos.
  const [filtroTorneio, setFiltroTorneio] = useState('');
  const [filtroDia, setFiltroDia] = useState('');
  const [diasDoFiltro, setDiasDoFiltro] = useState([]);
  const [diaDaInscricao, setDiaDaInscricao] = useState(() => new Map());
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
    // Sem categoria implícita: ela passa a vir SEMPRE do meio de entrada
    // escolhido, único lugar onde o clube configurou nome, categoria, valor,
    // rake e fichas.
    type: '',
    amount: '',
    payment_method: 'cash',
    payment_source: 'cash',
    // VÁRIOS meios de entrada por venda: uma entrada (buy-in OU reentrada) e
    // os add-ons que o jogador levar junto (bono dealer, add-on...). Cada um
    // vira a sua transação; o bilhete sai um só, com o total de fichas.
    buy_type_ids: [],
  });

  // Sem meio de entrada à mão a venda NÃO para: cai no modo categoria (buy-in /
  // rebuy / add-on com o rake do dia), que é como o clube operava antes dos
  // meios de entrada. Travar aqui matava a operação em três cenários reais — o
  // primeiro render, a sessão expirada e, principalmente, o modo OFFLINE —,
  // com uma mensagem mandando cadastrar o que já estava cadastrado.
  const semTiposDeBuy = activeBuyTypes.length === 0;
  // "O torneio realmente não cadastrou nenhum meio de entrada" só pode ser
  // afirmado com a resposta do servidor em mãos. Lista vazia por falha de
  // consulta é outra coisa, e merece outro aviso.
  const nenhumTipoCadastrado = semTiposDeBuy && tiposCarregados && !!torneioDosMeios;
  const salesBlockedStage = !!stageBlock?.sales_blocked;
  const diaSelecionado = tournamentDays.find((d) => d.id === formData.tournament_day_id);
  const salesBlockedDay = !!diaSelecionado?.sales_blocked;
  // Situação das MESAS do dia/torneio escolhido, lida quando o formulário abre.
  // Três estados, porque a ação do operador é diferente em cada um:
  //   'com-mesas'    → há mesa ativa; o assento sai normalmente;
  //   'sem-mesas'    → nenhuma mesa ativa cadastrada: FALTA CONFIGURAR, e todo
  //                    mundo vai sair com bilhete de alternado sem que exista
  //                    fila de alternados de verdade;
  //   'sem-conexao'  → offline: quem aloca é o servidor, no sync;
  //   'desconhecido' → a consulta falhou; a tela não afirma nada.
  const [estadoDasMesas, setEstadoDasMesas] = useState('desconhecido');
  // A conectividade é ESTADO, não uma leitura única na abertura do formulário.
  // Lida só uma vez, a tarja "Sem conexão" ficava presa depois de a internet
  // voltar com o formulário aberto — que é o caso comum no balcão. Aviso que
  // mente é aviso que o operador aprende a ignorar, e aí ele ignora junto o
  // aviso de mesa não configurada, que é o que o cliente pediu.
  const [redeOnline, setRedeOnline] = useState(() => isOnline());
  useEffect(() => {
    setRedeOnline(isOnline()); // resincroniza o que possa ter mudado antes de assinar
    return assinarConectividade(setRedeOnline);
  }, []);
  const torneioSelecionado = tournaments.find((x) => x.id === formData.tournament_id);
  // A alocação automática é a única em que a falta de mesa vira bilhete errado:
  // no modo manual o staff senta o jogador na mão e a tela nem emite bilhete.
  const alocacaoAutomatica =
    (diaSelecionado?.allocation_type || torneioSelecionado?.allocation_type) === 'automatic';
  const mesasTravadas = !!diaSelecionado?.tables_locked;
  // REENTRADA traz de volta UM eliminado — sem eliminado, o servidor recusa.
  // Por MESA, é a reentrada DAQUELE jogador: o seletor oferece só quem foi
  // eliminado no dia. Em MASSA, basta haver eliminação no contador do dia.
  const reentradaPorMesa = formData.type === 'rebuy' && modoDoTorneio(torneioSelecionado) === MODO_MESA;
  const [eliminadosDoDia, setEliminadosDoDia] = useState(null);
  useEffect(() => {
    if (!showModal || !reentradaPorMesa || !formData.tournament_day_id) {
      setEliminadosDoDia(null);
      return undefined;
    }
    let vivo = true;
    lerInscritos(formData.tournament_id, formData.tournament_day_id)
      .then((lista) => {
        if (vivo) setEliminadosDoDia(lista.filter((p) => p.status === 'eliminated').map((p) => p.player_id));
      })
      .catch(() => { if (vivo) setEliminadosDoDia(null); });
    return () => { vivo = false; };
  }, [showModal, reentradaPorMesa, formData.tournament_id, formData.tournament_day_id]);
  const avisarReentradaSemEliminado = formData.type === 'rebuy' && (
    reentradaPorMesa
      ? Array.isArray(eliminadosDoDia) && eliminadosDoDia.length === 0
      : !!diaSelecionado && Number(diaSelecionado.eliminations_count || 0) <= 0
  );
  // Mesas travadas/cheias → alternado é o certo. Nenhuma mesa cadastrada →
  // erro de configuração, e é isso que precisa aparecer ANTES da venda.
  const avisarSemMesa = alocacaoAutomatica && estadoDasMesas === 'sem-mesas';
  const avisarMesasTravadas = alocacaoAutomatica && mesasTravadas && !avisarSemMesa;
  const avisarMesasDesconhecidas =
    alocacaoAutomatica && !mesasTravadas && estadoDasMesas === 'sem-conexao';
  const podeCancelar = isAdmin || hasPermission('cashbox.admin');

  // Esc fecha o modal aberto. O caixa do clube trabalha de Tab e Enter, com as
  // duas mãos ocupadas: fechar só clicando no fundo deixava ele preso.
  const fecharVenda = useCallback(() => setShowModal(false), []);
  const fecharCancelamento = useCallback(() => setCancelling(null), []);
  const fecharTrocaDeMetodo = useCallback(() => setChangingMethod(null), []);
  const fecharTicket = () => { setShowTicketModal(false); loadData(); };
  useEscapeKey(showModal, fecharVenda);
  useEscapeKey(!!cancelling, fecharCancelamento);
  useEscapeKey(!!changingMethod, fecharTrocaDeMetodo);
  useEscapeKey(showTicketModal, fecharTicket);

  useEffect(() => {
    loadData();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // O banco avisa quando muda, em vez de esta tela perguntar de 5 em 5
  // segundos. Perguntando, ela refazia `/transactions` + `/tournaments` +
  // `/players` (a lista inteira de jogadores) doze vezes por minuto, por
  // operador logado, e quase sempre recebia de volta exatamente o que já
  // tinha. O poll segue como rede de segurança, em intervalo folgado.
  //
  // Sem filtro de propósito: o RLS já limita os eventos ao clube de quem está
  // logado, e o Caixa mostra a venda de TODOS os operadores — filtrar pela
  // etapa esconderia a venda do colega até o próximo poll.
  useRealtimeRefresh({
    canal: `caixa-${selectedStage?.id || 'sem-etapa'}`,
    tabelas: [{ table: 'transactions' }, { table: 'tournaments' }],
    aoMudar: () => loadData(),
  });

  // Os meios de entrada são do TORNEIO, e o torneio é escolhido aqui dentro, no
  // formulário de venda: é esta tela que avisa o contexto qual carregar. Sem
  // este aviso a lista ficaria vazia e toda venda cairia no modo categoria,
  // cobrando o valor do dia em vez do valor configurado na entrada. Como a
  // lista vale para todos os dias, ela já aparece antes de o dia ser escolhido.
  useEffect(() => {
    if (selectTournament) selectTournament(formData.tournament_id);
  }, [selectTournament, formData.tournament_id]);

  // Hidrata os meios de entrada na réplica offline (valor, rake e fichas).
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
      console.warn(`[Caixa] falha ao ler o bloqueio de vendas da etapa ${id}:`, error);
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

  // Confere as mesas ANTES da venda. O operador só descobria que faltava
  // cadastrar mesa quando o bilhete de ALTERNADO já tinha saído na impressora,
  // com o jogador esperando para sentar; aqui ele descobre com o formulário
  // ainda aberto. Só consulta com o formulário aberto (fora dele o dado não é
  // usado) e nunca bloqueia a venda: em evento ao vivo o clube às vezes vende
  // antes de montar as mesas, e travar o caixa é pior que o bilhete errado.
  useEffect(() => {
    if (!showModal) return undefined;
    // Sem dia, só vale perguntar pelo torneio quando o torneio não tem dias.
    // Só vale perguntar pelo torneio inteiro quando ele não tem dias; com dias
    // cadastrados e nenhum escolhido não existe conjunto de mesas a consultar.
    const perguntarPeloTorneio = !!formData.tournament_id && tournamentDays.length === 0;
    const alvoDoTorneio = perguntarPeloTorneio ? `/tables/tournament/${formData.tournament_id}` : null;
    const alvo = formData.tournament_day_id
      ? `/tables/day/${formData.tournament_day_id}`
      : alvoDoTorneio;
    if (!alvo) {
      setEstadoDasMesas('desconhecido');
      return undefined;
    }
    if (!redeOnline) {
      // Offline não dá para saber o estado das mesas — e a tela NÃO inventa.
      setEstadoDasMesas('sem-conexao');
      return undefined;
    }
    let cancelado = false;
    (async () => {
      try {
        const res = await api.get(alvo);
        // Mesa fechada/quebrada não recebe jogador: o servidor só aloca em
        // mesa 'active', então contar as outras daria falso "está tudo certo".
        const ativas = (Array.isArray(res.data) ? res.data : []).filter(
          (m) => (m.status || 'active') === 'active'
        );
        if (!cancelado) setEstadoDasMesas(ativas.length > 0 ? 'com-mesas' : 'sem-mesas');
      } catch (error) {
        // Falha de consulta não é "não tem mesa": calar é melhor que mentir.
        console.warn('[Caixa] falha ao conferir as mesas:', error);
        if (!cancelado) setEstadoDasMesas('desconhecido');
      }
    })();
    return () => { cancelado = true; };
  }, [showModal, formData.tournament_id, formData.tournament_day_id, tournamentDays.length, redeOnline]);

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
      // Torneio de dia único: o dia é implícito. Entra sozinho no formulário
      // e o seletor não aparece — só o multi-day pergunta "qual dia?". A
      // guarda pelo torneio descarta a resposta de uma troca já superada.
      if (activeDays.length === 1) {
        const unico = activeDays[0];
        // Os meios de entrada já marcados ficam: eles são do torneio, não do
        // dia. O valor é recalculado a partir do dia escolhido.
        setFormData((prev) => (prev.tournament_id === tournamentId
          ? { ...prev, tournament_day_id: unico.id }
          : prev));
      }
      // Hidrata os dias na réplica (buy_in/rake/chips/registered_players offline)
      if (response.data?.length) putEntities('tournament_days', response.data);
    } catch (error) {
      console.error('Erro ao carregar dias do torneio:', error);
      setTournamentDays([]);
    }
  };

  // Nome do jogador para o bilhete. Offline vem da réplica; online do
  // servidor. Sem nenhum dos dois, travessão — nunca "undefined" no papel.
  // Mesa e assento ATUAIS do jogador no dia, para o bilhete de add-on: o floor
  // leva a pilha extra até a cadeira dele. Sem rede, sem assento (alternado) ou
  // com alocação manual, o bloco de mesa sai do papel em vez de "MESA undefined".
  const assentoAtual = async (tournamentId, dayId, playerId) => {
    const url = dayId ? `/allocations/day/${dayId}` : `/allocations/tournament/${tournamentId}`;
    const res = await api.get(url).catch(() => ({ data: [] }));
    const alloc = (res.data || []).find((a) => a.player_id === playerId);
    const mesa = alloc?.tournament_tables?.table_number ?? alloc?.table_number;
    if (!alloc || mesa == null || alloc.seat_number == null) return null;
    return { table_number: mesa, seat_number: alloc.seat_number };
  };

  const nomeDoJogador = async (playerId, offline) => {
    try {
      if (offline) {
        const pInfo = await offlineRead(`/players/${playerId}`, {
          fromReplica: () => getEntity('players', playerId),
        });
        return pInfo?.name || '—';
      }
      const pRes = await api.get(`/players/${playerId}`);
      return pRes.data?.name || '—';
    } catch (_) {
      return '—';
    }
  };

  /* Assento de quem acabou de ENTRAR (buy-in ou reentrada) — devolve os dados
     do bilhete, ou null quando o assento tem de ser feito na mão.

     - offline: sem auto-assento (o servidor aloca no sync) → alternado;
     - mesas travadas: alternado (ou "sem mesa", se nenhuma foi cadastrada);
     - alocação automática: pede o assento ao servidor; sem lugar livre vira
       alternado, outro erro avisa para alocar na mão;
     - alocação manual: o staff senta o jogador; o bilhete sai SEM assento,
       só com a compra e as fichas. */
  const assentoDaEntrada = async ({ entradaOffline, tournament, selectedDay, avisoDeAlocacao }) => {
    const base = {
      tournament_name: tournament?.name || '',
      day_name: selectedDay?.day_name || '',
      created_at: new Date().toISOString(),
      id: formData.player_id,
    };
    if (entradaOffline) {
      // Offline não dá para conferir mesa nenhuma: o bilhete diz que o
      // assento sai no sync, não que existe fila de alternados.
      return {
        ...base,
        player_name: await nomeDoJogador(formData.player_id, true),
        is_alternate: true,
        offline: true,
        motivo_alternate: 'sem-conexao',
      };
    }

    const allocationTypeToUse = selectedDay?.allocation_type || tournament?.allocation_type;
    if (allocationTypeToUse !== 'automatic') {
      return { ...base, player_name: await nomeDoJogador(formData.player_id, false), sem_assento: true };
    }

    const tablesLocked = selectedDay?.tables_locked ?? false;
    if (tablesLocked) {
      // Mesas travadas SEM mesa nenhuma cadastrada não é fila de
      // alternados, é etapa por configurar: o bilhete precisa dizer qual
      // dos dois é, senão o operador procura uma fila que não existe.
      return {
        ...base,
        player_name: await nomeDoJogador(formData.player_id, false),
        is_alternate: true,
        motivo_alternate: estadoDasMesas === 'sem-mesas' ? 'sem-mesas' : 'travadas',
      };
    }

    try {
      const allocationResponse = formData.tournament_day_id
        // Day-scoped auto-allocation
        ? await api.post(`/allocations/day/${formData.tournament_day_id}/auto?player_id=${formData.player_id}`)
        // Tournament-scoped fallback
        : await api.post(`/allocations/tournament/${formData.tournament_id}/auto?player_id=${formData.player_id}`);
      return {
        ...allocationResponse.data,
        day_name: selectedDay?.day_name || allocationResponse.data.day_name || '',
      };
    } catch (allocationError) {
      console.error('Erro ao alocar jogador:', allocationError);
      const errDetail = allocationError.response?.data?.detail || '';
      const semMesaAtiva = errDetail.toLowerCase().includes('no active tables');
      const noSeats = errDetail.toLowerCase().includes('tables are full') || semMesaAtiva;
      if (noSeats) {
        // Sem assento o jogador vira alternado — mas o MOTIVO muda a
        // ação: mesa cheia é fila de alternados; nenhuma mesa ativa é
        // configuração faltando, e o staff tem de cadastrar as mesas.
        if (semMesaAtiva) setEstadoDasMesas('sem-mesas');
        return {
          ...base,
          player_name: await nomeDoJogador(formData.player_id, false),
          is_alternate: true,
          motivo_alternate: semMesaAtiva ? 'sem-mesas' : 'lotadas',
        };
      }
      toast.warning(t(avisoDeAlocacao, { reason: errDetail || t('cashRegister.unknownError') }));
      // A venda está paga: o bilhete sai mesmo assim, sem assento, para o
      // floor entregar as fichas enquanto alguém senta o jogador na mão.
      return { ...base, player_name: await nomeDoJogador(formData.player_id, false), sem_assento: true };
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

    // Com meios de entrada disponíveis, exige ao menos um marcado (é ele que
    // carrega valor, rake e fichas). No modo categoria, exige a categoria —
    // sem ela não dá para saber o que está sendo vendido.
    if (itensDaVenda.length === 0) {
      toast.warning(
        semTiposDeBuy
          ? t('cashRegister.categoryRequired', 'Escolha a categoria da entrada.')
          : t('cashRegister.buyTypeRequired', 'Escolha o meio de entrada.')
      );
      return;
    }

    // Retrato da venda ANTES de mandar: o formulário é limpo assim que ela é
    // aceita, e o bilhete precisa dos itens que o jogador pagou.
    const itens = itensDaVenda;
    const entrada = itens.find((item) => eEntrada(item.category)) || null;
    const extras = itens.filter((item) => !eEntrada(item.category));
    const tournament = tournaments.find((tr) => tr.id === formData.tournament_id);
    const selectedDay = tournamentDays.find((d) => d.id === formData.tournament_day_id);
    const pagamento = {
      payment_source: formData.payment_source || 'cash',
      payment_method: formData.payment_method || 'cash',
    };

    try {
      let tpId = null;
      let entradaOffline = false;
      let algoOffline = false;

      if (entrada?.category === 'buy_in') {
        // Camada offline: online chama o backend; sem rede, aplica na réplica e
        // enfileira (com id gerado no cliente p/ idempotência e p/ o rebuy e o
        // add-on desta mesma venda referenciarem o jogador).
        const clientTpId = uuid();
        const clientMutId = uuid();
        const regBody = {
          tournament_id: formData.tournament_id,
          tournament_day_id: formData.tournament_day_id || null,
          player_id: formData.player_id,
          buy_in_count: 1,
          ...pagamento,
          buy_type_id: entrada.buy_type_id || null,
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
        // O servidor grava a inscrição com o id gerado aqui (client_id vira a
        // chave), então os add-ons desta venda já sabem a quem se somar.
        tpId = reg.data?.id || clientTpId;
        entradaOffline = !!reg.offline;
      } else {
        // Reentrada ou só add-on: o jogador já está no DIA (online: backend;
        // offline: réplica).
        const tpList = await lerInscritos(formData.tournament_id, formData.tournament_day_id);
        const tournamentPlayer = tpList.find((p) => p.player_id === formData.player_id);
        if (!tournamentPlayer) {
          toast.error(t('cashRegister.playerNotRegistered'));
          return;
        }
        tpId = tournamentPlayer.id;

        if (entrada?.category === 'rebuy') {
          // O ranking NÃO é mexido aqui: tirar o jogador do ranking antes da
          // venda o reativava, e a reentrada por mesa — que exige o jogador
          // ELIMINADO — era recusada. O servidor faz isso na própria venda.
          //
          // UMA recompra por item. "Rebuy duplo" NÃO é rebuy × 2 — é um meio
          // de entrada próprio, com valor e fichas próprios.
          const cmid = uuid();
          const rbBody = {
            tournament_player_id: tpId,
            ...pagamento,
            buy_type_id: entrada.buy_type_id || null,
            client_mutation_id: cmid,
          };
          const rr = await offlineWrite({
            kind: 'rebuy', method: 'post',
            url: `/tournament-players/${tpId}/rebuy`,
            // `client_mutation_id` vai como PARAMETRO: a rota le parametros de
            // consulta, e o corpo era descartado — foi assim que a protecao
            // contra registrar a mesma venda duas vezes se perdeu.
            params: {
              ...pagamento,
              client_mutation_id: cmid,
              ...(entrada.buy_type_id ? { buy_type_id: entrada.buy_type_id } : {}),
            },
            body: rbBody,
            clientMutationId: cmid,
            meta: { kind: 'rebuy', player_id: formData.player_id },
            synthetic: { ok: true },
            applyLocal: () => applyRebuy(rbBody),
          });
          entradaOffline = !!rr.offline;
        }
      }
      algoOffline = entradaOffline;

      // Os extras (add-ons, bono dealer) vão DEPOIS da entrada, um a um, na
      // pilha do mesmo jogador. Se um deles for recusado com a entrada já
      // gravada, a venda NÃO é desfeita em silêncio: o que entrou fica, o
      // bilhete sai só com ele, e o operador vê exatamente o que faltou.
      const extrasVendidos = [];
      const extrasRecusados = [];
      for (const item of extras) {
        const cmid = uuid();
        const adBody = {
          tournament_player_id: tpId,
          ...pagamento,
          buy_type_id: item.buy_type_id || null,
          client_mutation_id: cmid,
        };
        try {
          // eslint-disable-next-line no-await-in-loop -- a ordem importa: um add-on por vez, na pilha do mesmo jogador
          const ar = await offlineWrite({
            kind: 'addon', method: 'post',
            url: `/tournament-players/${tpId}/addon`,
            params: {
              ...pagamento,
              ...(item.buy_type_id ? { buy_type_id: item.buy_type_id } : {}),
            },
            body: adBody,
            clientMutationId: cmid,
            meta: { kind: 'addon', player_id: formData.player_id },
            synthetic: { ok: true },
            applyLocal: () => applyAddon(adBody),
          });
          if (ar.offline) algoOffline = true;
          extrasVendidos.push(item);
        } catch (erroDoExtra) {
          // Nada vendido ainda (venda só de add-ons): é o erro da venda inteira.
          if (!entrada && extrasVendidos.length === 0) throw erroDoExtra;
          extrasRecusados.push({
            item,
            motivo: erroDoExtra.userMessage || erroDoExtra.response?.data?.detail || '',
          });
        }
      }

      if (algoOffline) {
        toast.success(t('offline.savedOffline', 'Salvo offline — será enviado ao sincronizar'));
      }
      if (extrasRecusados.length) {
        toast.error(t('cashRegister.partialSaleError', {
          defaultValue: 'A entrada foi registrada, mas não deu para lançar: {{itens}}. Lance de novo só o que faltou.',
          itens: extrasRecusados
            .map(({ item, motivo }) => (typeof motivo === 'string' && motivo ? `${item.name} (${motivo})` : item.name))
            .join(', '),
        }));
      }

      // UM bilhete para a venda inteira, com cada item e o total de fichas.
      const itensVendidos = [...(entrada ? [entrada] : []), ...extrasVendidos];
      const totais = totaisDosItens(itensVendidos);
      const compra = {
        itens: itensVendidos.map(({ name, amount, chips }) => ({ name, amount, chips })),
        total_amount: totais.amount,
        total_chips: totais.chips,
      };
      if (entrada) {
        const assento = await assentoDaEntrada({
          entradaOffline,
          tournament,
          selectedDay,
          avisoDeAlocacao: entrada.category === 'rebuy'
            ? 'cashRegister.rebuyAllocationManualWarning'
            : 'cashRegister.allocationManualWarning',
        });
        setAllocationData({ ...assento, ...compra });
      } else {
        // Só add-ons: o jogador já está sentado. O bilhete é de FICHAS — é
        // por ele que o floor entrega a pilha extra — e leva a mesa e o
        // assento onde ele está, para a pilha chegar à cadeira certa.
        const assento = await assentoAtual(
          formData.tournament_id, formData.tournament_day_id, formData.player_id,
        );
        setAllocationData({
          tournament_name: tournament?.name || '',
          day_name: selectedDay?.day_name || '',
          created_at: new Date().toISOString(),
          id: formData.player_id,
          player_name: await nomeDoJogador(formData.player_id, algoOffline),
          ...(assento || {}),
          sem_assento: !assento,
          so_fichas: true,
          ...compra,
        });
      }
      setShowTicketModal(true);

      setShowModal(false);
      setFormData({
        tournament_id: '',
        tournament_day_id: '',
        player_id: '',
        type: '',
        amount: '',
        payment_method: 'cash',
        payment_source: 'cash',
        buy_type_ids: [],
      });
      setPlayerCredit(0);
      setTournamentDays([]);
      loadData();
      avisarQueOCaixaMudou();
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
    // A compra reimpressa é a da VENDA: a entrada e os add-ons lançados com
    // ela (ver linhasDaMesmaVenda). Nome e fichas vêm do que foi gravado na
    // venda, não do cadastro de hoje — renomear o meio de entrada depois ou
    // mudar as fichas dele não pode reescrever o recibo. Venda antiga, sem as
    // fichas gravadas, reimprime como antes, sem a lista.
    const linhas = linhasDaMesmaVenda(transaction, transactions);
    const fichasConhecidas = linhas.every((l) => l.chips !== null && l.chips !== undefined);
    const itensReimpressos = fichasConhecidas
      ? linhas.map((l) => ({
          name: l.buy_type_name || buyCategoryLabel(l.type),
          amount: Number(l.amount) || 0,
          chips: Number(l.chips) || 0,
        }))
      : [];
    const totaisReimpressos = totaisDosItens(itensReimpressos);
    // Venda só de add-ons reimprime como bilhete de FICHAS (com a mesa atual).
    const soFichas = !linhas.some((l) => eEntrada(l.type));
    const compra = {
      ...(itensReimpressos.length
        ? { itens: itensReimpressos, total_amount: totaisReimpressos.amount, total_chips: totaisReimpressos.chips }
        : {}),
      so_fichas: soFichas,
    };
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
          ...compra,
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
          ...compra,
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

  /* Valor de RESERVA, usado só no modo categoria (nenhum meio de entrada à
     mão): vem da configuração do DIA, e do torneio quando o dia não foi
     escolhido. Cobrar os 500 do torneio num Dia 1A de 1000 é cobrar errado do
     jogador na frente dele. Com meio de entrada escolhido quem manda é ele.

     NÃO CAI NO BUY-IN quando rebuy/add-on não têm valor. Caía, por causa de um
     `||`, e o estrago era duplo: 31 dias têm `addon_amount` nulo (o formulário
     do dia grava zero como NULO), então a tela mostrava o preço do buy-in para
     um add-on — e o BACKEND, que faz `valor_do_dia or 0`, registrava ZERO. O
     operador cobrava 100 do jogador e o caixa guardava 0, e a diferença só
     aparecia no fechamento da noite.

     A tela mostra o que o servidor cobra. Sem valor configurado, é zero — e
     zero aparecendo na tela é o que faz alguém perceber que falta configurar. */
  const valorDoDia = (categoria, dia) => {
    if (categoria === 'rebuy') return dia.rebuy_amount ?? 0;
    if (categoria === 'addon') return dia.addon_amount ?? 0;
    return dia.buy_in ?? 0;
  };

  const valorDaCategoria = (categoria, diaId, tournamentId) => {
    const dia = tournamentDays.find((d) => d.id === diaId);
    const torneio = tournaments.find((tr) => tr.id === tournamentId);
    if (dia) return valorDoDia(categoria, dia);
    if (torneio) {
      if (categoria === 'rebuy') return torneio.rebuy ?? 0;
      if (categoria === 'addon') return torneio.addon ?? 0;
      return torneio.buy_in ?? 0;
    }
    return 0;
  };

  // O que está sendo vendido AGORA, item por item, com valor e fichas de cada
  // um. Com meios de entrada, são os marcados (entrada primeiro). Sem nenhum à
  // mão, é a categoria escolhida, com valor e fichas do dia. Calculado a cada
  // render: o total na tela e o que vai ao servidor saem da mesma lista.
  const itensDaVenda = semTiposDeBuy
    ? (formData.type
      ? [{
          buy_type_id: null,
          name: buyCategoryLabel(formData.type),
          category: formData.type,
          amount: Number(valorDaCategoria(formData.type, formData.tournament_day_id, formData.tournament_id)) || 0,
          chips: fichasDoDia(formData.type, diaSelecionado),
        }]
      : [])
    : montarItens(
      formData.buy_type_ids,
      activeBuyTypes,
      diaSelecionado,
      (categoria) => valorDaCategoria(categoria, formData.tournament_day_id, formData.tournament_id),
    );
  const totaisDaVenda = totaisDosItens(itensDaVenda);

  // Categoria "da venda": a da ENTRADA marcada (buy-in/reentrada) ou, sem
  // entrada, add-on. É ela que decide se a venda inscreve, traz de volta ou só
  // completa a pilha de quem já está sentado.
  const categoriaDaVenda = (ids) => {
    const marcados = activeBuyTypes.filter((b) => ids.includes(b.id));
    const entrada = marcados.find((b) => eEntrada(b.category));
    if (entrada) return entrada.category;
    return marcados.length ? 'addon' : '';
  };

  // Marca/desmarca um meio de entrada. Só cabe UMA entrada por venda: marcar
  // outra troca a anterior (ver utils/vendaComposta). Valor e fichas não ficam
  // guardados: saem da lista marcada a cada render, e por isso nunca descolam
  // do que está na tela.
  const alternarMeio = (id) => {
    setFormData((prev) => {
      const ids = alternarItem(prev.buy_type_ids, id, activeBuyTypes);
      return { ...prev, buy_type_ids: ids, type: categoriaDaVenda(ids) };
    });
  };

  // Modo sem meios de entrada: a categoria é escolhida direto e o valor/rake
  // ficam sendo os do dia (comportamento anterior aos meios de entrada).
  const handleCategoriaChange = (e) => {
    const categoria = e.target.value;
    setFormData((prev) => ({ ...prev, buy_type_ids: [], type: categoria }));
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

    // Trocar de TORNEIO invalida os meios de entrada marcados: eles pertencem
    // ao torneio, e manter a escolha cobraria o preço do torneio anterior (ou
    // de um cadastro que nem existe no novo). Trocar de DIA os mantém — a
    // lista é a mesma em todos os dias do torneio.
    if (name === 'tournament_id') {
      newFormData.buy_type_ids = [];
      if (!semTiposDeBuy) newFormData.type = '';
    }

    setFormData(newFormData);
  };

  // Mostra o NOME do meio de entrada vendido (é o que o clube cadastrou e o que
  // o operador reconhece). A primeira fonte é o nome CONGELADO na venda: a
  // lista carregada é a do torneio escolhido no formulário, e o extrato mostra
  // vendas de todos os torneios — procurar nela deixaria a maioria sem nome.
  // Sem nenhum dos dois, cai no rótulo da categoria (vendas antigas).
  const getTransactionTypeBadge = (transaction) => {
    const classes = { buy_in: 'badge-success', rebuy: 'badge-warning', addon: 'badge-info', prize: 'badge-danger' };
    const bt = activeBuyTypes.find((b) => b.id === transaction.buy_type_id);
    const label = transaction.buy_type_name
      || (bt ? bt.name : buyCategoryLabel(transaction.is_fee ? 'fee' : transaction.type));
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

  // ── Filtro do extrato: torneio e, no torneio de vários dias, o dia ──────
  // As vendas da etapa já chegam todas; o filtro é na tela. O dia de uma
  // venda é o da INSCRIÇÃO (tournament_player), lida do torneio escolhido.
  const torneiosDoExtrato = useMemo(() => {
    const vistos = new Map();
    for (const tx of transactions) {
      if (tx.tournament_id && !vistos.has(tx.tournament_id)) {
        vistos.set(tx.tournament_id, tx.tournament_name || tx.tournament_id);
      }
    }
    // A lista vem da venda mais recente para a mais antiga: o torneio da noite
    // aparece primeiro.
    return [...vistos.entries()].map(([id, nome]) => ({ id, nome }));
  }, [transactions]);

  useEffect(() => {
    setFiltroDia('');
    setDiasDoFiltro([]);
    if (!filtroTorneio) return undefined;
    let vivo = true;
    api.get(`/tournament-days/tournament/${filtroTorneio}`, { _silentError: true })
      .then((res) => {
        if (!vivo) return;
        const dias = (Array.isArray(res?.data) ? res.data : []).slice().sort((a, b) => (
          ((a.day_type === 'final') - (b.day_type === 'final')) || ((a.day_number || 0) - (b.day_number || 0))
        ));
        setDiasDoFiltro(dias);
      })
      .catch(() => { /* sem os dias, filtra só pelo torneio */ });
    return () => { vivo = false; };
  }, [filtroTorneio]);

  // Inscrições do torneio (para saber o dia de cada venda): só quando ele tem
  // mais de um dia, e relidas quando entra venda nova (inscrição nova).
  const variosDias = diasDoFiltro.length > 1;
  const quantidadeDeVendas = transactions.length;
  useEffect(() => {
    if (!filtroTorneio || !variosDias) { setDiaDaInscricao(new Map()); return undefined; }
    let vivo = true;
    api.get(`/tournament-players/tournament/${filtroTorneio}`, { _silentError: true })
      .then((res) => {
        if (!vivo) return;
        setDiaDaInscricao(new Map((Array.isArray(res?.data) ? res.data : []).map((i) => [i.id, i.tournament_day_id])));
      })
      .catch(() => {});
    return () => { vivo = false; };
  }, [filtroTorneio, variosDias, quantidadeDeVendas]);

  const transacoesFiltradas = useMemo(() => transactions.filter((tx) => {
    if (filtroTorneio && tx.tournament_id !== filtroTorneio) return false;
    // Prêmio não tem inscrição: com um dia escolhido, fica de fora.
    if (filtroDia && diaDaInscricao.get(tx.tournament_player_id) !== filtroDia) return false;
    return true;
  }), [transactions, filtroTorneio, filtroDia, diaDaInscricao]);

  // Memoizado: só recalcula quando a lista de transações muda (não a cada render).
  // Venda cancelada fica FORA dos totais: o dinheiro voltou para o jogador, e
  // contá-la faria o operador procurar na gaveta um valor que não está lá.
  // Os totais seguem o filtro de torneio/dia.
  const totals = useMemo(() => {
    const acc = { buy_in: 0, rebuy: 0, addon: 0, fee: 0, total: 0 };
    transacoesFiltradas.forEach(t => {
      if ((t.status || 'active') !== 'active') return;
      // Prêmio é SAÍDA (sai do caixa geral): somá-lo inflava o total geral
      // com o valor pago ao jogador, como se fosse uma venda.
      if (t.type === 'prize') return;
      const v = parseFloat(t.amount) || 0;
      // Taxa (Bono Dealer etc.) é vendida como addon, mas não é add-on.
      const categoria = t.type === 'addon' && t.is_fee ? 'fee' : t.type;
      if (acc[categoria] !== undefined) acc[categoria] += v;
      acc.total += v;
    });
    return acc;
  }, [transacoesFiltradas]);

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
      avisarQueOCaixaMudou();
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
              <Icon name="dollar" />
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

        {/* Os meios de entrada são do DIA, e o dia só é escolhido dentro do
            formulário de venda — por isso o aviso de "dia sem cadastro" mora
            lá, e não aqui: no topo da tela ele seria um palpite. */}
        {!selectedStage?.id && (
          <div className="cx-warning" role="alert">
            <span>
              {t('cashRegister.noStageSelected', 'Selecione uma etapa para vender.')}
            </span>
          </div>
        )}

        {/* Filtro do extrato: os totais e a lista seguem o torneio (e o dia,
            quando o torneio tem vários). */}
        {!loading && torneiosDoExtrato.length > 0 && (
          <div className="cx-filtros" role="group" aria-label={t('cashRegister.filterLabel', 'Filtrar vendas')}>
            <label className="cx-filtro">
              <span>{t('cashRegister.filterTournament', 'Torneio')}</span>
              <select value={filtroTorneio} onChange={(e) => setFiltroTorneio(e.target.value)}>
                <option value="">{t('cashRegister.filterAllTournaments', 'Todos os torneios')}</option>
                {torneiosDoExtrato.map((tr) => <option key={tr.id} value={tr.id}>{tr.nome}</option>)}
              </select>
            </label>
            {variosDias && (
              <label className="cx-filtro">
                <span>{t('cashRegister.filterDay', 'Dia')}</span>
                <select value={filtroDia} onChange={(e) => setFiltroDia(e.target.value)}>
                  <option value="">{t('cashRegister.filterAllDays', 'Todos os dias')}</option>
                  {diasDoFiltro.map((d) => <option key={d.id} value={d.id}>{d.day_name}</option>)}
                </select>
              </label>
            )}
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
              {totals.fee > 0 && (
                <Card className="stat-card">
                  <div className="cx-stat-icon">
                    <svg viewBox="0 0 24 24" fill="currentColor"><path d="M18 17H6v-2h12v2zm0-4H6v-2h12v2zm0-4H6V7h12v2zM3 22l1.5-1.5L6 22l1.5-1.5L9 22l1.5-1.5L12 22l1.5-1.5L15 22l1.5-1.5L18 22l1.5-1.5L21 22V2l-1.5 1.5L18 2l-1.5 1.5L15 2l-1.5 1.5L12 2l-1.5 1.5L9 2 7.5 3.5 6 2 4.5 3.5 3 2v20z"/></svg>
                  </div>
                  <div className="stat-info">
                    <h3>{formatCurrency(totals.fee)}</h3>
                    <p>{t('cashRegister.totalFees', 'Total Taxas')}</p>
                  </div>
                </Card>
              )}
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
          ) : transacoesFiltradas.length === 0 ? (
            <EmptyState icon={null} title={t('cashRegister.noTransactionsInFilter', 'Nenhuma venda neste filtro.')} />
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
                  {transacoesFiltradas.map((transaction) => (
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
                            {/* Add-on também reimprime: sai como bilhete de
                                FICHAS, com a mesa atual (ver handleReprint). */}
                            {['buy_in', 'rebuy', 'addon'].includes(transaction.type) && (
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
                            {/* Prêmio não é venda: não há forma de pagamento a trocar. */}
                            {transaction.type !== 'prize' && (
                              <button
                                type="button"
                                className="reprint-btn"
                                onClick={() => abrirTrocaDeMetodo(transaction)}
                              >
                                {t('cashRegister.changePaymentMethod', 'Trocar pagamento')}
                              </button>
                            )}
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
          <div className="modal-overlay" role="presentation" onClick={aoClicarNoFundo(fecharVenda)}>
            <div className="modal">
              <div className="modal-header">
                <h2>{t('cashRegister.newTransaction')}</h2>
                <button type="button" className="close-btn" onClick={() => setShowModal(false)} aria-label={t('common.close')}>
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

                {/* Torneio por equipes: a equipe inteira num lançamento só. */}
                {temMeioPorEquipe && formData.tournament_id && torneioDosMeios === formData.tournament_id && (
                  <div className="form-group">
                    <button
                      type="button"
                      className="eq-link-btn"
                      onClick={() => { setCobrarEquipeDe(formData.tournament_id); setShowModal(false); }}
                    >
                      {t('teams.chargeFromCashier', 'Inscrição por equipe? Cobrar equipe')}
                    </button>
                  </div>
                )}

                {/* Só o torneio com MAIS de um dia pergunta qual; no de dia
                    único o dia entra sozinho (loadTournamentDays) e aqui fica
                    só a linha com lotação e valor, para o operador conferir. */}
                {tournamentDays.length > 1 && (
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
                  </div>
                )}
                {tournamentDays.length === 1 && diaSelecionado && (
                  <p className="cx-day-auto" data-testid="dia-unico">
                    {t('cashRegister.day')}: {diaSelecionado.day_name} - {formatCurrency(diaSelecionado.buy_in)} ({diaSelecionado.registered_players}/{diaSelecionado.max_players} {t('cashRegister.playersLabel')})
                  </p>
                )}
                {/* O dia só é escolhido aqui dentro, então o bloqueio por
                    DIA só pode ser avisado depois da escolha. */}
                {salesBlockedDay && (
                  <p className="cx-credit-warning" role="alert">
                    {diaSelecionado?.sales_blocked_reason
                      || t('sales.blockedDayHint', 'Vendas encerradas para este dia.')}
                  </p>
                )}

                {/* Estado das MESAS, avisado ANTES de vender. Fica aqui e não
                    no topo da tela porque o dia — que é quem tem as mesas — só
                    é escolhido dentro deste formulário; no topo o aviso seria
                    um palpite. Nenhum deles bloqueia o botão de registrar. */}
                {avisarSemMesa && (
                  <div className="cx-warning cx-warning--mesas" role="alert">
                    <strong>{t('cashRegister.noTablesTitle', 'Nenhuma mesa cadastrada')}</strong>
                    <span>
                      {t(
                        'cashRegister.noTablesHint',
                        'Este dia não tem mesa ativa. A venda pode ser feita, mas o jogador vai sair com bilhete de ALTERNADO — cadastre as mesas em Mesas para o assento sair no bilhete.'
                      )}
                    </span>
                  </div>
                )}
                {avisarMesasTravadas && (
                  <output className="cx-warning cx-warning--mesas">
                    <strong>{t('cashRegister.tablesLockedTitle', 'Mesas travadas')}</strong>
                    <span>
                      {t(
                        'cashRegister.tablesLockedHint',
                        'As mesas estão travadas: quem entrar agora vai para a fila de alternados. O bilhete de alternado está correto.'
                      )}
                    </span>
                  </output>
                )}
                {avisarMesasDesconhecidas && (
                  <output className="cx-warning cx-warning--mesas">
                    <strong>{t('cashRegister.tablesUnknownTitle', 'Sem conexão')}</strong>
                    <span>
                      {t(
                        'cashRegister.tablesUnknownHint',
                        'Sem internet não dá para conferir as mesas. A venda é guardada e o assento é definido na sincronização.'
                      )}
                    </span>
                  </output>
                )}

                {avisarReentradaSemEliminado && (
                  <div className="cx-warning" role="alert">
                    <strong>{t('cashRegister.reentryNoEliminatedTitle')}</strong>
                    <span>
                      {reentradaPorMesa
                        ? t('cashRegister.reentryNoEliminatedTable')
                        : t('cashRegister.reentryNoEliminatedBulk')}
                    </span>
                  </div>
                )}

                <div className="form-group">
                  <label htmlFor="player_id">{t('cashRegister.player')}</label>
                  <PlayerSelect
                    value={formData.player_id}
                    onChange={handleChange}
                    required
                    name="player_id"
                    allowedIds={reentradaPorMesa && Array.isArray(eliminadosDoDia) ? eliminadosDoDia : undefined}
                  />
                  {reentradaPorMesa && (
                    <small className="cx-field-hint">{t('cashRegister.reentryOnlyEliminated')}</small>
                  )}
                </div>

                {/* Torneio sem meio de entrada cadastrado: a venda CONTINUA,
                    pela categoria e com o valor/rake do dia. O aviso é
                    informativo, não uma trava — e fica aqui porque só depois
                    de escolher o torneio dá para afirmar que ele não tem
                    cadastro. */}
                {nenhumTipoCadastrado && (
                  <div className="cx-warning" role="alert">
                    <strong>{t('cashRegister.noBuyTypesTitle', 'Nenhum meio de entrada cadastrado')}</strong>
                    <span>
                      {t(
                        'cashRegister.noBuyTypes',
                        'Este torneio não tem meios de entrada. A venda usa a categoria e o valor/rake do dia; cadastre os meios de entrada na edição do torneio.'
                      )}
                    </span>
                  </div>
                )}

                {/* Com meios de entrada disponíveis, o meio é a ÚNICA fonte da
                    categoria, do valor, do rake e das fichas — sem opção
                    "Manual" nem categoria solta ao lado. Sem nenhum à mão (dia
                    sem cadastro, sessão caída ou offline), o seletor vira o de
                    CATEGORIA: melhor vender com o valor do dia do que não
                    vender. */}
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
                  <div
                    className="form-group cx-buytypes"
                    role="group"
                    aria-labelledby="cx-buytypes-label"
                  >
                    <span id="cx-buytypes-label" className="cx-buytypes-label">
                      {t('cashRegister.buyType', 'Meio de entrada')}
                    </span>
                    <small className="cx-field-hint">
                      {t(
                        'cashRegister.buyTypesHint',
                        'Marque tudo o que o jogador está comprando: uma entrada (buy-in ou reentrada) e os extras, como add-on e bono dealer. Sai um bilhete só, com o total de fichas.'
                      )}
                    </small>
                    {/* O NOME configurado no torneio vem primeiro: é por ele
                        que o operador escolhe. Valor e fichas ao lado são os do
                        próprio meio de entrada — "Rebuy duplo" cobra o preço
                        dele, não o dobro do rebuy simples. */}
                    <div className="cx-buytype-list">
                      {activeBuyTypes.map((b) => {
                        const marcado = formData.buy_type_ids.includes(b.id);
                        return (
                          <label
                            key={b.id}
                            className={`cx-buytype-option${marcado ? ' is-checked' : ''}`}
                          >
                            <input
                              type="checkbox"
                              name="buy_type_ids"
                              value={b.id}
                              checked={marcado}
                              onChange={() => alternarMeio(b.id)}
                            />
                            <span className="cx-buytype-name">{b.name}</span>
                            <span className="cx-buytype-meta">
                              {buyCategoryLabel(b.category)} · {formatCurrency(b.amount)} · {formatarFichas(fichasDoTipo(b, diaSelecionado))} {t('cashRegister.chipsUnit', 'fichas')} · {Number(b.rake_percentage)}% rake
                            </span>
                          </label>
                        );
                      })}
                    </div>
                  </div>
                )}

                <div className="cx-sale-totals">
                  <div className="form-group">
                    <label htmlFor="amount">{t('cashRegister.amount')}</label>
                    {/* Somente leitura: o backend IGNORA qualquer valor digitado
                        — cada item cobra o do seu meio de entrada (o do dia,
                        quando não há nenhum). Aqui é só a SOMA deles. */}
                    <input
                      id="amount"
                      name="amount"
                      type="number"
                      step="0.01"
                      value={totaisDaVenda.amount}
                      readOnly
                      placeholder="0.00"
                    />
                  </div>
                  <div className="form-group">
                    <label htmlFor="total_chips">{t('cashRegister.totalChips', 'Fichas a entregar')}</label>
                    <input
                      id="total_chips"
                      name="total_chips"
                      type="text"
                      value={formatarFichas(totaisDaVenda.chips)}
                      readOnly
                    />
                  </div>
                </div>

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
                      {totaisDaVenda.amount > playerCredit && (
                        <option value="mixed">{t('cashRegister.paymentSourceMixed')}</option>
                      )}
                    </select>
                    {formData.payment_source === 'credit' && totaisDaVenda.amount > playerCredit && (
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
          <div className="modal-overlay" role="presentation" onClick={aoClicarNoFundo(fecharCancelamento)}>
            <div className="modal">
              <div className="modal-header">
                <h2>
                  {estornoIncompleto(cancelling)
                    ? t('cashRegister.finishCancel', 'Concluir estorno')
                    : t('cashRegister.cancelSale', 'Cancelar venda')}
                </h2>
                <button type="button" className="close-btn" onClick={() => setCancelling(null)} aria-label={t('common.close')}>
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
          <div className="modal-overlay" role="presentation" onClick={aoClicarNoFundo(fecharTrocaDeMetodo)}>
            <div className="modal">
              <div className="modal-header">
                <h2>{t('cashRegister.changePaymentMethod', 'Trocar pagamento')}</h2>
                <button type="button" className="close-btn" onClick={() => setChangingMethod(null)} aria-label={t('common.close')}>
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
          <div className="modal-overlay" role="presentation" onClick={aoClicarNoFundo(fecharTicket)}>
            <div className="modal">
              <div className="modal-header">
                <h2>
                  {tituloDoBilhete(allocationData)}
                </h2>
                <button type="button" className="close-btn" onClick={() => { setShowTicketModal(false); loadData(); }} aria-label={t('common.close')}>
                  <span className="close-icon"></span>
                </button>
              </div>
              <div className="modal-body">
                {/* Por que este bilhete saiu sem assento. "Mesas cheias" é fila
                    de alternados de verdade; "nenhuma mesa cadastrada" é a
                    etapa por configurar e o bilhete NÃO significa fila. */}
                {allocationData.motivo_alternate === 'sem-mesas' && (
                  <p className="cx-warning cx-warning--mesas" role="alert">
                    {t(
                      'cashRegister.ticketNoTablesHint',
                      'Não há mesa cadastrada neste dia: o jogador não entrou em fila de alternados. Cadastre as mesas em Mesas e aloque o jogador.'
                    )}
                  </p>
                )}
                {allocationData.motivo_alternate === 'sem-conexao' && (
                  <output className="cx-warning cx-warning--mesas">
                    {t(
                      'cashRegister.ticketOfflineHint',
                      'Venda guardada sem internet: o assento é definido na sincronização.'
                    )}
                  </output>
                )}
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
                    sem_assento: allocationData.sem_assento,
                    so_fichas: allocationData.so_fichas,
                    // O que o jogador comprou NESTA venda e o total de fichas:
                    // é por esse número que o floor entrega a pilha.
                    itens: allocationData.itens,
                    total_amount: allocationData.total_amount,
                    total_chips: allocationData.total_chips,
                  }}
                  formatarValor={formatCurrency}
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
        {cobrarEquipeDe && (
          <CobrarEquipeModal
            tournamentId={cobrarEquipeDe}
            onFechar={() => setCobrarEquipeDe(null)}
            onCobrado={(res) => {
              setCobrarEquipeDe(null);
              toast.success(t('teams.charged', 'Equipe cobrada: {{n}} inscrição(ões).', { n: res?.charged ?? 0 }));
              loadData();
            }}
          />
        )}
      </main>
    </div>
  );
};

export default Caixa;
