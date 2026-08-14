import React, { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import Sidebar from '../components/Sidebar';
import Card from '../components/Card';
import Button from '../components/Button';
import EmptyState from '../components/EmptyState';
import api from '../config/api';
import { useToast } from '../contexts/ToastContext';
import { useCurrency } from '../contexts/CurrencyContext';
import { useStage } from '../contexts/StageContext';
import { usePaymentMethods } from '../contexts/PaymentMethodsContext';
import { methodLabel } from '../utils/paymentMethodLabels';
import { useTranslation } from 'react-i18next';
import { offlineWrite } from '../offline/apiOffline';
import { applySangria } from '../offline/domainRules';
import { uuid, putEntity } from '../offline/db';
import './CaixaGeral.css';

const CaixaGeral = () => {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { toast } = useToast();
  const { formatCurrency } = useCurrency();
  // A etapa é a do app (barra/sidebar), não um seletor só desta tela: dois
  // seletores concorrentes faziam o operador sangrar a etapa errada — a tela
  // mostrava uma e o header X-Stage-ID mandava outra.
  const { selectedStage } = useStage();
  const { methods: paymentMethods } = usePaymentMethods();
  const stageId = selectedStage?.id || '';

  const [stageCash, setStageCash] = useState(null);
  const [stageSummary, setStageSummary] = useState(null);
  const [paymentBreakdown, setPaymentBreakdown] = useState(null);
  const [generalCash, setGeneralCash] = useState(null);
  const [rake, setRake] = useState(null);
  const [sangriaHistory, setSangriaHistory] = useState([]);
  const [showSangriaModal, setShowSangriaModal] = useState(false);

  // Acessibilidade: o fundo escuro fecha no clique, mas quem usa só o teclado
  // precisa do Esc para sair do modal.
  useEffect(() => {
    if (!showSangriaModal) return undefined;
    const onKeyDown = (ev) => {
      if (ev.key === 'Escape') setShowSangriaModal(false);
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [showSangriaModal]);

  // Fase 2: o rake da sangria é automático (soma dos rakes por transação ainda
  // não sangrados). pendingRake = rake pendente da etapa.
  const [pendingRake, setPendingRake] = useState(0);
  const [sangriaFormData, setSangriaFormData] = useState({
    amount: '',
    notes: ''
  });

  const loadPendingRake = async (id) => {
    try {
      const res = await api.get(`/cash/stage/${id}/pending-rake`);
      const pending = parseFloat(res.data?.pending_rake) || 0;
      setPendingRake(pending);
      putEntity('pending_rake', { id, pending }); // hidrata p/ sangria offline
    } catch (e) {
      setPendingRake(0);
    }
  };

  const loadStageCash = useCallback(async (id) => {
    try {
      const response = await api.get(`/cash/stage/${id}`);
      setStageCash(response.data);
      // hidrata o caixa da etapa na réplica (chave = stage_id) p/ sangria offline
      if (response.data) putEntity('stage_cash_register', { ...response.data, id });
    } catch (error) {
      console.error('Erro ao carregar caixa da etapa:', error);
      setStageCash(null);
    }
  }, []);

  // Resumo da etapa: quanto ELA mandou pro caixa geral e o rake que gerou.
  // Falhar aqui não pode apagar os outros cartões da tela.
  const loadStageSummary = useCallback(async (id) => {
    try {
      const response = await api.get(`/cash/stage/${id}/summary`);
      setStageSummary(response.data);
    } catch (error) {
      console.error(`[CaixaGeral] falha ao carregar o resumo da etapa ${id}:`, error);
      setStageSummary(null);
    }
  }, []);

  // Composição das entradas por forma de pagamento: é o que diz quanto do
  // caixa deve estar em espécie na gaveta antes de decidir o valor da sangria.
  const loadPaymentBreakdown = useCallback(async (id) => {
    try {
      const response = await api.get(`/cash/stage/${id}/payment-methods`);
      setPaymentBreakdown(response.data);
    } catch (error) {
      console.error(`[CaixaGeral] falha ao carregar a composição por forma de pagamento da etapa ${id}:`, error);
      setPaymentBreakdown(null);
    }
  }, []);

  const loadSangriaHistory = useCallback(async (id) => {
    try {
      const response = await api.get(`/cash/sangria/history?stage_id=${id}&limit=10`);
      setSangriaHistory(response.data);
    } catch (error) {
      console.error('Erro ao carregar histórico:', error);
    }
  }, []);

  const loadGeneralData = useCallback(async () => {
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    loadGeneralData();
  }, [loadGeneralData]);

  useEffect(() => {
    if (!stageId) {
      setStageCash(null);
      setStageSummary(null);
      setPaymentBreakdown(null);
      setSangriaHistory([]);
      setPendingRake(0);
      return;
    }
    loadStageCash(stageId);
    loadStageSummary(stageId);
    loadPaymentBreakdown(stageId);
    loadSangriaHistory(stageId);
    loadPendingRake(stageId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stageId, loadStageCash, loadStageSummary, loadPaymentBreakdown, loadSangriaHistory]);

  const handleSangriaSubmit = async (e) => {
    e.preventDefault();

    if (!stageCash || !stageId) {
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
      const sangriaData = {
        stage_id: stageId,
        stage_name: selectedStage.name,
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
        clientMutationId: cmid, meta: { kind: 'sangria', stage: selectedStage.name, amount },
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
      loadStageCash(stageId);
      loadStageSummary(stageId);
      loadPaymentBreakdown(stageId);
      loadGeneralData();
      loadSangriaHistory(stageId);
      loadPendingRake(stageId);

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

  // Método sem cadastro (desativado/apagado) cai no próprio code: melhor um
  // código cru do que uma linha sem nome no fechamento.
  const rotuloMetodo = (code) => {
    if (!code) return t('generalCash.paymentUnknown', 'Não informado');
    const cadastrado = (paymentMethods || []).find((m) => m.code === code);
    return methodLabel(t, cadastrado || { code });
  };

  const metodos = paymentBreakdown?.methods || [];

  // Sem etapa (ou sem resumo) o número da etapa não existe. Mostrar zero seria
  // mentira: diria que esta etapa não mandou nada ao caixa geral.
  const valorDaEtapa = (campo) =>
    stageId && stageSummary ? formatCurrency(stageSummary[campo]) : '--';

  const listaDeMetodos = (
    <div className="payment-breakdown">
      {metodos.map((m) => (
        <div className="payment-breakdown-item" key={m.code || '__sem_metodo'}>
          <span>{rotuloMetodo(m.code)}</span>
          <strong>{formatCurrency(m.total)}</strong>
        </div>
      ))}
      <div className="payment-breakdown-item total">
        <span>{t('generalCash.paymentMethodTotal', 'Total das entradas')}</span>
        <strong>{formatCurrency(paymentBreakdown?.total)}</strong>
      </div>
    </div>
  );

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

        {!stageId && (
          <EmptyState
            icon={null}
            title={t('generalCash.noStageSelected', 'Nenhuma etapa selecionada')}
            subtitle={t('generalCash.noStageSelectedHint', 'O caixa é conferido etapa por etapa. Escolha a etapa em Etapas para ver o caixa do dia e sangrar.')}
            ctaLabel={t('generalCash.goToStages', 'Ir para Etapas')}
            // Navegação do Router, não window.location: recarregar a SPA inteira
            // derruba a etapa selecionada e o cache já carregado, e no tablet do
            // caixa isso é uma tela branca de vários segundos no meio do evento.
            onCta={() => navigate('/etapas')}
          />
        )}

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

          {/* Caixa Geral — o que ESTA etapa mandou, com o total do clube ao lado.
              Não dá para decompor o saldo do caixa geral por etapa: despesas,
              outras receitas e pagamentos de funcionários entram nele sem
              guardar de que etapa vieram. Por isso os dois rótulos são
              explícitos — sem eles o cliente acha que os números não fecham. */}
          <Card className="stat-card general-cash-card">
            <div className="stat-header">
              <h3>{t('generalCash.sentToGeneralStage', 'Enviado ao caixa geral (esta etapa)')}</h3>
            </div>
            <div className="stat-amount">{valorDaEtapa('net_to_general')}</div>
            <div className="stat-details">
              <div className="stat-detail-item">
                <span>{t('generalCash.generalCashClubTotal', 'Caixa geral do clube (total)')}</span>
                <span>{generalCash ? formatCurrency(generalCash.current_balance) : t('common.loading')}</span>
              </div>
              <div className="stat-detail-item">
                <span>{t('generalCash.stageSangriaCount', 'Sangrias desta etapa')}</span>
                <span>{stageId && stageSummary ? stageSummary.sangria_count : '--'}</span>
              </div>
            </div>
          </Card>

          {/* Rake */}
          <Card className="stat-card rake-card">
            <div className="stat-header">
              <h3>{t('generalCash.rakeStage', 'Rake extraído (esta etapa)')}</h3>
            </div>
            <div className="stat-amount rake-amount">{valorDaEtapa('rake_extracted')}</div>
            <div className="stat-details">
              <div className="stat-detail-item">
                <span>{t('generalCash.rakeGeneratedStage', 'Rake gerado nas entradas')}</span>
                <span>{valorDaEtapa('rake_generated')}</span>
              </div>
              <div className="stat-detail-item">
                <span>{t('generalCash.accumulatedRakeClub', 'Rake acumulado do clube')}</span>
                <span>{rake ? formatCurrency(rake.total_rake) : t('common.loading')}</span>
              </div>
            </div>
          </Card>
        </div>

        {/* Entradas por método de pagamento — o cliente confere o caixa sem
            precisar abrir a sangria. */}
        {stageId && (
          <Card title={t('generalCash.byPaymentMethod', 'Entradas por forma de pagamento')}>
            {metodos.length === 0 ? (
              <EmptyState
                icon={null}
                title={t('generalCash.noPaymentBreakdown', 'Nenhuma entrada registrada nesta etapa')}
                subtitle={t('generalCash.noPaymentBreakdownHint', 'Assim que houver buy-in, rebuy ou add-on, a composição aparece aqui.')}
              />
            ) : (
              <>
                {listaDeMetodos}
                <p className="payment-breakdown-note">
                  {t('generalCash.paymentBreakdownNote', 'São as ENTRADAS da etapa (bruto). O saldo do caixa já teve as sangrias descontadas, então os dois valores não coincidem depois da primeira sangria.')}
                </p>
              </>
            )}
          </Card>
        )}

        {/* Sangria History */}
        {stageId && (
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
          <div
            className="modal-overlay"
            role="presentation"
            onClick={(e) => { if (e.target === e.currentTarget) setShowSangriaModal(false); }}
          >
            <div className="modal sangria-modal" role="dialog" aria-modal="true">
              <div className="modal-header">
                <h2>{t('generalCash.performSangria')}</h2>
                <button type="button" className="close-btn" onClick={() => setShowSangriaModal(false)} aria-label={t('common.close')}>
                  <span className="close-icon"></span>
                </button>
              </div>
              <form onSubmit={handleSangriaSubmit}>
                <div className="sangria-info">
                  <div className="info-item">
                    <span>{t('generalCash.stageLabel')}</span>
                    <strong>{selectedStage?.name}</strong>
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

                {/* Antes de escolher o valor, o operador precisa saber quanto do
                    caixa é dinheiro na gaveta e quanto entrou por PIX/cartão. */}
                {metodos.length > 0 && (
                  <div className="sangria-payment-breakdown">
                    <h4>{t('generalCash.byPaymentMethod', 'Entradas por forma de pagamento')}</h4>
                    {listaDeMetodos}
                  </div>
                )}

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
