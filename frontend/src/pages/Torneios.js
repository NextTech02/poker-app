import React, { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import Sidebar from '../components/Sidebar';
import Icon from '../components/Icon';
import EmptyState from '../components/EmptyState';
import { SkeletonTournamentCard } from '../components/SkeletonLoader';
import EntryTypesEditor from '../components/EntryTypesEditor';
import api from '../config/api';
import { getSelectedStage } from '../utils/stageUtils';
import { cachedGet, invalidateCache } from '../utils/apiCache';
import { useToast } from '../contexts/ToastContext';
import { useStage } from '../contexts/StageContext';
import { useCurrency } from '../contexts/CurrencyContext';
import { colunasDoDia, linhasDaApi, meiosPadrao, meiosParaApi, validarMeios } from '../utils/entryTypes';
import { FORMATOS_KO, formatoKo, koParaApi } from '../utils/ko';
import { MAX_FINALISTAS, equipesDoTorneio, equipesParaApi } from '../utils/equipes';
import { bilheteDoTorneio, bilheteParaApi } from '../utils/bilhete';
import BilheteConfigModal from '../components/bilhete/BilheteConfigModal';
import ExcluirComVendasModal from '../components/ExcluirComVendasModal';
import { usePermissions } from '../contexts/PermissionContext';
import ImagemDoBilheteCampo from '../components/bilhete/ImagemDoBilheteCampo';
import { useRealtimeRefresh } from '../hooks/useRealtimeRefresh';
import { useEscapeKey } from '../hooks/useEscapeKey';
import './Torneios.css';

// As duas formas de eliminar jogadores, na ordem em que aparecem no modal.
// Os dois modos seguem a mesma conta: toda entrada soma um jogador e toda
// reentrada traz de volta um eliminado. Muda só QUEM mexe no contador.
const MODOS_DE_ELIMINACAO = ['table', 'bulk'];

// Rótulos e dicas dos formatos de KO (padrão das chaves tournaments.koFormat_*).
const ROTULO_KO = { none: 'Nenhuma', ko: 'KO fixo', pko: 'PKO (progressivo)', mystery: 'Mystery Bounty' };
const DICA_KO = {
  none: 'Sem prêmio por eliminação: todo o pool vai para as posições.',
  ko: 'Quem elimina leva o bounty inteiro do jogador, pago na hora pelo caixa geral. Exige eliminação pelas mesas.',
  pko: 'Quem elimina leva parte do bounty em dinheiro; o resto soma no bounty dele. O campeão leva o próprio bounty no fim. Exige eliminação pelas mesas.',
  mystery: 'O pool KO vira envelopes quando o floor inicia a fase Mystery; cada eliminação sorteia um envelope. Exige eliminação pelas mesas.',
};

// O formulário do modal. Buy-in, rebuy, add-on e as fichas de cada um não moram
// mais aqui: viraram linhas da lista de MEIOS DE ENTRADA do torneio (estado
// próprio, `entryRows`), que é de onde o Caixa vende e de onde as colunas
// antigas dos dias são preenchidas.
const FORM_INICIAL = {
  name: '',
  has_qualifying: false,
  // Como o diretor elimina jogadores. 'bulk' é o padrão do banco e o único
  // modo que existia antes da escolha.
  elimination_mode: 'bulk',
  // Premiação por eliminação: formato, % do pozo líquido que vira pozo KO e,
  // no PKO, quanto do bounty é pago em dinheiro (o resto soma no de quem
  // eliminou). Não muda depois da primeira venda — o servidor recusa.
  ko_format: 'none',
  ko_percentage: '',
  ko_cash_share: '50',
  // Mystery: garantido do fundo e nível em que a fase começa.
  mystery_guarantee: '',
  mystery_start_level: '',
  // Torneio por equipes (bases do NSOP): Fase 1 = um dia classificatório com
  // pontos por mesa; Fase 2 = o dia final por revezamento.
  team_mode: false,
  team_finalists: '',
  team_tiebreak: 'best_individual',
  team_allow_reentry: false,
  // Bilhete deste torneio (em branco = o padrão do clube).
  ticket_logo_path: '',
  ticket_city: '',
  ticket_venue: '',
  qualifying_days: 2,
  qualifying_max_players: 100,
  qualifying_rebuy_level_limit: '',
  blind_template_id: '',
};

// Rótulo do N-ésimo dia classificatório como o salão chama: 1A, 1B, 1C…
// (o formulário limita a 20 dias; além do Z volta ao número puro).
export const rotuloDoClassificatorio = (n) => (n >= 1 && n <= 26 ? `1${String.fromCharCode(64 + n)}` : String(n));

// Campos do KO do formulário a partir do torneio gravado.
const koDoTorneio = (torneio) => ({
  ko_format: formatoKo(torneio),
  ko_percentage: torneio?.ko_percentage != null && Number(torneio.ko_percentage) > 0
    ? String(Number(torneio.ko_percentage)) : '',
  ko_cash_share: String(torneio?.ko_cash_share != null ? Number(torneio.ko_cash_share) : 50),
  mystery_guarantee: torneio?.mystery_guarantee != null && Number(torneio.mystery_guarantee) > 0
    ? String(Number(torneio.mystery_guarantee)) : '',
  mystery_start_level: torneio?.mystery_start_level != null ? String(torneio.mystery_start_level) : '',
});

const Torneios = () => {
  const { t } = useTranslation();
  const { toast, confirm } = useToast();
  const { selectedStage } = useStage();
  const { currency, formatCurrency } = useCurrency();
  const { isAdmin, hasPermission } = usePermissions();
  // Mesma permissão do estorno de venda no Caixa: quem administra o caixa.
  const podeEstornar = isAdmin || hasPermission('cashbox.admin');
  const hasStage = !!selectedStage?.id;

  const [tournaments, setTournaments] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showModal, setShowModal] = useState(false);
  const [showEditModal, setShowEditModal] = useState(false);
  const [editingTournament, setEditingTournament] = useState(null);
  const [formData, setFormData] = useState(FORM_INICIAL);
  // Meios de entrada do torneio (nome, valor, rake e fichas por linha). A lista
  // é UMA por torneio e vale para todos os dias dele — por isso aparece nos
  // dois caminhos, com ou sem classificatórios.
  const [entryRows, setEntryRows] = useState([]);
  // Desativados que vieram do banco: não aparecem, mas voltam no PUT — vendas
  // antigas apontam para eles e sumir com eles apagaria o rótulo do recibo.
  const [inactiveRows, setInactiveRows] = useState([]);
  const [entryError, setEntryError] = useState('');
  // Na edição a lista vem do servidor. Se não vier, o editor trava e o PUT é
  // pulado ao salvar: uma carga falhada nunca pode sobrescrever a lista real.
  const [entryLoadFailed, setEntryLoadFailed] = useState(false);
  const [blindTemplates, setBlindTemplates] = useState([]);
  const [submitting, setSubmitting] = useState(false);
  // Na edição, a configuração do KO vem do torneio COMPLETO: a lista de
  // torneios (função do banco com colunas fixas) não traz esses campos. Até
  // chegar, o formato fica travado e o salvar não mexe no KO — senão a tela
  // mandaria "Nenhuma" por cima de um torneio Mystery.
  const [koCarregado, setKoCarregado] = useState(false);
  // O torneio editado ERA por equipes? Desligar o modo precisa ir explícito.
  const [eraPorEquipes, setEraPorEquipes] = useState(false);
  const [formError, setFormError] = useState('');
  // Bilhete de inscrição do CLUBE (imagem, cidade, sede, enfeites).
  const [showBilhete, setShowBilhete] = useState(false);
  // Torneio criado por engano sendo excluído junto com as compras (o impacto).
  const [excluindoComVendas, setExcluindoComVendas] = useState(null);

  useEffect(() => {
    loadTournaments();
    loadBlindTemplates();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Todo torneio novo abre com os três meios de sempre (Buy-in, Rebuy, Add-on),
  // rake 20% e valor em branco; o clube renomeia, muda e acrescenta o que vende.
  useEffect(() => {
    if (!showModal) return;
    setEntryRows(meiosPadrao(t));
    setInactiveRows([]);
    setEntryError('');
    setEntryLoadFailed(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showModal]);

  // Polling que pausa quando a aba está oculta (reduz carga em produção).
  // A lista muda pouco: o que a movimenta é o status derivado dos dias
  // (pendente -> ativo -> encerrado). Perguntar de 5 em 5 segundos por isso
  // era o pior negócio do app.
  useRealtimeRefresh({
    canal: `torneios-${selectedStage?.id || 'sem-etapa'}`,
    tabelas: [{ table: 'tournaments' }, { table: 'tournament_days' }],
    aoMudar: () => loadTournaments(),
    ativo: hasStage,
  });

  // Patrocinador NÃO é do torneio: é do jogador (cadastro de jogadores). O
  // campo saiu do formulário a pedido do cliente (2026-10); a coluna
  // `sponsor_id` dos torneios antigos fica como está, só não é mais editada.
  const loadBlindTemplates = async () => {
    try {
      const data = await cachedGet(api, '/blind-templates', 60000);
      setBlindTemplates(data || []);
    } catch (err) {
      console.error('Erro ao carregar templates de blind:', err);
    }
  };

  const loadTournaments = async () => {
    try {
      // B3: cache de 30s — navegar para cá e voltar não re-fetcha
      const data = await cachedGet(api, '/tournaments', 30000);
      setTournaments(data);
    } catch (err) {
      console.error('Erro ao carregar torneios:', err);
    } finally {
      setLoading(false);
    }
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    setFormError('');

    // Bloqueio: um torneio precisa estar vinculado a uma etapa. O vínculo é
    // enviado via header X-Stage-ID (a partir da etapa selecionada). Sem etapa
    // selecionada, nem chega a chamar a API.
    const selectedStage = getSelectedStage();
    if (!selectedStage?.id) {
      setFormError(t('tournaments.selectStageFirst'));
      return;
    }

    // Sem meio de entrada válido o torneio nem é criado: sem um buy-in o Caixa
    // não teria o que vender, e um meio sem nome não dá para escolher.
    const problema = validarMeios(entryRows, t);
    if (problema) {
      setEntryError(problema);
      return;
    }

    setSubmitting(true);
    try {
      const res = await api.post('/tournaments', {
        name: formData.name,
        has_qualifying: formData.has_qualifying,
        elimination_mode: formData.elimination_mode || 'bulk',
        ...koParaApi(formData),
        ...equipesParaApi(formData),
        ...bilheteParaApi(formData),
      });
      const newTournamentId = res?.data?.id;

      // Os meios de entrada são do TORNEIO: gravados uma vez, valem para todos
      // os dias — inclusive os que forem criados depois, à mão. Sem eles o
      // Caixa venderia só pela categoria, com o valor do dia e sem nome.
      if (newTournamentId) {
        try {
          await api.put(`/tournaments/${newTournamentId}/buy-types`, {
            items: meiosParaApi(entryRows),
          });
        } catch (btErr) {
          // O torneio já existe; avisar em vez de derrubar a criação inteira.
          toast.warning(t('tournaments.buyTypesPartial', 'Torneio criado, mas não foi possível salvar os meios de entrada. Cadastre-os na edição do torneio.'));
        }
      }

      // Qualifying tournaments: auto-generate the whole structure — one final day
      // plus N qualifying days, each already linked to the final via
      // qualifies_to_day_id — so the operator doesn't create them day by day.
      if (formData.has_qualifying && newTournamentId) {
        // Por equipes: UM dia de Fase 1 (pontos por mesa) + a final por revezamento.
        const porEquipes = !!formData.team_mode;
        const qCount = porEquipes ? 1 : Math.max(1, parseInt(formData.qualifying_days, 10) || 1);
        // As colunas antigas do dia (buy_in, fichas...) seguem o primeiro meio
        // de cada categoria: telas e relatórios que ainda as leem não podem
        // contar uma história diferente da que o Caixa cobra.
        const colunas = colunasDoDia(entryRows);
        try {
          const finalRes = await api.post('/tournament-days', {
            tournament_id: newTournamentId,
            // No idioma da tela: "Día Final" / "Dia Final" / "Final Day".
            day_name: porEquipes
              ? t('teams.finalDayName', 'Final por revezamento')
              : t('tournaments.finalDayName', 'Dia Final'),
            day_number: qCount + 1,
            day_type: 'final',
            buy_in: 0,
            max_players: 1000,
            starting_chips: 0,
            rake_percentage: 0,
          });
          const finalDayId = finalRes?.data?.id || null;
          const qualifyingDayIds = [];
          for (let i = 1; i <= qCount; i++) {
            const dayRes = await api.post('/tournament-days', {
              tournament_id: newTournamentId,
              // "Día 1A", "Día 1B"… — como o clube chama os classificatórios.
              day_name: porEquipes
                ? t('teams.stage1DayName', 'Fase 1 — Pontos por mesa')
                : t('tournaments.qualifyingDayName', 'Dia {{label}}', { label: rotuloDoClassificatorio(i) }),
              // Por equipes, o Caixa não senta ninguém: as mesas saem do
              // sorteio por equipes (integrantes em mesas diferentes).
              ...(porEquipes ? { allocation_type: 'manual' } : {}),
              day_number: i,
              day_type: 'qualifying',
              qualifies_to_day_id: finalDayId,
              ...colunas,
              // O rake vem do meio de entrada escolhido na venda — 0 aqui.
              rake_percentage: 0,
              // Moeda segue o setting GLOBAL (Financeiro) — sem seleção por torneio.
              currency,
              max_players: parseInt(formData.qualifying_max_players, 10) || 100,
              rebuy_level_limit: formData.qualifying_rebuy_level_limit
                ? parseInt(formData.qualifying_rebuy_level_limit, 10)
                : null,
            });
            if (dayRes?.data?.id) qualifyingDayIds.push(dayRes.data.id);
          }

          // Aplica o template de blinds escolhido a TODOS os dias classificatórios
          // de uma só vez (o Dia Final fica em branco para ser configurado à parte).
          if (formData.blind_template_id && qualifyingDayIds.length > 0) {
            try {
              await Promise.all(
                qualifyingDayIds.map((dayId) =>
                  api.post('/blind-templates/apply', {
                    template_id: formData.blind_template_id,
                    tournament_day_id: dayId,
                    clear_existing: true,
                  })
                )
              );
            } catch (blindErr) {
              toast.warning(t('tournaments.qualifyingBlindsPartial', 'Dias criados, mas não foi possível aplicar a estrutura de blinds. Aplique manualmente na tela de Blinds.'));
            }
          }
        } catch (genErr) {
          // Tournament created OK; only the day generation failed.
          toast.warning(t('tournaments.qualifyingDaysPartial', 'Torneio criado, mas houve erro ao gerar os dias classificatórios. Adicione-os manualmente.'));
        }
      }

      toast.success(t('tournaments.createdSuccess'));
      invalidateCache('/tournaments'); // B3: invalida após mutação
      setShowModal(false);
      setFormData(FORM_INICIAL);
      loadTournaments();
    } catch (err) {
      const detail = err.userMessage || err.response?.data?.detail;
      const msg = typeof detail === 'string'
        ? detail
        : Array.isArray(detail)
          ? detail.map(d => d.msg).join(' | ')
          : t('tournaments.createError');
      setFormError(msg); // A7: erro inline dentro do modal
    } finally {
      setSubmitting(false);
    }
  };

  const handleEditSubmit = async (e) => {
    e.preventDefault();
    setFormError('');

    // Com a lista carregada, ela é validada e salva junto. Sem ela (a carga
    // falhou), o editor está travado e o PUT é pulado: nunca sobrescrever a
    // lista real com uma vazia.
    if (!entryLoadFailed) {
      const problema = validarMeios(entryRows, t);
      if (problema) {
        setEntryError(problema);
        return;
      }
    }

    setSubmitting(true);
    try {
      await api.patch(`/tournaments/${editingTournament.id}`, {
        name: formData.name,
        has_qualifying: formData.has_qualifying,
        // Trocar para "por mesa" com eliminações em massa já lançadas é
        // recusado pelo servidor (409) — a mensagem vem traduzida no erro.
        elimination_mode: formData.elimination_mode || 'bulk',
        ...(koCarregado
          ? { ...koParaApi(formData), ...equipesParaApi(formData, eraPorEquipes), ...bilheteParaApi(formData, true) }
          : {}),
      });
      if (!entryLoadFailed) {
        try {
          await api.put(`/tournaments/${editingTournament.id}/buy-types`, {
            items: meiosParaApi(entryRows, inactiveRows),
          });
        } catch (btErr) {
          // O nome já foi salvo; o modal fica aberto para o operador tentar a
          // lista de novo, em vez de achar que tudo deu certo.
          setFormError(btErr.userMessage || t('tournaments.entryTypesUpdatePartial', 'Torneio salvo, mas não foi possível salvar os meios de entrada. Tente de novo.'));
          return;
        }
      }
      toast.success(t('tournaments.updatedSuccess'));
      invalidateCache('/tournaments'); // B3
      setShowEditModal(false);
      setEditingTournament(null);
      setFormData(FORM_INICIAL);
      loadTournaments();
    } catch (err) {
      const msg = err.userMessage || t('tournaments.updateError');
      setFormError(msg);
    } finally {
      setSubmitting(false);
    }
  };

  const handleChange = (e) => {
    const { name, value } = e.target;
    setFormData((atual) => {
      const novo = { ...atual, [name]: value };
      // KO exige eliminação por mesa: é nela que o floor diz quem eliminou.
      if (name === 'ko_format' && value !== 'none') novo.elimination_mode = 'table';
      return novo;
    });
  };

  const handleCheck = (e) => {
    const { name, checked } = e.target;
    setFormData((atual) => ({ ...atual, [name]: checked }));
  };

  // Por equipes: Fase 1 (um classificatório) + final, eliminação pelas mesas
  // (os pontos saem da posição em cada mesa) e sem KO.
  const toggleTeams = () => setFormData((atual) => (atual.team_mode
    ? { ...atual, team_mode: false }
    : {
      ...atual,
      team_mode: true,
      has_qualifying: true,
      qualifying_days: 1,
      elimination_mode: 'table',
      ko_format: 'none',
    }));

  // KO é só para torneio sem classificatórios (v1): ligar os classificatórios
  // desliga o KO, e o aviso no modal diz por quê.
  const toggleQualifying = () => setFormData((atual) => ({
    ...atual,
    has_qualifying: !atual.has_qualifying,
    ko_format: !atual.has_qualifying ? 'none' : atual.ko_format,
    // Sem classificatório não há Fase 1: o modo por equipes sai junto.
    team_mode: atual.has_qualifying ? false : atual.team_mode,
  }));

  const openEditModal = async (tournament) => {
    setEditingTournament(tournament);
    setFormData({
      ...FORM_INICIAL,
      name: tournament.name,
      has_qualifying: tournament.has_qualifying || false,
      elimination_mode: tournament.elimination_mode === 'table' ? 'table' : 'bulk',
      ...koDoTorneio(tournament),
    });
    setFormError('');
    setEntryError('');
    setEntryLoadFailed(false);
    setEntryRows([]);
    setInactiveRows([]);
    setKoCarregado(false);
    setEraPorEquipes(false);
    setShowEditModal(true);
    api.get(`/tournaments/${tournament.id}`, { _silentError: true })
      .then((res) => {
        if (!res?.data) return;
        setFormData((atual) => ({
          ...atual, ...koDoTorneio(res.data), ...equipesDoTorneio(res.data), ...bilheteDoTorneio(res.data),
        }));
        setEraPorEquipes(!!res.data.team_mode);
        setKoCarregado(true);
      })
      .catch(() => { /* sem o torneio, o KO fica travado e não é enviado */ });
    // A lista do torneio vem do servidor. Falhou? O editor trava e avisa — e o
    // salvar não mexe nela.
    try {
      const res = await api.get(`/tournaments/${tournament.id}/buy-types`);
      const { ativos, inativos } = linhasDaApi(res?.data);
      setEntryRows(ativos);
      setInactiveRows(inativos);
    } catch (err) {
      console.error('Erro ao carregar meios de entrada do torneio:', err);
      setEntryLoadFailed(true);
      setEntryError(t('tournaments.entryTypesLoadError', 'Não foi possível carregar os meios de entrada deste torneio. Eles não serão alterados ao salvar.'));
    }
  };

  // Texto da recusa: repete os NÚMEROS, porque é o tamanho do que está em jogo
  // que faz o operador entender por que o sistema não deixa apagar.
  const textoDoBloqueio = (impacto) => [
    t(
      'tournaments.deleteBlocked',
      'Este torneio não pode ser excluído: tem {{entries}} entrada(s) vendida(s) somando {{amount}}, {{players}} jogador(es) pago(s) e {{prizes}} pagamento(s) de premiação. Excluir apagaria a venda, o dinheiro recebido e o registro de quem pagou — e o caixa da etapa NÃO seria estornado. Cancele as vendas no Caixa (o estorno devolve o dinheiro e acerta o caixa) antes de excluir.',
      {
        entries: impacto.entries || 0,
        amount: formatCurrency(impacto.entries_amount || 0),
        players: impacto.paying_players || 0,
        prizes: impacto.prizes || 0,
      }
    ),
    // O que o estorno em massa não resolve: o operador precisa saber o QUÊ
    // está travando, senão estorna tudo no Caixa e continua sem conseguir.
    impacto.non_cash_entries > 0 && t(
      'tournaments.deleteBlockedNonCash',
      '{{count}} venda(s) foram pagas com crédito ou ticket e precisam de ajuste manual.',
      { count: impacto.non_cash_entries }
    ),
    (impacto.blocking_links || []).includes('satellite_tickets') && t(
      'tournaments.deleteBlockedTickets', 'Há tickets de satélite ligados a este torneio.'
    ),
    (impacto.blocking_links || []).includes('satellite_prizes') && t(
      'tournaments.deleteBlockedSatPrizes', 'Há vagas de satélite (prêmio) apontando para este torneio.'
    ),
    (impacto.blocking_links || []).includes('sponsor_credit') && t(
      'tournaments.deleteBlockedCredit', 'Há crédito de patrocinador usado neste torneio.'
    ),
    impacto.paying_without_sale > 0 && t(
      'tournaments.deleteBlockedNoSale',
      '{{count}} jogador(es) têm valor pago sem venda registrada (importação ou ajuste).',
      { count: impacto.paying_without_sale }
    ),
    impacto.can_cancel_and_delete && !podeEstornar && t(
      'tournaments.deleteWithSalesAdminOnly',
      'Um administrador do caixa pode excluir este torneio junto com todas as compras.'
    ),
  ].filter(Boolean).join(' ');

  // Confirmação com números reais. Sem eles, "tem certeza?" não diz se o
  // torneio está vazio ou se leva junto o histórico de uma noite inteira.
  const textoDaConfirmacao = (nome, impacto) => {
    if (!impacto) return t('tournaments.confirmDelete');
    if (!impacto.days && !impacto.players && !impacto.cancelled_entries) {
      return t(
        'tournaments.confirmDeleteEmpty',
        'Excluir o torneio "{{name}}"? Ele não tem nenhum dia, inscrição ou venda registrada.',
        { name: nome }
      );
    }
    return t(
      'tournaments.confirmDeleteImpact',
      'Excluir o torneio "{{name}}"? Serão apagados em cascata: {{days}} dia(s), {{players}} inscrição(ões) e {{cancelled}} venda(s) já cancelada(s). Não há como desfazer.',
      {
        name: nome,
        days: impacto.days || 0,
        players: impacto.players || 0,
        cancelled: impacto.cancelled_entries || 0,
      }
    );
  };

  const handleDelete = async (id, nome) => {
    // Mede o estrago ANTES de perguntar. Apagar um torneio é ON DELETE CASCADE
    // em tudo: vendas, inscrições, dias, premiação e assentos somem junto — e o
    // caixa da etapa não é estornado, então o saldo passa a apontar dinheiro
    // sem origem e a etapa deixa de fechar.
    let impacto = null;
    try {
      const res = await api.get(`/tournaments/${id}/delete-impact`);
      impacto = res?.data || null;
    } catch {
      // Backend ainda sem o endpoint (o deploy não é atômico) ou rede caída:
      // seguimos com a confirmação genérica. Quem RECUSA de verdade é o
      // servidor — a tela só antecipa a informação.
      impacto = null;
    }

    if (impacto?.blocked) {
      // Só vendas em dinheiro em cima: oferece estornar todas e excluir.
      if (impacto.can_cancel_and_delete && podeEstornar) {
        setExcluindoComVendas(impacto);
        return;
      }
      toast.error(textoDoBloqueio(impacto), {
        title: t('tournaments.deleteBlockedTitle', 'Torneio com movimento financeiro'),
        duration: 14000,
      });
      return;
    }

    const ok = await confirm(textoDaConfirmacao(nome, impacto), {
      variant: 'danger', confirmText: t('common.delete'),
    });
    if (!ok) return;
    try {
      await api.delete(`/tournaments/${id}`);
      invalidateCache('/tournaments'); // B3
      loadTournaments();
    } catch (err) {
      // 409 = o servidor recusou por movimento financeiro. Pode acontecer mesmo
      // depois de um impacto liberado: outro operador vendeu no meio do caminho.
      if (err?.response?.status === 409) {
        const impactoDaRecusa = err.response?.data?.detail?.impact;
        toast.error(
          impactoDaRecusa ? textoDoBloqueio(impactoDaRecusa) : err.userMessage,
          { title: t('tournaments.deleteBlockedTitle', 'Torneio com movimento financeiro'), duration: 14000 }
        );
        return;
      }
      toast.error(t('tournaments.deleteError'));
    }
  };

  // A5 + A2.2: Status badge com normalização de casing e fallback para pending
  const getStatusBadge = (status) => {
    const normalized = (status || 'pending').toLowerCase();
    const map = {
      active:    { label: t('tournaments.statusActive',    'Ativo'),    cls: 'tr-status--active'    },
      pending:   { label: t('tournaments.statusPending',   'Pendente'), cls: 'tr-status--pending'   },
      completed: { label: t('tournaments.statusCompleted', 'Concluído'),cls: 'tr-status--done'      },
      cancelled: { label: t('tournaments.statusCancelled', 'Cancelado'),cls: 'tr-status--cancelled' },
    };
    const s = map[normalized] || map.pending; // fallback para pending se valor desconhecido
    return <span className={`tr-status-badge ${s.cls}`}>{s.label}</span>;
  };

  const openNewModal = () => {
    setFormData(FORM_INICIAL);
    setFormError('');
    setShowModal(true);
  };

  return (
    <div className="app-layout">
      <Sidebar />
      <main className="main-content">

        {/* ── Header ── */}
        <div className="tr-header">
          <div className="tr-header-left">
            <div className="tr-header-icon">
              <Icon name="trophy" />
            </div>
            <div>
              <h1 className="tr-title">{t('tournaments.title')}</h1>
              <p className="tr-subtitle">{t('tournaments.subtitle')}</p>
            </div>
          </div>
          <div className="tr-header-acoes">
          <button
            type="button"
            className="tr-btn-edit tr-btn-bilhete"
            onClick={() => setShowBilhete(true)}
            title={t('ticket.title', 'Bilhete de inscrição')}
          >
            {t('ticket.button', 'Bilhete')}
          </button>
          <button
            type="button"
            className="tr-btn-new"
            onClick={openNewModal}
            disabled={!hasStage}
            title={!hasStage ? t('tournaments.selectStageFirst', 'Selecione uma etapa antes de criar um torneio.') : undefined}
          >
            <svg viewBox="0 0 24 24" fill="currentColor" width="18" height="18">
              <path d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z"/>
            </svg>
            {t('tournaments.newTournament')}
          </button>
          </div>
        </div>

        {showBilhete && <BilheteConfigModal onFechar={() => setShowBilhete(false)} />}

        {/* ── Body ── */}
        {loading ? (
          /* B1: Skeleton screens em vez de texto "Carregando..." */
          <div className="tr-grid">
            <SkeletonTournamentCard />
            <SkeletonTournamentCard />
            <SkeletonTournamentCard />
          </div>
        ) : tournaments.length === 0 ? (
          /* A2: EmptyState unificado */
          <EmptyState
            icon={
              <svg viewBox="0 0 24 24" fill="currentColor">
                <path d="M19 5h-2V3H7v2H5c-1.1 0-2 .9-2 2v1c0 2.55 1.92 4.63 4.39 4.94.63 1.5 1.98 2.63 3.61 2.96V17H7v2h10v-2h-4v-1.1c1.63-.33 2.98-1.46 3.61-2.96C19.08 12.63 21 10.55 21 8V7c0-1.1-.9-2-2-2zM5 8V7h2v3.82C5.84 10.4 5 9.3 5 8zm14 0c0 1.3-.84 2.4-2 2.82V7h2v1z"/>
              </svg>
            }
            title={t('tournaments.noTournaments')}
            subtitle={t('tournaments.noTournamentsHint')}
            ctaLabel={t('tournaments.createFirst')}
            onCta={openNewModal}
          />
        ) : (
          <>
            <div className="tr-count-bar">
              <span>
                <strong>{tournaments.length}</strong>{' '}
                {tournaments.length === 1 ? t('tournaments.count', 'torneio') : t('tournaments.countPlural', 'torneios')}
              </span>
            </div>
            <div className="tr-grid">
              {tournaments.map((tournament) => {
                // JOGADORES e REENTRADAS separados. Antes o card mostrava
                // buy-ins + recompras num numero so, ao lado de um icone de
                // pessoas: quem recompra tres vezes aparecia como tres jogadores
                // e a contagem do torneio inflava. Recompra e add-on nao criam
                // gente nova na mesa.
                const players = tournament.total_players || 0;
                const reentries = tournament.total_reentries || 0;
                // O card inteiro continua clicável pelo link "Ver detalhes" esticado sobre ele
                // (ver .tr-card-cta::after no CSS); assim o teclado alcança a navegação pelo
                // próprio link, em vez de uma <div> com onClick que o Tab nunca visita.
                return (
                  <div key={tournament.id} className="tr-card">
                    <div className="tr-card-accent" />

                    <div className="tr-card-body">
                      <div className="tr-card-icon">
                        <svg viewBox="0 0 24 24" fill="currentColor">
                          <path d="M19 5h-2V3H7v2H5c-1.1 0-2 .9-2 2v1c0 2.55 1.92 4.63 4.39 4.94.63 1.5 1.98 2.63 3.61 2.96V17H7v2h10v-2h-4v-1.1c1.63-.33 2.98-1.46 3.61-2.96C19.08 12.63 21 10.55 21 8V7c0-1.1-.9-2-2-2zM5 8V7h2v3.82C5.84 10.4 5 9.3 5 8zm14 0c0 1.3-.84 2.4-2 2.82V7h2v1z"/>
                        </svg>
                      </div>
                      <div className="tr-card-info">
                        <div className="tr-card-name">{tournament.name}</div>
                        <div className="tr-card-badges">
                          {getStatusBadge(tournament.status)}
                          {tournament.has_qualifying && (
                            <span className="tr-badge-qualifying">{t('tournaments.hasQualifying', 'Com Classificatórias')}</span>
                          )}
                        </div>
                      </div>
                    </div>

                    <div className="tr-card-stats">
                      <div className="tr-stat">
                        <svg viewBox="0 0 24 24" fill="currentColor" width="14" height="14">
                          <path d="M16 11c1.66 0 2.99-1.34 2.99-3S17.66 5 16 5c-1.66 0-3 1.34-3 3s1.34 3 3 3zm-8 0c1.66 0 2.99-1.34 2.99-3S9.66 5 8 5C6.34 5 5 6.34 5 8s1.34 3 3 3zm0 2c-2.33 0-7 1.17-7 3.5V19h14v-2.5c0-2.33-4.67-3.5-7-3.5zm8 0c-.29 0-.62.02-.97.05 1.16.84 1.97 1.97 1.97 3.45V19h6v-2.5c0-2.33-4.67-3.5-7-3.5z"/>
                        </svg>
                        <span>
                          <strong>{players}</strong>{' '}
                          {players === 1
                            ? t('tournaments.playersSingular', 'jogador')
                            : t('tournaments.playersPlural', 'jogadores')}
                        </span>
                      </div>
                      {reentries > 0 && (
                        <div className="tr-stat" title={t('tournaments.reentriesHint')}>
                          <svg viewBox="0 0 24 24" fill="currentColor" width="14" height="14" aria-hidden="true">
                            <path d="M12 5V1L7 6l5 5V7c3.31 0 6 2.69 6 6s-2.69 6-6 6-6-2.69-6-6H4c0 4.42 3.58 8 8 8s8-3.58 8-8-3.58-8-8-8z"/>
                          </svg>
                          <span>
                            <strong>{reentries}</strong>{' '}
                            {reentries === 1
                              ? t('tournaments.reentrySingular', 'reentrada')
                              : t('tournaments.reentryPlural', 'reentradas')}
                          </span>
                        </div>
                      )}
                    </div>

                    <div className="tr-card-footer">
                      <button
                        type="button"
                        className="tr-btn-edit"
                        onClick={() => openEditModal(tournament)}
                      >
                        <svg viewBox="0 0 24 24" fill="currentColor" width="13" height="13">
                          <path d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04a1 1 0 0 0 0-1.41l-2.34-2.34a1 1 0 0 0-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z"/>
                        </svg>
                        {t('common.edit', 'Editar')}
                      </button>
                      <button
                        type="button"
                        className="tr-btn-delete"
                        onClick={() => handleDelete(tournament.id, tournament.name)}
                      >
                        <svg viewBox="0 0 24 24" fill="currentColor" width="13" height="13">
                          <path d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/>
                        </svg>
                        {t('common.delete', 'Excluir')}
                      </button>
                      <Link
                        to={`/relatorios/torneio/${tournament.id}`}
                        className="tr-btn-edit"
                      >
                        <svg viewBox="0 0 24 24" fill="currentColor" width="13" height="13">
                          <path d="M19 3H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zM9 17H7v-7h2v7zm4 0h-2V7h2v10zm4 0h-2v-4h2v4z"/>
                        </svg>
                        {t('tournaments.report')}
                      </Link>
                      <Link
                        to={`/torneios/${tournament.id}`}
                        className="tr-card-cta"
                        aria-label={`${t('tournaments.viewDetails', 'Ver detalhes')} — ${tournament.name}`}
                      >
                        {t('tournaments.viewDetails', 'Ver detalhes')}
                        <svg viewBox="0 0 24 24" fill="currentColor" width="14" height="14">
                          <path d="M8.59 16.59L13.17 12 8.59 7.41 10 6l6 6-6 6z"/>
                        </svg>
                      </Link>
                    </div>
                  </div>
                );
              })}
            </div>
          </>
        )}

        {/* ── Create Modal ── */}
        {showModal && (
          <TournamentModal
            title={t('tournaments.newTournament')}
            formData={formData}
            onChange={handleChange}
            onCheck={handleCheck}
            onToggleQualifying={toggleQualifying}
            onToggleTeams={toggleTeams}
            onSubmit={handleSubmit}
            onClose={() => { setShowModal(false); setFormError(''); }}
            submitLabel={t('tournaments.createFirst')}
            submitting={submitting}
            formError={formError}
            blindTemplates={blindTemplates}
            currency={currency}
            entryRows={entryRows}
            onEntryRowsChange={setEntryRows}
            entryError={entryError}
            onEntryError={setEntryError}
            t={t}
          />
        )}

        {excluindoComVendas && (
          <ExcluirComVendasModal
            impacto={excluindoComVendas}
            onClose={() => setExcluindoComVendas(null)}
            onChanged={() => { invalidateCache('/tournaments'); loadTournaments(); }}
          />
        )}

        {/* ── Edit Modal ── */}
        {showEditModal && (
          <TournamentModal
            title={t('tournaments.editTitle')}
            formData={formData}
            onChange={handleChange}
            onCheck={handleCheck}
            onToggleQualifying={toggleQualifying}
            onToggleTeams={toggleTeams}
            onSubmit={handleEditSubmit}
            onClose={() => { setShowEditModal(false); setFormError(''); }}
            submitLabel={t('tournaments.saveChanges')}
            submitting={submitting}
            formError={formError}
            currency={currency}
            entryRows={entryRows}
            onEntryRowsChange={setEntryRows}
            entryError={entryError}
            onEntryError={setEntryError}
            entryLoadFailed={entryLoadFailed}
            koBloqueado={!koCarregado}
            t={t}
            isEditing
          />
        )}

      </main>
    </div>
  );
};

/* ── Shared Modal — A7: inline error + loading state ── */
const TournamentModal = ({
  title, formData, onChange, onCheck, onToggleQualifying, onToggleTeams, onSubmit, onClose, submitLabel, submitting,
  formError, blindTemplates = [], currency, t, isEditing,
  entryRows = [], onEntryRowsChange, entryError = '', onEntryError, entryLoadFailed = false,
  koBloqueado = false,
}) => {
  // O backdrop fecha no clique (mouse); no teclado o equivalente é o Esc.
  useEscapeKey(!submitting, onClose);
  const comKo = (formData.ko_format || 'none') !== 'none';
  const porEquipes = !!formData.team_mode;

  return (
  <div
    className="tr-modal-overlay"
    role="presentation"
    onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
  >
    <div className="tr-modal" role="dialog" aria-modal="true" aria-label={title}>
      <div className="tr-modal-header">
        <div className="tr-modal-title-group">
          <div className="tr-modal-icon">
            <svg viewBox="0 0 24 24" fill="currentColor">
              <path d="M19 5h-2V3H7v2H5c-1.1 0-2 .9-2 2v1c0 2.55 1.92 4.63 4.39 4.94.63 1.5 1.98 2.63 3.61 2.96V17H7v2h10v-2h-4v-1.1c1.63-.33 2.98-1.46 3.61-2.96C19.08 12.63 21 10.55 21 8V7c0-1.1-.9-2-2-2zM5 8V7h2v3.82C5.84 10.4 5 9.3 5 8zm14 0c0 1.3-.84 2.4-2 2.82V7h2v1z"/>
            </svg>
          </div>
          <h2>{title}</h2>
        </div>
        <button type="button" className="tr-modal-close" onClick={onClose} disabled={submitting} aria-label={t('common.close', 'Fechar')}>
          <svg viewBox="0 0 24 24" fill="currentColor" width="20" height="20">
            <path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/>
          </svg>
        </button>
      </div>

      <form onSubmit={onSubmit} className="tr-modal-form">
        <div className="tr-field">
          <label htmlFor="tr-name">
            {t('tournaments.tournamentName')} <span className="tr-required">*</span>
          </label>
          <input
            id="tr-name"
            name="name"
            type="text"
            value={formData.name}
            onChange={onChange}
            required
            placeholder={t('tournaments.namePlaceholder')}
            autoFocus
            disabled={submitting}
          />
          {!isEditing && <small>{t('tournaments.nameHint')}</small>}
        </div>

        {/* Como eliminar jogadores: escolha do diretor, na criação e na
            edição. Os dois modos seguem a mesma regra de entradas e
            reentradas; muda só onde o diretor marca a eliminação. */}
        <div className="tr-section-label" id="tr-elim-label">{t('tournaments.eliminationModeSection')}</div>
        <div className="tr-elim-options" role="radiogroup" aria-labelledby="tr-elim-label">
          {MODOS_DE_ELIMINACAO.map((modo) => {
            const ativo = (formData.elimination_mode || 'bulk') === modo;
            // Em massa não registra quem eliminou (KO) nem em qual mesa o
            // jogador caiu (equipes): indisponível nos dois.
            const bloqueado = modo === 'bulk' && (comKo || porEquipes);
            return (
              <label key={modo} className={`tr-elim-option ${ativo ? 'active' : ''}`}>
                <input
                  type="radio"
                  name="elimination_mode"
                  value={modo}
                  checked={ativo}
                  onChange={onChange}
                  disabled={submitting || bloqueado}
                />
                <span className="tr-elim-text">
                  <span className="tr-elim-title">
                    {modo === 'table' ? t('tournaments.eliminationModeTable') : t('tournaments.eliminationModeBulk')}
                  </span>
                  <span className="tr-elim-hint">
                    {modo === 'table' ? t('tournaments.eliminationModeTableHint') : t('tournaments.eliminationModeBulkHint')}
                  </span>
                </span>
              </label>
            );
          })}
        </div>
        <small className="tr-elim-rule">{t('tournaments.eliminationModeRule')}</small>

        {/* Premiação por eliminação: parte do pozo líquido vira prêmio para
            quem elimina (KO fixo, PKO ou envelopes Mystery). */}
        <div className="tr-section-label">{t('tournaments.koSection', 'Premiação por eliminação (KO)')}</div>
        <div className="tr-qual-grid">
          <div className="tr-field">
            <label htmlFor="tr-ko-format">{t('tournaments.koFormat', 'Formato')}</label>
            <select
              id="tr-ko-format"
              name="ko_format"
              value={formData.ko_format || 'none'}
              onChange={onChange}
              disabled={submitting || koBloqueado || !!formData.has_qualifying}
            >
              {FORMATOS_KO.map((f) => (
                <option key={f} value={f}>{t(`tournaments.koFormat_${f}`, ROTULO_KO[f])}</option>
              ))}
            </select>
          </div>
          {comKo && (
            <div className="tr-field">
              <label htmlFor="tr-ko-pct">
                {formData.ko_format === 'mystery'
                  ? t('tournaments.koPercentageMystery', '% do buy-in para Mystery')
                  : t('tournaments.koPercentage', '% do buy-in para KO')}
              </label>
              <input
                id="tr-ko-pct"
                name="ko_percentage"
                type="number"
                min="1"
                max="100"
                step="0.5"
                value={formData.ko_percentage}
                onChange={onChange}
                disabled={submitting || koBloqueado}
                required
              />
            </div>
          )}
          {formData.ko_format === 'mystery' && (
            <>
              <div className="tr-field">
                <label htmlFor="tr-ko-guarantee">{t('tournaments.mysteryGuarantee', 'Garantido Mystery (opcional)')}</label>
                <input
                  id="tr-ko-guarantee"
                  name="mystery_guarantee"
                  type="number"
                  min="0"
                  step="1"
                  value={formData.mystery_guarantee}
                  onChange={onChange}
                  disabled={submitting || koBloqueado}
                />
              </div>
              <div className="tr-field">
                <label htmlFor="tr-ko-level">{t('tournaments.mysteryStartLevel', 'Fase Mystery a partir do nível (opcional)')}</label>
                <input
                  id="tr-ko-level"
                  name="mystery_start_level"
                  type="number"
                  min="1"
                  step="1"
                  value={formData.mystery_start_level}
                  onChange={onChange}
                  disabled={submitting || koBloqueado}
                />
              </div>
            </>
          )}
          {formData.ko_format === 'pko' && (
            <div className="tr-field">
              <label htmlFor="tr-ko-cash">{t('tournaments.koCashShare', 'PKO: % pago em dinheiro')}</label>
              <input
                id="tr-ko-cash"
                name="ko_cash_share"
                type="number"
                min="1"
                max="100"
                step="1"
                value={formData.ko_cash_share}
                onChange={onChange}
                disabled={submitting || koBloqueado}
                required
              />
            </div>
          )}
        </div>
        <small className="tr-elim-rule">
          {formData.has_qualifying
            ? t('tournaments.koNoQualifying', 'A premiação por eliminação funciona só em torneio sem dias classificatórios.')
            : t(`tournaments.koHint_${formData.ko_format || 'none'}`, DICA_KO[formData.ko_format || 'none'])}
        </small>

        {/* Meios de entrada: nos DOIS caminhos (com e sem classificatórios) e
            também na edição. A lista é do torneio e vale para todos os dias. */}
        <div className="tr-section-label">{t('tournaments.entryTypesSection', 'Meios de entrada')}</div>
        <EntryTypesEditor
          linhas={entryRows}
          onChange={onEntryRowsChange}
          erro={entryError}
          onErro={onEntryError}
          currency={currency}
          disabled={submitting || entryLoadFailed}
          idPrefix="tr-entry"
          porEquipe={porEquipes}
        />

        {/* Torneio por equipes: Fase 1 (pontos por mesa) + final por
            revezamento. Liga o classificatório e a eliminação por mesa. */}
        <button
          type="button"
          role="switch"
          aria-checked={porEquipes}
          disabled={submitting || koBloqueado}
          className={`tr-toggle-card ${porEquipes ? 'active' : ''}`}
          onClick={onToggleTeams}
        >
          <div className="tr-toggle-text">
            <span className="tr-toggle-title">{t('teams.toggle', 'Torneio por equipes')}</span>
            <span className="tr-toggle-hint">
              {t('teams.toggleHint', 'Equipes de 4: Fase 1 com pontos pela posição em cada mesa e final por revezamento a cada nível.')}
            </span>
          </div>
          <div className={`tr-toggle-switch ${porEquipes ? 'on' : ''}`}>
            <div className="tr-toggle-knob" />
          </div>
        </button>

        {porEquipes && (
          <div className="tr-qual-grid">
            <div className="tr-field">
              <label htmlFor="tr-team-finalists">{t('teams.finalists', 'Equipes na final')}</label>
              <input
                id="tr-team-finalists"
                name="team_finalists"
                type="number"
                min="1"
                max={MAX_FINALISTAS}
                step="1"
                value={formData.team_finalists}
                onChange={onChange}
                disabled={submitting}
                placeholder={t('teams.finalistsPlaceholder', 'Definir depois')}
              />
            </div>
            <div className="tr-field">
              <label htmlFor="tr-team-tiebreak">{t('teams.tiebreak', '2º critério de desempate')}</label>
              <select
                id="tr-team-tiebreak"
                name="team_tiebreak"
                value={formData.team_tiebreak || 'best_individual'}
                onChange={onChange}
                disabled={submitting}
              >
                <option value="best_individual">{t('teams.tiebreak_best_individual', 'Melhores pontos individuais')}</option>
                <option value="manual">{t('teams.tiebreak_manual', 'Decisão da direção')}</option>
              </select>
            </div>
            <label className="tr-check">
              <input
                type="checkbox"
                name="team_allow_reentry"
                checked={!!formData.team_allow_reentry}
                onChange={onCheck}
                disabled={submitting}
              />
              {t('teams.allowReentry', 'Permitir reentrada na Fase 1 (vale a última eliminação)')}
            </label>
          </div>
        )}
        {/* Bilhete de inscrição deste torneio: em branco, sai o do clube
            (botão "Bilhete" no topo da lista de torneios). */}
        <div className="tr-section-label">{t('ticket.tournamentSection', 'Bilhete deste torneio (opcional)')}</div>
        <ImagemDoBilheteCampo
          id="tr-ticket-logo"
          valor={formData.ticket_logo_path}
          onChange={(v) => onChange({ target: { name: 'ticket_logo_path', value: v } })}
          disabled={submitting || (isEditing && koBloqueado)}
          vazio={t('ticket.clubLogo', 'Imagem do clube')}
        />
        <div className="tr-qual-grid">
          <div className="tr-field">
            <label htmlFor="tr-ticket-city">{t('ticket.city', 'Cidade (abaixo da imagem)')}</label>
            <input id="tr-ticket-city" name="ticket_city" maxLength={80} value={formData.ticket_city || ''}
              onChange={onChange} disabled={submitting || (isEditing && koBloqueado)}
              placeholder={t('ticket.useClub', 'Padrão do clube')} />
          </div>
          <div className="tr-field">
            <label htmlFor="tr-ticket-venue">{t('ticket.venue', 'Sede / local')}</label>
            <input id="tr-ticket-venue" name="ticket_venue" maxLength={120} value={formData.ticket_venue || ''}
              onChange={onChange} disabled={submitting || (isEditing && koBloqueado)}
              placeholder={t('ticket.useClub', 'Padrão do clube')} />
          </div>
        </div>

        {porEquipes && (
          <small className="tr-elim-rule">
            {t('teams.formHint', 'O 1º critério de desempate é o capitão. A Fase 1 vira um dia classificatório e a final um dia final, já vinculados.')}
          </small>
        )}

        <button
          type="button"
          role="switch"
          aria-checked={!!formData.has_qualifying}
          disabled={submitting || porEquipes}
          className={`tr-toggle-card ${formData.has_qualifying ? 'active' : ''}`}
          onClick={onToggleQualifying}
        >
          <div className="tr-toggle-text">
            <span className="tr-toggle-title">{t ? t('tournaments.qualifyingToggle') : 'Com Dias Classificatórios'}</span>
            <span className="tr-toggle-hint">{t ? t('tournaments.qualifyingToggleHint') : 'Torneio multi-day com classificatória + final'}</span>
          </div>
          <div className={`tr-toggle-switch ${formData.has_qualifying ? 'on' : ''}`}>
            <div className="tr-toggle-knob" />
          </div>
        </button>

        {!isEditing && formData.has_qualifying && (
          <>
            <div className="tr-field">
              <label htmlFor="tr-qdays">{t('tournaments.qualifyingDaysCount', 'Dias classificatórios')}</label>
              <input
                id="tr-qdays"
                name="qualifying_days"
                type="number"
                min="1"
                max="20"
                step="1"
                value={porEquipes ? 1 : formData.qualifying_days}
                onChange={onChange}
                disabled={submitting || porEquipes}
              />
              <small>{t('tournaments.qualifyingDaysHint', 'Criaremos esses dias classificatórios + 1 dia final, já vinculados. Todos vendem os meios de entrada cadastrados acima.')}</small>
            </div>

            {/* Buy-in, rebuy, add-on e fichas saíram daqui: vêm da lista de
                meios de entrada acima, que vale para todos os dias. */}
            <div className="tr-section-label">{t('tournaments.qualifyingValuesLabel', 'Valores aplicados a todos os dias classificatórios')}</div>
            <div className="tr-qual-grid">
              <div className="tr-field">
                <label htmlFor="tr-qmax">{t('tournaments.maxPlayers', 'Máximo de jogadores')}</label>
                <input id="tr-qmax" name="qualifying_max_players" type="number" min="1"
                  value={formData.qualifying_max_players} onChange={onChange} disabled={submitting} />
              </div>
              <div className="tr-field">
                <label htmlFor="tr-qrlimit">{t('tournamentDayForm.rebuyLevelLimit', 'Nível limite de rebuy')}</label>
                <input id="tr-qrlimit" name="qualifying_rebuy_level_limit" type="number" min="1"
                  value={formData.qualifying_rebuy_level_limit} onChange={onChange} disabled={submitting}
                  placeholder={t('tournamentDayForm.leaveEmptyUnlimited', 'Deixe vazio para ilimitado')} />
              </div>
            </div>

            <div className="tr-field">
              <label htmlFor="tr-blind-template">{t('tournaments.qualifyingBlindTemplate', 'Estrutura de blinds')}</label>
              <select
                id="tr-blind-template"
                name="blind_template_id"
                value={formData.blind_template_id || ''}
                onChange={onChange}
                disabled={submitting}
              >
                <option value="">{t('tournaments.qualifyingBlindTemplateNone', 'Nenhuma (configurar depois)')}</option>
                {blindTemplates.map((tpl) => (
                  <option key={tpl.id} value={tpl.id}>{tpl.name}</option>
                ))}
              </select>
              <small>{t('tournaments.qualifyingBlindTemplateHint', 'A estrutura escolhida será aplicada a todos os dias classificatórios. O Dia Final fica em branco para configurar à parte.')}</small>
            </div>
          </>
        )}

        {/* A7: Erro de API inline, acima dos botões */}
        {formError && (
          <div className="tr-form-error">
            <svg viewBox="0 0 20 20" fill="currentColor" width="16" height="16">
              <path fillRule="evenodd" d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zM8.707 7.293a1 1 0 00-1.414 1.414L8.586 10l-1.293 1.293a1 1 0 101.414 1.414L10 11.414l1.293 1.293a1 1 0 001.414-1.414L11.414 10l1.293-1.293a1 1 0 00-1.414-1.414L10 8.586 8.707 7.293z" clipRule="evenodd" />
            </svg>
            {formError}
          </div>
        )}

        <div className="tr-modal-footer">
          <button type="button" className="tr-btn-cancel" onClick={onClose} disabled={submitting}>
            {t('common.cancel')}
          </button>
          {/* A7: Botão com spinner durante submit */}
          <button type="submit" className="tr-btn-submit" disabled={submitting}>
            {submitting ? (
              <>
                <svg className="tr-spinner" viewBox="0 0 24 24" fill="none" width="16" height="16">
                  <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" strokeDasharray="30 70" />
                </svg>
                {t('common.saving')}
              </>
            ) : (
              <>
                <svg viewBox="0 0 24 24" fill="currentColor" width="16" height="16">
                  <path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/>
                </svg>
                {submitLabel}
              </>
            )}
          </button>
        </div>
      </form>
    </div>
  </div>
  );
};

export default Torneios;
