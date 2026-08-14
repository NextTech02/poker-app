import React, { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import api from '../config/api';
import { useToast } from '../contexts/ToastContext';
import { useStage } from '../contexts/StageContext';
import Card from './Card';
import Button from './Button';
import EmptyState from './EmptyState';
import { SkeletonTableRow } from './SkeletonLoader';
import { useCurrency } from '../contexts/CurrencyContext';
import './CashboxAdminPanel.css';

// Ações: kind → { field de valor enviado, label da chave i18n }
const ACTION_CONFIG = {
  open: { payloadKey: 'initial_balance', labelKey: 'cashbox.initialBalance', titleKey: 'cashbox.openCashbox' },
  close: { payloadKey: 'actual_final_balance', labelKey: 'cashbox.countedBalance', titleKey: 'cashbox.closeCashbox' },
  supply: { payloadKey: 'amount', labelKey: 'cashbox.supplyAmount', titleKey: 'cashbox.supply' },
  sangria: { payloadKey: 'amount', labelKey: 'cashbox.sangriaAmount', titleKey: 'cashbox.sangria' },
  // Sangria que move o CAIXA DA ETAPA → Caixa Geral (com rake), sem tocar no
  // saldo do caixa modular. Reusa o endpoint /cash/sangria (nível da etapa).
  stageSangria: { payloadKey: 'amount', labelKey: 'generalCash.sangriaAmountLabel', titleKey: 'cashbox.sangriaToGeneral' },
};

const CashboxAdminPanel = () => {
  const { t } = useTranslation();
  const { toast } = useToast();
  const { selectedStage } = useStage();
  const { formatCurrency } = useCurrency();

  const [cashboxes, setCashboxes] = useState([]);
  const [loading, setLoading] = useState(true);
  const [modal, setModal] = useState(null); // { kind, cashbox }
  const [amount, setAmount] = useState('');
  const [notes, setNotes] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [pendingRake, setPendingRake] = useState(0); // rake pendente da etapa (auto)
  const [stageCash, setStageCash] = useState(null); // saldo do caixa da etapa

  // Rake automático da sangria (Fase 2): proporcional ao rake pendente da etapa.
  const autoRake = () => {
    const amt = parseFloat(amount) || 0;
    const bal = parseFloat(stageCash?.current_balance) || 0;
    let rk = bal > 0 ? (pendingRake * amt) / bal : 0;
    if (rk > amt) rk = amt;
    const pct = amt > 0 ? (rk / amt) * 100 : 0;
    return { rakeAmount: rk, netAmount: amt - rk, pct };
  };
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
    if (kind === 'stageSangria') {
      setPendingRake(0);
      setStageCash(null);
      if (selectedStage?.id) {
        api
          .get(`/cash/stage/${selectedStage.id}`, { _silentError: true })
          .then((r) => setStageCash(r.data))
          .catch(() => setStageCash(null));
        api
          .get(`/cash/stage/${selectedStage.id}/pending-rake`, { _silentError: true })
          .then((r) => setPendingRake(parseFloat(r.data?.pending_rake) || 0))
          .catch(() => setPendingRake(0));
      }
    }
    setModal({ kind, cashbox });
  };

  const submit = async (e) => {
    e.preventDefault();
    const { kind, cashbox } = modal;
    const cfg = ACTION_CONFIG[kind];
    setSubmitting(true);
    try {
      // Sangria da ETAPA → Caixa Geral (não toca no caixa modular).
      if (kind === 'stageSangria') {
        const amt = parseFloat(amount) || 0;
        if (amt <= 0) {
          toast.warning(t('generalCash.amountGreaterThanZero'));
          return;
        }
        if (stageCash && amt > parseFloat(stageCash.current_balance)) {
          toast.warning(t('generalCash.insufficientBalance', { value: formatCurrency(stageCash.current_balance) }));
          return;
        }
        const tag = cashbox.staff_name ? `[Caixa: ${cashbox.staff_name}] ` : '';
        await api.post('/cash/sangria', {
          stage_id: selectedStage?.id,
          stage_name: selectedStage?.name,
          amount: amt,
          rake_percentage: autoRake().pct,
          notes: `${tag}${notes || ''}`.trim() || null,
        });
        toast.success(t('cashbox.sangriaToGeneralSuccess'));
        setModal(null);
        await load();
        return;
      }

      const payload = { [cfg.payloadKey]: parseFloat(amount) || 0, notes: notes || null };
      const res = await api.post(`/cashboxes/${cashbox.id}/${kind}`, payload);

      if (kind === 'close') {
        const diff = res.data?.difference ?? 0;
        if (diff === 0) toast.success(t('cashbox.closedOk'));
        else if (diff > 0) toast.warning(t('cashbox.closedSurplus', { value: formatCurrency(diff) }));
        else toast.warning(t('cashbox.closedShortage', { value: formatCurrency(Math.abs(diff)) }));
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
            {t('cashbox.totalOpenBalance')}: <strong>{formatCurrency(totalOpen)}</strong>
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
                    <td className="amount">{formatCurrency(cb.current_balance)}</td>
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
                            <Button size="small" variant="secondary" onClick={() => openModal('stageSangria', cb)}>
                              {t('cashbox.sangriaToGeneral')}
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
              <button className="close-btn" onClick={() => setModal(null)} aria-label={t('common.close')}>
                <span className="close-icon"></span>
              </button>
            </div>
            <form onSubmit={submit}>
              {modal.kind === 'close' && (
                <div className="cb-admin__expected">
                  {t('cashbox.expectedBalance')}: <strong>{formatCurrency(modal.cashbox.current_balance)}</strong>
                </div>
              )}
              {(modal.kind === 'supply' || modal.kind === 'sangria') && (
                <div className="cb-admin__expected">
                  {t('cashbox.balance')}: <strong>{formatCurrency(modal.cashbox.current_balance)}</strong>
                </div>
              )}
              {modal.kind === 'stageSangria' && (
                <div className="cb-admin__expected">
                  {t('generalCash.stageLabel')} <strong>{selectedStage?.name || '—'}</strong>
                  <br />
                  {t('generalCash.availableBalanceLabel')}{' '}
                  <strong>{stageCash ? formatCurrency(stageCash.current_balance) : '…'}</strong>
                </div>
              )}
              <div className="form-group">
                <label htmlFor="cb-admin-amount">{t(ACTION_CONFIG[modal.kind].labelKey)}</label>
                <input
                  id="cb-admin-amount"
                  type="number"
                  step="0.01"
                  min={modal.kind === 'supply' || modal.kind === 'sangria' || modal.kind === 'stageSangria' ? '0.01' : '0'}
                  max={modal.kind === 'stageSangria' && stageCash ? stageCash.current_balance : undefined}
                  value={amount}
                  onChange={(e) => setAmount(e.target.value)}
                  required
                  autoFocus
                />
              </div>
              {modal.kind === 'stageSangria' && (
                <>
                  <div className="form-group">
                    <label>{t('generalCash.rakeAutoLabel', 'Rake (automático)')}</label>
                    <div className="sangria-rake-auto">
                      {formatCurrency(autoRake().rakeAmount)}
                      {parseFloat(amount) > 0 ? ` (${autoRake().pct.toFixed(2)}%)` : ''}
                    </div>
                  </div>
                  {parseFloat(amount) > 0 && (
                    <div className="cb-admin__expected">
                      {t('generalCash.toGeneralCash')}:{' '}
                      <strong className="amount net-amount">
                        {formatCurrency(autoRake().netAmount)}
                      </strong>
                    </div>
                  )}
                </>
              )}
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
              <button className="close-btn" onClick={() => setCreateOpen(false)} aria-label={t('common.close')}>
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
