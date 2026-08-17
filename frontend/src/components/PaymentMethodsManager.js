import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { usePaymentMethods } from '../contexts/PaymentMethodsContext';
import { useToast } from '../contexts/ToastContext';
import { methodLabel, isBuiltinMethod } from '../utils/paymentMethodLabels';
import './PaymentMethodsManager.css';

const PaymentMethodsManager = () => {
  const { t } = useTranslation();
  const { toast, confirm } = useToast();
  const { methods, loading, createMethod, updateMethod, deleteMethod } = usePaymentMethods();

  const [newLabel, setNewLabel] = useState('');
  const [busy, setBusy] = useState(false);
  const [editingId, setEditingId] = useState(null);
  const [editLabel, setEditLabel] = useState('');

  const handleAdd = async (e) => {
    e.preventDefault();
    if (!newLabel.trim()) return;
    setBusy(true);
    try {
      await createMethod(newLabel);
      setNewLabel('');
      toast.success(t('paymentMethods.added', 'Método adicionado.'));
    } catch (err) {
      toast.error(t('common.error'));
    } finally {
      setBusy(false);
    }
  };

  const startEdit = (m) => {
    setEditingId(m.id);
    setEditLabel(m.label);
  };

  const commitEdit = async (m) => {
    const label = editLabel.trim();
    setEditingId(null);
    if (!label || label === m.label) return;
    try {
      await updateMethod(m.id, { label });
      toast.success(t('paymentMethods.updated', 'Método atualizado.'));
    } catch {
      toast.error(t('common.error'));
    }
  };

  const toggleActive = async (m) => {
    try {
      await updateMethod(m.id, { active: !m.active });
    } catch {
      toast.error(t('common.error'));
    }
  };

  const handleDelete = async (m) => {
    const ok = await confirm(
      `${t('paymentMethods.confirmDelete', 'Excluir o método')} "${m.label}"?`,
      { variant: 'danger', confirmText: t('common.delete', 'Excluir') }
    );
    if (!ok) return;
    try {
      await deleteMethod(m.id);
    } catch {
      toast.error(t('common.error'));
    }
  };

  return (
    <div className="pm-wrap">
      <p className="pm-intro">
        {t('paymentMethods.intro', 'Configure as formas de pagamento aceitas. Os métodos ativos aparecem no Caixa ao registrar transações.')}
      </p>

      {/* Rótulo acima do campo, mesmo padrão de Despesas/Receitas (.exp-field),
          com htmlFor/id para o leitor de tela anunciar e o clique focar. */}
      <form className="pm-add" onSubmit={handleAdd}>
        <div className="pm-field pm-field--name">
          <label htmlFor="pm-new-name">{t('paymentMethods.name', 'Nome')}</label>
          <input
            id="pm-new-name"
            type="text"
            value={newLabel}
            onChange={(e) => setNewLabel(e.target.value)}
            placeholder={t('paymentMethods.namePlaceholderShort', 'ex.: Yape, Nequi, Cartão')}
            maxLength={60}
          />
        </div>
        <button type="submit" className="pm-btn-add" disabled={busy || !newLabel.trim()}>
          + {t('paymentMethods.add', 'Adicionar')}
        </button>
      </form>

      {loading ? (
        <div className="pm-loading">{t('common.loading', 'Carregando...')}</div>
      ) : methods.length === 0 ? (
        <div className="pm-empty">{t('paymentMethods.empty', 'Nenhum método cadastrado.')}</div>
      ) : (
        <div className="pm-table-wrap">
          <table className="pm-table">
            <thead>
              <tr>
                <th>{t('paymentMethods.name', 'Nome')}</th>
                <th>{t('paymentMethods.code', 'Código')}</th>
                <th>{t('paymentMethods.active', 'Ativo')}</th>
                <th aria-label={t('common.actions', 'Ações')} />
              </tr>
            </thead>
            <tbody>
              {methods.map((m) => (
                <tr key={m.id} className={m.active ? '' : 'pm-row-inactive'}>
                  <td>
                    {isBuiltinMethod(m.code) ? (
                      // Métodos universais: rótulo traduzido (i18n), não editável.
                      <span className="pm-label-builtin" title={t('paymentMethods.builtinHint', 'Método padrão (traduz automaticamente)')}>
                        {methodLabel(t, m)}
                        <span className="pm-builtin-tag">{t('paymentMethods.builtin', 'padrão')}</span>
                      </span>
                    ) : editingId === m.id ? (
                      // Edição inline: a coluna "Nome" já rotula visualmente;
                      // o aria-label cobre quem ouve a célula sem o cabeçalho.
                      <input
                        className="pm-edit-input"
                        autoFocus
                        aria-label={`${t('paymentMethods.name', 'Nome')} — ${m.label}`}
                        value={editLabel}
                        onChange={(e) => setEditLabel(e.target.value)}
                        onBlur={() => commitEdit(m)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') commitEdit(m);
                          if (e.key === 'Escape') setEditingId(null);
                        }}
                        maxLength={60}
                      />
                    ) : (
                      <button type="button" className="pm-label-btn" onClick={() => startEdit(m)} title={t('common.edit', 'Editar')}>
                        {m.label}
                      </button>
                    )}
                  </td>
                  <td><code className="pm-code">{m.code}</code></td>
                  <td>
                    <label className="pm-switch">
                      <input type="checkbox" checked={m.active}
                        aria-label={`${t('paymentMethods.active', 'Ativo')} — ${methodLabel(t, m)}`}
                        onChange={() => toggleActive(m)} />
                      <span className="pm-slider" />
                    </label>
                  </td>
                  <td className="pm-actions">
                    <button type="button" className="pm-btn-del" onClick={() => handleDelete(m)} title={t('common.delete', 'Excluir')}>
                      ×
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
};

export default PaymentMethodsManager;
