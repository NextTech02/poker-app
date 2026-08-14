import React, { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import api from '../config/api';
import { useToast } from '../contexts/ToastContext';
import { useStage } from '../contexts/StageContext';
import Button from './Button';
import { useCurrency } from '../contexts/CurrencyContext';
import './CashboxBanner.css';

/**
 * Banner do caixa modular do operador na etapa selecionada.
 * - Busca GET /cashboxes/me/current (usa X-Stage-ID do interceptor).
 * - Resposta null = super-admin / sem vínculo de funcionário → não renderiza nada
 *   e reporta `null` ao pai (que então NÃO bloqueia operações).
 * - Resposta com caixa → mostra status/saldo + abrir/fechar.
 *
 * @param {(cashbox: object|null) => void} onStateChange  recebe o caixa atual (ou null).
 */
const CashboxBanner = ({ onStateChange }) => {
  const { t } = useTranslation();
  const { toast } = useToast();
  const { selectedStage } = useStage();
  const { formatCurrency } = useCurrency();
  const [cashbox, setCashbox] = useState(undefined); // undefined = carregando
  const [needsStage, setNeedsStage] = useState(false);
  const [modal, setModal] = useState(null); // 'open' | 'close' | null
  const [initialBalance, setInitialBalance] = useState('0');
  const [actualBalance, setActualBalance] = useState('');
  const [notes, setNotes] = useState('');
  const [submitting, setSubmitting] = useState(false);

  // Acessibilidade: o fundo escuro fecha no clique, mas quem usa só o teclado
  // precisa do Esc para sair do modal.
  useEffect(() => {
    if (!modal) return undefined;
    const onKeyDown = (ev) => {
      if (ev.key === 'Escape' && !submitting) setModal(null);
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [modal, submitting]);

  const report = useCallback(
    (cb) => {
      if (onStateChange) onStateChange(cb);
    },
    [onStateChange]
  );

  const load = useCallback(async () => {
    try {
      const res = await api.get('/cashboxes/me/current', { _silentError: true });
      setNeedsStage(false);
      setCashbox(res.data || null);
      report(res.data || null);
    } catch (err) {
      if (err?.response?.status === 400) {
        // Nenhuma etapa selecionada
        setNeedsStage(true);
        setCashbox(null);
        report(null);
      } else {
        setCashbox(null);
        report(null);
      }
    }
  }, [report]);

  useEffect(() => {
    // Re-busca ao montar e sempre que a etapa selecionada mudar.
    setCashbox(undefined);
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [load, selectedStage?.id]);

  const openModal = (kind) => {
    setNotes('');
    if (kind === 'open') setInitialBalance('0');
    if (kind === 'close') setActualBalance(String(cashbox?.current_balance ?? 0));
    setModal(kind);
  };

  const submitOpen = async (e) => {
    e.preventDefault();
    setSubmitting(true);
    try {
      await api.post(`/cashboxes/${cashbox.id}/open`, {
        initial_balance: parseFloat(initialBalance) || 0,
        notes: notes || null,
      });
      toast.success(t('cashbox.openedSuccess'));
      setModal(null);
      await load();
    } catch (err) {
      toast.error(err.userMessage || t('cashbox.openError'));
    } finally {
      setSubmitting(false);
    }
  };

  const submitClose = async (e) => {
    e.preventDefault();
    setSubmitting(true);
    try {
      const res = await api.post(`/cashboxes/${cashbox.id}/close`, {
        actual_final_balance: parseFloat(actualBalance) || 0,
        notes: notes || null,
      });
      const diff = res.data?.difference ?? 0;
      if (diff === 0) {
        toast.success(t('cashbox.closedOk'));
      } else if (diff > 0) {
        toast.warning(t('cashbox.closedSurplus', { value: formatCurrency(diff) }));
      } else {
        toast.warning(t('cashbox.closedShortage', { value: formatCurrency(Math.abs(diff)) }));
      }
      setModal(null);
      await load();
    } catch (err) {
      toast.error(err.userMessage || t('cashbox.closeError'));
    } finally {
      setSubmitting(false);
    }
  };

  // Carregando: não renderiza para evitar flicker
  if (cashbox === undefined) return null;

  // Sem etapa selecionada
  if (needsStage) {
    return (
      <div className="cashbox-banner cashbox-banner--muted">
        <span className="cashbox-banner__hint">{t('cashbox.selectStageHint')}</span>
      </div>
    );
  }

  // Super-admin / sem caixa → nada
  if (!cashbox) return null;

  const isOpen = cashbox.status === 'open';
  const isArchived = cashbox.status === 'archived';

  const statusLabel = isOpen
    ? t('cashbox.statusOpen')
    : isArchived
    ? t('cashbox.statusArchived')
    : t('cashbox.statusClosed');

  return (
    <>
      <div
        className={`cashbox-banner ${
          isOpen ? 'cashbox-banner--open' : 'cashbox-banner--closed'
        }`}
      >
        <div className="cashbox-banner__main">
          <span className={`cashbox-banner__pill cashbox-banner__pill--${cashbox.status}`}>
            {statusLabel}
          </span>
          <div className="cashbox-banner__info">
            <span className="cashbox-banner__label">
              {t('cashbox.myCashbox')}
              {cashbox.staff_name ? ` · ${cashbox.staff_name}` : ''}
            </span>
            <span className="cashbox-banner__balance">
              {t('cashbox.balance')}: <strong>{formatCurrency(cashbox.current_balance)}</strong>
            </span>
          </div>
        </div>

        <div className="cashbox-banner__actions">
          {!isOpen && !isArchived && (
            <Button onClick={() => openModal('open')}>{t('cashbox.openCashbox')}</Button>
          )}
          {isOpen && (
            <Button variant="secondary" onClick={() => openModal('close')}>
              {t('cashbox.closeCashbox')}
            </Button>
          )}
        </div>
      </div>

      {!isOpen && !isArchived && (
        <p className="cashbox-banner__blocked-hint">{t('cashbox.blockedHint')}</p>
      )}

      {/* Modal abrir */}
      {modal === 'open' && (
        <div
          className="modal-overlay"
          role="presentation"
          onClick={(e) => { if (e.target === e.currentTarget && !submitting) setModal(null); }}
        >
          <div className="modal" role="dialog" aria-modal="true" aria-label={t('cashbox.openCashbox')}>
            <div className="modal-header">
              <h2>{t('cashbox.openCashbox')}</h2>
              <button type="button" className="close-btn" onClick={() => setModal(null)} aria-label={t('common.close')}>
                <span className="close-icon"></span>
              </button>
            </div>
            <form onSubmit={submitOpen}>
              <div className="form-group">
                <label htmlFor="cb-initial">{t('cashbox.initialBalance')}</label>
                <input
                  id="cb-initial"
                  type="number"
                  step="0.01"
                  min="0"
                  value={initialBalance}
                  onChange={(e) => setInitialBalance(e.target.value)}
                  required
                  autoFocus
                />
              </div>
              <div className="form-group">
                <label htmlFor="cb-notes-open">{t('cashbox.notes')}</label>
                <input
                  id="cb-notes-open"
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
                  {submitting ? t('common.saving', 'Salvando...') : t('cashbox.openCashbox')}
                </Button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Modal fechar */}
      {modal === 'close' && (
        <div
          className="modal-overlay"
          role="presentation"
          onClick={(e) => { if (e.target === e.currentTarget && !submitting) setModal(null); }}
        >
          <div className="modal" role="dialog" aria-modal="true" aria-label={t('cashbox.closeCashbox')}>
            <div className="modal-header">
              <h2>{t('cashbox.closeCashbox')}</h2>
              <button type="button" className="close-btn" onClick={() => setModal(null)} aria-label={t('common.close')}>
                <span className="close-icon"></span>
              </button>
            </div>
            <form onSubmit={submitClose}>
              <div className="cashbox-banner__expected">
                {t('cashbox.expectedBalance')}: <strong>{formatCurrency(cashbox.current_balance)}</strong>
              </div>
              <div className="form-group">
                <label htmlFor="cb-actual">{t('cashbox.countedBalance')}</label>
                <input
                  id="cb-actual"
                  type="number"
                  step="0.01"
                  min="0"
                  value={actualBalance}
                  onChange={(e) => setActualBalance(e.target.value)}
                  required
                  autoFocus
                />
              </div>
              <div className="form-group">
                <label htmlFor="cb-notes-close">{t('cashbox.notes')}</label>
                <input
                  id="cb-notes-close"
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
                  {submitting ? t('common.saving', 'Salvando...') : t('cashbox.closeCashbox')}
                </Button>
              </div>
            </form>
          </div>
        </div>
      )}
    </>
  );
};

export default CashboxBanner;
