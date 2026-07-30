import React, { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import Sidebar from '../components/Sidebar';
import Card from '../components/Card';
import Button from '../components/Button';
import EmptyState from '../components/EmptyState';
import { SkeletonTableRow } from '../components/SkeletonLoader';
import api from '../config/api';
import { useToast } from '../contexts/ToastContext';
import { usePermissions } from '../contexts/PermissionContext';
import { CURRENCIES } from '../utils/currencyUtils';
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

  const [orgs, setOrgs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState({ name: '', admin_name: '', admin_email: '', currency: 'BRL' });
  const [errors, setErrors] = useState({});

  const load = useCallback(async () => {
    try {
      const res = await api.get('/organizations');
      setOrgs(res.data || []);
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
      setForm({ name: '', admin_name: '', admin_email: '', currency: 'BRL' });
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
            description={t('organizations.noAccessDesc', 'Esta área é exclusiva dos administradores da plataforma.')}
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
                <th>{t('organizations.colStaff', 'Funcionários')}</th>
                <th>{t('common.status')}</th>
                <th>{t('common.actions')}</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <SkeletonTableRow columns={5} rows={3} />
              ) : orgs.length === 0 ? (
                <tr><td colSpan={5}>
                  <EmptyState
                    title={t('organizations.emptyTitle', 'Nenhuma organização')}
                    description={t('organizations.emptyDesc', 'Cadastre o primeiro clube para começar.')}
                  />
                </td></tr>
              ) : orgs.map((o) => (
                <tr key={o.id}>
                  <td className="org-name">{o.name}</td>
                  <td><code>{o.slug}</code></td>
                  <td>{o.staff_count ?? 0}</td>
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
              ))}
            </tbody>
          </table>
        </Card>

        {showForm && (
          <div className="org-modal-overlay" onClick={() => !saving && setShowForm(false)}>
            <div className="org-modal" onClick={(e) => e.stopPropagation()}>
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
                  <label>{t('organizations.currency', 'Moeda')}</label>
                  <select value={form.currency} onChange={(e) => setForm({ ...form, currency: e.target.value })}>
                    {Object.entries(CURRENCIES).map(([code, c]) => (
                      <option key={code} value={code}>{c.name}</option>
                    ))}
                  </select>
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
      </main>
    </div>
  );
};

export default Organizacoes;
