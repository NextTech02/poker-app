import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useBuyTypes } from '../contexts/BuyTypesContext';
import { useStage } from '../contexts/StageContext';
import { useToast } from '../contexts/ToastContext';
import './BuyTypesManager.css';

const CATEGORIES = ['buy_in', 'rebuy', 'addon'];

const BuyTypesManager = () => {
  const { t } = useTranslation();
  const { toast, confirm } = useToast();
  const { selectedStage } = useStage();
  const { buyTypes, loading, createBuyType, updateBuyType, deleteBuyType } = useBuyTypes();

  const blankForm = { name: '', category: 'buy_in', rake_percentage: 20 };
  const [form, setForm] = useState(blankForm);
  const [busy, setBusy] = useState(false);
  const [editingId, setEditingId] = useState(null);
  const [editForm, setEditForm] = useState(blankForm);

  const categoryLabel = (c) =>
    c === 'rebuy' ? t('cashRegister.rebuy', 'Rebuy') : c === 'addon' ? t('cashRegister.addon', 'Add-on') : t('cashRegister.buyIn', 'Buy-in');

  const handleAdd = async (e) => {
    e.preventDefault();
    if (!form.name.trim()) {
      toast.warning(t('buyTypes.nameRequired', 'Dê um nome ao tipo.'));
      return;
    }
    setBusy(true);
    try {
      await createBuyType(form);
      setForm(blankForm);
      toast.success(t('buyTypes.added', 'Tipo adicionado.'));
    } catch (err) {
      toast.error(t('common.error'));
    } finally {
      setBusy(false);
    }
  };

  const startEdit = (b) => {
    setEditingId(b.id);
    setEditForm({ name: b.name, category: b.category, rake_percentage: b.rake_percentage });
  };

  const saveEdit = async (b) => {
    if (!editForm.name.trim()) return;
    try {
      await updateBuyType(b.id, {
        name: editForm.name.trim(),
        category: editForm.category,
        rake_percentage: Number(editForm.rake_percentage) || 0,
      });
      toast.success(t('buyTypes.updated', 'Tipo atualizado.'));
    } catch {
      toast.error(t('common.error'));
    } finally {
      setEditingId(null);
    }
  };

  const toggleActive = async (b) => {
    try {
      await updateBuyType(b.id, { active: !b.active });
    } catch {
      toast.error(t('common.error'));
    }
  };

  const handleDelete = async (b) => {
    const ok = await confirm(`${t('buyTypes.confirmDelete', 'Excluir o tipo')} "${b.name}"?`, {
      variant: 'danger',
      confirmText: t('common.delete', 'Excluir'),
    });
    if (!ok) return;
    try {
      await deleteBuyType(b.id);
    } catch {
      toast.error(t('common.error'));
    }
  };

  if (!selectedStage?.id) {
    return (
      <div className="bty-wrap">
        <div className="bty-empty">{t('buyTypes.selectStage', 'Selecione uma etapa para configurar os tipos de buy.')}</div>
      </div>
    );
  }

  return (
    <div className="bty-wrap">
      <p className="bty-intro">
        {t('buyTypes.intro', 'Tipos de buy desta etapa. Cada tipo define o rake — o valor vem da configuração do torneio. Usados ao registrar no Caixa.')}{' '}
        <strong>{selectedStage.name}</strong>
      </p>

      <form className="bty-add" onSubmit={handleAdd}>
        <input
          className="bty-in-name"
          type="text"
          value={form.name}
          onChange={(e) => setForm({ ...form, name: e.target.value })}
          placeholder={t('buyTypes.namePlaceholder', 'Nome (ex.: Buy-in VIP)')}
          maxLength={80}
        />
        <select value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })}>
          {CATEGORIES.map((c) => (
            <option key={c} value={c}>{categoryLabel(c)}</option>
          ))}
        </select>
        <input
          className="bty-in-num"
          type="number" min="0" max="100" step="0.1"
          value={form.rake_percentage}
          onChange={(e) => setForm({ ...form, rake_percentage: e.target.value })}
          placeholder={t('buyTypes.rake', 'Rake %')}
        />
        <button type="submit" className="bty-btn-add" disabled={busy || !form.name.trim()}>
          + {t('buyTypes.add', 'Adicionar')}
        </button>
      </form>

      {loading ? (
        <div className="bty-loading">{t('common.loading', 'Carregando...')}</div>
      ) : buyTypes.length === 0 ? (
        <div className="bty-empty">{t('buyTypes.empty', 'Nenhum tipo cadastrado nesta etapa.')}</div>
      ) : (
        <div className="bty-table-wrap">
          <table className="bty-table">
            <thead>
              <tr>
                <th>{t('buyTypes.name', 'Nome')}</th>
                <th>{t('buyTypes.category', 'Categoria')}</th>
                <th>{t('buyTypes.rake', 'Rake %')}</th>
                <th>{t('buyTypes.active', 'Ativo')}</th>
                <th aria-label={t('common.actions', 'Ações')} />
              </tr>
            </thead>
            <tbody>
              {buyTypes.map((b) =>
                editingId === b.id ? (
                  <tr key={b.id} className="bty-row-editing">
                    <td>
                      <input className="bty-in-name" value={editForm.name} maxLength={80}
                        onChange={(e) => setEditForm({ ...editForm, name: e.target.value })} />
                    </td>
                    <td>
                      <select value={editForm.category} onChange={(e) => setEditForm({ ...editForm, category: e.target.value })}>
                        {CATEGORIES.map((c) => (<option key={c} value={c}>{categoryLabel(c)}</option>))}
                      </select>
                    </td>
                    <td>
                      <input className="bty-in-num" type="number" min="0" max="100" step="0.1" value={editForm.rake_percentage}
                        onChange={(e) => setEditForm({ ...editForm, rake_percentage: e.target.value })} />
                    </td>
                    <td colSpan={2} className="bty-edit-actions">
                      <button type="button" className="bty-btn-save" onClick={() => saveEdit(b)}>{t('common.save', 'Salvar')}</button>
                      <button type="button" className="bty-btn-cancel" onClick={() => setEditingId(null)}>{t('common.cancel', 'Cancelar')}</button>
                    </td>
                  </tr>
                ) : (
                  <tr key={b.id} className={b.active ? '' : 'bty-row-inactive'}>
                    <td className="bty-name">{b.name}</td>
                    <td><span className={`bty-cat bty-cat--${b.category}`}>{categoryLabel(b.category)}</span></td>
                    <td>{Number(b.rake_percentage)}%</td>
                    <td>
                      <label className="bty-switch">
                        <input type="checkbox" checked={b.active} onChange={() => toggleActive(b)} />
                        <span className="bty-slider" />
                      </label>
                    </td>
                    <td className="bty-actions">
                      <button type="button" className="bty-btn-edit" onClick={() => startEdit(b)}>{t('common.edit', 'Editar')}</button>
                      <button type="button" className="bty-btn-del" onClick={() => handleDelete(b)} title={t('common.delete', 'Excluir')}>×</button>
                    </td>
                  </tr>
                )
              )}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
};

export default BuyTypesManager;
