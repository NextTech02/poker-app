import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import Sidebar from '../components/Sidebar';
import Icon from '../components/Icon';
import Button from '../components/Button';
import EmptyState from '../components/EmptyState';
import { SkeletonTableRow } from '../components/SkeletonLoader';
import { useStage } from '../contexts/StageContext';
import api from '../config/api';
import { useToast } from '../contexts/ToastContext';
import { usePermissions } from '../contexts/PermissionContext';
// Util em vez do contexto de moeda: o valor entra numa frase montada no
// clique (o texto da confirmação), não numa parte da tela que precise
// re-renderizar quando a moeda global mudar.
import { formatCurrency } from '../utils/currencyUtils';
import './Etapas.css';

/**
 * Converte "AAAA-MM-DD" (como o banco guarda) numa data do fuso LOCAL.
 *
 * `new Date('2026-08-10')` é lido como meia-noite UTC, o que no Brasil, no
 * Peru e na Colômbia cai às 21h/19h do dia 09. O efeito era visível: a etapa
 * cadastrada para 10/08 aparecia como 09/08 na lista, e no ÚLTIMO dia da
 * etapa o sistema já a marcava como "Concluída".
 */
const parseDataLocal = (texto) => {
  if (!texto) return null;
  const [ano, mes, dia] = String(texto).slice(0, 10).split('-').map(Number);
  if (!ano || !mes || !dia) return null;
  return new Date(ano, mes - 1, dia);
};

