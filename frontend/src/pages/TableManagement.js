import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { useRealtimeRefresh } from '../hooks/useRealtimeRefresh';
import { useEscapeKey } from '../hooks/useEscapeKey';
import { useTranslation } from 'react-i18next';
import { useParams, useNavigate } from 'react-router-dom';
import Sidebar from '../components/Sidebar';
import SeatTicket from '../components/SeatTicket';
import api from '../config/api';
import { useToast } from '../contexts/ToastContext';
import { MODO_MESA, useModoDeEliminacao } from '../hooks/useModoDeEliminacao';
import { offlineWrite } from '../offline/apiOffline';
import { applyEliminate, applyUneliminate } from '../offline/domainRules';
import { uuid } from '../offline/db';
import './TableManagement.css';

// Fecha só quando o clique caiu no próprio fundo, não em um filho. Substitui o
// `onClick={stopPropagation}` que ficava no conteúdo do modal — aquele era um
// clique sem caminho de teclado, e o fundo em si não é um controle.
const aoClicarNoFundo = (aoFechar) => (evento) => {
  if (evento.target === evento.currentTarget) aoFechar();
};

// O interceptor de `config/api.js` já traduz a recusa com código e a deixa
// em `userMessage`; sem ela, vale o que a API mandou (frase ou {code, message}).
// Assentos que recebem jogador: os da mesa menos os desativados pelo floor.
const assentosAtivos = (mesa) => mesa.seats - (mesa.blocked_seats || []).length;

const motivoDoErro = (err) => {
  const detail = err?.response?.data?.detail;
  return err?.userMessage || (typeof detail === 'string' ? detail : detail?.message) || err?.message;
};

