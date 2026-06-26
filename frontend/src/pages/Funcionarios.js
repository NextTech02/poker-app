import React, { useEffect, useState } from 'react';
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
import './Funcionarios.css';

const ALL_PERMISSIONS = [
  { key: 'dashboard', label: 'Dashboard' },
  { key: 'stages', label: 'Etapas' },
  { key: 'tournaments', label: 'Torneios' },
  { key: 'players', label: 'Jogadores' },
  { key: 'cashier', label: 'Caixa' },
  { key: 'cashier_players', label: 'Caixa - Jogadores' },
  { key: 'cashier_tickets', label: 'Caixa - Tickets' },
  { key: 'sangi', label: 'Sangi' },
  { key: 'prizes', label: 'Premiação' },
  { key: 'prizes_release', label: 'Premiação - Liberar' },
  { key: 'financial', label: 'Financeiro' },
  { key: 'reports', label: 'Relatórios' },
  { key: 'general_cash', label: 'Caixa Geral' },
  { key: 'cashbox.operate', label: 'Caixa Próprio - Operar' },
  { key: 'cashbox.admin', label: 'Caixa Próprio - Admin' },
  { key: 'rankings', label: 'Rankings' },
  { key: 'blinds', label: 'Blinds' },
  { key: 'tables', label: 'Mesas' },
  { key: 'broadcast', label: 'Broadcast' },
  { key: 'employees', label: 'Funcionários' },
];