const Etapas = () => {
  const { t } = useTranslation();
  const { selectedStage, selectStage } = useStage();
  const { toast, confirm } = useToast();
  const { isAdmin, hasPermission } = usePermissions();
  // Mesma condição do servidor (CashboxService.can_admin): é do operador de
  // caixa que se está tirando a permissão de vender, então não é ele quem
  // destrava.
  const podeBloquear = isAdmin || hasPermission('cashbox.admin');
  const [stages, setStages] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showModal, setShowModal] = useState(false);

  // Acessibilidade: o fundo escuro fecha no clique, mas quem usa só o teclado
  // precisa do Esc para sair do modal.
  useEffect(() => {
    if (!showModal) return undefined;
    const onKeyDown = (ev) => {
      if (ev.key === 'Escape') setShowModal(false);
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [showModal]);

  const [editingStage, setEditingStage] = useState(null);
  // Erro de data mostrado DENTRO do modal, ao lado dos campos. Um toast some
  // sozinho e deixa a pessoa olhando um formulário que não salva.
  const [erroDatas, setErroDatas] = useState('');
  const [formData, setFormData] = useState({
    name: '',
    location: '',
    start_date: '',
    end_date: '',
    description: '',
    status: 'upcoming',
  });

  useEffect(() => {
    loadStages();
  }, []);

  const loadStages = async () => {
    try {
      const response = await api.get('/stages');
      setStages(response.data);
    } catch (error) {
      console.error('Erro ao carregar etapas:', error);
    } finally {
      setLoading(false);
    }
  };

  /**
   * Mesma regra do servidor (backend/app/models/stage.py): início
   * OBRIGATÓRIO, fim OPCIONAL (o circuito pode estar em aberto), fim nunca
   * antes do início. Aqui é só para avisar cedo — quem decide é o backend.
   * Uma etapa que termina antes de começar some do relatório por período e
   * nunca aparece como "em andamento".
   */
  const validarDatas = ({ start_date: inicio, end_date: fim }) => {
    if (!inicio) {
      return t('stages.startDateRequired', 'Informe a data de início da etapa');
    }
    // Datas no formato AAAA-MM-DD comparam certo como texto.
    if (fim && fim < inicio) {
      return t(
        'stages.endBeforeStart',
        'A data final não pode ser anterior à data de início'
      );
    }
    return '';
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    const erroDeData = validarDatas(formData);
    if (erroDeData) {
      setErroDatas(erroDeData);
      return;
    }
    setErroDatas('');
    // ISSUE-001 fix: backend expects null for empty optional date fields,
    // not empty strings — otherwise FastAPI returns 422.
    const payload = {
      ...formData,
      start_date: formData.start_date || null,
      end_date: formData.end_date || null,
      description: formData.description || null,
    };
    try {
      if (editingStage) {
        await api.patch(`/stages/${editingStage.id}`, payload);
        toast.success(t('stages.updatedSuccess'));
      } else {
        await api.post('/stages', payload);
        toast.success(t('stages.createdSuccess'));
      }
      setShowModal(false);
      setEditingStage(null);
      setFormData({
        name: '',
        location: '',
        start_date: '',
        end_date: '',
        description: '',
        status: 'upcoming',
      });
      loadStages();
    } catch (error) {
      const msg =
        error.userMessage ||
        error.response?.data?.detail ||
        t('stages.saveError');
      toast.error(typeof msg === 'string' ? msg : t('stages.saveError'));
    }
  };

  // Liga/desliga a venda em toda a etapa. Explícito (blocked: true/false) e não
  // um toggle no servidor: com dois admins na tela, um toggle acabaria
  // reliberando a venda que o outro acabou de encerrar.
  const handleToggleSalesBlock = async (stage) => {
    const bloquear = !stage.sales_blocked;
    const ok = await confirm(
      bloquear
        ? t('sales.confirmBlockStage', 'Encerrar a venda de entradas em TODOS os dias desta etapa?')
        : t('sales.confirmUnblockStage', 'Liberar novamente a venda de entradas desta etapa?'),
      bloquear ? { variant: 'danger' } : {}
    );
    if (!ok) return;
    try {
      await api.post(`/stages/${stage.id}/sales-block`, { blocked: bloquear, reason: null });
      toast.success(
        bloquear
          ? t('sales.blockedDone', 'Vendas encerradas para esta etapa')
          : t('sales.unblockedDone', 'Vendas liberadas para esta etapa')
      );
      loadStages();
    } catch (error) {
      toast.error(
        error.userMessage || error.response?.data?.detail
        || t('sales.blockError', 'Não foi possível alterar o bloqueio de vendas')
      );
    }
  };

  const handleEdit = (stage) => {
    setEditingStage(stage);
    setErroDatas('');
    setFormData({
      name: stage.name,
      location: stage.location,
      start_date: stage.start_date || '',
      end_date: stage.end_date || '',
      description: stage.description || '',
      status: stage.status,
    });
    setShowModal(true);
  };

  /**
   * Traduz o resumo do servidor em "3 sangrias, 12 despesas, R$ 4.500 em
   * caixa". Só entra na frase o que realmente existe — número zero na lista
   * só faz o operador parar de ler.
   */
  const descreverImpacto = (impacto) => {
    const partes = [];
    const somar = (quantidade, chave, texto) => {
      if (quantidade) partes.push(`${quantidade} ${String(t(chave, texto))}`);
    };
    somar(impacto.sangrias, 'stages.impactSangrias', 'sangrias');
    somar(impacto.expenses, 'stages.impactExpenses', 'despesas');
    somar(impacto.other_revenues, 'stages.impactRevenues', 'outras receitas');
    somar(impacto.staff_payments, 'stages.impactStaffPayments', 'pagamentos de funcionário');
    somar(impacto.chip_consignments, 'stages.impactConsignments', 'consignações de fichas');
    somar(impacto.cashboxes, 'stages.impactCashboxes', 'caixas de funcionário');
    somar(impacto.buy_types, 'stages.impactBuyTypes', 'tipos de buy');
    if (impacto.cash_balance) {
      partes.push(`${formatCurrency(impacto.cash_balance)} ${t('stages.impactInCash', 'em caixa')}`);
    }
    return partes;
  };

  const arquivarEtapa = async (stageId) => {
    try {
      await api.post(`/stages/${stageId}/archive`);
      toast.success(t('stages.archivedSuccess', 'Etapa arquivada'));
      loadStages();
    } catch (error) {
      toast.error(
        error.userMessage || error.response?.data?.detail
        || t('stages.archiveError', 'Não foi possível arquivar a etapa')
      );
    }
  };

  const handleDelete = async (stageId) => {
    // As chaves estrangeiras para `stages` são ON DELETE CASCADE: apagar a
    // etapa apaga junto sangrias, despesas, outras receitas, pagamentos de
    // funcionário, caixas, tipos de buy e consignações de ficha. Por isso
    // perguntamos ao servidor o que seria destruído ANTES de perguntar "tem
    // certeza?" — a confirmação antiga não dizia nada disso.
    let impacto = null;
    try {
      impacto = (await api.get(`/stages/${stageId}/delete-impact`)).data;
    } catch (error) {
      // Backend ainda sem a rota (o deploy não é atômico): segue com o texto
      // genérico de sempre em vez de impedir a operação.
      impacto = null;
    }
    const partes = impacto ? descreverImpacto(impacto) : [];

    if (impacto?.blocked) {
      // Tem dinheiro no meio. Excluir apagaria a contabilidade da etapa sem
      // rastro e sem desfazer; o caminho vira arquivar, que preserva tudo.
      const arquivar = await confirm(
        `${t('stages.deleteBlocked', 'Esta etapa tem movimento financeiro e não pode ser excluída:')}`
        + ` ${partes.join(', ')}. `
        + t('stages.archiveInstead', 'Deseja arquivar a etapa? Ela sai da frente e nada é apagado.'),
        { confirmText: t('stages.archive', 'Arquivar') }
      );
      if (!arquivar) return;
      await arquivarEtapa(stageId);
      return;
    }

    const semEtapa = impacto?.tournaments
      ? ` ${impacto.tournaments} ${t('stages.impactTournaments', 'torneios ficam sem etapa.')}`
      : '';
    const mensagem = partes.length
      ? `${t('stages.confirmDeleteWhat', 'Excluir esta etapa apaga em definitivo:')} ${partes.join(', ')}.`
        + `${semEtapa} ${t('stages.confirmDeleteIrreversible', 'Isso não pode ser desfeito.')}`
      : t('stages.confirmDelete');

    const ok = await confirm(mensagem, { variant: 'danger', confirmText: t('common.delete') });
    if (!ok) return;

    try {
      await api.delete(`/stages/${stageId}`);
      loadStages();
    } catch (error) {
      console.error('Erro ao excluir etapa:', error);
      toast.error(
        error.userMessage || error.response?.data?.detail || t('stages.deleteError')
      );
    }
  };

  const handleChange = (e) => {
    setFormData({
      ...formData,
      [e.target.name]: e.target.value,
    });
  };

  const openNewModal = () => {
    setEditingStage(null);
    setErroDatas('');
    setFormData({
      name: '',
      location: '',
      start_date: '',
      end_date: '',
      description: '',
      status: 'upcoming',
    });
    setShowModal(true);
  };

  // Compute effective status from dates. Stored 'cancelled' / 'completed'
  // are terminal and should not be auto-overridden. For 'upcoming' / 'active',
  // the dates are the source of truth — this fixes stages showing "Próxima"
  // when their end_date is already in the past (ISSUE-002).
  const getEffectiveStatus = (stage) => {
    if (stage.status === 'cancelled' || stage.status === 'completed') {
      return stage.status;
    }
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const start = parseDataLocal(stage.start_date);
    const end = parseDataLocal(stage.end_date);
    if (end && end < today) return 'completed';
    if (start && start <= today && (!end || end >= today)) return 'active';
    return 'upcoming';
  };

  const getStatusBadge = (stage) => {
    const status = getEffectiveStatus(stage);
    const badges = {
      upcoming: { label: t('stages.statusUpcoming', 'Próxima'), className: 'badge-info' },
      active: { label: t('stages.statusActive', 'Em Andamento'), className: 'badge-success' },
      completed: { label: t('stages.statusCompleted', 'Concluída'), className: 'badge-secondary' },
      cancelled: { label: t('stages.statusCancelled', 'Cancelada'), className: 'badge-danger' },
    };
    const badge = badges[status] || badges.upcoming;
    return <span className={`badge ${badge.className}`}>{badge.label}</span>;
  };

  const formatDate = (dateString) => {
    const data = parseDataLocal(dateString);
    if (!data) return '-';
    return data.toLocaleDateString('pt-BR');
  };

  const handleSelectStage = (stage) => {
    selectStage(stage);
  };

  const isStageSelected = (stageId) => {
    return selectedStage?.id === stageId;
  };

  return (
    <div className="app-container">
      <Sidebar />
      <main className="main-content">

        {/* ── Page Header ── */}
        <div className="et-header">
          <div className="et-header-left">
            <div className="et-header-icon">
              <Icon name="calendar" />
            </div>
            <div>
              <h1 className="et-title">{t('stages.title', 'Etapas')}</h1>
              <p className="et-subtitle">{t('stages.subtitle', 'Gerenciar etapas do circuito')}</p>
            </div>
          </div>
          <button type="button" className="et-btn-new" onClick={openNewModal}>
            <svg viewBox="0 0 24 24" fill="currentColor" width="18" height="18">
              <path d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z"/>
            </svg>
            {t('stages.newStage', 'Nova Etapa')}
          </button>
        </div>

        {loading ? (
          /* B1: Skeleton table em vez de texto */
          <div className="stages-table-container">
            <table className="stages-table">
              <thead>
                <tr>
                  <th>{t('stages.columnStatus')}</th><th>{t('stages.columnName')}</th><th>{t('stages.columnLocation')}</th>
                  <th>{t('stages.columnStart')}</th><th>{t('stages.columnEnd')}</th><th>{t('stages.columnTournaments')}</th><th>{t('stages.columnActions')}</th>
                </tr>
              </thead>
              <tbody>
                <SkeletonTableRow cols={7} />
                <SkeletonTableRow cols={7} />
                <SkeletonTableRow cols={7} />
              </tbody>
            </table>
          </div>
        ) : stages.length === 0 ? (
          <EmptyState
            icon={
              <svg viewBox="0 0 24 24" fill="currentColor">
                <path d="M19 3h-1V1h-2v2H8V1H6v2H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm0 16H5V8h14v11zM7 10h5v5H7z"/>
              </svg>
            }
            title={t('stages.noStages', 'Nenhuma etapa encontrada')}
            subtitle={t('stages.noStagesHint')}
            ctaLabel={t('stages.newStage', 'Nova Etapa')}
            onCta={openNewModal}
          />
        ) : (
          <>
            {/* Desktop Table View */}
            <div className="stages-table-container">
              <table className="stages-table">
                <thead>
                  <tr>
                    <th>{t('stages.columnStatus')}</th>
                    <th>{t('stages.columnName')}</th>
                    <th>{t('stages.columnLocation')}</th>
                    <th>{t('stages.columnStart')}</th>
                    <th>{t('stages.columnEnd')}</th>
                    <th>{t('stages.columnTournaments')}</th>
                    <th>{t('stages.columnActions')}</th>
                  </tr>
                </thead>
                <tbody>
                  {stages.map((stage) => (
                    <tr
                      key={stage.id}
                      className={isStageSelected(stage.id) ? 'selected-row' : ''}
                    >
                      <td>
                        <div className="status-badges">
                          {getStatusBadge(stage)}
                        </div>
                      </td>
                      <td>
                        <strong>{stage.name}</strong>
                        {stage.description && (
                          <div className="stage-description-inline">{stage.description}</div>
                        )}
                      </td>
                      <td>{stage.location}</td>
                      <td>{formatDate(stage.start_date)}</td>
                      <td>{formatDate(stage.end_date)}</td>
                      <td className="text-center">{stage.tournament_count || 0}</td>
                      <td>
                        <div className="table-actions">
                          {!isStageSelected(stage.id) ? (
                            <Button
                              variant="primary"
                              size="small"
                              onClick={() => handleSelectStage(stage)}
                            >
                              {t('stages.selectStage').replace('Selecione uma Etapa', 'Selecionar')}
                            </Button>
                          ) : (
                            <Button
                              variant="success"
                              size="small"
                              disabled
                            >
                              {t('common.active')}
                            </Button>
                          )}
                          <Button
                            variant="secondary"
                            size="small"
                            onClick={() => handleEdit(stage)}
                          >
                            {t('common.edit')}
                          </Button>
                          {/* Chave-mestra: encerra a venda em TODOS os dias da
                              etapa de uma vez ("fecha tudo agora"). Só para
                              quem o backend deixa (CashboxService.can_admin em
                              routers/stages.py): mostrar a quem não pode faz o
                              usuário clicar, levar 403 e ficar sem saber se as
                              vendas pararam. */}
                          {podeBloquear && (
                            <Button
                              variant={stage.sales_blocked ? 'success' : 'danger'}
                              size="small"
                              onClick={() => handleToggleSalesBlock(stage)}
                            >
                              {stage.sales_blocked
                                ? t('sales.unblockStage', 'Liberar vendas')
                                : t('sales.blockStage', 'Encerrar vendas')}
                            </Button>
                          )}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {/* Mobile Card View */}
            <div className="stages-cards-mobile">
              {stages.map((stage) => (
                <div
                  key={stage.id}
                  className={`stage-card-mobile ${isStageSelected(stage.id) ? 'selected' : ''}`}
                >
                  <div className="stage-card-header">
                    <h3 className="stage-card-title">{stage.name}</h3>
                    <div className="stage-card-badges">
                      {getStatusBadge(stage)}
                    </div>
                  </div>

                  {stage.description && (
                    <p className="stage-card-description">{stage.description}</p>
                  )}

                  <div className="stage-card-info">
                    <div className="stage-card-info-item">
                      <span className="stage-card-info-label">{t('stages.columnLocation')}</span>
                      <span className="stage-card-info-value">{stage.location}</span>
                    </div>
                    <div className="stage-card-info-item">
                      <span className="stage-card-info-label">{t('stages.columnTournaments')}</span>
                      <span className="stage-card-info-value">{stage.tournament_count || 0}</span>
                    </div>
                    <div className="stage-card-info-item">
                      <span className="stage-card-info-label">{t('stages.periodStart')}</span>
                      <span className="stage-card-info-value">{formatDate(stage.start_date)}</span>
                    </div>
                    <div className="stage-card-info-item">
                      <span className="stage-card-info-label">{t('stages.periodEnd')}</span>
                      <span className="stage-card-info-value">{formatDate(stage.end_date)}</span>
                    </div>
                  </div>

                  <div className="stage-card-actions">
                    {!isStageSelected(stage.id) ? (
                      <Button
                        variant="primary"
                        size="small"
                        onClick={() => handleSelectStage(stage)}
                      >
                        {t('stages.selectButton')}
                      </Button>
                    ) : (
                      <Button
                        variant="success"
                        size="small"
                        disabled
                      >
                        {t('stages.statusActiveShort')}
                      </Button>
                    )}
                    <Button
                      variant="secondary"
                      size="small"
                      onClick={() => handleEdit(stage)}
                    >
                      {t('common.edit')}
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          </>
        )}

        {showModal && (
          <div
            className="modal-overlay"
            role="presentation"
            onClick={(e) => { if (e.target === e.currentTarget) setShowModal(false); }}
          >
            <div className="modal" role="dialog" aria-modal="true">
              <div className="modal-header">
                <h2>{editingStage ? t('common.edit') + ' ' + t('stages.title').slice(0, -1) : t('stages.newStage')}</h2>
                <button type="button" className="close-btn" onClick={() => setShowModal(false)} aria-label={t('common.close')}>
                  <span className="close-icon"></span>
                </button>
              </div>
              <form onSubmit={handleSubmit}>
                <div className="form-group">
                  <label htmlFor="name">{t('stages.stageName')} *</label>
                  <input
                    id="name"
                    name="name"
                    type="text"
                    value={formData.name}
                    onChange={handleChange}
                    required
                    placeholder={t('stages.namePlaceholder')}
                  />
                </div>

                <div className="form-group">
                  <label htmlFor="location">{t('stages.location')} *</label>
                  <input
                    id="location"
                    name="location"
                    type="text"
                    value={formData.location}
                    onChange={handleChange}
                    required
                    placeholder={t('stages.locationPlaceholder')}
                  />
                </div>

                {/* Etapa antiga, gravada antes da data virar obrigatória: em
                    vez de travar a tela, pedimos a data aqui, que é onde ela
                    pode ser informada. */}
                {editingStage && !editingStage.start_date && (
                  <output className="et-aviso-data">
                    {t(
                      'stages.legacyNoStartDate',
                      'Esta etapa foi criada sem data de início. Informe a data para poder salvar.'
                    )}
                  </output>
                )}

                <div className="form-row">
                  <div className="form-group">
                    <label htmlFor="start_date">{t('stages.startDate')} *</label>
                    <input
                      id="start_date"
                      name="start_date"
                      type="date"
                      value={formData.start_date}
                      onChange={handleChange}
                      required
                      aria-invalid={erroDatas ? 'true' : undefined}
                    />
                  </div>

                  <div className="form-group">
                    <label htmlFor="end_date">{t('stages.endDate')}</label>
                    <input
                      id="end_date"
                      name="end_date"
                      type="date"
                      value={formData.end_date}
                      onChange={handleChange}
                      /* O navegador já barra o fim antes do início; a
                         validação no submit é a que vale (data digitada). */
                      min={formData.start_date || undefined}
                      aria-invalid={erroDatas ? 'true' : undefined}
                    />
                  </div>
                </div>

                {erroDatas && (
                  <div className="et-erro-data" role="alert">{erroDatas}</div>
                )}

                <div className="form-group">
                  <label htmlFor="status">{t('common.status')}</label>
                  <select
                    id="status"
                    name="status"
                    value={formData.status}
                    onChange={handleChange}
                    required
                  >
                    <option value="upcoming">{t('stages.statusUpcoming')}</option>
                    <option value="active">{t('stages.statusActive')}</option>
                    <option value="completed">{t('stages.statusCompleted')}</option>
                    <option value="cancelled">{t('stages.statusCancelled')}</option>
                  </select>
                </div>

                <div className="form-group">
                  <label htmlFor="description">{t('stages.descriptionLabel')}</label>
                  <textarea
                    id="description"
                    name="description"
                    value={formData.description}
                    onChange={handleChange}
                    rows="3"
                    placeholder={t('stages.descriptionPlaceholder')}
                  />
                </div>

                <div className="modal-actions">
                  <div className="modal-actions-left">
                    {editingStage && (
                      <Button
                        type="button"
                        variant="danger"
                        onClick={() => {
                          setShowModal(false);
                          handleDelete(editingStage.id);
                        }}
                      >
                        {t('common.delete')}
                      </Button>
                    )}
                  </div>
                  <div className="modal-actions-right">
                    <Button type="button" variant="secondary" onClick={() => setShowModal(false)}>
                      {t('common.cancel')}
                    </Button>
                    <Button type="submit">
                      {editingStage ? t('common.save') : t('common.add')}
                    </Button>
                  </div>
                </div>
              </form>
            </div>
          </div>
        )}
      </main>
    </div>
  );
};

export default Etapas;
