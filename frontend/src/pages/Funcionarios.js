import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import Sidebar from '../components/Sidebar';
import Card from '../components/Card';
import Button from '../components/Button';
import EmptyState from '../components/EmptyState';
import { SkeletonTableRow } from '../components/SkeletonLoader';
import api from '../config/api';
import { useToast } from '../contexts/ToastContext';
import { useStage } from '../contexts/StageContext';
import { useCurrency } from '../contexts/CurrencyContext';
import { supabase } from '../config/supabase';
import { useEscapeKey } from '../hooks/useEscapeKey';
import './Funcionarios.css';

const ALL_PERMISSIONS = [
  { key: 'dashboard', label: 'staff.perm.dashboard' },
  { key: 'stages', label: 'staff.perm.stages' },
  { key: 'tournaments', label: 'staff.perm.tournaments' },
  { key: 'players', label: 'staff.perm.players' },
  { key: 'cashier', label: 'staff.perm.cashier' },
  { key: 'cashier_players', label: 'staff.perm.cashierPlayers' },
  { key: 'cashier_tickets', label: 'staff.perm.cashierTickets' },
  // Emissão de ticket em LOTE. Fica separada de `cashier_tickets` porque um
  // erro no lote multiplica o prejuízo por dezenas de entradas já pagas — é
  // decisão de dono, não de operador de caixa.
  { key: 'cashier_tickets.master', label: 'staff.perm.cashierTicketsMaster', fallback: 'Tickets em lote (master)' },
  { key: 'sangi', label: 'staff.perm.sangi' },
  { key: 'prizes', label: 'staff.perm.prizes' },
  { key: 'prizes_release', label: 'staff.perm.prizesRelease' },
  { key: 'financial', label: 'staff.perm.financial' },
  { key: 'reports', label: 'staff.perm.reports' },
  { key: 'general_cash', label: 'staff.perm.generalCash' },
  { key: 'cashbox.operate', label: 'staff.perm.cashboxOperate' },
  { key: 'cashbox.admin', label: 'staff.perm.cashboxAdmin' },
  { key: 'rankings', label: 'staff.perm.rankings' },
  { key: 'blinds', label: 'staff.perm.blinds' },
  { key: 'tables', label: 'staff.perm.tables' },
  { key: 'broadcast', label: 'staff.perm.broadcast' },
  { key: 'employees', label: 'staff.perm.employees' },
];

