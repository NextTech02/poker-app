import React, { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import Sidebar from '../components/Sidebar';
import Card from '../components/Card';
import Button from '../components/Button';
import EmptyState from '../components/EmptyState';
import { SkeletonTableRow } from '../components/SkeletonLoader';
import ActivityLogTable from '../components/ActivityLogTable';
import api from '../config/api';
import { useToast } from '../contexts/ToastContext';
import { usePermissions } from '../contexts/PermissionContext';
import { CURRENCIES } from '../utils/currencyUtils';
import { IDIOMAS } from '../utils/idiomaDoUsuario';
import { currentOrgId, enterOrg } from '../utils/orgScope';
import { useEscapeKey } from '../hooks/useEscapeKey';
import './Organizacoes.css';

/**
 * Cadastro de organizações (clientes do SaaS) — visível apenas para o
 * platform_admin da NextHub. O backend valida o mesmo claim: esconder a tela
 * não é segurança, é só conveniência.
 *
 * O dono do clube recebe um CONVITE por e-mail e define a própria senha; a
 * senha nunca passa por aqui.
 */
const Organizacoes = () => {
  const { t } = useTranslation();
  const { toast, confirm } = useToast();
  const { isPlatformAdmin, loading: permLoading } = usePermissions();
  const [busyId, setBusyId] = useState(null);

  // Organização que o token carrega agora — é o que o RLS está enxergando.
  const activeOrgId = currentOrgId();

  // Drill-down de funcionários por organização (carregado sob demanda).
  const [expandedOrg, setExpandedOrg] = useState(null);
  const [staffByOrg, setStaffByOrg] = useState({});
  const [staffLoading, setStaffLoading] = useState(null);
  // Log de acessos aberto (uma org por vez, dentro do drill-down dela).
  const [logsOrg, setLogsOrg] = useState(null);
  const fetchLogsDaOrg = useCallback(
    (params) => api.get(`/organizations/${logsOrg}/activity-logs`, { params }).then((r) => r.data),
    [logsOrg],
  );

  const [orgs, setOrgs] = useState([]);
  const [plans, setPlans] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState({ name: '', admin_name: '', admin_email: '', currency: 'BRL', language: 'pt-BR', plan: 'free' });
  const [errors, setErrors] = useState({});

  // Modal de mudança de plano.
  const [planModal, setPlanModal] = useState(null); // { org, plan_code, max_users_override }
  const [savingPlan, setSavingPlan] = useState(false);

  // Esc fecha os modais — é o equivalente de teclado ao clique no fundo escuro.
  useEscapeKey(showForm && !saving, () => setShowForm(false));
  useEscapeKey(!!planModal && !savingPlan, () => setPlanModal(null));

  const load = useCallback(async () => {
    try {
      const [orgRes, planRes] = await Promise.all([
        api.get('/organizations'),
        api.get('/organizations/plans').catch(() => ({ data: [] })),
      ]);
      setOrgs(orgRes.data || []);
      setPlans(planRes.data || []);
    } catch (err) {
      if (err.response?.status !== 403) {
        toast.error(t('organizations.errorLoad', 'Erro ao carregar organizações'));
      }
    } finally {
      setLoading(false);
    }
  }, [toast, t]);

  useEffect(() => {
    if (!permLoading && isPlatformAdmin) load();
    else if (!permLoading) setLoading(false);
  }, [permLoading, isPlatformAdmin, load]);

  /** Abre/fecha a lista de funcionários de uma organização, buscando sob
   *  demanda na 1ª vez (cache em staffByOrg). */
  const toggleStaff = async (org) => {
    if (expandedOrg === org.id) {
      setExpandedOrg(null);
      setLogsOrg(null);
      return;
    }
    setExpandedOrg(org.id);
    setLogsOrg(null);
    if (staffByOrg[org.id]) return; // já em cache
    setStaffLoading(org.id);
    try {
      const res = await api.get(`/organizations/${org.id}/staff`);
      setStaffByOrg((prev) => ({ ...prev, [org.id]: res.data || [] }));
    } catch (err) {
      toast.error(err.userMessage || t('organizations.errorLoadStaff', 'Erro ao carregar funcionários'));
      setExpandedOrg(null);
    } finally {
      setStaffLoading(null);
    }
  };

  /**
   * Entra na organização para operá-la como se fosse dela: o app inteiro
   * (dados, caixa, relatórios, convites de funcionário) passa a enxergar só
   * este clube.
   *
   * Não é um filtro de tela — é um TOKEN NOVO com o claim da organização. Por
   * isso o isolamento vale também no banco (RLS) e nas telas que falam direto
   * com o Supabase, sem depender de nenhum filtro no frontend.
   */
  const inspect = async (org) => {
    if (org.id === activeOrgId || busyId) return;
    const ok = await confirm(
      t('organizations.confirmEnter',
        'Entrar em "{{name}}"? O sistema passa a mostrar e editar apenas os dados deste clube.',
        { name: org.name }),
      {
        title: t('organizations.enterTitle', 'Entrar na organização?'),
        confirmText: t('organizations.enter', 'Entrar'),
      }
    );
    if (!ok) return;
    setBusyId(org.id);
    try {
      await enterOrg(org.id);   // recarrega o app já escopado
    } catch (err) {
      toast.error(err.userMessage || t('organizations.errorEnter', 'Não foi possível entrar nesta organização'));
      setBusyId(null);
    }
  };

  /** Salva a mudança de plano / override de usuários de uma org. */
  const savePlan = async () => {
    if (!planModal) return;
    setSavingPlan(true);
    try {
      const body = {
        plan_code: planModal.plan_code,
        max_users_override:
          planModal.max_users_override === '' || planModal.max_users_override == null
            ? null
            : Number(planModal.max_users_override),
      };
      const res = await api.patch(`/organizations/${planModal.org.id}/plan`, body);
      const updated = res.data || {};
      // Recarrega para trazer limites/trial recalculados do backend.
      setPlanModal(null);
      toast.success(t('organizations.planUpdated', 'Plano atualizado.'));
      setLoading(true);
      load();
      return updated;
    } catch (err) {
      toast.error(err.userMessage || t('organizations.errorPlan', 'Erro ao alterar o plano'));
    } finally {
      setSavingPlan(false);
    }
  };

  // "∞" quando o limite é ilimitado (null).
  const fmtLimit = (v) => (v == null ? '∞' : v);

  // Dias restantes do trial (ou null se não houver trial).
  const trialDaysLeft = (org) => {
    if (!org.trial_ends_at) return null;
    const ms = new Date(org.trial_ends_at).getTime() - Date.now();
    return Math.ceil(ms / 86400000);
  };

  /** Suspender/reativar corta ou devolve o acesso de TODOS os usuários do clube
   *  imediatamente (o RLS deixa de enxergar a organização). Por isso confirma. */
  const toggleStatus = async (org) => {
    const suspending = org.status === 'active';
    const ok = await confirm(
      suspending
        ? t('organizations.confirmSuspend', 'Suspender "{{name}}"? Todos os usuários deste clube perdem o acesso imediatamente.', { name: org.name })
        : t('organizations.confirmReactivate', 'Reativar "{{name}}"? Os usuários voltam a ter acesso.', { name: org.name }),
      {
        title: suspending
          ? t('organizations.suspendTitle', 'Suspender organização?')
          : t('organizations.reactivateTitle', 'Reativar organização?'),
        variant: suspending ? 'danger' : 'primary',
        confirmText: suspending
          ? t('organizations.suspend', 'Suspender')
          : t('organizations.reactivate', 'Reativar'),
      }
    );
    if (!ok) return;

    setBusyId(org.id);
    try {
      await api.patch(`/organizations/${org.id}/status`, {
        status: suspending ? 'suspended' : 'active',
      });
      toast.success(suspending
        ? t('organizations.suspended_ok', 'Organização suspensa.')
        : t('organizations.reactivated_ok', 'Organização reativada.'));
      setOrgs((prev) => prev.map((o) =>
        o.id === org.id ? { ...o, status: suspending ? 'suspended' : 'active' } : o));
    } catch (err) {
      toast.error(err.userMessage || t('organizations.errorStatus', 'Erro ao alterar o status'));
    } finally {
      setBusyId(null);
    }
  };

  /** Exclusão DEFINITIVA. Só habilitada para org suspensa e exige digitar o
   *  nome — proteção contra clique acidental, já que apaga todos os dados. */
  const removeOrg = async (org) => {
    const ok = await confirm(
      t('organizations.confirmDelete',
        'Excluir "{{name}}" e TODOS os seus dados (torneios, jogadores, caixa, histórico)? Esta ação não pode ser desfeita.',
        { name: org.name }),
      {
        title: t('organizations.deleteTitle', 'Excluir organização?'),
        variant: 'danger',
        confirmText: t('organizations.delete', 'Excluir'),
      }
    );
    if (!ok) return;

    setBusyId(org.id);
    try {
      const res = await api.delete(`/organizations/${org.id}`);
      const removed = res.data?.deleted || {};
      const total = Object.values(removed).reduce((a, b) => a + Number(b || 0), 0);
      toast.success(t('organizations.deleted_ok', 'Organização excluída ({{count}} registros removidos).', { count: total }));
      setOrgs((prev) => prev.filter((o) => o.id !== org.id));
    } catch (err) {
      toast.error(err.userMessage || t('organizations.errorDelete', 'Erro ao excluir a organização'));
    } finally {
      setBusyId(null);
    }
  };

  const validate = () => {
    const e = {};
    if (!form.name.trim()) e.name = t('organizations.required', 'Obrigatório');
    if (!form.admin_name.trim()) e.admin_name = t('organizations.required', 'Obrigatório');
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(form.admin_email)) {
      e.admin_email = t('organizations.invalidEmail', 'E-mail inválido');
    }
    setErrors(e);
    return Object.keys(e).length === 0;
  };

  const submit = async (ev) => {
    ev.preventDefault();
    if (!validate()) return;
    setSaving(true);
    try {
      const res = await api.post('/organizations', form);
      if (res.data?.invite_error) {
        toast.warning(res.data.invite_error);
      } else {
        toast.success(t('organizations.created', 'Organização criada. Convite enviado para {{email}}.', { email: form.admin_email }));
      }
      setShowForm(false);
      setForm({ name: '', admin_name: '', admin_email: '', currency: 'BRL', language: 'pt-BR', plan: 'free' });
      setLoading(true);
      load();
    } catch (err) {
      // userMessage já vem achatado pelo interceptor (422 do FastAPI é uma
      // lista de objetos; renderizá-la direto quebraria a tela).
      toast.error(err.userMessage || t('organizations.errorCreate', 'Erro ao criar organização'));
    } finally {
      setSaving(false);
    }
  };

  if (!permLoading && !isPlatformAdmin) {
    return (
      <div className="app-container">
        <Sidebar />
        <main className="main-content">
          <EmptyState
            title={t('organizations.noAccessTitle', 'Acesso restrito')}
            subtitle={t('organizations.noAccessDesc', 'Esta área é exclusiva dos administradores da plataforma.')}
          />
        </main>
      </div>
    );
  }

  return (
    <div className="app-container">
      <Sidebar />
      <main className="main-content">
        <div className="page-header">
          <div>
            <h1>{t('organizations.title', 'Organizações')}</h1>
            <p className="subtitle">{t('organizations.subtitle', 'Clubes e operadores que usam o sistema')}</p>
          </div>
          <Button onClick={() => setShowForm(true)}>
            + {t('organizations.new', 'Nova Organização')}
          </Button>
        </div>

        <Card>
          <table className="org-table">
            <thead>
              <tr>
                <th>{t('organizations.colName', 'Organização')}</th>
                <th>{t('organizations.colSlug', 'Identificador')}</th>
                <th>{t('organizations.colPlan', 'Plano')}</th>
                <th>{t('organizations.colStaff', 'Funcionários')}</th>
                <th>{t('common.status')}</th>
                <th>{t('common.actions')}</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <SkeletonTableRow cols={6} />
              ) : orgs.length === 0 ? (
                <tr><td colSpan={6}>
                  <EmptyState
                    title={t('organizations.emptyTitle', 'Nenhuma organização')}
                    subtitle={t('organizations.emptyDesc', 'Cadastre o primeiro clube para começar.')}
                  />
                </td></tr>
              ) : orgs.map((o) => (
                <React.Fragment key={o.id}>
                <tr>
                  <td className="org-name">
                    {o.name}
                    {o.id === activeOrgId && (
                      <span className="org-viewing-badge">
                        {t('organizations.viewing', 'Visualizando')}
                      </span>
                    )}
                  </td>
                  <td><code>{o.slug}</code></td>
                  <td>
                    <span className={`org-plan-badge plan-${o.plan_code}`}>{o.plan_name || o.plan_code}</span>
                    {trialDaysLeft(o) != null && (
                      <div className={`org-trial ${trialDaysLeft(o) <= 0 ? 'expired' : trialDaysLeft(o) <= 7 ? 'soon' : ''}`}>
                        {trialDaysLeft(o) > 0
                          ? t('organizations.trialLeft', 'Trial: {{n}}d', { n: trialDaysLeft(o) })
                          : t('organizations.trialExpired', 'Trial expirado')}
                      </div>
                    )}
                  </td>
                  <td>
                    <div className="org-staff-cell">
                      <button
                        type="button"
                        className="org-staff-toggle"
                        onClick={() => toggleStaff(o)}
                        aria-expanded={expandedOrg === o.id}
                        title={t('organizations.viewStaff', 'Ver funcionários')}
                      >
                        <span className={`org-staff-chevron ${expandedOrg === o.id ? 'open' : ''}`}>▸</span>
                        <span className="org-staff-count">{o.staff_count ?? 0}</span>
                      </button>
                      <span
                        className={`org-usage ${o.max_users != null && (o.active_users ?? 0) >= o.max_users ? 'at-limit' : ''}`}
                        title={t('organizations.usageHint', 'Usuários ativos / limite do plano')}
                      >
                        {o.active_users ?? 0}/{fmtLimit(o.max_users)}
                      </span>
                    </div>
                  </td>
                  <td>
                    <span className={`org-badge ${o.status}`}>
                      {o.status === 'active'
                        ? t('common.active')
                        : o.status === 'suspended'
                          ? t('organizations.suspended', 'Suspensa')
                          : t('common.cancelled')}
                    </span>
                  </td>
                  <td>
                    <div className="org-actions">
                      {o.status === 'active' && o.id !== activeOrgId && (
                        <Button
                          size="small"
                          onClick={() => inspect(o)}
                          disabled={busyId === o.id}
                          title={t('organizations.enterHint', 'Ver e editar os dados apenas deste clube')}
                        >
                          {busyId === o.id ? t('common.loading') : t('organizations.enter', 'Entrar')}
                        </Button>
                      )}
                      <Button
                        size="small"
                        variant="secondary"
                        onClick={() => setPlanModal({ org: o, plan_code: o.plan_code, max_users_override: o.max_users_override ?? '' })}
                        disabled={busyId === o.id}
                        title={t('organizations.changePlan', 'Alterar plano')}
                      >
                        {t('organizations.plan', 'Plano')}
                      </Button>
                      {o.status !== 'cancelled' && (
                        <Button
                          size="small"
                          variant="secondary"
                          onClick={() => toggleStatus(o)}
                          disabled={busyId === o.id}
                        >
                          {busyId === o.id
                            ? t('common.saving')
                            : o.status === 'active'
                              ? t('organizations.suspend', 'Suspender')
                              : t('organizations.reactivate', 'Reativar')}
                        </Button>
                      )}
                      {o.status !== 'active' && (
                        <Button
                          size="small"
                          variant="danger"
                          onClick={() => removeOrg(o)}
                          disabled={busyId === o.id}
                          title={t('organizations.deleteHint', 'Apaga todos os dados desta organização')}
                        >
                          {t('organizations.delete', 'Excluir')}
                        </Button>
                      )}
                    </div>
                  </td>
                </tr>
                {expandedOrg === o.id && (
                  <tr className="org-staff-row">
                    <td colSpan={6}>
                      {staffLoading === o.id ? (
                        <div className="org-staff-loading">{t('common.loading', 'Carregando...')}</div>
                      ) : (staffByOrg[o.id] || []).length === 0 ? (
                        <div className="org-staff-empty">
                          {t('organizations.noStaff', 'Nenhum funcionário cadastrado nesta organização.')}
                        </div>
                      ) : (
                        <div className="org-staff-wrap">
                          <table className="org-staff-table">
                            <thead>
                              <tr>
                                <th>{t('staff.name', 'Nome')}</th>
                                <th>{t('staff.email', 'E-mail')}</th>
                                <th>{t('organizations.staffRole', 'Função')}</th>
                                <th>{t('common.status', 'Status')}</th>
                                <th>{t('organizations.staffSince', 'Desde')}</th>
                              </tr>
                            </thead>
                            <tbody>
                              {(staffByOrg[o.id] || []).map((s) => (
                                <tr key={s.id}>
                                  <td className="org-staff-name">{s.name}</td>
                                  <td>{s.email}</td>
                                  <td>{s.permission_group_name || <span className="org-staff-nogroup">—</span>}</td>
                                  <td>
                                    <span className={`org-staff-badge ${s.active ? 'active' : 'inactive'}`}>
                                      {s.active ? t('common.active', 'Ativo') : t('organizations.staffInactive', 'Inativo')}
                                    </span>
                                  </td>
                                  <td>{s.created_at ? new Date(s.created_at).toLocaleDateString() : '—'}</td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      )}
                      {staffLoading !== o.id && (
                        <div className="org-logs">
                          <button
                            type="button"
                            className="btn btn-secondary btn-sm"
                            aria-expanded={logsOrg === o.id}
                            onClick={() => setLogsOrg(logsOrg === o.id ? null : o.id)}
                          >
                            {logsOrg === o.id
                              ? t('organizations.hideAccess', 'Ocultar acessos')
                              : t('organizations.viewAccess', 'Ver acessos')}
                          </button>
                          {logsOrg === o.id && (
                            <ActivityLogTable users={staffByOrg[o.id]} fetchPage={fetchLogsDaOrg} />
                          )}
                        </div>
                      )}
                    </td>
                  </tr>
                )}
                </React.Fragment>
              ))}
            </tbody>
          </table>
        </Card>

        {showForm && (
          <div className="org-modal-overlay" role="presentation" onClick={(e) => { if (e.target === e.currentTarget && !saving) setShowForm(false); }}>
            <div className="org-modal" role="dialog" aria-modal="true" aria-label={t('organizations.new', 'Nova Organização')}>
              <h2>{t('organizations.new', 'Nova Organização')}</h2>
              <p className="org-modal-hint">
                {t('organizations.inviteHint', 'O administrador receberá um convite por e-mail para definir a própria senha.')}
              </p>
              <form onSubmit={submit}>
                <div className="org-field">
                  <label>{t('organizations.orgName', 'Nome do clube')}</label>
                  <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })}
                         placeholder={t('organizations.orgNamePlaceholder', 'Ex: Clube Royal Lima')} />
                  {errors.name && <span className="org-error">{errors.name}</span>}
                </div>
                <div className="org-field">
                  <label>{t('organizations.adminName', 'Nome do administrador')}</label>
                  <input value={form.admin_name} onChange={(e) => setForm({ ...form, admin_name: e.target.value })}
                         placeholder={t('organizations.adminNamePlaceholder', 'Nome completo')} />
                  {errors.admin_name && <span className="org-error">{errors.admin_name}</span>}
                </div>
                <div className="org-field">
                  <label>{t('organizations.adminEmail', 'E-mail do administrador')}</label>
                  <input type="email" value={form.admin_email}
                         onChange={(e) => setForm({ ...form, admin_email: e.target.value })}
                         placeholder="dono@clube.com" />
                  {errors.admin_email && <span className="org-error">{errors.admin_email}</span>}
                </div>
                <div className="org-field">
                  <label htmlFor="org-currency">{t('organizations.currency', 'Moeda')}</label>
                  <select id="org-currency" value={form.currency} onChange={(e) => setForm({ ...form, currency: e.target.value })}>
                    {Object.entries(CURRENCIES).map(([code, c]) => (
                      <option key={code} value={code}>{c.name}</option>
                    ))}
                  </select>
                </div>
                {/* Idioma do clube. Decide o texto que NASCE no banco junto com a
                    organizacao — nomes de cargos e formas de pagamento —, e nao
                    apenas a interface. Por isso e escolhido aqui, na criacao:
                    corrigir depois exige editar registro por registro. */}
                <div className="org-field">
                  <label htmlFor="org-language">{t('organizations.language', 'Idioma')}</label>
                  <select id="org-language" value={form.language} onChange={(e) => setForm({ ...form, language: e.target.value })}>
                    {IDIOMAS.map((l) => (
                      <option key={l.code} value={l.code}>{l.name}</option>
                    ))}
                  </select>
                </div>
                <div className="org-field">
                  <label htmlFor="org-plan">{t('organizations.plan', 'Plano')}</label>
                  <select id="org-plan" value={form.plan} onChange={(e) => setForm({ ...form, plan: e.target.value })}>
                    {(plans.length ? plans : [
                      { code: 'free', name: 'Free' }, { code: 'standard', name: 'Standard' },
                      { code: 'pro', name: 'Pro' }, { code: 'premium', name: 'Premium' },
                    ]).map((p) => (
                      <option key={p.code} value={p.code}>{p.name}</option>
                    ))}
                  </select>
                  {(() => {
                    const p = plans.find((x) => x.code === form.plan);
                    if (!p) return null;
                    return (
                      <span className="org-plan-hint">
                        {t('organizations.planLimits', 'Usuários {{u}} · Torneios/mês {{t}} · Mesas {{m}} · Clientes {{c}}', {
                          u: fmtLimit(p.max_users), t: fmtLimit(p.max_tournaments_month),
                          m: fmtLimit(p.max_tables_tournament), c: fmtLimit(p.max_clients),
                        })}
                        {p.trial_days ? ` · ${t('organizations.planTrial', 'Trial {{d}}d', { d: p.trial_days })}` : ''}
                      </span>
                    );
                  })()}
                </div>
                <div className="org-modal-actions">
                  <Button type="button" variant="secondary" onClick={() => setShowForm(false)} disabled={saving}>
                    {t('common.cancel')}
                  </Button>
                  <Button type="submit" disabled={saving}>
                    {saving ? t('common.saving') : t('organizations.create', 'Criar e convidar')}
                  </Button>
                </div>
              </form>
            </div>
          </div>
        )}

        {planModal && (() => {
          const p = (plans.find((x) => x.code === planModal.plan_code)) || {};
          return (
            <div className="org-modal-overlay" role="presentation" onClick={(e) => { if (e.target === e.currentTarget && !savingPlan) setPlanModal(null); }}>
              <div className="org-modal" role="dialog" aria-modal="true" aria-label={t('organizations.changePlanTitle', 'Alterar plano')}>
                <h2>{t('organizations.changePlanTitle', 'Alterar plano')}</h2>
                <p className="org-modal-hint">
                  {t('organizations.changePlanHint', 'Muda o plano de "{{name}}". Não remove dados existentes — apenas ajusta os limites daqui pra frente.', { name: planModal.org.name })}
                </p>
                <div className="org-field">
                  <label>{t('organizations.plan', 'Plano')}</label>
                  <select
                    value={planModal.plan_code}
                    onChange={(e) => setPlanModal({ ...planModal, plan_code: e.target.value })}
                  >
                    {(plans.length ? plans : [
                      { code: 'free', name: 'Free' }, { code: 'standard', name: 'Standard' },
                      { code: 'pro', name: 'Pro' }, { code: 'premium', name: 'Premium' },
                    ]).map((pl) => (
                      <option key={pl.code} value={pl.code}>{pl.name}</option>
                    ))}
                  </select>
                  {p.code && (
                    <span className="org-plan-hint">
                      {t('organizations.planLimits', 'Usuários {{u}} · Torneios/mês {{t}} · Mesas {{m}} · Clientes {{c}}', {
                        u: fmtLimit(p.max_users), t: fmtLimit(p.max_tournaments_month),
                        m: fmtLimit(p.max_tables_tournament), c: fmtLimit(p.max_clients),
                      })}
                      {p.trial_days ? ` · ${t('organizations.planTrial', 'Trial {{d}}d', { d: p.trial_days })}` : ''}
                    </span>
                  )}
                </div>
                <div className="org-field">
                  <label>{t('organizations.userOverride', 'Limite de usuários (override)')}</label>
                  <input
                    type="number"
                    min="0"
                    value={planModal.max_users_override}
                    onChange={(e) => setPlanModal({ ...planModal, max_users_override: e.target.value })}
                    placeholder={t('organizations.userOverridePlaceholder', 'Deixe vazio para usar o limite do plano')}
                  />
                  <span className="org-plan-hint">
                    {t('organizations.userOverrideHint', 'Opcional. Use para acordos Premium/personalizados — vence o limite do plano.')}
                  </span>
                </div>
                <div className="org-modal-actions">
                  <Button type="button" variant="secondary" onClick={() => setPlanModal(null)} disabled={savingPlan}>
                    {t('common.cancel')}
                  </Button>
                  <Button type="button" onClick={savePlan} disabled={savingPlan}>
                    {savingPlan ? t('common.saving') : t('organizations.savePlan', 'Salvar plano')}
                  </Button>
                </div>
              </div>
            </div>
          );
        })()}
      </main>
    </div>
  );
};

export default Organizacoes;
