import React, { useEffect, useState } from 'react';
import Sidebar from '../components/Sidebar';
import Card from '../components/Card';
import Button from '../components/Button';
import EmptyState from '../components/EmptyState';
import api from '../config/api';
import { useToast } from '../contexts/ToastContext';
import { useCurrency } from '../contexts/CurrencyContext';
import { useTranslation } from 'react-i18next';
import { offlineWrite } from '../offline/apiOffline';
import { applySangria } from '../offline/domainRules';
import { uuid, putEntity } from '../offline/db';
import './CaixaGeral.css';

const CaixaGeral = () => {
  const { t } = useTranslation();
  const { toast } = useToast();
  const { formatCurrency } = useCurrency();
  const [stages, setStages] = useState([]);
  const [selectedStage, setSelectedStage] = useState('');
  const [stageCash, setStageCash] = useState(null);
  const [generalCash, setGeneralCash] = useState(null);
  const [rake, setRake] = useState(null);
  const [sangriaHistory, setSangriaHistory] = useState([]);
  const [showSangriaModal, setShowSangriaModal] = useState(false);
  // Fase 2: o rake da sangria é automático (soma dos rakes por transação ainda
  // não sangrados). pendingRake = rake pendente da etapa.
  const [pendingRake, setPendingRake] = useState(0);
  const [sangriaFormData, setSangriaFormData] = useState({
    amount: '',
    notes: ''
  });

  const loadPendingRake = async (stageId) => {
    try {
      const res = await api.get(`/cash/stage/${stageId}/pending-rake`);
      const pending = parseFloat(res.data?.pending_rake) || 0;
      setPendingRake(pending);
      putEntity('pending_rake', { id: stageId, pending }); // hidrata p/ sangria offline
    } catch (e) {
      setPendingRake(0);
    }
  };

  useEffect(() => {
    loadStages();
    loadGeneralData();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (selectedStage) {
      loadStageCash();
      loadSangriaHistory();
      loadPendingRake(selectedStage);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedStage]);

  const loadStages = async () => {
    try {
      // ISSUE-008 fix: backend doesn't parse comma-separated status values,
      // so the previous `?status=active,upcoming` silently filtered out most
      // stages. Fetch all stages and filter out terminal ones client-side.
      const response = await api.get('/stages');
      const openStages = response.data.filter(
        (s) => s.status !== 'completed' && s.status !== 'cancelled'
      );
      setStages(openStages);
      if (openStages.length > 0 && !selectedStage) {
        setSelectedStage(openStages[0].id);
      }
    } catch (error) {
      console.error('Erro ao carregar etapas:', error);
      if (error.response?.status === 401 || error.response?.status === 403) {
        toast.error(t('generalCash.sessionExpired'));
        window.location.href = '/login';
      }
    }
  };

  const loadStageCash = async () => {
    if (!selectedStage) return;

    try {
      const response = await api.get(`/cash/stage/${selectedStage}`);
      setStageCash(response.data);
      // hidrata o caixa da etapa na réplica (chave = stage_id) p/ sangria offline
      if (response.data) putEntity('stage_cash_register', { ...response.data, id: selectedStage });
    } catch (error) {
      console.error('Erro ao carregar caixa da etapa:', error);
      setStageCash(null);
    }
  };

  const loadGeneralData = async () => {
    try {
      const [generalRes, rakeRes] = await Promise.all([
        api.get('/cash/general'),
        api.get('/cash/rake')
      ]);
      setGeneralCash(generalRes.data);
      setRake(rakeRes.data);
    } catch (error) {
      console.error('Erro ao carregar dados gerais:', error);
      if (error.response?.status === 401 || error.response?.status === 403) {
        toast.error(t('generalCash.sessionExpired'));
        window.location.href = '/login';
      }
    }
  };

  const loadSangriaHistory = async () => {
    if (!selectedStage) return;

    try {
      const response = await api.get(`/cash/sangria/history?stage_id=${selectedStage}&limit=10`);
      setSangriaHistory(response.data);
    } catch (error) {
      console.error('Erro ao carregar histórico:', error);
    }
  };

  const handleSangriaSubmit = async (e) => {
    e.preventDefault();

    if (!stageCash || !selectedStage) {
      toast.warning(t('generalCash.selectStageFirst'));
      return;
    }

    const amount = parseFloat(sangriaFormData.amount);
    if (amount <= 0) {
      toast.warning(t('generalCash.amountGreaterThanZero'));
      return;
    }

    if (amount > parseFloat(stageCash.current_balance)) {
      toast.warning(t('generalCash.insufficientBalance', { value: formatCurrency(stageCash.current_balance) }));
      return;
    }

    try {
      const stage = stages.find(s => s.id === selectedStage);
      const sangriaData = {
        stage_id: selectedStage,
        stage_name: stage.name,
        amount: amount,
        // Rake é calculado no backend a partir dos rakes por transação; enviamos
        // o % efetivo apenas por compatibilidade do payload (o backend ignora).
        rake_percentage: calculateNetAmount().effectivePct,
        notes: sangriaFormData.notes || null
      };

      const cmid = uuid();
      const body = { ...sangriaData, client_mutation_id: cmid };
      const response = await offlineWrite({
        kind: 'sangria', method: 'post', url: '/cash/sangria', body,
        clientMutationId: cmid, meta: { kind: 'sangria', stage: stage.name, amount },
        synthetic: { message: t('offline.savedOffline', 'Salvo offline — será enviado ao sincronizar') },
        applyLocal: () => applySangria(body),
      });

      toast.success(response.data.message);

      // Reset form and close modal
      setSangriaFormData({
        amount: '',
        notes: ''
      });
      setShowSangriaModal(false);

      // Reload all data
      loadStageCash();
      loadGeneralData();
      loadSangriaHistory();
      loadPendingRake(selectedStage);

    } catch (error) {
      console.error('Erro ao realizar sangria:', error);
      const errorMsg = error.response?.data?.detail || t('generalCash.sangriaError');
      toast.error(typeof errorMsg === 'string' ? errorMsg : t('generalCash.sangriaError'));
    }
  };

  const formatDate = (dateString) => {
    return new Date(dateString).toLocaleString('pt-BR', {
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    });
  };

  // Rake automático: proporcional ao rake pendente da etapa (Fase 2).
  const calculateNetAmount = () => {
    const amount = parseFloat(sangriaFormData.amount) || 0;
    const balance = parseFloat(stageCash?.current_balance) || 0;
    let rakeAmount = balance > 0 ? (pendingRake * amount) / balance : 0;
    if (rakeAmount > amount) rakeAmount = amount;
    const netAmount = amount - rakeAmount;
    const effectivePct = amount > 0 ? (rakeAmount / amount) * 100 : 0;
    return { rakeAmount, netAmount, effectivePct };
  };

  return (
    <div className="app-container">
      <Sidebar />
      <main className="main-content">
        <div className="page-header">
          <div>
            <h1>{t('generalCash.pageTitle')}</h1>
            <p className="subtitle">{t('generalCash.pageSubtitle')}</p>
          </div>
        </div>

        {/* Stage Selector */}
        <Card className="stage-selector-card">
          <div className="stage-selector">
            <label htmlFor="stage-select">{t('generalCash.selectStageLabel')}</label>
            <select
              id="stage-select"
              value={selectedStage}
              onChange={(e) => setSelectedStage(e.target.value)}
              className="stage-select-input"
            >
              <option value="">{t('generalCash.selectStageOption')}</option>
              {stages.map(stage => (
                <option key={stage.id} value={stage.id}>
                  {stage.name} - {stage.location}
                </option>
              ))}
            </select>
          </div>
        </Card>

        {/* Cash Overview */}
        <div className="stats-grid">
          {/* Stage Cash (Caixa do Dia) */}
          <Card className="stat-card stage-cash-card">
            {stageCash ? (
              <>
                <div className="stat-header">
                  <h3>{t('generalCash.dailyCash')}</h3>
                </div>
                <div className="stat-amount">{formatCurrency(stageCash.current_balance)}</div>
                <Button
                  onClick={() => setShowSangriaModal(true)}
                  disabled={parseFloat(stageCash.current_balance) <= 0}
                  className="sangria-button"
                >
                  {t('generalCash.performSangria')}
                </Button>
              </>
            ) : (
              <>
                <div className="stat-header">
                  <h3>{t('generalCash.dailyCash')}</h3>
                </div>
                <div className="empty-state-simple">
                  <p>{t('generalCash.selectStageEmpty')}</p>
                </div>
              </>
            )}
          </Card>

          {/* General Cash (Caixa Geral) */}
          <Card className="stat-card general-cash-card">
            <div className="stat-header">
              <h3>{t('generalCash.generalCashTitle')}</h3>
            </div>
            {generalCash ? (
              <div className="stat-amount">{formatCurrency(generalCash.current_balance)}</div>
            ) : (
              <div className="loading">{t('common.loading')}</div>
            )}
          </Card>

          {/* Rake */}
          <Card className="stat-card rake-card">
            <div className="stat-header">
              <h3>{t('generalCash.accumulatedRake')}</h3>
            </div>
            {rake ? (
              <div className="stat-amount rake-amount">{formatCurrency(rake.total_rake)}</div>
            ) : (
              <div className="loading">{t('common.loading')}</div>
            )}
          </Card>
        </div>

        {/* Sangria History */}
        {selectedStage && (
          <Card title={t('generalCash.sangriaHistory')}>
            {sangriaHistory.length === 0 ? (
              <EmptyState
                icon={null}
                title={t('generalCash.noSangria')}
                subtitle={t('generalCash.noSangriaHint')}
              />
            ) : (
              <div className="table-container">
                <table className="sangria-table">
                  <thead>
                    <tr>
                      <th>{t('generalCash.colDateTime')}</th>
                      <th>{t('generalCash.colGrossAmount')}</th>
                      <th>{t('generalCash.colRakePercent')}</th>
                      <th>{t('generalCash.colRakeAmount')}</th>
                      <th>{t('generalCash.colNetAmount')}</th>
                      <th>{t('generalCash.colNotes')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {sangriaHistory.map((sangria) => (
                      <tr key={sangria.id}>
                        <td>{formatDate(sangria.created_at)}</td>
                        <td className="amount">{formatCurrency(sangria.amount)}</td>
                        <td>{parseFloat(sangria.rake_percentage).toFixed(2)}%</td>
                        <td className="amount rake-amount">{formatCurrency(sangria.rake_amount)}</td>
                        <td className="amount net-amount">{formatCurrency(sangria.net_amount)}</td>
                        <td>{sangria.notes || '-'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>
        )}

        {/* Sangria Modal */}
        {showSangriaModal && stageCash && (
          <div className="modal-overlay" onClick={() => setShowSangriaModal(false)}>
            <div className="modal sangria-modal" onClick={(e) => e.stopPropagation()}>
              <div className="modal-header">
                <h2>{t('generalCash.performSangria')}</h2>
                <button className="close-btn" onClick={() => setShowSangriaModal(false)} aria-label={t('common.close')}>
                  <span className="close-icon"></span>
                </button>
              </div>
              <form onSubmit={handleSangriaSubmit}>
                <div className="sangria-info">
                  <div className="info-item">
                    <span>{t('generalCash.stageLabel')}</span>
                    <strong>{stages.find(s => s.id === selectedStage)?.name}</strong>
                  </div>
                  <div className="info-item">
                    <span>{t('generalCash.availableBalanceLabel')}</span>
                    <strong>{formatCurrency(stageCash.current_balance)}</strong>
                  </div>
                </div>

                <div className="form-group">
                  <label htmlFor="amount">{t('generalCash.sangriaAmountLabel')}</label>
                  <input
                    id="amount"
                    name="amount"
                    type="number"
                    step="0.01"
                    max={stageCash.current_balance}
                    value={sangriaFormData.amount}
                    onChange={(e) => setSangriaFormData({...sangriaFormData, amount: e.target.value})}
                    required
                    placeholder="0.00"
                  />
                </div>

                <div className="form-group">
                  <label>{t('generalCash.rakeAutoLabel', 'Rake (automático)')}</label>
                  <div className="sangria-rake-auto">
                    {formatCurrency(calculateNetAmount().rakeAmount)}
                    {sangriaFormData.amount ? ` (${calculateNetAmount().effectivePct.toFixed(2)}%)` : ''}
                  </div>
                  <small>{t('generalCash.rakeAutoHint', 'Calculado a partir do rake dos tipos de buy das entradas desta etapa.')}</small>
                </div>

                <div className="form-group">
                  <label htmlFor="notes">{t('generalCash.notesOptionalLabel')}</label>
                  <textarea
                    id="notes"
                    name="notes"
                    rows="3"
                    value={sangriaFormData.notes}
                    onChange={(e) => setSangriaFormData({...sangriaFormData, notes: e.target.value})}
                    placeholder={t('generalCash.notesPlaceholder')}
                  />
                </div>

                {sangriaFormData.amount && (
                  <div className="sangria-calculation">
                    <h4>{t('generalCash.sangriaCalculation')}</h4>
                    <div className="calculation-item">
                      <span>{t('generalCash.grossAmountLabel')}</span>
                      <strong>{formatCurrency(sangriaFormData.amount)}</strong>
                    </div>
                    <div className="calculation-item rake">
                      <span>{t('generalCash.rakeWithPercent', { percent: calculateNetAmount().effectivePct.toFixed(2) })}</span>
                      <strong className="rake-amount">- {formatCurrency(calculateNetAmount().rakeAmount)}</strong>
                    </div>
                    <div className="calculation-item total">
                      <span>{t('generalCash.toGeneralCash')}</span>
                      <strong className="net-amount">{formatCurrency(calculateNetAmount().netAmount)}</strong>
                    </div>
                  </div>
                )}

                <div className="modal-actions">
                  <Button type="button" variant="secondary" onClick={() => setShowSangriaModal(false)}>
                    {t('common.cancel')}
                  </Button>
                  <Button type="submit">{t('generalCash.confirmSangria')}</Button>
                </div>
              </form>
            </div>
          </div>
        )}
      </main>
    </div>
  );
};

export default CaixaGeral;