const Funcionarios = () => {
  const { t } = useTranslation();
  const { toast, confirm } = useToast();
  const notify = (msg, type = 'error') => toast[type](msg);
  const { selectedStage } = useStage();
  const { formatCurrency } = useCurrency();

  const [activeTab, setActiveTab] = useState('staff');
  const [staffList, setStaffList] = useState([]);
  const [groups, setGroups] = useState([]);
  const [loading, setLoading] = useState(true);

  // Staff modal
  const [showStaffModal, setShowStaffModal] = useState(false);
  const [staffForm, setStaffForm] = useState({ email: '', permission_group_id: '' });
  const [staffSaving, setStaffSaving] = useState(false);
  const [verInativos, setVerInativos] = useState(false);

  // Group modal
  const [showGroupModal, setShowGroupModal] = useState(false);
  const [editingGroup, setEditingGroup] = useState(null);
  const [groupForm, setGroupForm] = useState({ name: '', description: '', permissions: [] });
  const [groupSaving, setGroupSaving] = useState(false);

  // Esc fecha os modais — é o equivalente de teclado ao clique no fundo escuro.
  useEscapeKey(showStaffModal, () => setShowStaffModal(false));
  useEscapeKey(showGroupModal, () => setShowGroupModal(false));

  // Pagamentos (staff payments) tab — scoped to the selected stage
  const [payments, setPayments] = useState({}); // staff_id -> { id, amount, status, paid_at }
  const [amountInputs, setAmountInputs] = useState({}); // staff_id -> string (editable)
  const [reservedBudget, setReservedBudget] = useState(0);
  const [generalCash, setGeneralCash] = useState(null); // { id, current_balance }
  const [payLoading, setPayLoading] = useState(false);
  const [payBusy, setPayBusy] = useState(null); // staff_id currently being paid/reversed

  // loadData e uma funcao comum, recriada a cada render: incluir na lista de
  // dependencias causaria refetch infinito. Roda so na montagem, de proposito.
  useEffect(() => {
    loadData();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Load staff payments + budget when entering the Pagamentos tab (or switching stage)
  useEffect(() => {
    if (activeTab === 'pagamentos' && selectedStage?.id) {
      loadPayments();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTab, selectedStage?.id]);

  const loadPayments = async () => {
    const stageId = selectedStage?.id;
    if (!stageId) return;
    setPayLoading(true);
    try {
      // General cash + existing payments (read directly via Supabase)
      const [gcRes, payRes] = await Promise.all([
        supabase.from('general_cash_register').select('id, current_balance').limit(1).single(),
        supabase.from('staff_payments').select('*').eq('stage_id', stageId),
      ]);
      setGeneralCash(gcRes.data || null);
      const map = {};
      const inputs = {};
      (payRes.data || []).forEach((p) => {
        map[p.staff_id] = p;
        inputs[p.staff_id] = String(p.amount ?? '');
      });
      setPayments(map);
      setAmountInputs(inputs);

      // Reference budget: sum of the staff-reserved prize across the stage's tournaments
      try {
        const tRes = await api.get('/tournaments');
        const tours = tRes.data || [];
        const summaries = await Promise.all(
          tours.map((t) =>
            api.get(`/tournaments/${t.id}/prizes/summary`).then((r) => r.data).catch(() => null)
          )
        );
        const budget = summaries.reduce(
          (acc, s) =>
            s && s.reserved_purpose === 'staff' ? acc + (parseFloat(s.reserved_amount) || 0) : acc,
          0
        );
        setReservedBudget(budget);
      } catch (_) {
        setReservedBudget(0);
      }
    } catch (err) {
      notify(t('staff.errLoadPayments'));
    } finally {
      setPayLoading(false);
    }
  };

  const handleAmountChange = (staffId, val) => {
    setAmountInputs((prev) => ({ ...prev, [staffId]: val }));
  };

  const handleSaveAmount = async (staffId) => {
    const stageId = selectedStage?.id;
    if (!stageId) return;
    const amount = Math.max(0, parseFloat(amountInputs[staffId]) || 0);
    const existing = payments[staffId];
    // Avoid a pointless write if nothing changed
    if (existing && (parseFloat(existing.amount) || 0) === amount) return;
    if (!existing && amount === 0) return;
    try {
      if (existing) {
        await supabase
          .from('staff_payments')
          .update({ amount, updated_at: new Date().toISOString() })
          .eq('id', existing.id);
      } else {
        await supabase
          .from('staff_payments')
          .insert({ stage_id: stageId, staff_id: staffId, amount, status: 'pending' });
      }
      loadPayments();
    } catch (err) {
      notify(t('staff.errSaveAmount'));
    }
  };

  const handlePay = async (staffId) => {
    const stageId = selectedStage?.id;
    if (!stageId || !generalCash) return;
    const amount = Math.max(0, parseFloat(amountInputs[staffId]) || parseFloat(payments[staffId]?.amount) || 0);
    if (amount <= 0) {
      notify(t('staff.defineAmountBeforePay'));
      return;
    }
    const balance = parseFloat(generalCash.current_balance) || 0;
    if (amount > balance) {
      notify(t('staff.insufficientGeneralCash', { balance: formatCurrency(balance) }));
      return;
    }
    setPayBusy(staffId);
    try {
      const existing = payments[staffId];
      if (existing) {
        await supabase
          .from('staff_payments')
          .update({ amount, status: 'paid', paid_at: new Date().toISOString() })
          .eq('id', existing.id);
      } else {
        await supabase
          .from('staff_payments')
          .insert({ stage_id: stageId, staff_id: staffId, amount, status: 'paid', paid_at: new Date().toISOString() });
      }
      // Debit the general cash register (mirrors prize payout)
      await supabase
        .from('general_cash_register')
        .update({ current_balance: String(balance - amount) })
        .eq('id', generalCash.id);
      notify(t('staff.paymentRegistered'), 'success');
      loadPayments();
    } catch (err) {
      notify(t('staff.errRegisterPayment'));
    } finally {
      setPayBusy(null);
    }
  };

  const handleReverse = async (staffId) => {
    const p = payments[staffId];
    if (!p || p.status !== 'paid' || !generalCash) return;
    const amount = parseFloat(p.amount) || 0;
    setPayBusy(staffId);
    try {
      await supabase
        .from('staff_payments')
        .update({ status: 'pending', paid_at: null })
        .eq('id', p.id);
      // Refund the general cash
      await supabase
        .from('general_cash_register')
        .update({ current_balance: String((parseFloat(generalCash.current_balance) || 0) + amount) })
        .eq('id', generalCash.id);
      notify(t('staff.paymentReversed'), 'success');
      loadPayments();
    } catch (err) {
      notify(t('staff.errReversePayment'));
    } finally {
      setPayBusy(null);
    }
  };

  const loadData = async () => {
    setLoading(true);
    try {
      const [staffRes, groupsRes] = await Promise.all([
        api.get('/staff'),
        api.get('/staff/groups'),
      ]);
      setStaffList(staffRes.data || []);
      setGroups(groupsRes.data || []);
    } catch (err) {
      notify(t('staff.errLoadData'));
    } finally {
      setLoading(false);
    }
  };

  // ── Staff handlers ──

  const openCreateStaff = () => {
    setStaffForm({ email: '', permission_group_id: '' });
    setShowStaffModal(true);
  };

  const handleCreateStaff = async () => {
    const email = (staffForm.email || '').trim();
    if (!email || !/^[^@\s]+@[^@\s.]+\.[^@\s]+$/.test(email)) {
      notify(t('staff.fillEmail', 'Informe um e-mail válido.'));
      return;
    }
    setStaffSaving(true);
    try {
      // Só o e-mail vai: o próprio funcionário define nome e senha ao aceitar
      // o convite. O admin não escolhe a senha de ninguém.
      const payload = { email };
      if (staffForm.permission_group_id) payload.permission_group_id = staffForm.permission_group_id;
      await api.post('/staff', payload);
      notify(t('staff.inviteSent', 'Convite enviado para {{email}}.', { email }), 'success');
      setShowStaffModal(false);
      loadData();
    } catch (err) {
      const detail = err.response?.data?.detail || t('staff.errCreateStaff');
      notify(detail);
    } finally {
      setStaffSaving(false);
    }
  };

  const handleRemoveStaff = async (staff) => {
    const ok = await confirm(
      t('staff.confirmRemove',
        'Excluir {{name}} deste clube? Se a pessoa não trabalhar em outro clube, a conta de acesso dela também será apagada.',
        { name: staff.name || staff.email }),
      { title: t('staff.removeTitle', 'Excluir funcionário?'), variant: 'danger',
        confirmText: t('staff.remove', 'Excluir') }
    );
    if (!ok) return;
    try {
      const { data } = await api.delete(`/staff/${staff.id}/remove`);
      if (data.acao === 'desativado') {
        // Não é falha: o banco preserva quem tem lançamento financeiro, senão
        // apagá-lo mudaria o resultado de etapas já fechadas.
        notify(t('staff.removedButKept',
          '{{name}} tem movimentações registradas, então foi apenas desativado — o histórico financeiro é preservado.',
          { name: data.nome || staff.name }), 'info');
      } else if (data.conta_removida) {
        notify(t('staff.removedWithAccount', '{{name}} foi excluído e a conta de acesso removida.',
          { name: data.nome || staff.name }), 'success');
      } else {
        notify(t('staff.removedOnly', '{{name}} foi excluído deste clube.',
          { name: data.nome || staff.name }), 'success');
      }
      loadData();
    } catch (err) {
      notify(err.response?.data?.detail || t('staff.errRemove', 'Não foi possível excluir o funcionário.'));
    }
  };

  const handleResendInvite = async (staff) => {
    try {
      await api.post(`/staff/${staff.id}/resend-invite`);
      notify(t('staff.inviteResent', 'Novo link enviado para {{email}}.', { email: staff.email }), 'success');
    } catch (err) {
      notify(err.response?.data?.detail || t('staff.errResend', 'Não foi possível reenviar o convite.'));
    }
  };

  const handleCancelInvite = async (staff) => {
    const ok = await confirm(
      t('staff.confirmCancelInvite', 'Cancelar o convite de {{email}}?', { email: staff.email }),
      { title: t('staff.cancelInvite', 'Cancelar convite'), variant: 'danger',
        confirmText: t('staff.cancelInvite', 'Cancelar convite') }
    );
    if (!ok) return;
    try {
      await api.delete(`/staff/${staff.id}`);
      notify(t('staff.inviteCancelled', 'Convite cancelado.'), 'success');
      loadData();
    } catch (err) {
      notify(err.response?.data?.detail || t('staff.errCancelInvite', 'Não foi possível cancelar o convite.'));
    }
  };

  const handleToggleActive = async (staff) => {
    try {
      await api.patch(`/staff/${staff.id}`, { active: !staff.active });
      notify(staff.active ? t('staff.staffDeactivated') : t('staff.staffActivated'), 'success');
      loadData();
    } catch (err) {
      notify(t('staff.errUpdateStaff'));
    }
  };

  const handleChangeGroup = async (staffId, groupId) => {
    try {
      await api.patch(`/staff/${staffId}`, { permission_group_id: groupId || null });
      notify(t('staff.groupUpdated'), 'success');
      loadData();
    } catch (err) {
      notify(t('staff.errUpdateGroup'));
    }
  };

  // ── Group handlers ──

  const openCreateGroup = () => {
    setEditingGroup(null);
    setGroupForm({ name: '', description: '', permissions: [] });
    setShowGroupModal(true);
  };

  const openEditGroup = (group) => {
    setEditingGroup(group);
    setGroupForm({
      name: group.name,
      description: group.description || '',
      permissions: [...group.permissions],
    });
    setShowGroupModal(true);
  };

  const togglePermission = (key) => {
    setGroupForm((prev) => {
      const perms = prev.permissions.includes(key)
        ? prev.permissions.filter((p) => p !== key)
        : [...prev.permissions, key];
      return { ...prev, permissions: perms };
    });
  };

  const toggleAllPermissions = () => {
    setGroupForm((prev) => {
      const allSelected = ALL_PERMISSIONS.every((p) => prev.permissions.includes(p.key));
      return {
        ...prev,
        permissions: allSelected ? [] : ALL_PERMISSIONS.map((p) => p.key),
      };
    });
  };

  const handleSaveGroup = async () => {
    if (!groupForm.name) {
      notify(t('staff.enterGroupName'));
      return;
    }
    setGroupSaving(true);
    try {
      if (editingGroup) {
        await api.patch(`/staff/groups/${editingGroup.id}`, groupForm);
        notify(t('staff.groupUpdated'), 'success');
      } else {
        await api.post('/staff/groups', groupForm);
        notify(t('staff.groupCreated'), 'success');
      }
      setShowGroupModal(false);
      loadData();
    } catch (err) {
      const detail = err.response?.data?.detail || t('staff.errSaveGroup');
      notify(detail);
    } finally {
      setGroupSaving(false);
    }
  };

  const handleDeleteGroup = async (group) => {
    if (!window.confirm(t('staff.confirmRemoveGroup', { name: group.name }))) return;
    try {
      await api.delete(`/staff/groups/${group.id}`);
      notify(t('staff.groupRemoved'), 'success');
      loadData();
    } catch (err) {
      notify(t('staff.errRemoveGroup'));
    }
  };

  // Derived values for the Pagamentos tab
  const activeStaff = staffList.filter((s) => s.active);
  const totalPaid = Object.values(payments).reduce(
    (a, p) => a + (p.status === 'paid' ? parseFloat(p.amount) || 0 : 0),
    0
  );
  const totalAssigned = activeStaff.reduce((a, s) => {
    const v = amountInputs[s.id] ?? payments[s.id]?.amount ?? 0;
    return a + (parseFloat(v) || 0);
  }, 0);

  return (
    <div className="layout">
      <Sidebar />
      <main className="main-content">
        <div className="page-header">
          <h1>{t('staff.title')}</h1>
          <div className="page-header-actions">
            {activeTab === 'staff' ? (
              <Button onClick={openCreateStaff}>+ {t('staff.newEmployee')}</Button>
            ) : (
              <Button onClick={openCreateGroup}>+ {t('staff.newGroup')}</Button>
            )}
          </div>
        </div>

        {/* Tabs */}
        <div className="func-tabs">
          <button
            className={`func-tab ${activeTab === 'staff' ? 'active' : ''}`}
            onClick={() => setActiveTab('staff')}
          >
            {t('staff.tabStaff')}
          </button>
          <button
            className={`func-tab ${activeTab === 'groups' ? 'active' : ''}`}
            onClick={() => setActiveTab('groups')}
          >
            {t('staff.tabGroups')}
          </button>
          <button
            className={`func-tab ${activeTab === 'pagamentos' ? 'active' : ''}`}
            onClick={() => setActiveTab('pagamentos')}
          >
            {t('staff.tabPayments')}
          </button>
        </div>

        {/* ── Staff Tab ── */}
        {activeTab === 'staff' && (
          <Card>
            {loading ? (
              <table className="table"><tbody>{Array.from({ length: 4 }).map((_, i) => <SkeletonTableRow key={i} cols={5} />)}</tbody></table>
            ) : staffList.length === 0 ? (
              <EmptyState title={t('staff.noStaffRegistered')} />
            ) : (
              <div className="table-responsive">
                {/* Quem tem lançamento financeiro não pode ser apagado sem
                    reescrever os livros. Esconder os desativados resolve a
                    poluição da lista sem perder o histórico. */}
                {staffList.some((x) => !x.active) && (
                  <div className="func-barra-filtro">
                    {/* Botão de alternância, não caixa de seleção: o gesto é
                        "ligar/desligar uma visão", e o estado precisa ser
                        legível de relance. */}
                    <button
                      type="button"
                      className={`func-chip ${verInativos ? 'ativo' : ''}`}
                      onClick={() => setVerInativos((v) => !v)}
                      aria-pressed={verInativos}
                      title={verInativos
                        ? t('staff.hideInactiveHint', 'Ocultar funcionários desativados')
                        : t('staff.showInactiveHint', 'Mostrar funcionários desativados')}
                    >
                      <svg viewBox="0 0 24 24" fill="currentColor" width="15" height="15" aria-hidden="true">
                        {verInativos ? (
                          <path d="M12 4.5C7 4.5 2.73 7.61 1 12c1.73 4.39 6 7.5 11 7.5s9.27-3.11 11-7.5c-1.73-4.39-6-7.5-11-7.5zm0 12.5a5 5 0 1 1 0-10 5 5 0 0 1 0 10zm0-8a3 3 0 1 0 0 6 3 3 0 0 0 0-6z"/>
                        ) : (
                          <path d="M12 6.5c2.76 0 5 2.24 5 5 0 .51-.1 1-.24 1.46l3.06 3.06c1.39-1.23 2.49-2.77 3.18-4.53C21.27 7.11 17 4 12 4c-1.27 0-2.49.2-3.64.57l2.17 2.17c.47-.14.96-.24 1.47-.24zM2.71 3.16a.996.996 0 0 0 0 1.41l1.97 1.97A11.892 11.892 0 0 0 1 11.5C2.73 15.89 7 19 12 19c1.52 0 2.97-.3 4.31-.82l2.72 2.72a.996.996 0 1 0 1.41-1.41L4.13 3.16a.996.996 0 0 0-1.42 0zM12 16.5c-2.76 0-5-2.24-5-5 0-.77.18-1.5.49-2.14l1.57 1.57c-.03.18-.06.37-.06.57 0 1.66 1.34 3 3 3 .2 0 .38-.03.57-.07l1.57 1.57c-.65.32-1.37.5-2.14.5z"/>
                        )}
                      </svg>
                      {t('staff.inactiveFilter', 'Desativados')}
                      <span className="func-chip-num">
                        {staffList.filter((x) => !x.active).length}
                      </span>
                    </button>
                  </div>
                )}
                <table className="table">
                  <thead>
                    <tr>
                      <th>{t('common.name')}</th>
                      <th>{t('staff.email')}</th>
                      <th>{t('staff.group')}</th>
                      <th>{t('common.status')}</th>
                      <th>{t('common.actions')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {staffList.filter((s) => verInativos || s.active).map((s) => (
                      <tr key={s.id} className={!s.active ? 'func-row-inactive' : ''}>
                        <td>{s.name}</td>
                        <td>{s.email}</td>
                        <td>
                          <select
                            className="func-group-select"
                            value={s.permission_group_id || ''}
                            onChange={(e) => handleChangeGroup(s.id, e.target.value)}
                          >
                            <option value="">{t('staff.noGroup')}</option>
                            {groups.map((g) => (
                              <option key={g.id} value={g.id}>{g.name}</option>
                            ))}
                          </select>
                        </td>
                        <td>
                          {/* Dois estados de convite, com causas diferentes:
                              'pending'         = já tinha conta, falta aceitar;
                              'awaiting_signup' = conta nova, falta definir a senha. */}
                          {s.invite_status === 'pending' ? (
                            <span className="func-status func-status--pending"
                                  title={t('staff.pendingInviteHint', 'Aguardando a pessoa aceitar o convite')}>
                              {t('staff.pendingInvite', 'Convite pendente')}
                            </span>
                          ) : s.invite_status === 'awaiting_signup' ? (
                            <span className="func-status func-status--pending"
                                  title={t('staff.awaitingSignupHint', 'Convite enviado; a pessoa ainda não definiu a senha')}>
                              {t('staff.awaitingSignup', 'Aguardando cadastro')}
                            </span>
                          ) : (
                            <span className={`func-status ${s.active ? 'func-status--active' : 'func-status--inactive'}`}>
                              {s.active ? t('staff.active') : t('staff.inactive')}
                            </span>
                          )}
                        </td>
                        <td>
                          {/* Contêiner flex: botões irmãos soltos na célula não
                              têm como receber espaçamento entre si. */}
                          <div className="func-acoes-linha">
                          {/* Num convite pendente, "Ativar" forçaria a entrada de
                              alguém que ainda não aceitou. O que cabe é desfazer
                              o convite. */}
                          {s.invite_status === 'awaiting_signup' ? (
                            <>
                              <button
                                className="func-action-btn func-action-btn--success"
                                onClick={() => handleResendInvite(s)}
                                title={t('staff.resendHint', 'Os links do e-mail expiram; envie outro')}
                              >
                                {t('staff.resendInvite', 'Reenviar')}
                              </button>
                              <button
                                className="func-action-btn func-action-btn--danger"
                                onClick={() => handleCancelInvite(s)}
                              >
                                {t('staff.cancelInvite', 'Cancelar convite')}
                              </button>
                            </>
                          ) : s.invite_status === 'pending' ? (
                            <button
                              className="func-action-btn func-action-btn--danger"
                              onClick={() => handleCancelInvite(s)}
                            >
                              {t('staff.cancelInvite', 'Cancelar convite')}
                            </button>
                          ) : (
                            <>
                              <button
                                className={`func-action-btn ${s.active ? 'func-action-btn--danger' : 'func-action-btn--success'}`}
                                onClick={() => handleToggleActive(s)}
                              >
                                {s.active ? t('staff.deactivate') : t('staff.activate')}
                              </button>
                              <button
                                className="func-action-btn func-action-btn--danger"
                                onClick={() => handleRemoveStaff(s)}
                                title={t('staff.removeHint', 'Tira do clube; apaga a conta se ela não estiver em outro')}
                              >
                                {t('staff.remove', 'Excluir')}
                              </button>
                            </>
                          )}
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>
        )}

        {/* ── Pagamentos Tab ── */}
        {activeTab === 'pagamentos' && (
          <Card>
            {!selectedStage?.id ? (
              <EmptyState title={t('staff.selectStageForPayments')} />
            ) : (
              <>
                <div className="func-pay-summary">
                  <div className="func-pay-stat">
                    <span className="func-pay-stat-label">{t('staff.reservedForStaff')}</span>
                    <strong className="func-pay-stat-value">{formatCurrency(reservedBudget)}</strong>
                    <span className="func-pay-stat-hint">{t('staff.reservedForStaffHint')}</span>
                  </div>
                  <div className="func-pay-stat">
                    <span className="func-pay-stat-label">{t('staff.totalAssigned')}</span>
                    <strong className="func-pay-stat-value">{formatCurrency(totalAssigned)}</strong>
                  </div>
                  <div className="func-pay-stat">
                    <span className="func-pay-stat-label">{t('staff.totalPaid')}</span>
                    <strong className="func-pay-stat-value">{formatCurrency(totalPaid)}</strong>
                  </div>
                  <div className="func-pay-stat">
                    <span className="func-pay-stat-label">{t('staff.generalCashAvailable')}</span>
                    <strong className="func-pay-stat-value">{formatCurrency(generalCash?.current_balance || 0)}</strong>
                  </div>
                </div>

                {payLoading ? (
                  <table className="table"><tbody>{Array.from({ length: 4 }).map((_, i) => <SkeletonTableRow key={i} cols={4} />)}</tbody></table>
                ) : activeStaff.length === 0 ? (
                  <EmptyState title={t('staff.noActiveStaff')} />
                ) : (
                  <div className="table-responsive">
                    <table className="table">
                      <thead>
                        <tr>
                          <th>{t('staff.employee')}</th>
                          <th>{t('staff.amount')}</th>
                          <th>{t('common.status')}</th>
                          <th>{t('common.actions')}</th>
                        </tr>
                      </thead>
                      <tbody>
                        {activeStaff.map((s) => {
                          const p = payments[s.id];
                          const isPaid = p?.status === 'paid';
                          const busy = payBusy === s.id;
                          return (
                            <tr key={s.id}>
                              <td>{s.name}</td>
                              <td>
                                <input
                                  type="number"
                                  min="0"
                                  step="0.01"
                                  className="func-pay-input"
                                  value={amountInputs[s.id] ?? ''}
                                  disabled={isPaid}
                                  placeholder={t('staff.amountPlaceholder')}
                                  onChange={(e) => handleAmountChange(s.id, e.target.value)}
                                  onBlur={() => !isPaid && handleSaveAmount(s.id)}
                                />
                              </td>
                              <td>
                                <span className={`func-status ${isPaid ? 'func-status--active' : 'func-status--inactive'}`}>
                                  {isPaid ? t('staff.paid') : t('staff.pending')}
                                </span>
                                {isPaid && p?.paid_at && (
                                  <span className="func-pay-date">{new Date(p.paid_at).toLocaleDateString('pt-BR')}</span>
                                )}
                              </td>
                              <td>
                                {isPaid ? (
                                  <button className="func-action-btn func-action-btn--danger" disabled={busy} onClick={() => handleReverse(s.id)}>
                                    {busy ? '...' : t('staff.reverse')}
                                  </button>
                                ) : (
                                  <button className="func-action-btn func-action-btn--success" disabled={busy} onClick={() => handlePay(s.id)}>
                                    {busy ? '...' : t('staff.pay')}
                                  </button>
                                )}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                )}
              </>
            )}
          </Card>
        )}

        {/* ── Groups Tab ── */}
        {activeTab === 'groups' && (
          <Card>
            {loading ? (
              <table className="table"><tbody>{Array.from({ length: 3 }).map((_, i) => <SkeletonTableRow key={i} cols={4} />)}</tbody></table>
            ) : groups.length === 0 ? (
              <EmptyState title={t('staff.noGroupsRegistered')} />
            ) : (
              <div className="table-responsive">
                <table className="table">
                  <thead>
                    <tr>
                      <th>{t('common.name')}</th>
                      <th>{t('staff.description')}</th>
                      <th>{t('staff.permissions')}</th>
                      <th>{t('common.actions')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {groups.map((g) => (
                      <tr key={g.id}>
                        <td><strong>{g.name}</strong></td>
                        <td>{g.description || '—'}</td>
                        <td>
                          <div className="func-perm-tags">
                            {g.permissions.length === ALL_PERMISSIONS.length ? (
                              <span className="func-perm-tag func-perm-tag--all">{t('staff.allPermissions')}</span>
                            ) : g.permissions.length === 0 ? (
                              <span className="func-perm-tag func-perm-tag--none">{t('staff.noPermissions')}</span>
                            ) : (
                              g.permissions.slice(0, 4).map((p) => {
                                const found = ALL_PERMISSIONS.find((ap) => ap.key === p);
                                return (
                                  <span key={p} className="func-perm-tag">
                                    {found ? t(found.label, found.fallback) : p}
                                  </span>
                                );
                              })
                            )}
                            {g.permissions.length > 4 && (
                              <span className="func-perm-tag func-perm-tag--more">
                                +{g.permissions.length - 4}
                              </span>
                            )}
                          </div>
                        </td>
                        <td>
                          <div className="func-actions">
                            <button className="func-action-btn" onClick={() => openEditGroup(g)}>{t('common.edit')}</button>
                            <button className="func-action-btn func-action-btn--danger" onClick={() => handleDeleteGroup(g)}>{t('common.remove')}</button>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>
        )}

        {/* ── Staff Create Modal ── */}
        {showStaffModal && (
          <div className="modal-overlay" role="presentation" onClick={(e) => { if (e.target === e.currentTarget) setShowStaffModal(false); }}>
            <div className="modal func-modal" role="dialog" aria-modal="true" aria-label={t('staff.inviteEmployee', 'Convidar funcionário')}>
              <div className="modal-header">
                <h2>{t('staff.inviteEmployee', 'Convidar funcionário')}</h2>
                <button type="button" className="modal-close" onClick={() => setShowStaffModal(false)} aria-label={t('common.close', 'Fechar')}>×</button>
              </div>
              <div className="modal-body">
                <p className="func-invite-hint">
                  {t('staff.inviteHint',
                     'O funcionário recebe um e-mail e define o próprio nome e senha. Você não precisa criar nem repassar senha.')}
                </p>
                <div className="form-group">
                  <label>{t('staff.email')}</label>
                  <input
                    type="email"
                    className="form-input"
                    value={staffForm.email}
                    onChange={(e) => setStaffForm({ ...staffForm, email: e.target.value })}
                    placeholder="email@exemplo.com"
                    autoFocus
                  />
                </div>
                <div className="form-group">
                  <label>{t('staff.permissionGroup')}</label>
                  <select
                    className="form-input"
                    value={staffForm.permission_group_id}
                    onChange={(e) => setStaffForm({ ...staffForm, permission_group_id: e.target.value })}
                  >
                    <option value="">{t('staff.noGroup')}</option>
                    {groups.map((g) => (
                      <option key={g.id} value={g.id}>{g.name}</option>
                    ))}
                  </select>
                </div>
              </div>
              <div className="modal-footer">
                <Button variant="secondary" onClick={() => setShowStaffModal(false)}>{t('common.cancel')}</Button>
                <Button onClick={handleCreateStaff} disabled={staffSaving}>
                  {staffSaving ? t('staff.sending', 'Enviando...') : t('staff.sendInvite', 'Enviar convite')}
                </Button>
              </div>
            </div>
          </div>
        )}

        {/* ── Group Create/Edit Modal ── */}
        {showGroupModal && (
          <div className="modal-overlay" role="presentation" onClick={(e) => { if (e.target === e.currentTarget) setShowGroupModal(false); }}>
            <div className="modal func-modal func-modal--wide" role="dialog" aria-modal="true" aria-label={editingGroup ? t('staff.editGroup') : t('staff.newGroup')}>
              <div className="modal-header">
                <h2>{editingGroup ? t('staff.editGroup') : t('staff.newGroup')}</h2>
                <button type="button" className="modal-close" onClick={() => setShowGroupModal(false)} aria-label={t('common.close', 'Fechar')}>×</button>
              </div>
              <div className="modal-body">
                <div className="form-group">
                  <label>{t('staff.groupName')}</label>
                  <input
                    type="text"
                    className="form-input"
                    value={groupForm.name}
                    onChange={(e) => setGroupForm({ ...groupForm, name: e.target.value })}
                    placeholder={t('staff.groupNamePlaceholder')}
                  />
                </div>
                <div className="form-group">
                  <label>{t('staff.description')}</label>
                  <input
                    type="text"
                    className="form-input"
                    value={groupForm.description}
                    onChange={(e) => setGroupForm({ ...groupForm, description: e.target.value })}
                    placeholder={t('staff.groupDescriptionPlaceholder')}
                  />
                </div>
                <div className="form-group">
                  <label>
                    {t('staff.permissions')}
                    {/* O botao mora DENTRO do <label>, e <button> e um
                        elemento rotulavel: sem o aria-label, o leitor de tela
                        anuncia "Permissoes" — o texto do rotulo — em vez da
                        acao que o botao executa. */}
                    <button
                      type="button"
                      className="func-select-all-btn"
                      onClick={toggleAllPermissions}
                      aria-label={ALL_PERMISSIONS.every((p) => groupForm.permissions.includes(p.key))
                        ? t('staff.deselectAll')
                        : t('staff.selectAll')}
                    >
                      {ALL_PERMISSIONS.every((p) => groupForm.permissions.includes(p.key))
                        ? t('staff.deselectAll')
                        : t('staff.selectAll')}
                    </button>
                  </label>
                  <div className="func-perm-grid">
                    {ALL_PERMISSIONS.map((perm) => (
                      <label key={perm.key} className="func-perm-check">
                        <input
                          type="checkbox"
                          checked={groupForm.permissions.includes(perm.key)}
                          onChange={() => togglePermission(perm.key)}
                        />
                        <span>{t(perm.label, perm.fallback)}</span>
                      </label>
                    ))}
                  </div>
                </div>
              </div>
              <div className="modal-footer">
                <Button variant="secondary" onClick={() => setShowGroupModal(false)}>{t('common.cancel')}</Button>
                <Button onClick={handleSaveGroup} disabled={groupSaving}>
                  {groupSaving ? t('staff.saving') : editingGroup ? t('staff.saveChanges') : t('staff.createGroup')}
                </Button>
              </div>
            </div>
          </div>
        )}
      </main>
    </div>
  );
};

export default Funcionarios;
