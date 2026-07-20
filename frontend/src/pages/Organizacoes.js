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
  const { toast } = useToast();
  const { isPlatformAdmin, loading: permLoading } = usePermissions();

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
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <SkeletonTableRow columns={4} rows={3} />
              ) : orgs.length === 0 ? (
                <tr><td colSpan={4}>
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
