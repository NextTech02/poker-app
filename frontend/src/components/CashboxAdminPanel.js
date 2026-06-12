import React, { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import api from '../config/api';
import { useToast } from '../contexts/ToastContext';
import { useStage } from '../contexts/StageContext';
import Card from './Card';
import Button from './Button';
import EmptyState from './EmptyState';
import { SkeletonTableRow } from './SkeletonLoader';
import './CashboxAdminPanel.css';

const fmt = (n) =>
  new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(n ?? 0);

// Ações: kind → { field de valor enviado, label da chave i18n }
const ACTION_CONFIG = {
  open: { payloadKey: 'initial_balance', labelKey: 'cashbox.initialBalance', titleKey: 'cashbox.openCashbox' },
  close: { payloadKey: 'actual_final_balance', labelKey: 'cashbox.countedBalance', titleKey: 'cashbox.closeCashbox' },
  supply: { payloadKey: 'amount', labelKey: 'cashbox.supplyAmount', titleKey: 'cashbox.supply' },
  sangria: { payloadKey: 'amount', labelKey: 'cashbox.sangriaAmount', titleKey: 'cashbox.sangria' },
};

const CashboxAdminPanel = () => {
  const { t } = useTranslation();
  const { toast } = useToast();
  const { selectedStage } = useStage();

  const [cashboxes, setCashboxes] = useState([]);
  const [loading, setLoading] = useState(true);
  const [modal, setModal] = useState(null); // { kind, cashbox }
  const [amount, setAmount] = useState('');
  const [notes, setNotes] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [staffList, setStaffList] = useState([]);
  const [createOpen, setCreateOpen] = useState(false);
  const [newStaffId, setNewStaffId] = useState('');
  const [creating, setCreating] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.get('/cashboxes', { _silentError: true });
      setCashboxes(res.data || []);
    } catch (err) {
      setCashboxes([]);
    } finally {
      setLoading(false);
    }
  }, []);

  const loadStaff = useCallback(async () => {
    try {
      const res = await api.get('/staff', { _silentError: true });
      setStaffList((res.data || []).filter((s) => s.active));
    } catch (_) {
      setStaffList([]);
    }
  }, []);

  useEffect(() => {
    load();
    loadStaff();
  }, [load, loadStaff, selectedStage?.id]);

  // Funcionários que ainda não têm caixa nesta etapa.
  const existingStaffIds = new Set(cashboxes.map((c) => c.staff_id));
  const availableStaff = staffList.filter((s) => !existingStaffIds.has(s.id));

  const submitCreate = async (e) => {
    e.preventDefault();
    if (!newStaffId) return;
    setCreating(true);
    try {
      await api.post('/cashboxes', { staff_id: newStaffId });
      toast.success(t('cashbox.createdSuccess'));
      setCreateOpen(false);
      setNewStaffId('');
      await load();
    } catch (err) {
      toast.error(err.userMessage || t('cashbox.createError'));
    } finally {
      setCreating(false);
    }
  };

  const openModal = (kind, cashbox) => {
    setNotes('');
    if (kind === 'close') setAmount(String(cashbox.current_balance ?? 0));
    else if (kind === 'open') setAmount('0');
    else setAmount('');
    setModal({ kind, cashbox });
  };

  const submit = async (e) => {
    e.preventDefault();
    const { kind, cashbox } = modal;
    const cfg = ACTION_CONFIG[kind];
    setSubmitting(true);
    try {
      const payload = { [cfg.payloadKey]: parseFloat(amount) || 0, notes: notes || null };
      const res = await api.post(`/cashboxes/${cashbox.id}/${kind}`, payload);

      if (kind === 'close') {
        const diff = res.data?.difference ?? 0;
        if (diff === 0) toast.success(t('cashbox.closedOk'));
        else if (diff > 0) toast.warning(t('cashbox.closedSurplus', { value: fmt(diff) }));
        else toast.warning(t('cashbox.closedShortage', { value: fmt(Math.abs(diff)) }));
      } else if (kind === 'open') {
        toast.success(t('cashbox.openedSuccess'));
      } else if (kind === 'supply') {
        toast.success(t('cashbox.supplySuccess'));
      } else if (kind === 'sangria') {
        toast.success(t('cashbox.sangriaSuccess'));
      }

      setModal(null);
      await load();
    } catch (err) {
      toast.error(err.userMessage || t('cashbox.actionError'));
    } finally {
      setSubmitting(false);
    }
  };

  const statusPill = (status) => {
    const label =
      status === 'open' ? t('cashbox.statusOpen')
      : status === 'archived' ? t('cashbox.statusArchived')
      : t('cashbox.statusClosed');
    return <span className={`cb-admin__pill cb-admin__pill--${status}`}>{label}</span>;
  };

  const totalOpen = cashboxes
    .filter((c) => c.status === 'open')
    .reduce((sum, c) => sum + (c.current_balance || 0), 0);

  return (
    <>
    <Card
      title={t('cashbox.adminTitle')}
      className="cb-admin"
    >
      <div className="cb-admin__topbar">
        <Button size="small" onClick={() => { setNewStaffId(''); setCreateOpen(true); }}>
          + {t('cashbox.newCashbox')}
        </Button>
      </div>

      <div className="cb-admin__context">
        <span>
          {selectedStage
            ? t('cashbox.stageContext', { stage: selectedStage.name })
            : t('cashbox.allStagesContext')}
        </span>
        {!loading && cashboxes.length > 0 && (
          <span className="cb-admin__total">
            {t('cashbox.totalOpenBalance')}: <strong>{fmt(totalOpen)}</strong>
          </span>
        )}
      </div>

      {loading ? (
        <div className="table-container">
          <table className="transactions-table">
            <thead>
              <tr>
                <th>{t('cashbox.staff')}</th>
                <th>{t('cashbox.status')}</th>
                <th>{t('cashbox.balance')}</th>
                <th>{t('cashbox.actions')}</th>
              </tr>
            </thead>
            <tbody>
              <SkeletonTableRow cols={4} />
              <SkeletonTableRow cols={4} />
              <SkeletonTableRow cols={4} />
            </tbody>
          </table>
        </div>
      ) : cashboxes.length === 0 ? (
        <EmptyState
          icon={null}
          title={t('cashbox.noCashboxes')}
          subtitle={t('cashbox.noCashboxesHint')}
        />
      ) : (
        <div className="table-container">
          <table className="transactions-table cb-admin__table">
            <thead>
              <tr>
                <th>{t('cashbox.staff')}</th>
                <th>{t('cashbox.status')}</th>
                <th>{t('cashbox.balance')}</th>
                <th>{t('cashbox.actions')}</th>
              </tr>
            </thead>
            <tbody>
              {cashboxes.map((cb) => {
                const isOpen = cb.status === 'open';
                const isArchived = cb.status === 'archived';
                return (
                  <tr key={cb.id}>
                    <td>
                      <div className="cb-admin__staff">
                        <span className="cb-admin__staff-name">{cb.staff_name || '—'}</span>
                        {cb.staff_email && (
                          <span className="cb-admin__staff-email">{cb.staff_email}</span>
                        )}
                      </div>
                    </td>
                    <td>{statusPill(cb.status)}</td>
                    <td className="amount">{fmt(cb.current_balance)}</td>
                    <td>
                      <div className="cb-admin__actions">
                        {isOpen && (
                          <>
                            <Button size="small" onClick={() => openModal('supply', cb)}>
                              {t('cashbox.supply')}
                            </Button>
                            <Button size="small" variant="secondary" onClick={() => openModal('sangria', cb)}>
                              {t('cashbox.sangria')}
                            </Button>
                            <Button size="small" variant="secondary" onClick={() => openModal('close', cb)}>
                              {t('cashbox.closeCashbox')}
                            </Button>
                          </>
                        )}
                        {!isOpen && !isArchived && (
                          <Button size="small" onClick={() => openModal('open', cb)}>
                            {t('cashbox.openCashbox')}
                          </Button>
                        )}
                        {isArchived && <span className="cb-admin__muted">—</span>}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </Card>

      {modal && (
        <div className="modal-overlay" onClick={() => !submitting && setModal(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h2>
                {t(ACTION_CONFIG[modal.kind].titleKey)}
                {modal.cashbox.staff_name ? ` · ${modal.cashbox.staff_name}` : ''}
              </h2>
              <button className="close-btn" onClick={() => setModal(null)} aria-label="Fechar">
                <span className="close-icon"></span>
              </button>
            </div>
            <form onSubmit={submit}>
              {modal.kind === 'close' && (
                <div className="cb-admin__expected">
                  {t('cashbox.expectedBalance')}: <strong>{fmt(modal.cashbox.current_balance)}</strong>
                </div>
              )}
              {(modal.kind === 'supply' || modal.kind === 'sangria') && (
                <div className="cb-admin__expected">
                  {t('cashbox.balance')}: <strong>{fmt(modal.cashbox.current_balance)}</strong>
                </div>
              )}
              <div className="form-group">
                <label htmlFor="cb-admin-amount">{t(ACTION_CONFIG[modal.kind].labelKey)}</label>
                <input
                  id="cb-admin-amount"
                  type="number"
                  step="0.01"
                  min={modal.kind === 'supply' || modal.kind === 'sangria' ? '0.01' : '0'}
                  value={amount}
                  onChange={(e) => setAmount(e.target.value)}
                  required
                  autoFocus
                />
              </div>
              <div className="form-group">
                <label htmlFor="cb-admin-notes">{t('cashbox.notes')}</label>
                <input
                  id="cb-admin-notes"
                  type="text"
                  maxLength={500}
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  placeholder={t('cashbox.notesPlaceholder')}
                />
              </div>
              <div className="modal-actions">
                <Button type="button" variant="secondary" onClick={() => setModal(null)} disabled={submitting}>
                  {t('common.cancel')}
                </Button>
                <Button type="submit" disabled={submitting}>
                  {submitting ? t('common.saving', 'Salvando...') : t(ACTION_CONFIG[modal.kind].titleKey)}
                </Button>
              </div>
            </form>
          </div>
        </div>
      )}

      {createOpen && (
        <div className="modal-overlay" onClick={() => !creating && setCreateOpen(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h2>{t('cashbox.newCashbox')}</h2>
              <button className="close-btn" onClick={() => setCreateOpen(false)} aria-label="Fechar">
                <span className="close-icon"></span>
              </button>
            </div>
            <form onSubmit={submitCreate}>
              {availableStaff.length === 0 ? (
                <p className="cb-admin__empty-note">{t('cashbox.allStaffHaveCashbox')}</p>
              ) : (
                <div className="form-group">
                  <label htmlFor="cb-new-staff">{t('cashbox.staff')}</label>
                  <select
                    id="cb-new-staff"
                    value={newStaffId}
                    onChange={(e) => setNewStaffId(e.target.value)}
                    required
                    autoFocus
                  >
                    <option value="">{t('cashbox.selectStaff')}</option>
                    {availableStaff.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.name}{s.email ? ` (${s.email})` : ''}
                      </option>
                    ))}
                  </select>
                </div>
              )}
              <div className="modal-actions">
                <Button type="button" variant="secondary" onClick={() => setCreateOpen(false)} disabled={creating}>
                  {t('common.cancel')}
                </Button>
                <Button type="submit" disabled={creating || availableStaff.length === 0 || !newStaffId}>
                  {creating ? t('common.saving', 'Salvando...') : t('cashbox.create')}
                </Button>
              </div>
            </form>
          </div>
        </div>
      )}
    </>
  );
};

export default CashboxAdminPanel;
