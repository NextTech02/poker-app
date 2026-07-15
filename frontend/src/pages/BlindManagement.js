import React, { useState, useEffect, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import Sidebar from '../components/Sidebar';
import Card from '../components/Card';
import Button from '../components/Button';
import Breadcrumb from '../components/Breadcrumb';
import EmptyState from '../components/EmptyState';
import api from '../config/api';
import { useToast } from '../contexts/ToastContext';
import './BlindManagement.css';

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
  const [isBreakMode, setIsBreakMode] = useState(false);
  // Inline edit (click a value to edit) + drag-to-reorder
  const [editCell, setEditCell] = useState(null); // { id, field }
  const [editVal, setEditVal] = useState('');
  const [dragId, setDragId] = useState(null);
  const [dragOverId, setDragOverId] = useState(null);
  const [reordering, setReordering] = useState(false);
  // Template states
  const [templates, setTemplates] = useState([]);
  const [showTemplateModal, setShowTemplateModal] = useState(false);
  const [formData, setFormData] = useState({
    level: '',
    small_blind: '',
    big_blind: '',
    ante: 0,
    duration: 15,
    is_break: false,
  });

  const [loadError, setLoadError] = useState(null);

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
  }, [dayId]);

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
      setIsBreakMode(false);
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

      await api.patch(`/tournament-days/${dayId}/blinds/${editingBlind.id}`, data);
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
      loadData();
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
    } catch (error) {
      const msg = error.response?.data?.detail || t('common.error');
      toast.error(typeof msg === 'string' ? msg : t('common.error'));
    }
  };

  // ── Drag-to-reorder blind levels ──────────────────────────────────────────
  const onRowDragStart = (e, blind) => {
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

    const reordered = [...blinds];
    const [moved] = reordered.splice(from, 1);
    reordered.splice(to, 0, moved);

    // Optimistic renumber, then persist only the positions that changed.
    setBlinds(reordered.map((b, i) => ({ ...b, level: i + 1 })));
    setReordering(true);
    try {
      for (let i = 0; i < reordered.length; i++) {
        if (reordered[i].level !== i + 1) {
          await patchBlind(reordered[i], { level: i + 1 });
        }
      }
      await loadData();
    } catch (error) {
      const msg = error.response?.data?.detail || t('common.error');
      toast.error(typeof msg === 'string' ? msg : t('common.error'));
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
      loadData();
    } catch (error) {
      console.error('Error deleting blind:', error);
      toast.error(t('common.error'));
    }
  };

  const openEditModal = (blind) => {
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
    // Auto-suggest next level
    const nextLevel = blinds.length > 0 ? Math.max(...blinds.map(b => b.level)) + 1 : 1;
    // Auto-suggest blinds based on last non-break level
    const lastBlind = blinds.filter(b => !b.is_break).slice(-1)[0];

    setIsBreakMode(asBreak);
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
                      return (
                        <span
                          className={canEdit ? 'inline-editable' : ''}
                          onClick={canEdit ? () => startEdit(blind, field) : undefined}
                          title={canEdit ? t('blinds.clickToEdit', 'Clique para editar') : undefined}
                        >
                          {display}
                        </span>
                      );
                    };
                    return (
                      <tr
                        key={blind.id}
                        className={`blind-row ${blind.is_break ? 'break-row' : ''} ${dragOverId === blind.id ? 'drag-over' : ''} ${dragId === blind.id ? 'dragging' : ''}`}
                        draggable={!editCell && !reordering}
                        onDragStart={(e) => onRowDragStart(e, blind)}
                        onDragOver={(e) => onRowDragOver(e, blind)}
                        onDrop={(e) => onRowDrop(e, blind)}
                        onDragEnd={onRowDragEnd}
                      >
                        <td className="level-cell">
                          <span className="drag-handle" title={t('blinds.dragToReorder', 'Arraste para reordenar')}>⠿</span>
                          {blind.is_break ? (
                            <span className="break-badge">{t('blinds.break')}</span>
                          ) : (
                            <strong>{t('blinds.level')} {displayLevelById[blind.id]}</strong>
                          )}
                        </td>
                        <td>{blind.is_break ? '-' : cell('small_blind', blind.small_blind.toLocaleString())}</td>
                        <td>{blind.is_break ? '-' : cell('big_blind', blind.big_blind.toLocaleString())}</td>
                        <td>{blind.is_break ? '-' : cell('ante', (blind.ante || 0).toLocaleString())}</td>
                        <td>{cell('duration', `${blind.duration} min`)}</td>
                        <td>
                          <div className="action-buttons">
                            <button
                              className="btn-small btn-edit"
                              onClick={() => openEditModal(blind)}
                              title={t('common.edit')}
                            >
                              {t('common.edit')}
                            </button>
                            <button
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
              <span>{t('blinds.levels')}: {blindLevels.length}</span>
              <span>{t('blinds.breaks')}: {breakLevels.length}</span>
              <span>{t('blinds.totalDuration')}: {totalDuration} min ({Math.floor(totalDuration / 60)}h {totalDuration % 60}min)</span>
              <span>{t('blinds.breakTime')}: {totalBreakTime} min</span>
            </div>
          )}
        </Card>

        {/* Add Blind/Break Modal */}
        {showAddModal && (
          <div className="modal-overlay" onClick={() => setShowAddModal(false)}>
            <div className="modal" onClick={(e) => e.stopPropagation()}>
              <div className="modal-header">
                <h2>{formData.is_break ? t('blinds.addBreak') : t('blinds.addBlind')}</h2>
                <button className="close-btn" onClick={() => setShowAddModal(false)} aria-label={t('common.close')}>
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

                      // Generate options for all available levels (1 to maxLevel + 1)
                      for (let i = 1; i <= maxLevel + 1; i++) {
                        // Skip if level already exists
                        if (existingLevels.has(i)) continue;

                        const prevBlind = blinds.filter(b => b.level < i).sort((a, b) => b.level - a.level)[0];
                        const nextBlind = blinds.filter(b => b.level > i).sort((a, b) => a.level - b.level)[0];

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
          <div className="modal-overlay" onClick={() => setShowEditModal(false)}>
            <div className="modal" onClick={(e) => e.stopPropagation()}>
              <div className="modal-header">
                <h2>{formData.is_break ? t('blinds.editBreak') : t('blinds.editBlind')}</h2>
                <button className="close-btn" onClick={() => setShowEditModal(false)} aria-label={t('common.close')}>
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
          <div className="modal-overlay" onClick={() => setShowTemplateModal(false)}>
            <div className="modal template-modal" onClick={(e) => e.stopPropagation()}>
              <div className="modal-header">
                <h2>{t('blinds.loadTemplate')}</h2>
                <button className="close-btn" onClick={() => setShowTemplateModal(false)} aria-label={t('common.close')}>
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
