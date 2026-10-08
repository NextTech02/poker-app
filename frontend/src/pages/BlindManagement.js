import React, { useState, useEffect, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useTimerSync, formatTime } from '../hooks/useTimerSync';
import { useTranslation } from 'react-i18next';
import Sidebar from '../components/Sidebar';
import Card from '../components/Card';
import Button from '../components/Button';
import Breadcrumb from '../components/Breadcrumb';
import EmptyState from '../components/EmptyState';
import api from '../config/api';
import { useToast } from '../contexts/ToastContext';
import { useEscapeKey } from '../hooks/useEscapeKey';
import './BlindManagement.css';

// Fecha só quando o clique caiu no próprio fundo, não em um filho. Substitui o
// `onClick={stopPropagation}` que ficava no conteúdo do modal — aquele era um
// clique sem equivalente de teclado, e o fundo em si não é um controle.
const aoClicarNoFundo = (aoFechar) => (evento) => {
  if (evento.target === evento.currentTarget) aoFechar();
};

const BlindManagement = () => {
  const { toast, confirm } = useToast();
  const { t } = useTranslation();
  const { dayId } = useParams();
  const navigate = useNavigate();
  const [tournamentDay, setTournamentDay] = useState(null);
  const [tournament, setTournament] = useState(null);
  const [blinds, setBlinds] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showAddModal, setShowAddModal] = useState(false);
  const [showEditModal, setShowEditModal] = useState(false);
  const [editingBlind, setEditingBlind] = useState(null);
  // Inline edit (click a value to edit) + drag-to-reorder
  const [editCell, setEditCell] = useState(null); // { id, field }
  const [editVal, setEditVal] = useState('');
  const [dragId, setDragId] = useState(null);
  const [dragOverId, setDragOverId] = useState(null);
  const [reordering, setReordering] = useState(false);
  /* Blind cuja duração acabou de ser GRAVADA. Nele aparece o botão de replicar
     a duração para os níveis seguintes — "a partir do nível 3, tudo vira 20
     min" é o ajuste mais comum na véspera, e célula a célula é lento e dá
     erro. Só o id fica em estado: nível, tipo e duração são lidos da lista já
     recarregada, para o botão nunca descrever um valor que não está no banco. */
  const [ofertaReplicarId, setOfertaReplicarId] = useState(null);
  // Template states
  const [templates, setTemplates] = useState([]);
  const [showTemplateModal, setShowTemplateModal] = useState(false);

  // Esc fecha o modal aberto: o clique no fundo é gesto de mouse, e quem monta
  // a estrutura de blinds pelo teclado precisa da mesma saída.
  const fecharAdd = useCallback(() => setShowAddModal(false), []);
  const fecharEdit = useCallback(() => setShowEditModal(false), []);
  const fecharTemplates = useCallback(() => setShowTemplateModal(false), []);
  useEscapeKey(showAddModal, fecharAdd);
  useEscapeKey(showEditModal, fecharEdit);
  useEscapeKey(showTemplateModal, fecharTemplates);
  const [formData, setFormData] = useState({
    level: '',
    small_blind: '',
    big_blind: '',
    ante: 0,
    duration: 15,
    is_break: false,
  });

  const [loadError, setLoadError] = useState(null);

  // Onde o torneio está AGORA: o mesmo relógio do controle e do telão (poll +
  // Realtime). `current_level` é a POSIÇÃO (`level`) na estrutura; o diretor
  // vê a linha destacada sem precisar abrir a tela de controle.
  const { timerState } = useTimerSync(dayId, blinds);

  const loadData = useCallback(async () => {
    setLoadError(null);
    try {
      // Load tournament day first so we can distinguish "day not found"
      // from transient errors on secondary requests (ISSUE-006).
      const dayRes = await api.get(`/tournament-days/${dayId}`);
      setTournamentDay(dayRes.data);

      const [blindsRes, templatesRes] = await Promise.all([
        api.get(`/tournament-days/${dayId}/blinds`),
        api.get('/blind-templates'),
      ]);
      setBlinds(blindsRes.data.sort((a, b) => a.level - b.level));
      setTemplates(templatesRes.data);

      if (dayRes.data.tournament_id) {
        const tournamentRes = await api.get(`/tournaments/${dayRes.data.tournament_id}`);
        setTournament(tournamentRes.data);
      }
    } catch (error) {
      console.error('Error loading data:', error);
      const status = error.response?.status;
      const detail = error.response?.data?.detail;
      const message =
        status === 404
          ? t('blinds.dayNotFound', 'Dia do torneio não encontrado. Verifique o link e tente novamente.')
          : typeof detail === 'string'
            ? detail
            : t('blinds.loadErrorMessage', 'Não foi possível carregar a estrutura de blinds.');
      setLoadError({ status, message });
      toast.error(message);
    } finally {
      setLoading(false);
    }
  }, [dayId, t, toast]);

  useEffect(() => {
    loadData();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dayId]);

  const handleChange = (e) => {
    const { name, value, type, checked } = e.target;
    setFormData({
      ...formData,
      [name]: type === 'checkbox' ? checked : value,
    });
  };

  const handleAddBlind = async (e) => {
    e.preventDefault();
    try {
      const data = {
        level: parseInt(formData.level),
        duration: parseInt(formData.duration),
        is_break: formData.is_break,
      };

      // Only include blind values if it's not a break
      if (!formData.is_break) {
        data.small_blind = parseInt(formData.small_blind);
        data.big_blind = parseInt(formData.big_blind);
        data.ante = parseInt(formData.ante) || 0;
      } else {
        data.small_blind = 0;
        data.big_blind = 0;
        data.ante = 0;
      }

      await api.post(`/tournament-days/${dayId}/blinds`, data);
      setShowAddModal(false);
      setFormData({
        level: '',
        small_blind: '',
        big_blind: '',
        ante: 0,
        duration: 15,
        is_break: false,
      });
      loadData();
    } catch (error) {
      console.error('Error adding blind:', error);
      const errorMessage = error.response?.data?.detail || t('common.error');
      toast.error(typeof errorMessage === 'string' ? errorMessage : t('common.error'));
    }
  };

  const handleEditBlind = async (e) => {
    e.preventDefault();
    try {
      const data = {
        level: parseInt(formData.level),
        duration: parseInt(formData.duration),
        is_break: formData.is_break,
      };

      // Only include blind values if it's not a break
      if (!formData.is_break) {
        data.small_blind = parseInt(formData.small_blind);
        data.big_blind = parseInt(formData.big_blind);
        data.ante = parseInt(formData.ante) || 0;
      } else {
        data.small_blind = 0;
        data.big_blind = 0;
        data.ante = 0;
      }

      const editadoId = editingBlind.id;
      const mudouDuracao = data.duration !== editingBlind.duration;
      await api.patch(`/tournament-days/${dayId}/blinds/${editadoId}`, data);
      setShowEditModal(false);
      setEditingBlind(null);
      setFormData({
        level: '',
        small_blind: '',
        big_blind: '',
        ante: 0,
        duration: 15,
        is_break: false,
      });
      await loadData();
      setOfertaReplicarId(mudouDuracao ? editadoId : null);
    } catch (error) {
      console.error('Error updating blind:', error);
      const errorMessage = error.response?.data?.detail || t('common.error');
      toast.error(typeof errorMessage === 'string' ? errorMessage : t('common.error'));
    }
  };

  // ── Inline edit: click a blind value to edit it without opening the modal ──
  const patchBlind = async (blind, changes) => {
    const data = {
      level: blind.level,
      duration: blind.duration,
      is_break: blind.is_break,
      small_blind: blind.is_break ? 0 : (blind.small_blind || 0),
      big_blind: blind.is_break ? 0 : (blind.big_blind || 0),
      ante: blind.is_break ? 0 : (blind.ante || 0),
      ...changes,
    };
    await api.patch(`/tournament-days/${dayId}/blinds/${blind.id}`, data);
  };

  const startEdit = (blind, field) => {
    if (blind.is_break && field !== 'duration') return; // breaks: only duration editable
    setOfertaReplicarId(null);
    setEditCell({ id: blind.id, field });
    setEditVal(String(blind[field] ?? 0));
  };
  const cancelEdit = () => { setEditCell(null); setEditVal(''); };
  const commitEdit = async (blind) => {
    if (!editCell) return;
    const field = editCell.field;
    const n = parseInt(editVal, 10);
    const val = Number.isNaN(n) ? 0 : Math.max(0, n);
    cancelEdit();
    if ((blind[field] ?? 0) === val) return; // unchanged
    try {
      await patchBlind(blind, { [field]: val });
      await loadData();
      if (field === 'duration') setOfertaReplicarId(blind.id);
    } catch (error) {
      const msg = error.response?.data?.detail || t('common.error');
      toast.error(typeof msg === 'string' ? msg : t('common.error'));
    }
  };

  // ── Replicar a duração recém-gravada para os níveis seguintes ─────────────
  // Só alcança linhas do MESMO tipo (nível → níveis, intervalo → intervalos):
  // o intervalo tem duração própria e não pode esticar junto. É UM pedido ao
  // servidor, e não um PATCH por linha: o relógio deriva o nível atual da
  // soma das durações, e uma estrutura gravada pela metade faria o telão
  // pular de nível.
  const alvoReplicar = ofertaReplicarId ? blinds.find((b) => b.id === ofertaReplicarId) : null;
  const seguintesDiferentes = alvoReplicar
    ? blinds.filter((b) =>
        b.level > alvoReplicar.level
        && !!b.is_break === !!alvoReplicar.is_break
        && b.duration !== alvoReplicar.duration
      ).length
    : 0;

  const replicarDuracao = async () => {
    if (!alvoReplicar) return;
    const { level, duration, is_break } = alvoReplicar;
    try {
      const res = await api.post(`/tournament-days/${dayId}/blinds/replicate-duration`, {
        after_level: level,
        duration,
        is_break: !!is_break,
      });
      setOfertaReplicarId(null);
      toast.success(t(
        is_break ? 'blinds.replicatedToNextBreaks' : 'blinds.replicatedToNext',
        is_break
          ? '{{duration}} min aplicados a {{count}} intervalos seguintes.'
          : '{{duration}} min aplicados a {{count}} níveis seguintes.',
        { count: res.data?.updated ?? seguintesDiferentes, duration }
      ));
      await loadData();
    } catch (error) {
      const msg = error.response?.data?.detail || t('common.error');
      toast.error(typeof msg === 'string' ? msg : t('common.error'));
    }
  };

  // ── Nível atual ───────────────────────────────────────────────────────────
  // Relógio já acionado (rodando, ou pausado com tempo corrido) e dia não
  // encerrado: a linha do nível atual ganha destaque e as anteriores ficam
  // apagadas. Antes de o diretor apertar play não há "nível atual" — nada a
  // sinalizar.
  const relogioAcionado = !!timerState
    && (!!timerState.timer_started_at || (timerState.elapsed_time || 0) > 0);
  const emAndamento = relogioAcionado && tournamentDay?.status !== 'completed';
  const nivelAtual = emAndamento ? timerState.current_level : null;
  const blindAtual = nivelAtual != null ? (blinds.find((b) => b.level === nivelAtual) || null) : null;
  // Com o dia em andamento, o relógio deriva o nível atual da SOMA das durações
  // na ordem: mexer no que já passou (ou no atual) mudaria o passado do
  // cronômetro. Essas linhas não arrastam nem recebem soltura (o servidor
  // recusa também).
  const travado = (blind) => nivelAtual != null && blind.level <= nivelAtual;
  const avisoTravado = () => t(
    'blinds.reorderLockedWhileRunning',
    'Com o dia em andamento, só os níveis depois do atual podem ser reordenados.'
  );

  // ── Drag-to-reorder blind levels ──────────────────────────────────────────
  const onRowDragStart = (e, blind) => {
    if (travado(blind)) { e.preventDefault(); return; }
    setOfertaReplicarId(null); // os níveis vão renumerar; "a partir do N" perde o sentido
    setDragId(blind.id);
    e.dataTransfer.effectAllowed = 'move';
  };
  const onRowDragOver = (e, blind) => {
    e.preventDefault();
    if (blind.id !== dragOverId) setDragOverId(blind.id);
  };
  const onRowDragEnd = () => { setDragId(null); setDragOverId(null); };
  const onRowDrop = async (e, target) => {
    e.preventDefault();
    const from = blinds.findIndex((b) => b.id === dragId);
    const to = blinds.findIndex((b) => b.id === target.id);
    setDragId(null);
    setDragOverId(null);
    if (from < 0 || to < 0 || from === to) return;
    if (travado(blinds[from]) || travado(target)) {
      toast.warning(avisoTravado());
      return;
    }

    const reordered = [...blinds];
    const [moved] = reordered.splice(from, 1);
    reordered.splice(to, 0, moved);

    // Renumera na hora (a tela responde antes da rede) e grava a ORDEM inteira
    // numa chamada só, atômica no servidor. Nível a nível colidia com o índice
    // único (dia, nível): a primeira linha que pulava para o lugar de outra
    // dava erro — era o "não consigo arrastar" do diretor.
    setBlinds(reordered.map((b, i) => ({ ...b, level: i + 1 })));
    setReordering(true);
    try {
      const res = await api.put(`/tournament-days/${dayId}/blinds/order`, {
        ids: reordered.map((b) => b.id),
      });
      if (Array.isArray(res?.data) && res.data.length > 0) {
        setBlinds([...res.data].sort((a, b) => a.level - b.level));
      } else {
        await loadData();
      }
    } catch (error) {
      const detail = error.response?.data?.detail;
      let msg;
      if (detail?.code === 'reordenar_nivel_em_andamento') msg = avisoTravado();
      else if (typeof detail === 'string') msg = detail;
      else msg = detail?.message || t('common.error');
      toast.error(msg);
      await loadData(); // revert to server truth on failure
    } finally {
      setReordering(false);
    }
  };

  const handleDeleteBlind = async (blindId) => {
    const blind = blinds.find((b) => b.id === blindId);
    // Sequential blind number (ignoring breaks), to match the table display.
    let _seq = 0;
    let displayNum = null;
    for (const b of blinds) {
      if (!b.is_break) _seq += 1;
      if (b.id === blindId) { displayNum = b.is_break ? null : _seq; break; }
    }
    const levelLabel = blind ? (blind.is_break ? t('blinds.break') : `${t('blinds.level')} ${displayNum}`) : '';
    const ok = await confirm(
      t('blinds.confirmDeleteMessage', 'O nível de blind {{level}} será removido permanentemente da estrutura.', { level: levelLabel }),
      {
        title: t('blinds.confirmDeleteTitle', 'Excluir nível de blind?'),
        variant: 'danger',
        confirmText: t('common.delete'),
      }
    );
    if (!ok) return;

    try {
      await api.delete(`/tournament-days/${dayId}/blinds/${blindId}`);
      setOfertaReplicarId(null);
      loadData();
    } catch (error) {
      console.error('Error deleting blind:', error);
      toast.error(t('common.error'));
    }
  };

  // ── Limpar a estrutura inteira ────────────────────────────────────────────
  // Refazer nível a nível uma estrutura errada consome o intervalo inteiro. Em
  // troca, não há desfazer: por isso a confirmação sugere salvar como template
  // antes, e um dia em andamento exige uma SEGUNDA confirmação (o telão fica
  // sem blind na frente dos jogadores).
  const handleClearStructure = async () => {
    if (blinds.length === 0) return;

    const ok = await confirm(
      t(
        'blinds.confirmClearMessage',
        'Todos os {{count}} níveis (incluindo intervalos) serão apagados permanentemente e o relógio volta ao nível 1 com 00:00. Não há como desfazer — se quiser guardar esta estrutura, salve-a como modelo antes.',
        { count: blinds.length }
      ),
      {
        title: t('blinds.confirmClearTitle', 'Apagar a estrutura inteira?'),
        variant: 'danger',
        confirmText: t('blinds.clearStructure', 'Limpar estrutura'),
      }
    );
    if (!ok) return;

    // O dia rodando é o caso caro: quem confirma precisa saber que o telão
    // fica em branco agora, não no próximo intervalo.
    const emAndamento =
      tournamentDay?.status === 'active' ||
      Boolean(tournamentDay?.timer_started_at && !tournamentDay?.is_paused);

    if (emAndamento) {
      const ok2 = await confirm(
        t(
          'blinds.confirmClearRunning',
          'Este dia está EM ANDAMENTO. O telão ficará sem blinds e o relógio será zerado imediatamente. Confirma mesmo assim?'
        ),
        {
          title: t('blinds.confirmClearRunningTitle', 'O dia está rodando'),
          variant: 'danger',
          confirmText: t('blinds.clearStructure', 'Limpar estrutura'),
        }
      );
      if (!ok2) return;
    }

    try {
      await api.delete(`/tournament-days/${dayId}/blinds`, emAndamento ? { params: { force: true } } : undefined);
      setOfertaReplicarId(null);
      toast.success(t('blinds.structureCleared', 'Estrutura apagada.'));
      loadData();
    } catch (error) {
      console.error('Error clearing structure:', error);
      const detail = error.response?.data?.detail;
      // 409 = o dia virou "em andamento" entre o carregamento da tela e o
      // clique. Mostrar o motivo do servidor evita o operador achar que a
      // limpeza funcionou.
      const message =
        typeof detail === 'string' ? detail : t('blinds.clearError', 'Não foi possível apagar a estrutura.');
      toast.error(message);
      // Sem recarregar, `emAndamento` continua falso (foi calculado no load da
      // tela) e o próximo clique manda a mesma requisição SEM force: o operador
      // fica preso no mesmo 409 até dar F5. Recarregar traz o dia já como
      // ativo, e aí a segunda confirmação aparece e a limpeza passa.
      if (error.response?.status === 409) {
        loadData();
      }
    }
  };

  const openEditModal = (blind) => {
    setOfertaReplicarId(null);
    setEditingBlind(blind);
    setFormData({
      level: blind.level,
      small_blind: blind.small_blind || '',
      big_blind: blind.big_blind || '',
      ante: blind.ante || 0,
      duration: blind.duration,
      is_break: blind.is_break || false,
    });
    setShowEditModal(true);
  };

  const openAddModal = (asBreak = false) => {
    setOfertaReplicarId(null);
    // Auto-suggest next level
    const nextLevel = blinds.length > 0 ? Math.max(...blinds.map(b => b.level)) + 1 : 1;
    // Auto-suggest blinds based on last non-break level
    const lastBlind = blinds.filter(b => !b.is_break).slice(-1)[0];

    setFormData({
      level: nextLevel,
      small_blind: asBreak ? 0 : (lastBlind ? lastBlind.small_blind * 2 : ''),
      big_blind: asBreak ? 0 : (lastBlind ? lastBlind.big_blind * 2 : ''),
      ante: asBreak ? 0 : (lastBlind ? (lastBlind.ante > 0 ? lastBlind.ante * 2 : lastBlind.big_blind) : 0),
      duration: asBreak ? 10 : (lastBlind ? lastBlind.duration : 15),
      is_break: asBreak,
    });
    setShowAddModal(true);
  };

  // Template functions
  const handleApplyTemplate = async (templateId) => {
    if (blinds.length > 0) {
      const ok = await confirm(t('blinds.confirmApplyTemplate'));
      if (!ok) return;
    }

    try {
      await api.post('/blind-templates/apply', {
        template_id: templateId,
        tournament_day_id: dayId,
        clear_existing: true
      });
      setShowTemplateModal(false);
      setOfertaReplicarId(null);
      loadData();
    } catch (error) {
      console.error('Error applying template:', error);
      toast.error(t('common.error'));
    }
  };

  const handleDeleteTemplate = async (templateId, tplName) => {
    const ok = await confirm(`${t('blinds.confirmDeleteTemplate')} "${tplName}"?`, { variant: 'danger', confirmText: t('common.delete') });
    if (!ok) return;

    try {
      await api.delete(`/blind-templates/${templateId}`);
      const templatesRes = await api.get('/blind-templates');
      setTemplates(templatesRes.data);
    } catch (error) {
      console.error('Error deleting template:', error);
      toast.error(t('common.error'));
    }
  };

  const getDisplayTitle = () => {
    if (tournament && tournamentDay) {
      return `${tournament.name} - ${tournamentDay.day_name}`;
    }
    if (tournamentDay) {
      return tournamentDay.day_name;
    }
    return t('blinds.title');
  };

  // Calculate summary stats
  const blindLevels = blinds.filter(b => !b.is_break);
  const breakLevels = blinds.filter(b => b.is_break);
  const totalDuration = blinds.reduce((acc, b) => acc + b.duration, 0);
  const totalBreakTime = breakLevels.reduce((acc, b) => acc + b.duration, 0);

  // Display level number: sequential count of actual blind levels only — a
  // break must NOT consume a level number (it keeps `level` only for ordering).
  const displayLevelById = {};
  {
    let n = 0;
    for (const b of blinds) {
      if (!b.is_break) {
        n += 1;
        displayLevelById[b.id] = n;
      }
    }
  }

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

  if (!tournamentDay) {
    return (
      <div className="app-container">
        <Sidebar />
        <main className="main-content">
          <Breadcrumb items={[
            { label: t('common.home', 'Início'), to: '/' },
            { label: t('tournaments.title', 'Torneios'), to: '/torneios' },
            { label: t('blinds.title', 'Estrutura de Blinds') },
          ]} />
          <div className="page-header">
            <div>
              <h1>{t('blinds.title', 'Estrutura de Blinds')}</h1>
            </div>
          </div>
          <EmptyState
            icon={
              <svg viewBox="0 0 24 24" fill="currentColor">
                <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-2h2v2zm0-4h-2V7h2v6z"/>
              </svg>
            }
            title={loadError?.status === 404
              ? t('blinds.dayNotFoundTitle', 'Dia do torneio não encontrado')
              : t('blinds.loadErrorTitle', 'Não foi possível carregar a estrutura de blinds')}
            subtitle={loadError?.message || t('common.noData')}
            ctaLabel={t('common.back')}
            onCta={() => navigate('/torneios')}
          />
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
          { label: t('blinds.title') },
        ]} />
        <div className="page-header">
          <div>
            <h1>{t('blinds.title')}</h1>
            <p className="subtitle">{getDisplayTitle()}</p>
          </div>
          <div className="header-actions">
            <Button variant="info" onClick={() => setShowTemplateModal(true)}>
              {t('blinds.loadTemplate')}
            </Button>
            <Button onClick={() => openAddModal(false)}>
              {t('blinds.addBlind')}
            </Button>
            <Button variant="warning" onClick={() => openAddModal(true)}>
              {t('blinds.addBreak')}
            </Button>
            <Button variant="danger" disabled={blinds.length === 0} onClick={handleClearStructure}>
              {t('blinds.clearStructure', 'Limpar estrutura')}
            </Button>
            <Button variant="secondary" onClick={() => navigate(-1)}>
              {t('common.back')}
            </Button>
          </div>
        </div>

        <Card>
          <div className="blinds-table-container">
            <table className="blinds-table">
              <thead>
                <tr>
                  <th>{t('blinds.level')}</th>
                  <th>{t('blinds.smallBlind')}</th>
                  <th>{t('blinds.bigBlind')}</th>
                  <th>{t('blinds.ante')}</th>
                  <th>{t('blinds.duration')}</th>
                  <th>{t('common.actions')}</th>
                </tr>
              </thead>
              <tbody>
                {blinds.length === 0 ? (
                  <tr>
                    <td colSpan="6" className="empty-table-message">
                      {t('blinds.noBlindRegistered')}
                    </td>
                  </tr>
                ) : (
                  blinds.map((blind) => {
                    const cell = (field, display) => {
                      const editing = editCell && editCell.id === blind.id && editCell.field === field;
                      const canEdit = !blind.is_break || field === 'duration';
                      if (editing) {
                        return (
                          <input
                            type="number"
                            min="0"
                            className="inline-edit-input"
                            value={editVal}
                            autoFocus
                            onChange={(e) => setEditVal(e.target.value)}
                            onBlur={() => commitEdit(blind)}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter') { e.preventDefault(); commitEdit(blind); }
                              else if (e.key === 'Escape') { e.preventDefault(); cancelEdit(); }
                            }}
                          />
                        );
                      }
                      // Célula que não pode ser editada é só texto — sem clique,
                      // sem parada do Tab.
                      if (!canEdit) return <span>{display}</span>;
                      // É um botão de verdade: abre a edição no Enter/Espaço,
                      // não só no clique.
                      return (
                        <button
                          type="button"
                          className="inline-editable"
                          onClick={() => startEdit(blind, field)}
                          title={t('blinds.clickToEdit', 'Clique para editar')}
                        >
                          {display}
                        </button>
                      );
                    };
                    const ehAtual = blindAtual?.id === blind.id;
                    const jaPassou = nivelAtual != null && blind.level < nivelAtual;
                    const bloqueado = travado(blind);
                    return (
                      <tr
                        key={blind.id}
                        className={`blind-row ${blind.is_break ? 'break-row' : ''} ${ehAtual ? 'current-row' : ''} ${jaPassou ? 'past-row' : ''} ${dragOverId === blind.id ? 'drag-over' : ''} ${dragId === blind.id ? 'dragging' : ''}`}
                        draggable={!editCell && !reordering && !bloqueado}
                        aria-current={ehAtual ? 'true' : undefined}
                        onDragStart={(e) => onRowDragStart(e, blind)}
                        onDragOver={(e) => onRowDragOver(e, blind)}
                        onDrop={(e) => onRowDrop(e, blind)}
                        onDragEnd={onRowDragEnd}
                      >
                        <td className="level-cell">
                          <span
                            className={`drag-handle${bloqueado ? ' drag-handle--locked' : ''}`}
                            title={bloqueado ? avisoTravado() : t('blinds.dragToReorder', 'Arraste para reordenar')}
                          >⠿</span>
                          {blind.is_break ? (
                            <span className="break-badge">{t('blinds.break')}</span>
                          ) : (
                            <strong>{t('blinds.level')} {displayLevelById[blind.id]}</strong>
                          )}
                          {ehAtual && (
                            <span className="current-badge">
                              <span className="pulse" aria-hidden="true" />
                              {t('blinds.currentBadge', 'Agora')} · {formatTime(timerState.time_remaining_current_level)}
                            </span>
                          )}
                        </td>
                        <td>{blind.is_break ? '-' : cell('small_blind', blind.small_blind.toLocaleString())}</td>
                        <td>{blind.is_break ? '-' : cell('big_blind', blind.big_blind.toLocaleString())}</td>
                        <td>{blind.is_break ? '-' : cell('ante', (blind.ante || 0).toLocaleString())}</td>
                        <td>
                          <span className="duration-cell">
                            {cell('duration', `${blind.duration} min`)}
                            {alvoReplicar?.id === blind.id && seguintesDiferentes > 0 && editCell?.id !== blind.id && (() => {
                              const rotulo = t(
                                blind.is_break ? 'blinds.replicateToNextBreaks' : 'blinds.replicateToNext',
                                blind.is_break
                                  ? 'Aplicar {{duration}} min aos intervalos seguintes'
                                  : 'Aplicar {{duration}} min aos níveis seguintes',
                                { duration: blind.duration }
                              );
                              return (
                                <button
                                  type="button"
                                  className="replicate-next"
                                  onClick={replicarDuracao}
                                  title={rotulo}
                                  aria-label={rotulo}
                                >⇣</button>
                              );
                            })()}
                          </span>
                        </td>
                        <td>
                          <div className="action-buttons">
                            <button
                              type="button"
                              className="btn-small btn-edit"
                              onClick={() => openEditModal(blind)}
                              title={t('common.edit')}
                            >
                              {t('common.edit')}
                            </button>
                            <button
                              type="button"
                              className="btn-small btn-delete"
                              onClick={() => handleDeleteBlind(blind.id)}
                              title={t('common.delete')}
                            >
                              {t('common.delete')}
                            </button>
                          </div>
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>

          {/* Summary - only show if there are blinds */}
          {blinds.length > 0 && (
            <div className="blinds-summary">
              {emAndamento && blindAtual && (
                <span className="summary-current">
                  {t('blinds.currentLevelStat', 'Nível atual')}: {blindAtual.is_break
                    ? t('blinds.break')
                    : `${t('blinds.level')} ${displayLevelById[blindAtual.id]}`} · {formatTime(timerState.time_remaining_current_level)}
                </span>
              )}
              <span>{t('blinds.levels')}: {blindLevels.length}</span>
              <span>{t('blinds.breaks')}: {breakLevels.length}</span>
              <span>{t('blinds.totalDuration')}: {totalDuration} min ({Math.floor(totalDuration / 60)}h {totalDuration % 60}min)</span>
              <span>{t('blinds.breakTime')}: {totalBreakTime} min</span>
            </div>
          )}
        </Card>

        {/* Add Blind/Break Modal */}
        {showAddModal && (
          <div className="modal-overlay" role="presentation" onClick={aoClicarNoFundo(fecharAdd)}>
            <div className="modal">
              <div className="modal-header">
                <h2>{formData.is_break ? t('blinds.addBreak') : t('blinds.addBlind')}</h2>
                <button type="button" className="close-btn" onClick={() => setShowAddModal(false)} aria-label={t('common.close')}>
                  <span className="close-icon"></span>
                </button>
              </div>
              <form onSubmit={handleAddBlind}>
                <div className="form-group">
                  <label htmlFor="level">{t('blinds.position')} *</label>
                  <select
                    id="level"
                    name="level"
                    value={formData.level}
                    onChange={handleChange}
                    required
                    className="level-select"
                  >
                    {/* Generate position options */}
                    {(() => {
                      const maxLevel = blinds.length > 0 ? Math.max(...blinds.map(b => b.level)) : 0;
                      const existingLevels = new Set(blinds.map(b => b.level));
                      const options = [];

                      // Ordena UMA vez. Antes, cada nível candidato refazia dois
                      // filter + sort sobre a lista inteira — custo quadrático
                      // dentro do próprio render do <select>.
                      const porNivel = [...blinds].sort((a, b) => a.level - b.level);
                      // Como `i` só cresce, um ponteiro que avança encontra a
                      // vizinhança de cada nível sem revarrer a lista.
                      let p = 0;

                      // Generate options for all available levels (1 to maxLevel + 1)
                      for (let i = 1; i <= maxLevel + 1; i++) {
                        // Skip if level already exists
                        if (existingLevels.has(i)) continue;

                        while (p < porNivel.length && porNivel[p].level < i) p++;
                        // porNivel[p] tem level > i: o nível i não existe (foi filtrado acima).
                        const prevBlind = p > 0 ? porNivel[p - 1] : undefined;
                        const nextBlind = p < porNivel.length ? porNivel[p] : undefined;

                        let label = t('blinds.positionLevel', 'Nível {{n}}', { n: i });
                        if (prevBlind && nextBlind) {
                          const prevLabel = prevBlind.is_break ? t('blinds.break') : `${prevBlind.small_blind}/${prevBlind.big_blind}`;
                          const nextLabel = nextBlind.is_break ? t('blinds.break') : `${nextBlind.small_blind}/${nextBlind.big_blind}`;
                          label += ` ${t('blinds.positionBetween', '(entre {{prev}} e {{next}})', { prev: prevLabel, next: nextLabel })}`;
                        } else if (prevBlind) {
                          const prevLabel = prevBlind.is_break ? t('blinds.break') : `${prevBlind.small_blind}/${prevBlind.big_blind}`;
                          label += ` ${t('blinds.positionAfter', '(após {{prev}})', { prev: prevLabel })}`;
                        } else if (nextBlind) {
                          const nextLabel = nextBlind.is_break ? t('blinds.break') : `${nextBlind.small_blind}/${nextBlind.big_blind}`;
                          label += ` ${t('blinds.positionBefore', '(antes de {{next}})', { next: nextLabel })}`;
                        } else {
                          label += ` ${t('blinds.positionFirst', '(primeiro nível)')}`;
                        }
                        options.push(<option key={i} value={i}>{label}</option>);
                      }

                      return options;
                    })()}
                  </select>
                </div>

                <div className="form-group">
                  <label htmlFor="duration">{t('blinds.duration')} *</label>
                  <input
                    id="duration"
                    name="duration"
                    type="number"
                    min="1"
                    value={formData.duration}
                    onChange={handleChange}
                    required
                    placeholder={formData.is_break ? "10" : "15"}
                  />
                </div>

                {!formData.is_break && (
                  <>
                    <div className="form-row">
                      <div className="form-group">
                        <label htmlFor="small_blind">{t('blinds.smallBlind')} *</label>
                        <input
                          id="small_blind"
                          name="small_blind"
                          type="number"
                          min="1"
                          value={formData.small_blind}
                          onChange={handleChange}
                          required
                          placeholder={t('blinds.smallBlindPlaceholder', 'Ex: 25')}
                        />
                      </div>

                      <div className="form-group">
                        <label htmlFor="big_blind">{t('blinds.bigBlind')} *</label>
                        <input
                          id="big_blind"
                          name="big_blind"
                          type="number"
                          min="1"
                          value={formData.big_blind}
                          onChange={handleChange}
                          required
                          placeholder={t('blinds.bigBlindPlaceholder', 'Ex: 50')}
                        />
                      </div>
                    </div>

                    <div className="form-group">
                      <label htmlFor="ante">{t('blinds.ante')}</label>
                      <input
                        id="ante"
                        name="ante"
                        type="number"
                        min="0"
                        value={formData.ante}
                        onChange={handleChange}
                        placeholder="0"
                      />
                    </div>
                  </>
                )}

                {formData.is_break && (
                  <div className="break-info">
                    <p>{t('blinds.breakInfo', 'Os jogadores terão {{duration}} minutos de intervalo neste ponto do torneio.', { duration: formData.duration || '?' })}</p>
                  </div>
                )}

                <div className="modal-actions">
                  <Button type="button" variant="secondary" onClick={() => setShowAddModal(false)}>
                    {t('common.cancel')}
                  </Button>
                  <Button type="submit">{formData.is_break ? t('blinds.addBreak') : t('blinds.addBlind')}</Button>
                </div>
              </form>
            </div>
          </div>
        )}

        {/* Edit Blind/Break Modal */}
        {showEditModal && (
          <div className="modal-overlay" role="presentation" onClick={aoClicarNoFundo(fecharEdit)}>
            <div className="modal">
              <div className="modal-header">
                <h2>{formData.is_break ? t('blinds.editBreak') : t('blinds.editBlind')}</h2>
                <button type="button" className="close-btn" onClick={() => setShowEditModal(false)} aria-label={t('common.close')}>
                  <span className="close-icon"></span>
                </button>
              </div>
              <form onSubmit={handleEditBlind}>
                <div className="form-group type-toggle">
                  <label>
                    <input
                      type="checkbox"
                      name="is_break"
                      checked={formData.is_break}
                      onChange={handleChange}
                    />
                    <span className="toggle-label">{t('blinds.isBreak')}</span>
                  </label>
                </div>

                <div className="form-row">
                  <div className="form-group">
                    <label htmlFor="edit_level">{t('blinds.level')} *</label>
                    <input
                      id="edit_level"
                      name="level"
                      type="number"
                      min="1"
                      value={formData.level}
                      onChange={handleChange}
                      required
                    />
                  </div>

                  <div className="form-group">
                    <label htmlFor="edit_duration">{t('blinds.duration')} *</label>
                    <input
                      id="edit_duration"
                      name="duration"
                      type="number"
                      min="1"
                      value={formData.duration}
                      onChange={handleChange}
                      required
                    />
                  </div>
                </div>

                {!formData.is_break && (
                  <>
                    <div className="form-row">
                      <div className="form-group">
                        <label htmlFor="edit_small_blind">{t('blinds.smallBlind')} *</label>
                        <input
                          id="edit_small_blind"
                          name="small_blind"
                          type="number"
                          min="1"
                          value={formData.small_blind}
                          onChange={handleChange}
                          required
                        />
                      </div>

                      <div className="form-group">
                        <label htmlFor="edit_big_blind">{t('blinds.bigBlind')} *</label>
                        <input
                          id="edit_big_blind"
                          name="big_blind"
                          type="number"
                          min="1"
                          value={formData.big_blind}
                          onChange={handleChange}
                          required
                        />
                      </div>
                    </div>

                    <div className="form-group">
                      <label htmlFor="edit_ante">{t('blinds.ante')}</label>
                      <input
                        id="edit_ante"
                        name="ante"
                        type="number"
                        min="0"
                        value={formData.ante}
                        onChange={handleChange}
                      />
                    </div>
                  </>
                )}

                {formData.is_break && (
                  <div className="break-info">
                    <p>{t('blinds.breakInfo', 'Os jogadores terão {{duration}} minutos de intervalo neste ponto do torneio.', { duration: formData.duration || '?' })}</p>
                  </div>
                )}

                <div className="modal-actions">
                  <Button type="button" variant="secondary" onClick={() => setShowEditModal(false)}>
                    {t('common.cancel')}
                  </Button>
                  <Button type="submit">{t('common.save')}</Button>
                </div>
              </form>
            </div>
          </div>
        )}

        {/* Template Selection Modal */}
        {showTemplateModal && (
          <div className="modal-overlay" role="presentation" onClick={aoClicarNoFundo(fecharTemplates)}>
            <div className="modal template-modal">
              <div className="modal-header">
                <h2>{t('blinds.loadTemplate')}</h2>
                <button type="button" className="close-btn" onClick={() => setShowTemplateModal(false)} aria-label={t('common.close')}>
                  <span className="close-icon"></span>
                </button>
              </div>
              <div className="modal-body">
                {templates.length === 0 ? (
                  <div className="empty-templates">
                    <p>{t('blinds.noTemplates')}</p>
                    <p className="hint">{t('blinds.noTemplatesHint')}</p>
                  </div>
                ) : (
                  <div className="template-list">
                    {templates.map((template) => (
                      <div key={template.id} className="template-item">
                        <div className="template-info">
                          <h4>{template.name}</h4>
                          {template.description && <p className="template-desc">{template.description}</p>}
                          <div className="template-meta">
                            <span>{t('blinds.initialSbBb')}: {template.initial_small_blind}/{template.initial_big_blind}</span>
                            <span>{t('blinds.duration')}: {template.blind_duration}min</span>
                            {template.custom_levels && (
                              <span>{template.custom_levels.length} {t('blinds.levels').toLowerCase()}</span>
                            )}
                          </div>
                        </div>
                        <div className="template-actions">
                          <Button size="small" onClick={() => handleApplyTemplate(template.id)}>
                            {t('blinds.applyTemplate')}
                          </Button>
                          <Button size="small" variant="danger" onClick={() => handleDeleteTemplate(template.id, template.name)}>
                            {t('common.delete')}
                          </Button>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
              <div className="modal-actions">
                <Button variant="secondary" onClick={() => setShowTemplateModal(false)}>
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

export default BlindManagement;
