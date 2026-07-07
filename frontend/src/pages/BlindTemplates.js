import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import Sidebar from '../components/Sidebar';
import api from '../config/api';
import { useToast } from '../contexts/ToastContext';
import './BlindTemplates.css';

// Próximo nível: dobra a partir do último nível que não é break.
const nextLevelFrom = (prev) => {
  if (!prev) return { small_blind: 25, big_blind: 50, ante: 0, duration: 15, is_break: false };
  return {
    small_blind: (prev.small_blind || 0) * 2 || 25,
    big_blind: (prev.big_blind || 0) * 2 || 50,
    ante: prev.ante > 0 ? prev.ante * 2 : 0,
    duration: prev.duration || 15,
    is_break: false,
  };
};

const newBreak = () => ({ small_blind: 0, big_blind: 0, ante: 0, duration: 10, is_break: true });

const BlindTemplates = () => {
  const { t } = useTranslation();
  const { toast, confirm } = useToast();

  const [templates, setTemplates] = useState([]);
  const [loading, setLoading] = useState(true);

  const [showEditor, setShowEditor] = useState(false);
  const [editingId, setEditingId] = useState(null);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [levels, setLevels] = useState([]);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    loadTemplates();
  }, []);

  const loadTemplates = async () => {
    try {
      setLoading(true);
      const res = await api.get('/blind-templates');
      setTemplates(res.data || []);
    } catch (err) {
      console.error('Erro ao carregar templates de blind:', err);
    } finally {
      setLoading(false);
    }
  };

  const lastNonBreak = (arr) => {
    for (let i = arr.length - 1; i >= 0; i--) if (!arr[i].is_break) return arr[i];
    return null;
  };

  const openNew = () => {
    setEditingId(null);
    setName('');
    setDescription('');
    setLevels([nextLevelFrom(null)]);
    setShowEditor(true);
  };

  const openEdit = (tpl) => {
    setEditingId(tpl.id);
    setName(tpl.name || '');
    setDescription(tpl.description || '');
    const lv = (tpl.custom_levels && tpl.custom_levels.length)
      ? tpl.custom_levels.map((l) => ({
          small_blind: l.small_blind || 0,
          big_blind: l.big_blind || 0,
          ante: l.ante || 0,
          duration: l.duration || 15,
          is_break: !!l.is_break,
        }))
      : [nextLevelFrom(null)];
    setLevels(lv);
    setShowEditor(true);
  };

  const addLevel = () => setLevels((prev) => [...prev, nextLevelFrom(lastNonBreak(prev))]);
  const addBreak = () => setLevels((prev) => [...prev, newBreak()]);
  const removeRow = (idx) => setLevels((prev) => prev.filter((_, i) => i !== idx));
  const updateRow = (idx, field, value) =>
    setLevels((prev) => prev.map((r, i) => (i === idx ? { ...r, [field]: value } : r)));

  const handleSave = async (e) => {
    e.preventDefault();
    if (!name.trim()) {
      toast.warning(t('blindTemplates.nameRequired', 'Dê um nome ao template.'));
      return;
    }
    if (!levels.length) {
      toast.warning(t('blindTemplates.needLevel', 'Adicione ao menos um nível.'));
      return;
    }
    const custom_levels = levels.map((r, i) => ({
      level: i + 1,
      small_blind: r.is_break ? 0 : (parseInt(r.small_blind, 10) || 0),
      big_blind: r.is_break ? 0 : (parseInt(r.big_blind, 10) || 0),
      ante: r.is_break ? 0 : (parseInt(r.ante, 10) || 0),
      duration: parseInt(r.duration, 10) || 1,
      is_break: !!r.is_break,
    }));
    const payload = {
      name: name.trim(),
      description: description.trim() || null,
      blind_increase_type: 'custom',
      custom_levels,
    };
    setSaving(true);
    try {
      if (editingId) {
        await api.patch(`/blind-templates/${editingId}`, payload);
      } else {
        await api.post('/blind-templates', payload);
      }
      toast.success(t('blindTemplates.saved', 'Template salvo com sucesso.'));
      setShowEditor(false);
      loadTemplates();
    } catch (err) {
      const detail = err.response?.data?.detail;
      toast.error(typeof detail === 'string' ? detail : t('common.error'));
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (tpl) => {
    const ok = await confirm(
      `${t('blindTemplates.confirmDelete', 'Excluir o template')} "${tpl.name}"?`,
      { variant: 'danger', confirmText: t('common.delete') }
    );
    if (!ok) return;
    try {
      await api.delete(`/blind-templates/${tpl.id}`);
      loadTemplates();
    } catch {
      toast.error(t('common.error'));
    }
  };

  const levelCount = (tpl) => (tpl.custom_levels || []).filter((l) => !l.is_break).length;
  const breakCount = (tpl) => (tpl.custom_levels || []).filter((l) => l.is_break).length;

  // Numeração de exibição: breaks não consomem número de nível.
  let displayCounter = 0;
  const displayLabel = (row) => {
    if (row.is_break) return t('blindTemplates.break', 'Break');
    displayCounter += 1;
    return `${t('blindTemplates.level', 'Nível')} ${displayCounter}`;
  };

  return (
    <div className="app-layout">
      <Sidebar />
      <main className="main-content">
        <div className="bt-page-header">
          <div className="bt-page-header-left">
            <div className="bt-page-icon">
              <svg viewBox="0 0 24 24" fill="currentColor">
                <path d="M19 5h-2V3H7v2H5c-1.1 0-2 .9-2 2v1c0 2.55 1.92 4.63 4.39 4.94.63 1.5 1.98 2.63 3.61 2.96V17H7v2h10v-2h-4v-1.1c1.63-.33 2.98-1.46 3.61-2.96C19.08 12.63 21 10.55 21 8V7c0-1.1-.9-2-2-2z" />
              </svg>
            </div>
            <div>
              <h1 className="bt-page-title">{t('blindTemplates.pageTitle', 'Templates de Blinds')}</h1>
              <p className="bt-page-subtitle">
                {t('blindTemplates.intro', 'Crie e salve estruturas de blinds reutilizáveis. Depois, é só carregá-las em qualquer dia de torneio.')}
              </p>
            </div>
          </div>
          <button className="bt-btn-new" onClick={openNew}>
            <svg viewBox="0 0 24 24" fill="currentColor" width="18" height="18">
              <path d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z" />
            </svg>
            {t('blindTemplates.newTemplate', 'Novo template')}
          </button>
        </div>

        <div className="bt-wrap">
      {loading ? (
        <div className="bt-loading">{t('common.loading', 'Carregando...')}</div>
      ) : templates.length === 0 ? (
        <div className="bt-empty">
          <svg viewBox="0 0 24 24" fill="currentColor" width="40" height="40">
            <path d="M19 5h-2V3H7v2H5c-1.1 0-2 .9-2 2v1c0 2.55 1.92 4.63 4.39 4.94.63 1.5 1.98 2.63 3.61 2.96V17H7v2h10v-2h-4v-1.1c1.63-.33 2.98-1.46 3.61-2.96C19.08 12.63 21 10.55 21 8V7c0-1.1-.9-2-2-2z" />
          </svg>
          <h3>{t('blindTemplates.emptyTitle', 'Nenhum template ainda')}</h3>
          <p>{t('blindTemplates.emptyHint', 'Crie seu primeiro template de estrutura de blinds.')}</p>
        </div>
      ) : (
        <div className="bt-grid">
          {templates.map((tpl) => (
            <div key={tpl.id} className="bt-card">
              <div className="bt-card-head">
                <h3 className="bt-card-name">{tpl.name}</h3>
                <span className="bt-card-count">
                  {levelCount(tpl)} {t('blindTemplates.levelsShort', 'níveis')}
                  {breakCount(tpl) > 0 && ` · ${breakCount(tpl)} ${t('blindTemplates.breaksShort', 'breaks')}`}
                </span>
              </div>
              {tpl.description && <p className="bt-card-desc">{tpl.description}</p>}
              <div className="bt-card-actions">
                <button className="bt-btn-edit" onClick={() => openEdit(tpl)}>
                  {t('common.edit', 'Editar')}
                </button>
                <button className="bt-btn-delete" onClick={() => handleDelete(tpl)}>
                  {t('common.delete', 'Excluir')}
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {showEditor && (
        <div className="bt-overlay" onClick={() => !saving && setShowEditor(false)}>
          <div className="bt-modal" onClick={(e) => e.stopPropagation()}>
            <div className="bt-modal-head">
              <h2>
                {editingId
                  ? t('blindTemplates.editTitle', 'Editar template')
                  : t('blindTemplates.newTitle', 'Novo template de blinds')}
              </h2>
              <button className="bt-close" onClick={() => setShowEditor(false)} aria-label={t('common.close', 'Fechar')}>
                ×
              </button>
            </div>

            <form onSubmit={handleSave} className="bt-form">
              <div className="bt-field-row">
                <div className="bt-field">
                  <label htmlFor="bt-name">{t('blindTemplates.name', 'Nome')} *</label>
                  <input
                    id="bt-name"
                    type="text"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder={t('blindTemplates.namePlaceholder', 'Ex.: Turbo 20min')}
                    required
                  />
                </div>
                <div className="bt-field">
                  <label htmlFor="bt-desc">{t('blindTemplates.description', 'Descrição')}</label>
                  <input
                    id="bt-desc"
                    type="text"
                    value={description}
                    onChange={(e) => setDescription(e.target.value)}
                    placeholder={t('blindTemplates.descriptionPlaceholder', 'Opcional')}
                  />
                </div>
              </div>

              <div className="bt-levels">
                <table className="bt-levels-table">
                  <thead>
                    <tr>
                      <th>#</th>
                      <th>{t('blinds.smallBlind', 'SB')}</th>
                      <th>{t('blinds.bigBlind', 'BB')}</th>
                      <th>{t('blinds.ante', 'Ante')}</th>
                      <th>{t('blinds.duration', 'Duração')}</th>
                      <th aria-label="remover" />
                    </tr>
                  </thead>
                  <tbody>
                    {(() => { displayCounter = 0; return null; })()}
                    {levels.map((row, idx) => (
                      <tr key={idx} className={row.is_break ? 'bt-row-break' : ''}>
                        <td className="bt-row-label">{displayLabel(row)}</td>
                        {row.is_break ? (
                          <td colSpan={3} className="bt-break-cell">
                            {t('blindTemplates.breakRow', 'Intervalo')}
                          </td>
                        ) : (
                          <>
                            <td>
                              <input
                                type="number" min="0"
                                value={row.small_blind}
                                onChange={(e) => updateRow(idx, 'small_blind', e.target.value)}
                              />
                            </td>
                            <td>
                              <input
                                type="number" min="0"
                                value={row.big_blind}
                                onChange={(e) => updateRow(idx, 'big_blind', e.target.value)}
                              />
                            </td>
                            <td>
                              <input
                                type="number" min="0"
                                value={row.ante}
                                onChange={(e) => updateRow(idx, 'ante', e.target.value)}
                              />
                            </td>
                          </>
                        )}
                        <td>
                          <input
                            type="number" min="1"
                            value={row.duration}
                            onChange={(e) => updateRow(idx, 'duration', e.target.value)}
                          />
                        </td>
                        <td>
                          <button
                            type="button"
                            className="bt-row-remove"
                            onClick={() => removeRow(idx)}
                            title={t('common.delete', 'Excluir')}
                            disabled={levels.length === 1}
                          >
                            ×
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>

                <div className="bt-levels-actions">
                  <button type="button" className="bt-btn-add" onClick={addLevel}>
                    + {t('blinds.addBlind', 'Adicionar nível')}
                  </button>
                  <button type="button" className="bt-btn-add bt-btn-add-break" onClick={addBreak}>
                    + {t('blinds.addBreak', 'Adicionar break')}
                  </button>
                </div>
              </div>

              <div className="bt-modal-actions">
                <button type="button" className="bt-btn-cancel" onClick={() => setShowEditor(false)} disabled={saving}>
                  {t('common.cancel', 'Cancelar')}
                </button>
                <button type="submit" className="bt-btn-save" disabled={saving}>
                  {saving ? t('common.saving', 'Salvando...') : t('common.save', 'Salvar')}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
        </div>
      </main>
    </div>
  );
};

export default BlindTemplates;
