import React, { useEffect, useState } from 'react';
import Sidebar from '../components/Sidebar';
import Card from '../components/Card';
import Button from '../components/Button';
import api from '../config/api';
import { useToast } from '../contexts/ToastContext';
import './CaixaGeral.css';

const CaixaGeral = () => {
  const { toast } = useToast();
  const [stages, setStages] = useState([]);
  const [selectedStage, setSelectedStage] = useState('');
  const [stageCash, setStageCash] = useState(null);
  const [generalCash, setGeneralCash] = useState(null);
  const [rake, setRake] = useState(null);
  const [sangriaHistory, setSangriaHistory] = useState([]);
  const [showSangriaModal, setShowSangriaModal] = useState(false);
  const [sangriaFormData, setSangriaFormData] = useState({
    amount: '',
    rake_percentage: '20.00',
    notes: ''
  });

  useEffect(() => {
    loadStages();
    loadGeneralData();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (selectedStage) {
      loadStageCash();
      loadSangriaHistory();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedStage]);

  const loadStages = async () => {
    try {
      const response = await api.get('/stages?status=active,upcoming');
      setStages(response.data);
      if (response.data.length > 0 && !selectedStage) {
        setSelectedStage(response.data[0].id);
      }
    } catch (error) {
      console.error('Erro ao carregar etapas:', error);
      if (error.response?.status === 401 || error.response?.status === 403) {
        toast.error('Sessao expirada. Por favor, faca login novamente.');
        window.location.href = '/login';
      }
    }
  };

  const loadStageCash = async () => {
    if (!selectedStage) return;

    try {
      const response = await api.get(`/cash/stage/${selectedStage}`);
      setStageCash(response.data);
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
        toast.error('Sessao expirada. Por favor, faca login novamente.');
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
      toast.warning('Selecione uma etapa primeiro');
      return;
    }

    const amount = parseFloat(sangriaFormData.amount);
    if (amount <= 0) {
      toast.warning('Valor deve ser maior que zero');
      return;
    }

    if (amount > parseFloat(stageCash.current_balance)) {
      toast.warning(`Saldo insuficiente! Disponivel: R$ ${parseFloat(stageCash.current_balance).toFixed(2)}`);
      return;
    }

    try {
      const stage = stages.find(s => s.id === selectedStage);
      const sangriaData = {
        stage_id: selectedStage,
        stage_name: stage.name,
        amount: amount,
        rake_percentage: parseFloat(sangriaFormData.rake_percentage),
        notes: sangriaFormData.notes || null
      };

      const response = await api.post('/cash/sangria', sangriaData);

      toast.success(response.data.message);

      // Reset form and close modal
      setSangriaFormData({
        amount: '',
        rake_percentage: '20.00',
        notes: ''
      });
      setShowSangriaModal(false);

      // Reload all data
      loadStageCash();
      loadGeneralData();
      loadSangriaHistory();

    } catch (error) {
      console.error('Erro ao realizar sangria:', error);
      const errorMsg = error.response?.data?.detail || 'Erro ao realizar sangria';
      toast.error(typeof errorMsg === 'string' ? errorMsg : 'Erro ao realizar sangria');
    }
  };

  const formatCurrency = (value) => {
    return `R$ ${parseFloat(value || 0).toFixed(2)}`;
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

  const calculateNetAmount = () => {
    const amount = parseFloat(sangriaFormData.amount) || 0;
    const rakePercentage = parseFloat(sangriaFormData.rake_percentage) || 0;
    const rakeAmount = (amount * rakePercentage) / 100;
    const netAmount = amount - rakeAmount;
    return { rakeAmount, netAmount };
  };

  return (
    <div className="app-container">
      <Sidebar />
      <main className="main-content">
        <div className="page-header">
          <div>
            <h1>Caixa Geral e Sangria</h1>
            <p className="subtitle">Gestão de caixa por etapa com rake</p>
          </div>
        </div>

        {/* Stage Selector */}
        <Card className="stage-selector-card">
          <div className="stage-selector">
            <label htmlFor="stage-select">Selecione a Etapa:</label>
            <select
              id="stage-select"
              value={selectedStage}
              onChange={(e) => setSelectedStage(e.target.value)}
              className="stage-select-input"
            >
              <option value="">Selecione uma etapa</option>
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
                  <h3>Caixa do Dia</h3>
                </div>
                <div className="stat-amount">{formatCurrency(stageCash.current_balance)}</div>
                <Button
                  onClick={() => setShowSangriaModal(true)}
                  disabled={parseFloat(stageCash.current_balance) <= 0}
                  className="sangria-button"
                >
                  Realizar Sangria
                </Button>
              </>
            ) : (
              <>
                <div className="stat-header">
                  <h3>Caixa do Dia</h3>
                </div>
                <div className="empty-state-simple">
                  <p>Selecione uma etapa</p>
                </div>
              </>
            )}
          </Card>

          {/* General Cash (Caixa Geral) */}
          <Card className="stat-card general-cash-card">
            <div className="stat-header">
              <h3>Caixa Geral</h3>
            </div>
            {generalCash ? (
              <div className="stat-amount">{formatCurrency(generalCash.current_balance)}</div>
            ) : (
              <div className="loading">Carregando...</div>
            )}
          </Card>

          {/* Rake */}
          <Card className="stat-card rake-card">
            <div className="stat-header">
              <h3>Rake Acumulado</h3>
            </div>
            {rake ? (
              <div className="stat-amount rake-amount">{formatCurrency(rake.total_rake)}</div>
            ) : (
              <div className="loading">Carregando...</div>
            )}
          </Card>
        </div>

        {/* Sangria History */}
        {selectedStage && (
          <Card title="Histórico de Sangrias">
            {sangriaHistory.length === 0 ? (
              <div className="empty-state">
                <p>Nenhuma sangria realizada nesta etapa</p>
              </div>
            ) : (
              <div className="table-container">
                <table className="sangria-table">
                  <thead>
                    <tr>
                      <th>Data/Hora</th>
                      <th>Valor Bruto</th>
                      <th>Rake (%)</th>
                      <th>Rake (Valor)</th>
                      <th>Valor Líquido</th>
                      <th>Observações</th>
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
                <h2>Realizar Sangria</h2>
                <button className="close-btn" onClick={() => setShowSangriaModal(false)} aria-label="Fechar">
                  <span className="close-icon"></span>
                </button>
              </div>
              <form onSubmit={handleSangriaSubmit}>
                <div className="sangria-info">
                  <div className="info-item">
                    <span>Etapa:</span>
                    <strong>{stages.find(s => s.id === selectedStage)?.name}</strong>
                  </div>
                  <div className="info-item">
                    <span>Saldo Disponível:</span>
                    <strong>{formatCurrency(stageCash.current_balance)}</strong>
                  </div>
                </div>

                <div className="form-group">
                  <label htmlFor="amount">Valor da Sangria (R$)</label>
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
                  <label htmlFor="rake_percentage">Percentual de Rake (%)</label>
                  <input
                    id="rake_percentage"
                    name="rake_percentage"
                    type="number"
                    step="0.01"
                    min="0"
                    max="100"
                    value={sangriaFormData.rake_percentage}
                    onChange={(e) => setSangriaFormData({...sangriaFormData, rake_percentage: e.target.value})}
                    required
                  />
                </div>

                <div className="form-group">
                  <label htmlFor="notes">Observações (opcional)</label>
                  <textarea
                    id="notes"
                    name="notes"
                    rows="3"
                    value={sangriaFormData.notes}
                    onChange={(e) => setSangriaFormData({...sangriaFormData, notes: e.target.value})}
                    placeholder="Adicione observações sobre esta sangria"
                  />
                </div>

                {sangriaFormData.amount && (
                  <div className="sangria-calculation">
                    <h4>Cálculo da Sangria</h4>
                    <div className="calculation-item">
                      <span>Valor Bruto:</span>
                      <strong>{formatCurrency(sangriaFormData.amount)}</strong>
                    </div>
                    <div className="calculation-item rake">
                      <span>Rake ({sangriaFormData.rake_percentage}%):</span>
                      <strong className="rake-amount">- {formatCurrency(calculateNetAmount().rakeAmount)}</strong>
                    </div>
                    <div className="calculation-item total">
                      <span>Para Caixa Geral:</span>
                      <strong className="net-amount">{formatCurrency(calculateNetAmount().netAmount)}</strong>
                    </div>
                  </div>
                )}

                <div className="modal-actions">
                  <Button type="button" variant="secondary" onClick={() => setShowSangriaModal(false)}>
                    Cancelar
                  </Button>
                  <Button type="submit">Confirmar Sangria</Button>
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