const Funcionarios = () => {
  const { toast } = useToast();
  const notify = (msg, type = 'error') => toast[type](msg);
  const { selectedStage } = useStage();
  const { formatCurrency } = useCurrency();

  const [activeTab, setActiveTab] = useState('staff');
  const [staffList, setStaffList] = useState([]);
  const [groups, setGroups] = useState([]);
  const [loading, setLoading] = useState(true);

  // Staff modal
  const [showStaffModal, setShowStaffModal] = useState(false);
  const [staffForm, setStaffForm] = useState({ name: '', email: '', password: '', permission_group_id: '' });
  const [staffSaving, setStaffSaving] = useState(false);

  // Group modal
  const [showGroupModal, setShowGroupModal] = useState(false);
  const [editingGroup, setEditingGroup] = useState(null);
  const [groupForm, setGroupForm] = useState({ name: '', description: '', permissions: [] });
  const [groupSaving, setGroupSaving] = useState(false);

  // Pagamentos (staff payments) tab — scoped to the selected stage
  const [payments, setPayments] = useState({}); // staff_id -> { id, amount, status, paid_at }
  const [amountInputs, setAmountInputs] = useState({}); // staff_id -> string (editable)
  const [reservedBudget, setReservedBudget] = useState(0);
  const [generalCash, setGeneralCash] = useState(null); // { id, current_balance }
  const [payLoading, setPayLoading] = useState(false);
  const [payBusy, setPayBusy] = useState(null); // staff_id currently being paid/reversed

  useEffect(() => {
    loadData();
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
      notify('Erro ao carregar pagamentos do staff');
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
      notify('Erro ao salvar o valor');
    }
  };

  const handlePay = async (staffId) => {
    const stageId = selectedStage?.id;
    if (!stageId || !generalCash) return;
    const amount = Math.max(0, parseFloat(amountInputs[staffId]) || parseFloat(payments[staffId]?.amount) || 0);
    if (amount <= 0) {
      notify('Defina um valor maior que zero antes de pagar.');
      return;
    }
    const balance = parseFloat(generalCash.current_balance) || 0;
    if (amount > balance) {
      notify(`Saldo insuficiente no Caixa Geral. Disponível: ${formatCurrency(balance)}`);
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
      notify('Pagamento registrado e debitado do Caixa Geral.', 'success');
      loadPayments();
    } catch (err) {
      notify('Erro ao registrar o pagamento');
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
      notify('Pagamento estornado — valor devolvido ao Caixa Geral.', 'success');
      loadPayments();
    } catch (err) {
      notify('Erro ao estornar o pagamento');
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
      notify('Erro ao carregar dados');
    } finally {
      setLoading(false);
    }
  };

  // ── Staff handlers ──

  const openCreateStaff = () => {
    setStaffForm({ name: '', email: '', password: '', permission_group_id: '' });
    setShowStaffModal(true);
  };

  const handleCreateStaff = async () => {
    if (!staffForm.name || !staffForm.email || !staffForm.password) {
      notify('Preencha nome, email e senha');
      return;
    }
    setStaffSaving(true);
    try {
      const payload = { ...staffForm };
      if (!payload.permission_group_id) delete payload.permission_group_id;
      await api.post('/staff', payload);
      notify('Funcionário criado com sucesso', 'success');
      setShowStaffModal(false);
      loadData();
    } catch (err) {
      const detail = err.response?.data?.detail || 'Erro ao criar funcionário';
      notify(detail);
    } finally {
      setStaffSaving(false);
    }
  };

  const handleToggleActive = async (staff) => {
    try {
      await api.patch(`/staff/${staff.id}`, { active: !staff.active });
      notify(staff.active ? 'Funcionário desativado' : 'Funcionário ativado', 'success');
      loadData();
    } catch (err) {
      notify('Erro ao atualizar funcionário');
    }
  };

  const handleChangeGroup = async (staffId, groupId) => {
    try {
      await api.patch(`/staff/${staffId}`, { permission_group_id: groupId || null });
      notify('Grupo atualizado', 'success');
      loadData();
    } catch (err) {
      notify('Erro ao atualizar grupo');
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
      notify('Informe o nome do grupo');
      return;
    }
    setGroupSaving(true);
    try {
      if (editingGroup) {
        await api.patch(`/staff/groups/${editingGroup.id}`, groupForm);
        notify('Grupo atualizado', 'success');
      } else {
        await api.post('/staff/groups', groupForm);
        notify('Grupo criado com sucesso', 'success');
      }
      setShowGroupModal(false);
      loadData();
    } catch (err) {
      const detail = err.response?.data?.detail || 'Erro ao salvar grupo';
      notify(detail);
    } finally {
      setGroupSaving(false);
    }
  };

  const handleDeleteGroup = async (group) => {
    if (!window.confirm(`Remover o grupo "${group.name}"?`)) return;
    try {
      await api.delete(`/staff/groups/${group.id}`);
      notify('Grupo removido', 'success');
      loadData();
    } catch (err) {
      notify('Erro ao remover grupo');
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
          <h1>Funcionários</h1>
          <div className="page-header-actions">
            {activeTab === 'staff' ? (
              <Button onClick={openCreateStaff}>+ Novo Funcionário</Button>
            ) : (
              <Button onClick={openCreateGroup}>+ Novo Grupo</Button>
            )}
          </div>
        </div>

        {/* Tabs */}
        <div className="func-tabs">
          <button
            className={`func-tab ${activeTab === 'staff' ? 'active' : ''}`}
            onClick={() => setActiveTab('staff')}
          >
            Funcionários
          </button>
          <button
            className={`func-tab ${activeTab === 'groups' ? 'active' : ''}`}
            onClick={() => setActiveTab('groups')}
          >
            Grupos de Permissão
          </button>
          <button
            className={`func-tab ${activeTab === 'pagamentos' ? 'active' : ''}`}
            onClick={() => setActiveTab('pagamentos')}
          >
            Pagamentos
          </button>
        </div>

        {/* ── Staff Tab ── */}
        {activeTab === 'staff' && (
          <Card>
            {loading ? (
              <table className="table"><tbody>{Array.from({ length: 4 }).map((_, i) => <SkeletonTableRow key={i} cols={5} />)}</tbody></table>
            ) : staffList.length === 0 ? (
              <EmptyState message="Nenhum funcionário cadastrado" />
            ) : (
              <div className="table-responsive">
                <table className="table">
                  <thead>
                    <tr>
                      <th>Nome</th>
                      <th>Email</th>
                      <th>Grupo</th>
                      <th>Status</th>
                      <th>Ações</th>
                    </tr>
                  </thead>
                  <tbody>
                    {staffList.map((s) => (
                      <tr key={s.id} className={!s.active ? 'func-row-inactive' : ''}>
                        <td>{s.name}</td>
                        <td>{s.email}</td>
                        <td>
                          <select
                            className="func-group-select"
                            value={s.permission_group_id || ''}
                            onChange={(e) => handleChangeGroup(s.id, e.target.value)}
                          >
                            <option value="">Sem grupo</option>
                            {groups.map((g) => (
                              <option key={g.id} value={g.id}>{g.name}</option>
                            ))}
                          </select>
                        </td>
                        <td>
                          <span className={`func-status ${s.active ? 'func-status--active' : 'func-status--inactive'}`}>
                            {s.active ? 'Ativo' : 'Inativo'}
                          </span>
                        </td>
                        <td>
                          <button
                            className={`func-action-btn ${s.active ? 'func-action-btn--danger' : 'func-action-btn--success'}`}
                            onClick={() => handleToggleActive(s)}
                          >
                            {s.active ? 'Desativar' : 'Ativar'}
                          </button>
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
              <EmptyState message="Selecione uma etapa para gerenciar os pagamentos do staff." />
            ) : (
              <>
                <div className="func-pay-summary">
                  <div className="func-pay-stat">
                    <span className="func-pay-stat-label">Reservado p/ staff (etapa)</span>
                    <strong className="func-pay-stat-value">{formatCurrency(reservedBudget)}</strong>
                    <span className="func-pay-stat-hint">Soma da % reservada (staff) dos torneios</span>
                  </div>
                  <div className="func-pay-stat">
                    <span className="func-pay-stat-label">Total atribuído</span>
                    <strong className="func-pay-stat-value">{formatCurrency(totalAssigned)}</strong>
                  </div>
                  <div className="func-pay-stat">
                    <span className="func-pay-stat-label">Total pago</span>
                    <strong className="func-pay-stat-value">{formatCurrency(totalPaid)}</strong>
                  </div>
                  <div className="func-pay-stat">
                    <span className="func-pay-stat-label">Caixa Geral disponível</span>
                    <strong className="func-pay-stat-value">{formatCurrency(generalCash?.current_balance || 0)}</strong>
                  </div>
                </div>

                {payLoading ? (
                  <table className="table"><tbody>{Array.from({ length: 4 }).map((_, i) => <SkeletonTableRow key={i} cols={4} />)}</tbody></table>
                ) : activeStaff.length === 0 ? (
                  <EmptyState message="Nenhum funcionário ativo cadastrado." />
                ) : (
                  <div className="table-responsive">
                    <table className="table">
                      <thead>
                        <tr>
                          <th>Funcionário</th>
                          <th>Valor</th>
                          <th>Status</th>
                          <th>Ações</th>
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
                                  placeholder="0,00"
                                  onChange={(e) => handleAmountChange(s.id, e.target.value)}
                                  onBlur={() => !isPaid && handleSaveAmount(s.id)}
                                />
                              </td>
                              <td>
                                <span className={`func-status ${isPaid ? 'func-status--active' : 'func-status--inactive'}`}>
                                  {isPaid ? 'Pago' : 'Pendente'}
                                </span>
                                {isPaid && p?.paid_at && (
                                  <span className="func-pay-date">{new Date(p.paid_at).toLocaleDateString('pt-BR')}</span>
                                )}
                              </td>
                              <td>
                                {isPaid ? (
                                  <button className="func-action-btn func-action-btn--danger" disabled={busy} onClick={() => handleReverse(s.id)}>
                                    {busy ? '...' : 'Estornar'}
                                  </button>
                                ) : (
                                  <button className="func-action-btn func-action-btn--success" disabled={busy} onClick={() => handlePay(s.id)}>
                                    {busy ? '...' : 'Pagar'}
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
              <EmptyState message="Nenhum grupo cadastrado" />
            ) : (
              <div className="table-responsive">
                <table className="table">
                  <thead>
                    <tr>
                      <th>Nome</th>
                      <th>Descrição</th>
                      <th>Permissões</th>
                      <th>Ações</th>
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
                              <span className="func-perm-tag func-perm-tag--all">Todas</span>
                            ) : g.permissions.length === 0 ? (
                              <span className="func-perm-tag func-perm-tag--none">Nenhuma</span>
                            ) : (
                              g.permissions.slice(0, 4).map((p) => {
                                const found = ALL_PERMISSIONS.find((ap) => ap.key === p);
                                return (
                                  <span key={p} className="func-perm-tag">
                                    {found ? found.label : p}
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
                            <button className="func-action-btn" onClick={() => openEditGroup(g)}>Editar</button>
                            <button className="func-action-btn func-action-btn--danger" onClick={() => handleDeleteGroup(g)}>Remover</button>
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
          <div className="modal-overlay" onClick={() => setShowStaffModal(false)}>
            <div className="modal func-modal" onClick={(e) => e.stopPropagation()}>
              <div className="modal-header">
                <h2>Novo Funcionário</h2>
                <button className="modal-close" onClick={() => setShowStaffModal(false)}>×</button>
              </div>
              <div className="modal-body">
                <div className="form-group">
                  <label>Nome</label>
                  <input
                    type="text"
                    className="form-input"
                    value={staffForm.name}
                    onChange={(e) => setStaffForm({ ...staffForm, name: e.target.value })}
                    placeholder="Nome completo"
                  />
                </div>
                <div className="form-group">
                  <label>Email</label>
                  <input
                    type="email"
                    className="form-input"
                    value={staffForm.email}
                    onChange={(e) => setStaffForm({ ...staffForm, email: e.target.value })}
                    placeholder="email@exemplo.com"
                  />
                </div>
                <div className="form-group">
                  <label>Senha</label>
                  <input
                    type="password"
                    className="form-input"
                    value={staffForm.password}
                    onChange={(e) => setStaffForm({ ...staffForm, password: e.target.value })}
                    placeholder="Mínimo 6 caracteres"
                  />
                </div>
                <div className="form-group">
                  <label>Grupo de Permissão</label>
                  <select
                    className="form-input"
                    value={staffForm.permission_group_id}
                    onChange={(e) => setStaffForm({ ...staffForm, permission_group_id: e.target.value })}
                  >
                    <option value="">Sem grupo</option>
                    {groups.map((g) => (
                      <option key={g.id} value={g.id}>{g.name}</option>
                    ))}
                  </select>
                </div>
              </div>
              <div className="modal-footer">
                <Button variant="secondary" onClick={() => setShowStaffModal(false)}>Cancelar</Button>
                <Button onClick={handleCreateStaff} disabled={staffSaving}>
                  {staffSaving ? 'Criando...' : 'Criar Funcionário'}
                </Button>
              </div>
            </div>
          </div>
        )}

        {/* ── Group Create/Edit Modal ── */}
        {showGroupModal && (
          <div className="modal-overlay" onClick={() => setShowGroupModal(false)}>
            <div className="modal func-modal func-modal--wide" onClick={(e) => e.stopPropagation()}>
              <div className="modal-header">
                <h2>{editingGroup ? 'Editar Grupo' : 'Novo Grupo'}</h2>
                <button className="modal-close" onClick={() => setShowGroupModal(false)}>×</button>
              </div>
              <div className="modal-body">
                <div className="form-group">
                  <label>Nome do Grupo</label>
                  <input
                    type="text"
                    className="form-input"
                    value={groupForm.name}
                    onChange={(e) => setGroupForm({ ...groupForm, name: e.target.value })}
                    placeholder="Ex: Caixa, Gerente"
                  />
                </div>
                <div className="form-group">
                  <label>Descrição</label>
                  <input
                    type="text"
                    className="form-input"
                    value={groupForm.description}
                    onChange={(e) => setGroupForm({ ...groupForm, description: e.target.value })}
                    placeholder="Breve descrição do grupo"
                  />
                </div>
                <div className="form-group">
                  <label>
                    Permissões
                    <button
                      type="button"
                      className="func-select-all-btn"
                      onClick={toggleAllPermissions}
                    >
                      {ALL_PERMISSIONS.every((p) => groupForm.permissions.includes(p.key))
                        ? 'Desmarcar todas'
                        : 'Selecionar todas'}
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
                        <span>{perm.label}</span>
                      </label>
                    ))}
                  </div>
                </div>
              </div>
              <div className="modal-footer">
                <Button variant="secondary" onClick={() => setShowGroupModal(false)}>Cancelar</Button>
                <Button onClick={handleSaveGroup} disabled={groupSaving}>
                  {groupSaving ? 'Salvando...' : editingGroup ? 'Salvar Alterações' : 'Criar Grupo'}
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