const TableManagement = () => {
  const { t } = useTranslation();
  const { dayId } = useParams();
  const navigate = useNavigate();
  const { toast, confirm } = useToast();

  // ── State ─────────────────────────────────────────────────────────────────
  const [day, setDay] = useState(null);
  const [tournamentName, setTournamentName] = useState('');
  const [tables, setTables] = useState([]);
  const [allocations, setAllocations] = useState([]);
  const [unallocated, setUnallocated] = useState([]);
  // Inscritos DO DIA: é por eles que a cadeira vira um tournament_player. Ler
  // pelo torneio (como a tela antiga) pegava a inscrição de outro dia.
  const [inscritos, setInscritos] = useState([]);
  const [loading, setLoading] = useState(true);

  // Drag-and-drop
  const [draggedPlayer, setDraggedPlayer] = useState(null);

  // Modals
  const [showTicket, setShowTicket] = useState(null);
  const [showAddTableModal, setShowAddTableModal] = useState(false);
  const [showBulkModal, setShowBulkModal] = useState(false);

  // Esc fecha o modal aberto — o clique no fundo é gesto de mouse, e quem opera
  // a mesa só pelo teclado precisa de uma saída equivalente.
  const fecharTicket = useCallback(() => setShowTicket(null), []);
  const fecharAddTable = useCallback(() => setShowAddTableModal(false), []);
  const fecharBulk = useCallback(() => setShowBulkModal(false), []);
  useEscapeKey(!!showTicket, fecharTicket);
  useEscapeKey(showAddTableModal, fecharAddTable);
  useEscapeKey(showBulkModal, fecharBulk);

  // Add table form
  // Assentos e número ficam como TEXTO enquanto o operador digita: corrigir
  // a cada tecla transformava "12" em "22" (o 1 virava 2 pelo mínimo antes
  // do 2 chegar). A correção acontece ao sair do campo e ao gravar.
  const [newTableSeats, setNewTableSeats] = useState(9);
  const [newTableCount, setNewTableCount] = useState(1);
  // Número da (primeira) mesa do lote: vem sugerido como o próximo livre, mas
  // é do operador — o salão pode já ter as mesas 1-4 de outro evento.
  const [newTableStart, setNewTableStart] = useState(1);
  // Troca de número na própria mesa: {id, value} enquanto edita.
  const [editingTable, setEditingTable] = useState(null);

  const proximoNumeroLivre = () =>
    (tables.length > 0 ? Math.max(...tables.map(t => t.table_number)) + 1 : 1);
  // Mesa de 1 assento não existe no salão; vazio volta ao padrão de 9.
  const assentosValidos = () => Math.max(2, parseInt(newTableSeats, 10) || 9);
  const numeroInicialValido = () => Math.max(1, parseInt(newTableStart, 10) || proximoNumeroLivre());
  const abrirAddTable = () => {
    setNewTableStart(proximoNumeroLivre());
    setShowAddTableModal(true);
  };

  // Bulk allocation
  const [bulkMode, setBulkMode] = useState('balanced');
  const [bulkLoading, setBulkLoading] = useState(false);
  const modeInitialized = useRef(false);

  // Lock state (derived from day)
  const tablesLocked = day?.tables_locked ?? false;

  // Modo "por posição nas mesas": é AQUI que o diretor elimina, no assento.
  // No modo em massa o ✕ não aparece — quem elimina é o contador do Controle.
  const porMesa = useModoDeEliminacao(day?.tournament_id) === MODO_MESA;
  const inscritoPorJogador = useMemo(
    () => new Map(inscritos.map((i) => [i.player_id, i])),
    [inscritos]
  );
  const eliminados = useMemo(
    () => inscritos
      .filter((i) => i.status === 'eliminated')
      .sort((a, b) => String(b.eliminated_at || '').localeCompare(String(a.eliminated_at || ''))),
    [inscritos]
  );

  // ── Data Loading ──────────────────────────────────────────────────────────
  const loadData = useCallback(async () => {
    try {
      const [dayRes, tablesRes, allocRes, unallocRes] = await Promise.all([
        api.get(`/tournament-days/${dayId}`),
        api.get(`/tables/day/${dayId}`),
        api.get(`/allocations/day/${dayId}`),
        api.get(`/allocations/day/${dayId}/unallocated`),
      ]);
      const dayData = dayRes.data;
      setDay(dayData);
      setTables(tablesRes.data);
      setAllocations(allocRes.data);
      setUnallocated(unallocRes.data);
      setLoading(false);

      // Fora do Promise.all: sem a lista de inscritos a tela de mesas continua
      // útil; só o ✕ de eliminar fica sem a quem apontar.
      api.get(`/tournament-players/day/${dayId}`, { _silentError: true })
        .then((res) => setInscritos(Array.isArray(res?.data) ? res.data : []))
        .catch(() => {});

      // Initialize bulk mode from day's saved allocation_mode (only on first load)
      if (!modeInitialized.current && dayData?.allocation_mode) {
        setBulkMode(dayData.allocation_mode);
        modeInitialized.current = true;
      }

      // Fetch tournament name if not yet loaded
      if (dayData?.tournament_id && !tournamentName) {
        try {
          const tRes = await api.get(`/tournaments/${dayData.tournament_id}`);
          setTournamentName(tRes.data.name || '');
        } catch (_) { /* non-fatal */ }
      }
    } catch (err) {
      console.error('Erro ao carregar dados:', err);
      setLoading(false);
    }
  }, [dayId, tournamentName]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  // Polling de 5s que pausa quando a aba está oculta.
  useRealtimeRefresh({
    canal: `mesas-dia-${dayId}`,
    tabelas: [
      { table: 'tournament_tables' },
      { table: 'tournament_players', filter: `tournament_day_id=eq.${dayId}` },
    ],
    aoMudar: () => loadData(),
    ativo: !!dayId,
  });

  // ── Lock Toggle ───────────────────────────────────────────────────────────
  const handleToggleLock = async () => {
    const action = tablesLocked ? t('tableManagement.actionUnlock') : t('tableManagement.actionLock');
    const msg = tablesLocked
      ? t('tableManagement.confirmUnlock')
      : t('tableManagement.confirmLock');
    const ok = await confirm(msg, { confirmText: action });
    if (!ok) return;
    try {
      await api.post(`/tournament-days/${dayId}/tables-lock`);
      await loadData();
      toast.success(tablesLocked ? t('tableManagement.tablesUnlockedSuccess') : t('tableManagement.tablesLockedSuccess'));
    } catch (err) {
      toast.error(t('tableManagement.errorToggleLock', { detail: err.response?.data?.detail || err.message }));
    }
  };

  // ── Add Tables ────────────────────────────────────────────────────────────
  const handleAddTables = async () => {
    try {
      const seats = assentosValidos();
      const numero = numeroInicialValido();
      if (newTableCount === 1) {
        await api.post(`/tables/day/${dayId}`, { table_number: numero, seats });
      } else {
        await api.post(`/tables/day/${dayId}/bulk?count=${newTableCount}&seats=${seats}&start_number=${numero}`);
      }
      await loadData();
      setShowAddTableModal(false);
      toast.success(newTableCount > 1
        ? t('tableManagement.tablesAddedSuccessPlural', { count: newTableCount })
        : t('tableManagement.tablesAddedSuccessSingular'));
    } catch (err) {
      toast.error(t('tableManagement.errorAddTable', { detail: motivoDoErro(err) }));
    }
  };

  // ── Remove / Disable Table ────────────────────────────────────────────────
  const handleRemoveTable = async (table) => {
    const hasPlayers = allocations.some(a => a.table_id === table.id);
    if (hasPlayers) {
      toast.warning(t('tableManagement.cannotRemoveTableWithPlayers'));
      return;
    }
    const ok = await confirm(t('tableManagement.confirmRemoveTable', { number: table.table_number }), { variant: 'danger', confirmText: t('common.remove') });
    if (!ok) return;
    try {
      await api.delete(`/tables/${table.id}`);
      await loadData();
      toast.success(t('tableManagement.tableRemovedSuccess', { number: table.table_number }));
    } catch (err) {
      toast.error(t('tableManagement.errorRemoveTable', { detail: err.response?.data?.detail || err.message }));
    }
  };

  const handleToggleTableStatus = async (table) => {
    const newStatus = table.status === 'active' ? 'closed' : 'active';
    const label = newStatus === 'closed' ? t('tableManagement.actionDeactivate') : t('tableManagement.actionReactivate');
    const ok = await confirm(t('tableManagement.confirmToggleTableStatus', { label, number: table.table_number }), { confirmText: label });
    if (!ok) return;
    try {
      await api.patch(`/tables/${table.id}`, { status: newStatus });
      await loadData();
    } catch (err) {
      toast.error(t('tableManagement.errorToggleTableStatus', { detail: err.response?.data?.detail || err.message }));
    }
  };

  // ── Ativar / desativar assento ────────────────────────────────────────────
  // Cadeira quebrada, lugar encostado na parede: o assento sai de circulação
  // sem mudar o tamanho da mesa. Ninguém é alocado nele (automático, em massa
  // ou arrastando). Com alguém sentado a API recusa — o jogador precisa ser
  // movido antes, e o botão nem aparece em assento ocupado.
  const handleToggleSeat = async (table, seatNum, desativado) => {
    try {
      await api.patch(`/tables/${table.id}/seats/${seatNum}`, { active: desativado });
      await loadData();
    } catch (err) {
      toast.error(t('tableManagement.errorToggleSeat', { detail: motivoDoErro(err) }));
    }
  };

  // ── Mudar o número da mesa ────────────────────────────────────────────────
  // O número identifica a mesa FÍSICA no salão. Quem está sentado continua
  // sentado (a alocação aponta para o id, não para o número); só o rótulo
  // muda. Número já usado no dia é recusado pela API (409 com código).
  const iniciarTrocaDeNumero = (table) =>
    setEditingTable({ id: table.id, value: String(table.table_number) });
  const cancelarTrocaDeNumero = () => setEditingTable(null);

  const handleRenameTable = async (table) => {
    const novo = parseInt(editingTable?.value, 10);
    if (!Number.isInteger(novo) || novo < 1) {
      toast.warning(t('tableManagement.invalidTableNumber'));
      return;
    }
    if (novo === table.table_number) {
      setEditingTable(null);
      return;
    }
    try {
      await api.patch(`/tables/${table.id}`, { table_number: novo });
      setEditingTable(null);
      await loadData();
      toast.success(t('tableManagement.tableRenamedSuccess', { from: table.table_number, to: novo }));
    } catch (err) {
      toast.error(t('tableManagement.errorRenameTable', { detail: motivoDoErro(err) }));
    }
  };

  // ── Bulk Allocation ───────────────────────────────────────────────────────
  const handleSaveMode = async () => {
    try {
      await api.patch(`/tournament-days/${dayId}`, { allocation_mode: bulkMode });
      const modeLabels = { sequential: t('tableManagement.modeLabelSequential'), balanced: t('tableManagement.modeLabelBalanced'), random_balanced: t('tableManagement.modeLabelRandomBalanced') };
      toast.success(t('tableManagement.modeSetSuccess', { mode: modeLabels[bulkMode] || bulkMode }));
      setShowBulkModal(false);
    } catch (err) {
      toast.error(t('tableManagement.errorSaveMode', { detail: err.response?.data?.detail || err.message }));
    }
  };

  const handleBulkAllocate = async () => {
    setBulkLoading(true);
    try {
      // Persist the selected mode so individual buy-ins also use it
      await api.patch(`/tournament-days/${dayId}`, { allocation_mode: bulkMode });

      const res = await api.post(`/allocations/day/${dayId}/bulk`, {
        mode: bulkMode,
        player_ids: [],
      });
      await loadData();
      setShowBulkModal(false);
      toast.success(t('tableManagement.bulkAllocateSuccess', { count: res.data.length }));
    } catch (err) {
      toast.error(t('tableManagement.errorBulkAllocate', { detail: err.response?.data?.detail || err.message }));
    } finally {
      setBulkLoading(false);
    }
  };

  // ── Drag and Drop ─────────────────────────────────────────────────────────
  const handleDragStart = (e, player, isAllocated = false, allocationId = null) => {
    setDraggedPlayer({ ...player, isAllocated, allocationId });
    e.dataTransfer.effectAllowed = 'move';
  };

  const handleDragOver = (e) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
  };

  const handleDropToUnallocated = async (e) => {
    e.preventDefault();
    if (!draggedPlayer || !draggedPlayer.isAllocated) { setDraggedPlayer(null); return; }
    try {
      await api.delete(`/allocations/${draggedPlayer.allocationId}`);
      await loadData();
    } catch (err) {
      toast.error(t('tableManagement.errorUnallocate', { detail: err.response?.data?.detail || err.message }));
    } finally {
      setDraggedPlayer(null);
    }
  };

  const handleDropToSeat = async (e, tableId, seatNumber) => {
    e.preventDefault();
    if (!draggedPlayer) return;

    const isOccupied = allocations.some(a => a.table_id === tableId && a.seat_number === seatNumber);
    if (isOccupied) { toast.warning(t('tableManagement.seatOccupied')); return; }

    try {
      if (draggedPlayer.isAllocated && draggedPlayer.allocationId) {
        // Move player to new seat
        await api.patch(`/allocations/${draggedPlayer.allocationId}`, {
          table_id: tableId,
          seat_number: seatNumber,
        });
        const updated = await api.get(`/allocations/${draggedPlayer.allocationId}`);
        setShowTicket(updated.data);
      } else {
        // New allocation
        const res = await api.post(`/allocations/day/${dayId}/manual`, {
          player_id: draggedPlayer.player_id,
          table_id: tableId,
          seat_number: seatNumber,
        });
        setShowTicket(res.data);
      }
      await loadData();
    } catch (err) {
      toast.error(t('tableManagement.errorAllocate', { detail: motivoDoErro(err) }));
    } finally {
      setDraggedPlayer(null);
    }
  };

  // ── Eliminação no assento (modo "por mesa") ───────────────────────────────
  // Elimina, libera a cadeira e soma no contador que a TV lê — tudo no
  // servidor, numa chamada só. Pela fila offline, como as outras operações do
  // salão: sem rede a eliminação entra na fila e a tela já reflete.
  const handleEliminate = async (allocation) => {
    const nome = allocation.players?.name || t('tableManagement.defaultPlayer');
    const inscrito = inscritoPorJogador.get(allocation.player_id);
    if (!inscrito) {
      toast.error(t('tableManagement.errorEliminate', { detail: t('tableManagement.playerNotInDay') }));
      return;
    }
    const ok = await confirm(
      t('tableManagement.confirmEliminate', { name: nome }),
      { variant: 'danger', confirmText: t('tableManagement.eliminatePlayer') }
    );
    if (!ok) return;

    const body = { tournament_player_id: inscrito.id };
    try {
      const r = await offlineWrite({
        kind: 'eliminate', method: 'post',
        url: `/tournament-players/${inscrito.id}/eliminate`,
        body, clientMutationId: uuid(), meta: { kind: 'eliminate', name: nome },
        synthetic: { ok: true }, applyLocal: () => applyEliminate(body),
      });
      setInscritos((prev) => prev.map((i) => (
        i.id === inscrito.id ? { ...i, status: 'eliminated', eliminated_at: new Date().toISOString() } : i
      )));
      toast.success(t('tableManagement.eliminatedSuccess', { name: nome }));
      if (!r?.offline) await loadData();
    } catch (err) {
      toast.error(err.userMessage || t('tableManagement.errorEliminate', { detail: err.response?.data?.detail || err.message }));
    }
  };

  // Desfazer: eliminação lançada no jogador errado. Não é reentrada (não há
  // venda); o jogador volta à lista de "sem mesa" para ser sentado de novo.
  const handleUneliminate = async (inscrito) => {
    const nome = inscrito.player_name || t('tableManagement.defaultPlayer');
    const body = { tournament_player_id: inscrito.id };
    try {
      const r = await offlineWrite({
        kind: 'restore', method: 'post',
        url: `/tournament-players/${inscrito.id}/uneliminate`,
        body, clientMutationId: uuid(), meta: { kind: 'restore', name: nome },
        synthetic: { ok: true }, applyLocal: () => applyUneliminate(body),
      });
      setInscritos((prev) => prev.map((i) => (
        i.id === inscrito.id ? { ...i, status: 'active', eliminated_at: null } : i
      )));
      toast.success(t('tableManagement.uneliminatedSuccess', { name: nome }));
      if (!r?.offline) await loadData();
    } catch (err) {
      toast.error(err.userMessage || t('tableManagement.errorUneliminate', { detail: err.response?.data?.detail || err.message }));
    }
  };

  // ── Alternate Ticket ──────────────────────────────────────────────────────
  const handleShowAlternateTicket = (player) => {
    setShowTicket({
      player_name: player.player_name,
      tournament_name: tournamentName,
      day_name: day?.day_name || '',
      is_alternate: true,
      table_number: null,
      seat_number: null,
      created_at: new Date().toISOString(),
      id: player.player_id,
    });
  };

  // ── Render Helpers ────────────────────────────────────────────────────────
  const getAllocationForSeat = (tableId, seatNum) =>
    allocations.find(a => a.table_id === tableId && a.seat_number === seatNum);

  const renderSeat = (table, seatNum) => {
    const allocation = getAllocationForSeat(table.id, seatNum);
    const occupied = !!allocation;
    const inactive = table.status !== 'active';
    const desativado = !occupied && (table.blocked_seats || []).includes(seatNum);
    const recebe = !occupied && !inactive && !desativado;
    let rotuloVazio = t('tableManagement.seatEmpty');
    if (inactive) rotuloVazio = '—';
    else if (desativado) rotuloVazio = t('tableManagement.seatDisabled');
    const rotuloDoBotao = desativado
      ? t('tableManagement.enableSeat', { number: seatNum })
      : t('tableManagement.disableSeat', { number: seatNum });

    return (
      <div
        key={seatNum}
        className={`tm-seat ${occupied ? 'occupied' : 'empty'} ${inactive ? 'inactive' : ''} ${desativado ? 'blocked' : ''} ${draggedPlayer && recebe ? 'droppable' : ''}`}
        onDragOver={recebe ? handleDragOver : undefined}
        onDrop={recebe ? (e) => handleDropToSeat(e, table.id, seatNum) : undefined}
      >
        <span className="tm-seat-num">{seatNum}</span>
        {occupied ? (
          <div
            className="tm-seat-player"
            draggable
            onDragStart={(e) => handleDragStart(e, { player_id: allocation.player_id, player_name: allocation.players?.name }, true, allocation.id)}
            title={allocation.players?.name}
          >
            <svg className="tm-player-icon-svg" viewBox="0 0 24 24" fill="currentColor" xmlns="http://www.w3.org/2000/svg">
              <path d="M12 12c2.7 0 4.8-2.1 4.8-4.8S14.7 2.4 12 2.4 7.2 4.5 7.2 7.2 9.3 12 12 12zm0 2.4c-3.2 0-9.6 1.6-9.6 4.8v2.4h19.2v-2.4c0-3.2-6.4-4.8-9.6-4.8z"/>
            </svg>
            {porMesa && (
              <button
                type="button"
                className="tm-btn-elim"
                draggable={false}
                onMouseDown={(e) => e.stopPropagation()}
                onClick={() => handleEliminate(allocation)}
                title={`${t('tableManagement.eliminatePlayer')}: ${allocation.players?.name || ''}`}
                aria-label={`${t('tableManagement.eliminatePlayer')}: ${allocation.players?.name || ''}`}
              >✕</button>
            )}
          </div>
        ) : (
          <>
            <span className="tm-seat-empty">{rotuloVazio}</span>
            {!inactive && (
              <button
                type="button"
                className={`tm-seat-toggle ${desativado ? 'is-off' : ''}`}
                title={rotuloDoBotao}
                aria-label={rotuloDoBotao}
                aria-pressed={desativado}
                onClick={() => handleToggleSeat(table, seatNum, desativado)}
              >{desativado ? '✓' : '⊘'}</button>
            )}
          </>
        )}
      </div>
    );
  };

  const renderTable = (table) => {
    const seats = [];
    for (let i = 1; i <= table.seats; i++) seats.push(renderSeat(table, i));
    const occupied = allocations.filter(a => a.table_id === table.id).length;
    const isInactive = table.status !== 'active';

    return (
      <div key={table.id} className={`tm-table ${isInactive ? 'tm-table-inactive' : ''}`}>
        <div className="tm-table-header">
          <div className="tm-table-title">
            {editingTable?.id === table.id ? (
              <form className="tm-rename" onSubmit={(e) => { e.preventDefault(); handleRenameTable(table); }}>
                <input
                  type="number" min="1"
                  className="tm-input tm-input-num"
                  aria-label={t('tableManagement.tableNumberLabel')}
                  value={editingTable.value}
                  autoFocus
                  onChange={(e) => setEditingTable({ id: table.id, value: e.target.value })}
                  onKeyDown={(e) => { if (e.key === 'Escape') cancelarTrocaDeNumero(); }}
                />
                <button type="submit" className="tm-btn-icon btn-green">{t('common.save')}</button>
                <button type="button" className="tm-btn-icon" onClick={cancelarTrocaDeNumero}>{t('common.cancel')}</button>
              </form>
            ) : (
              <>
                <span className="tm-table-num">{t('tableManagement.tableTitle', { number: table.table_number })}</span>
                <button
                  type="button"
                  className="tm-btn-icon tm-btn-rename"
                  title={t('tableManagement.renameTable')}
                  aria-label={t('tableManagement.renameTable')}
                  onClick={() => iniciarTrocaDeNumero(table)}
                >✎</button>
              </>
            )}
            {isInactive && <span className="tm-badge-closed">{table.status === 'closed' ? t('tableManagement.badgeClosed') : t('tableManagement.badgeBroken')}</span>}
          </div>
          <div className="tm-table-meta">
            <span className="tm-occupancy">{occupied}/{assentosAtivos(table)}</span>
            <button
              type="button"
              className={`tm-btn-icon ${isInactive ? 'btn-green' : 'btn-orange'}`}
              title={isInactive ? t('tableManagement.reactivateTable') : t('tableManagement.closeTable')}
              onClick={() => handleToggleTableStatus(table)}
            >{isInactive ? t('tableManagement.activate') : t('tableManagement.close')}</button>
            {occupied === 0 && (
              <button
                type="button"
                className="tm-btn-icon btn-red"
                title={t('tableManagement.removeTable')}
                onClick={() => handleRemoveTable(table)}
              >{t('common.remove')}</button>
            )}
          </div>
        </div>
        <div className="tm-seats-grid">
          {seats}
        </div>
      </div>
    );
  };

  // ── Main Render ───────────────────────────────────────────────────────────
  if (loading) {
    return (
      <div className="app-container">
        <Sidebar />
        <main className="main-content"><div className="loading">{t('common.loading')}</div></main>
      </div>
    );
  }

  const totalSeats = tables.filter(t => t.status === 'active').reduce((s, t) => s + assentosAtivos(t), 0);
  const totalOccupied = allocations.length;

  return (
    <div className="app-container">
      <Sidebar />
      <main className="main-content tm-page">

        {/* ── Header ── */}
        <div className="tm-header">
          <div className="tm-header-left">
            <h1 className="tm-title">{t('tableManagement.title')}</h1>
            <p className="tm-subtitle">
              {t('tableManagement.subtitleSeats', { dayName: day?.day_name, occupied: totalOccupied, total: totalSeats })}
              {unallocated.length > 0 && (
                <span className={`tm-badge-alt ${tablesLocked ? 'locked' : ''}`}>
                  {unallocated.length} {tablesLocked ? t('tableManagement.badgeAlternate') : t('tableManagement.badgeNoTable')}
                </span>
              )}
            </p>
          </div>
          <div className="tm-header-actions">
            <button
              type="button"
              className={`tm-btn-lock ${tablesLocked ? 'locked' : 'unlocked'}`}
              onClick={handleToggleLock}
              title={tablesLocked ? t('tableManagement.tablesLockedTooltip') : t('tableManagement.tablesOpenTooltip')}
            >
              {tablesLocked ? t('tableManagement.tablesLocked') : t('tableManagement.tablesOpen')}
            </button>
            <button type="button" className="tm-btn-secondary" onClick={() => setShowBulkModal(true)}>
              {t('tableManagement.bulkAllocate')}
            </button>
            <button type="button" className="tm-btn-secondary" onClick={abrirAddTable}>
              {t('tableManagement.addTable')}
            </button>
            <button type="button" className="tm-btn-back" onClick={() => navigate(-1)}>
              {t('tableManagement.back')}
            </button>
          </div>
        </div>

        {/* ── Layout ── */}
        <div className="tm-layout">

          {/* Players / Alternates panel */}
          <div className="tm-players-panel">
            <div className="tm-panel-header">
              <h2 className="tm-panel-title">
                {tablesLocked ? t('tableManagement.panelAlternates') : t('tableManagement.panelNoTable')}
              </h2>
              <span className="tm-count-badge">{unallocated.length}</span>
            </div>
            {tablesLocked && (
              <p className="tm-alt-hint">
                {t('tableManagement.altHint')}
              </p>
            )}
            <div
              className="tm-players-list"
              onDragOver={handleDragOver}
              onDrop={handleDropToUnallocated}
            >
              {unallocated.length === 0 ? (
                <div className="tm-empty-list">
                  {tablesLocked
                    ? t('tableManagement.noAlternates')
                    : t('tableManagement.allPlayersAllocated')}
                </div>
              ) : (
                unallocated.map((p) => (
                  <div
                    key={p.player_id}
                    className={`tm-player-card ${tablesLocked ? 'alternate' : ''}`}
                    draggable
                    onDragStart={(e) => handleDragStart(e, p)}
                  >
                    <div className="tm-player-info">
                      <span className="tm-player-name">{p.player_name}</span>
                    </div>
                    {tablesLocked && (
                      <button
                        type="button"
                        className="tm-btn-print-alt"
                        title={t('tableManagement.printAlternateTicket')}
                        onClick={() => handleShowAlternateTicket(p)}
                      >{t('tableManagement.print')}</button>
                    )}
                    {!tablesLocked && (
                      <span className="tm-drag-hint">{t('tableManagement.dragHint')}</span>
                    )}
                  </div>
                ))
              )}
            </div>

            {porMesa && (
              <div className="tm-eliminated-panel">
                <div className="tm-panel-header">
                  <h2 className="tm-panel-title">{t('tableManagement.panelEliminated')}</h2>
                  <span className="tm-count-badge">{eliminados.length}</span>
                </div>
                <p className="tm-alt-hint">{t('tableManagement.eliminatedHint')}</p>
                {eliminados.length === 0 ? (
                  <div className="tm-empty-list">{t('tableManagement.noEliminated')}</div>
                ) : (
                  <ul className="tm-eliminated-list">
                    {eliminados.map((i) => (
                      <li key={i.id} className="tm-eliminated-item">
                        <span className="tm-player-name">{i.player_name}</span>
                        <button
                          type="button"
                          className="tm-btn-undo"
                          onClick={() => handleUneliminate(i)}
                          aria-label={`${t('tableManagement.undoElimination')}: ${i.player_name}`}
                        >{t('tableManagement.undoElimination')}</button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}
          </div>

          {/* Tables panel */}
          <div className="tm-tables-panel">
            {tables.length === 0 ? (
              <div className="tm-no-tables">
                <p>{t('tableManagement.noTablesRegistered')}</p>
                <button type="button" className="tm-btn-secondary" onClick={abrirAddTable}>
                  {t('tableManagement.addFirstTable')}
                </button>
              </div>
            ) : (
              <div className="tm-tables-grid">
                {tables.map(renderTable)}
              </div>
            )}
          </div>
        </div>

        {/* ── Ticket Modal ── */}
        {showTicket && (
          <div className="tm-modal-overlay" role="presentation" onClick={aoClicarNoFundo(fecharTicket)}>
            <div className="tm-modal">
              <div className="tm-modal-header">
                <h3>{showTicket.is_alternate ? t('tableManagement.ticketAlternate') : t('tableManagement.playerAllocated')}</h3>
                <button type="button" className="tm-close-btn" onClick={() => setShowTicket(null)}>✕</button>
              </div>
              <SeatTicket allocation={showTicket} />
            </div>
          </div>
        )}

        {/* ── Add Table Modal ── */}
        {showAddTableModal && (
          <div className="tm-modal-overlay" role="presentation" onClick={aoClicarNoFundo(fecharAddTable)}>
            <div className="tm-modal tm-modal-sm">
              <div className="tm-modal-header">
                <h3>{t('tableManagement.addTablesModalTitle')}</h3>
                <button type="button" className="tm-close-btn" onClick={() => setShowAddTableModal(false)}>✕</button>
              </div>
              <div className="tm-modal-body">
                <div className="tm-form-row">
                  <label>{t('tableManagement.tableCountLabel')}</label>
                  <input
                    type="number" min="1" max="50"
                    value={newTableCount}
                    onChange={(e) => setNewTableCount(Math.max(1, parseInt(e.target.value) || 1))}
                    className="tm-input"
                  />
                </div>
                <div className="tm-form-row">
                  <label>{t('tableManagement.seatsPerTableLabel')}</label>
                  <input
                    type="number" min="2"
                    value={newTableSeats}
                    onChange={(e) => setNewTableSeats(e.target.value)}
                    onBlur={() => setNewTableSeats(assentosValidos())}
                    className="tm-input"
                  />
                </div>
                <div className="tm-form-row">
                  <label>{newTableCount > 1 ? t('tableManagement.tableStartNumberLabel') : t('tableManagement.tableNumberLabel')}</label>
                  <input
                    type="number" min="1"
                    value={newTableStart}
                    onChange={(e) => setNewTableStart(e.target.value)}
                    onBlur={() => setNewTableStart(numeroInicialValido())}
                    className="tm-input"
                  />
                </div>
              </div>
              <div className="tm-modal-actions">
                <button type="button" className="tm-btn-secondary" onClick={() => setShowAddTableModal(false)}>{t('common.cancel')}</button>
                <button type="button" className="tm-btn-primary" onClick={handleAddTables}>
                  {newTableCount > 1 ? t('tableManagement.addTablesButtonMulti', { count: newTableCount }) : t('tableManagement.addTablesButtonSingle')}
                </button>
              </div>
            </div>
          </div>
        )}

        {/* ── Bulk Allocation Modal ── */}
        {showBulkModal && (
          <div className="tm-modal-overlay" role="presentation" onClick={aoClicarNoFundo(fecharBulk)}>
            <div className="tm-modal tm-modal-sm">
              <div className="tm-modal-header">
                <h3>{t('tableManagement.bulkModalTitle')}</h3>
                <button type="button" className="tm-close-btn" onClick={() => setShowBulkModal(false)}>✕</button>
              </div>
              <div className="tm-modal-body">
                <p className="tm-hint-text">
                  {t('tableManagement.bulkModalHint', { count: unallocated.length })}
                </p>
                <div className="tm-mode-select">
                  <label className="tm-mode-label">{t('tableManagement.distributionMode')}</label>
                  <div className="tm-mode-options">
                    {[
                      { value: 'sequential', label: t('tableManagement.modeSequentialLabel'), desc: t('tableManagement.modeSequentialDesc') },
                      { value: 'balanced', label: t('tableManagement.modeBalancedLabel'), desc: t('tableManagement.modeBalancedDesc') },
                      { value: 'random_balanced', label: t('tableManagement.modeRandomBalancedLabel'), desc: t('tableManagement.modeRandomBalancedDesc') },
                    ].map((opt) => (
                      <button
                        key={opt.value}
                        type="button"
                        className={`tm-mode-card ${bulkMode === opt.value ? 'selected' : ''}`}
                        aria-pressed={bulkMode === opt.value}
                        onClick={() => setBulkMode(opt.value)}
                      >
                        <div className="tm-mode-radio">
                          <div className={`tm-radio-dot ${bulkMode === opt.value ? 'active' : ''}`} />
                        </div>
                        <div>
                          <div className="tm-mode-name">{opt.label}</div>
                          <div className="tm-mode-desc">{opt.desc}</div>
                        </div>
                      </button>
                    ))}
                  </div>
                </div>
              </div>
              <div className="tm-modal-actions">
                <button type="button" className="tm-btn-secondary" onClick={() => setShowBulkModal(false)}>{t('common.cancel')}</button>
                <button
                  type="button"
                  className="tm-btn-outline"
                  onClick={handleSaveMode}
                  disabled={bulkLoading}
                  title={t('tableManagement.setModeTooltip')}
                >
                  {t('tableManagement.setMode')}
                </button>
                <button
                  type="button"
                  className="tm-btn-primary"
                  onClick={handleBulkAllocate}
                  disabled={bulkLoading || unallocated.length === 0}
                  title={unallocated.length === 0 ? t('tableManagement.noPlayersWithoutTable') : t('tableManagement.allocatePlayersTooltip', { count: unallocated.length })}
                >
                  {bulkLoading ? t('tableManagement.allocating') : t('tableManagement.allocatePlayersButton', { count: unallocated.length })}
                </button>
              </div>
            </div>
          </div>
        )}

      </main>
    </div>
  );
};

export default TableManagement;
