import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import api from '../config/api';
import { supabase } from '../config/supabase';
import { useToast } from '../contexts/ToastContext';
import { useCurrency } from '../contexts/CurrencyContext';
import Button from './Button';
import EmptyState from './EmptyState';
import './ExpensesManager.css';

const BUCKET = 'comprovantes';

// A organização vem do token: o caminho do arquivo começa por ela e é isso que
// a policy do Storage compara para isolar os clubes.
const currentOrgId = () => {
  try {
    const tok = localStorage.getItem('supabase_token');
    return JSON.parse(atob(tok.split('.')[1])).organization_id || null;
  } catch (_) {
    return null;
  }
};

const fmtSize = (b) => {
  const n = Number(b) || 0;
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
};

// Aba "Despesas" do Financeiro. Os lançamentos ancoram numa ETAPA (fecham o DRE
// dela) e podem, opcionalmente, apontar um torneio específico.

const EMPTY = {
  stage_id: '', category_id: '', tournament_id: '',
  description: '', supplier: '', amount: '',
  status: 'pendente', due_date: '', payment_method: '', notes: '',
  paid_from_cash: true,
};

const fmtDate = (v, locale) => {
  if (!v) return '—';
  try { return new Date(v).toLocaleDateString(locale); } catch { return '—'; }
};

export default function ExpensesManager() {
  const { t, i18n } = useTranslation();
  const { toast, confirm } = useToast();
  const { formatCurrency } = useCurrency();

  const [stages, setStages] = useState([]);
  const [tournaments, setTournaments] = useState([]);
  const [categories, setCategories] = useState([]);
  const [expenses, setExpenses] = useState([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);

  const [filters, setFilters] = useState({ stage_id: '', category_id: '', status: '' });
  const [showForm, setShowForm] = useState(false);
  const [editing, setEditing] = useState(null);
  const [form, setForm] = useState(EMPTY);
  const [errors, setErrors] = useState({});

  // Modelos de despesa recorrente (aluguel, dealers…).
  const [templates, setTemplates] = useState([]);
  const [saveAsTemplate, setSaveAsTemplate] = useState(false);

  // Comprovantes da despesa aberta no modal de anexos.
  const [attachFor, setAttachFor] = useState(null);
  const [attachments, setAttachments] = useState([]);
  const [uploading, setUploading] = useState(false);

  // Listas auxiliares (uma vez).
  useEffect(() => {
    Promise.all([
      api.get('/stages').catch(() => ({ data: [] })),
      api.get('/tournaments').catch(() => ({ data: [] })),
      api.get('/expenses/categories', { params: { active: true } }).catch(() => ({ data: [] })),
      api.get('/expenses/templates').catch(() => ({ data: [] })),
    ]).then(([s, tr, c, tp]) => {
      setStages(s.data || []);
      setTournaments(tr.data || []);
      setCategories(c.data || []);
      setTemplates(tp.data || []);
    });
  }, []);

  const reloadTemplates = useCallback(async () => {
    try {
      const r = await api.get('/expenses/templates');
      setTemplates(r.data || []);
    } catch (_) { /* silencioso */ }
  }, []);

  // ── Comprovantes ────────────────────────────────────────────────────────
  const openAttachments = async (e) => {
    setAttachFor(e);
    setAttachments([]);
    try {
      const r = await api.get(`/expenses/${e.id}/attachments`);
      setAttachments(r.data || []);
    } catch (err) {
      toast.error(err.userMessage || t('expenses.attachLoadError', 'Erro ao carregar os comprovantes'));
    }
  };

  const uploadFile = async (file) => {
    if (!file || !attachFor) return;
    const org = currentOrgId();
    if (!org) {
      toast.error(t('expenses.attachNoOrg', 'Não foi possível identificar a organização.'));
      return;
    }
    setUploading(true);
    try {
      // Nome único: dois comprovantes com o mesmo nome não se sobrescrevem.
      const safe = file.name.replace(/[^\w.-]+/g, '_');
      const path = `${org}/${attachFor.id}/${Date.now()}-${safe}`;
      const { error: upErr } = await supabase.storage.from(BUCKET).upload(path, file, {
        contentType: file.type || 'application/octet-stream',
        upsert: false,
      });
      if (upErr) throw upErr;

      await api.post(`/expenses/${attachFor.id}/attachments`, {
        path,
        file_name: file.name,
        content_type: file.type || null,
        size_bytes: file.size,
      });
      toast.success(t('expenses.attachUploaded', 'Comprovante anexado.'));
      const r = await api.get(`/expenses/${attachFor.id}/attachments`);
      setAttachments(r.data || []);
      load();
    } catch (err) {
      toast.error(err.userMessage || err.message || t('expenses.attachError', 'Não foi possível anexar'));
    } finally {
      setUploading(false);
    }
  };

  const downloadAttachment = async (a) => {
    try {
      // URL assinada de vida curta: o bucket é privado, não há link público.
      const { data, error } = await supabase.storage.from(BUCKET).createSignedUrl(a.path, 60);
      if (error) throw error;
      window.open(data.signedUrl, '_blank', 'noopener');
    } catch (err) {
      toast.error(t('expenses.attachOpenError', 'Não foi possível abrir o comprovante'));
    }
  };

  const removeAttachment = async (a) => {
    setUploading(true);
    try {
      await api.delete(`/expenses/${attachFor.id}/attachments/${a.id}`);
      setAttachments((prev) => prev.filter((x) => x.id !== a.id));
      load();
    } catch (err) {
      toast.error(err.userMessage || t('expenses.attachError', 'Não foi possível remover'));
    } finally {
      setUploading(false);
    }
  };

  // ── Modelos ─────────────────────────────────────────────────────────────
  const applyTemplate = (id) => {
    const tp = templates.find((x) => x.id === id);
    if (!tp) return;
    setForm((f) => ({
      ...f,
      category_id: tp.category_id || '',
      description: tp.description || '',
      supplier: tp.supplier || '',
      amount: tp.amount != null ? String(tp.amount) : '',
    }));
  };

  const removeTemplate = async (tp) => {
    try {
      await api.delete(`/expenses/templates/${tp.id}`);
      reloadTemplates();
    } catch (err) {
      toast.error(err.userMessage || t('expenses.templateError', 'Não foi possível excluir o modelo'));
    }
  };

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = {};
      if (filters.stage_id) params.stage_id = filters.stage_id;
      if (filters.category_id) params.category_id = filters.category_id;
      if (filters.status) params.status = filters.status;
      const res = await api.get('/expenses', { params });
      setExpenses(res.data || []);
    } catch (err) {
      toast.error(err.userMessage || t('expenses.loadError', 'Erro ao carregar as despesas'));
    } finally {
      setLoading(false);
    }
  }, [filters, toast, t]);

  useEffect(() => { load(); }, [load]);

  const totals = useMemo(() => {
    let total = 0, paid = 0, pending = 0;
    for (const e of expenses) {
      const v = Number(e.amount) || 0;
      total += v;
      if (e.status === 'pago') paid += v; else pending += v;
    }
    return { total, paid, pending };
  }, [expenses]);

  const openNew = () => {
    setEditing(null);
    setForm({ ...EMPTY, stage_id: filters.stage_id || '' });
    setErrors({});
    setSaveAsTemplate(false);
    setShowForm(true);
  };

  const openEdit = (e) => {
    setEditing(e);
    setForm({
      stage_id: e.stage_id || '',
      category_id: e.category_id || '',
      tournament_id: e.tournament_id || '',
      description: e.description || '',
      supplier: e.supplier || '',
      amount: String(e.amount ?? ''),
      status: e.status || 'pendente',
      due_date: e.due_date || '',
      payment_method: e.payment_method || '',
      notes: e.notes || '',
      paid_from_cash: e.paid_from_cash !== false,
    });
    setErrors({});
    setSaveAsTemplate(false);
    setShowForm(true);
  };

  const validate = () => {
    const err = {};
    if (!form.stage_id) err.stage_id = t('expenses.required', 'Obrigatório');
    if (!form.description.trim()) err.description = t('expenses.required', 'Obrigatório');
    if (!(Number(form.amount) > 0)) err.amount = t('expenses.amountInvalid', 'Informe um valor maior que zero');
    setErrors(err);
    return Object.keys(err).length === 0;
  };

  const submit = async (ev) => {
    ev.preventDefault();
    if (!validate()) return;
    setBusy(true);
    try {
      // Campos vazios viram null: o backend ignora e o banco não recebe ''.
      const body = {
        stage_id: form.stage_id,
        category_id: form.category_id || null,
        tournament_id: form.tournament_id || null,
        description: form.description.trim(),
        supplier: form.supplier.trim() || null,
        amount: Number(form.amount),
        status: form.status,
        due_date: form.due_date || null,
        payment_method: form.payment_method || null,
        notes: form.notes.trim() || null,
        paid_from_cash: !!form.paid_from_cash,
      };
      if (editing) {
        const { stage_id, ...patch } = body; // etapa não muda depois de criada
        await api.patch(`/expenses/${editing.id}`, patch);
        toast.success(t('expenses.updated', 'Despesa atualizada.'));
      } else {
        await api.post('/expenses', body);
        toast.success(t('expenses.created', 'Despesa registrada.'));
      }
      // Guarda como modelo para reaplicar nas próximas etapas.
      if (saveAsTemplate) {
        try {
          await api.post('/expenses/templates', {
            name: body.description.slice(0, 80),
            category_id: body.category_id,
            description: body.description,
            supplier: body.supplier,
            amount: body.amount,
          });
          reloadTemplates();
        } catch (_) { /* não impede o salvamento da despesa */ }
      }
      setShowForm(false);
      load();
    } catch (err) {
      toast.error(err.userMessage || t('expenses.saveError', 'Não foi possível salvar a despesa'));
    } finally {
      setBusy(false);
    }
  };

  const togglePaid = async (e) => {
    setBusy(true);
    try {
      await api.patch(`/expenses/${e.id}`, { status: e.status === 'pago' ? 'pendente' : 'pago' });
      load();
    } catch (err) {
      toast.error(err.userMessage || t('expenses.saveError', 'Não foi possível salvar a despesa'));
    } finally {
      setBusy(false);
    }
  };

  const remove = async (e) => {
    const ok = await confirm(
      t('expenses.confirmDelete', 'Excluir "{{d}}"? Esta ação não pode ser desfeita.', { d: e.description }),
      { title: t('expenses.deleteTitle', 'Excluir despesa?'), variant: 'danger', confirmText: t('common.delete', 'Excluir') }
    );
    if (!ok) return;
    setBusy(true);
    try {
      await api.delete(`/expenses/${e.id}`);
      toast.success(t('expenses.deleted', 'Despesa excluída.'));
      load();
    } catch (err) {
      toast.error(err.userMessage || t('expenses.deleteError', 'Não foi possível excluir'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="exp-wrap">
      {/* Resumo */}
      <div className="exp-totals">
        <div className="exp-total-box">
          <span className="exp-total-label">{t('expenses.total', 'Total')}</span>
          <span className="exp-total-value">{formatCurrency(totals.total)}</span>
        </div>
        <div className="exp-total-box">
          <span className="exp-total-label">{t('expenses.paid', 'Pago')}</span>
          <span className="exp-total-value exp-paid">{formatCurrency(totals.paid)}</span>
        </div>
        <div className="exp-total-box">
          <span className="exp-total-label">{t('expenses.pending', 'A pagar')}</span>
          <span className="exp-total-value exp-pending">{formatCurrency(totals.pending)}</span>
        </div>
      </div>

      {/* Filtros + ação */}
      <div className="exp-toolbar">
        <div className="form-group">
          <label>{t('expenses.filterStage', 'Etapa')}</label>
          <select value={filters.stage_id} onChange={(e) => setFilters(p => ({ ...p, stage_id: e.target.value }))}>
            <option value="">{t('expenses.allStages', 'Todas as etapas')}</option>
            {stages.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        </div>
        <div className="form-group">
          <label>{t('expenses.filterCategory', 'Categoria')}</label>
          <select value={filters.category_id} onChange={(e) => setFilters(p => ({ ...p, category_id: e.target.value }))}>
            <option value="">{t('expenses.allCategories', 'Todas')}</option>
            {categories.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </div>
        <div className="form-group">
          <label>{t('common.status', 'Status')}</label>
          <select value={filters.status} onChange={(e) => setFilters(p => ({ ...p, status: e.target.value }))}>
            <option value="">{t('expenses.allStatus', 'Todos')}</option>
            <option value="pendente">{t('expenses.statusPending', 'A pagar')}</option>
            <option value="pago">{t('expenses.statusPaid', 'Pago')}</option>
          </select>
        </div>
        <div className="exp-toolbar-actions">
          <Button onClick={openNew}>+ {t('expenses.new', 'Nova despesa')}</Button>
        </div>
      </div>

      {/* Lista */}
      {loading ? (
        <p className="exp-loading">{t('common.loading', 'Carregando...')}</p>
      ) : expenses.length === 0 ? (
        <EmptyState
          title={t('expenses.emptyTitle', 'Nenhuma despesa registrada')}
          description={t('expenses.emptyDesc', 'Lance os gastos da etapa para o DRE fechar o resultado real.')}
        />
      ) : (
        <div className="table-container">
          <table className="exp-table">
            <thead>
              <tr>
                <th>{t('expenses.colDescription', 'Descrição')}</th>
                <th>{t('expenses.colCategory', 'Categoria')}</th>
                <th>{t('expenses.colStage', 'Etapa')}</th>
                <th>{t('expenses.colDue', 'Vencimento')}</th>
                <th className="exp-num">{t('expenses.colAmount', 'Valor')}</th>
                <th>{t('common.status', 'Status')}</th>
                <th>{t('common.actions', 'Ações')}</th>
              </tr>
            </thead>
            <tbody>
              {expenses.map((e) => (
                <tr key={e.id}>
                  <td>
                    <div className="exp-desc">{e.description}</div>
                    {(e.supplier || e.tournament_name || e.paid_from_cash === false) && (
                      <div className="exp-sub">
                        {e.supplier}
                        {e.supplier && e.tournament_name ? ' · ' : ''}
                        {e.tournament_name}
                        {e.paid_from_cash === false && (
                          <span className="exp-tag-outside">
                            {t('expenses.outsideTag', 'por fora')}
                          </span>
                        )}
                      </div>
                    )}
                  </td>
                  <td>{e.category_name || <span className="exp-muted">—</span>}</td>
                  <td>{e.stage_name || '—'}</td>
                  <td>{fmtDate(e.due_date, i18n.language)}</td>
                  <td className="exp-num">{formatCurrency(e.amount)}</td>
                  <td>
                    <button
                      type="button"
                      className={`exp-status exp-status--${e.status}`}
                      onClick={() => togglePaid(e)}
                      disabled={busy}
                      title={t('expenses.toggleHint', 'Clique para alternar')}
                    >
                      {e.status === 'pago' ? t('expenses.statusPaid', 'Pago') : t('expenses.statusPending', 'A pagar')}
                    </button>
                  </td>
                  <td>
                    <div className="exp-actions">
                      <Button size="small" variant="secondary" onClick={() => openAttachments(e)} disabled={busy}
                        title={t('expenses.attachments', 'Comprovantes')}>
                        📎
                      </Button>
                      <Button size="small" variant="secondary" onClick={() => openEdit(e)} disabled={busy}>
                        {t('common.edit', 'Editar')}
                      </Button>
                      <Button size="small" variant="danger" onClick={() => remove(e)} disabled={busy}>
                        {t('common.delete', 'Excluir')}
                      </Button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Formulário */}
      {showForm && (
        <div className="exp-modal-overlay" onClick={() => !busy && setShowForm(false)}>
          <div className="exp-modal" onClick={(ev) => ev.stopPropagation()}>
            <h2>{editing ? t('expenses.editTitle', 'Editar despesa') : t('expenses.new', 'Nova despesa')}</h2>

            {/* Modelos recorrentes: preenchem o formulário em um clique. */}
            {!editing && templates.length > 0 && (
              <div className="exp-field">
                <label>{t('expenses.useTemplate', 'Usar um modelo')}</label>
                <select defaultValue="" onChange={(e) => { applyTemplate(e.target.value); e.target.value = ''; }}>
                  <option value="">{t('expenses.pickTemplate', 'Selecione para preencher…')}</option>
                  {templates.map((tp) => (
                    <option key={tp.id} value={tp.id}>
                      {tp.name} — {formatCurrency(tp.amount)}
                    </option>
                  ))}
                </select>
                <div className="exp-template-chips">
                  {templates.map((tp) => (
                    <span className="exp-template-chip" key={tp.id}>
                      {tp.name}
                      <button type="button" onClick={() => removeTemplate(tp)} title={t('common.delete', 'Excluir')}>×</button>
                    </span>
                  ))}
                </div>
              </div>
            )}

            <form onSubmit={submit}>
              <div className="exp-field">
                <label>{t('expenses.colStage', 'Etapa')} *</label>
                <select
                  value={form.stage_id}
                  onChange={(e) => setForm({ ...form, stage_id: e.target.value, tournament_id: '' })}
                  disabled={!!editing}
                >
                  <option value="">{t('expenses.selectStage', 'Selecione a etapa')}</option>
                  {stages.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
                </select>
                {errors.stage_id && <span className="exp-error">{errors.stage_id}</span>}
              </div>

              <div className="exp-field">
                <label>{t('expenses.colDescription', 'Descrição')} *</label>
                <input
                  value={form.description}
                  onChange={(e) => setForm({ ...form, description: e.target.value })}
                  placeholder={t('expenses.descPlaceholder', 'Ex: 2 dealers - sábado')}
                />
                {errors.description && <span className="exp-error">{errors.description}</span>}
              </div>

              <div className="exp-row">
                <div className="exp-field">
                  <label>{t('expenses.colCategory', 'Categoria')}</label>
                  <select value={form.category_id} onChange={(e) => setForm({ ...form, category_id: e.target.value })}>
                    <option value="">{t('expenses.noCategory', 'Sem categoria')}</option>
                    {categories.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
                  </select>
                </div>
                <div className="exp-field">
                  <label>{t('expenses.colAmount', 'Valor')} *</label>
                  <input
                    type="number" step="0.01" min="0"
                    value={form.amount}
                    onChange={(e) => setForm({ ...form, amount: e.target.value })}
                    placeholder="0,00"
                  />
                  {errors.amount && <span className="exp-error">{errors.amount}</span>}
                </div>
              </div>

              <div className="exp-row">
                <div className="exp-field">
                  <label>{t('expenses.colSupplier', 'Fornecedor')}</label>
                  <input
                    value={form.supplier}
                    onChange={(e) => setForm({ ...form, supplier: e.target.value })}
                    placeholder={t('expenses.supplierPlaceholder', 'Opcional')}
                  />
                </div>
                <div className="exp-field">
                  <label>{t('expenses.colDue', 'Vencimento')}</label>
                  <input type="date" value={form.due_date} onChange={(e) => setForm({ ...form, due_date: e.target.value })} />
                </div>
              </div>

              <div className="exp-row">
                <div className="exp-field">
                  <label>{t('expenses.tournamentOptional', 'Torneio (opcional)')}</label>
                  <select value={form.tournament_id} onChange={(e) => setForm({ ...form, tournament_id: e.target.value })}>
                    <option value="">{t('expenses.wholeStage', 'Etapa inteira')}</option>
                    {tournaments
                      .filter(tr => !form.stage_id || tr.stage_id === form.stage_id)
                      .map(tr => <option key={tr.id} value={tr.id}>{tr.name}</option>)}
                  </select>
                </div>
                <div className="exp-field">
                  <label>{t('common.status', 'Status')}</label>
                  <select value={form.status} onChange={(e) => setForm({ ...form, status: e.target.value })}>
                    <option value="pendente">{t('expenses.statusPending', 'A pagar')}</option>
                    <option value="pago">{t('expenses.statusPaid', 'Pago')}</option>
                  </select>
                </div>
              </div>

              {/* Define se o pagamento sai do caixa geral do clube. */}
              <label className="exp-check">
                <input
                  type="checkbox"
                  checked={!form.paid_from_cash}
                  onChange={(e) => setForm({ ...form, paid_from_cash: !e.target.checked })}
                />
                <span>
                  {t('expenses.paidOutside', 'Pago por fora (banco) — não movimenta o caixa geral')}
                </span>
              </label>

              {!editing && (
                <label className="exp-check">
                  <input
                    type="checkbox"
                    checked={saveAsTemplate}
                    onChange={(e) => setSaveAsTemplate(e.target.checked)}
                  />
                  <span>{t('expenses.saveTemplate', 'Salvar como modelo — para reaplicar nas próximas etapas')}</span>
                </label>
              )}

              <div className="exp-modal-actions">
                <Button type="button" variant="secondary" onClick={() => setShowForm(false)} disabled={busy}>
                  {t('common.cancel', 'Cancelar')}
                </Button>
                <Button type="submit" disabled={busy}>
                  {busy ? t('common.saving', 'Salvando...') : t('common.save', 'Salvar')}
                </Button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Comprovantes: nota fiscal, recibo, foto do pagamento */}
      {attachFor && (
        <div className="exp-modal-overlay" onClick={() => !uploading && setAttachFor(null)}>
          <div className="exp-modal" onClick={(ev) => ev.stopPropagation()}>
            <h2>{t('expenses.attachments', 'Comprovantes')}</h2>
            <p className="exp-attach-sub">{attachFor.description}</p>

            {attachments.length === 0 ? (
              <p className="exp-attach-empty">{t('expenses.attachEmpty', 'Nenhum comprovante anexado.')}</p>
            ) : (
              <ul className="exp-attach-list">
                {attachments.map((a) => (
                  <li key={a.id} className="exp-attach-item">
                    <button type="button" className="exp-attach-name" onClick={() => downloadAttachment(a)}>
                      {a.file_name}
                    </button>
                    <span className="exp-attach-size">{fmtSize(a.size_bytes)}</span>
                    <button
                      type="button"
                      className="exp-attach-del"
                      onClick={() => removeAttachment(a)}
                      disabled={uploading}
                      title={t('common.delete', 'Excluir')}
                    >
                      ×
                    </button>
                  </li>
                ))}
              </ul>
            )}

            <label className="exp-upload">
              <input
                type="file"
                accept="image/*,application/pdf"
                disabled={uploading}
                onChange={(e) => { uploadFile(e.target.files?.[0]); e.target.value = ''; }}
              />
              <span>
                {uploading
                  ? t('expenses.attachUploading', 'Enviando…')
                  : t('expenses.attachAdd', 'Anexar comprovante (imagem ou PDF, até 10 MB)')}
              </span>
            </label>

            <div className="exp-modal-actions">
              <Button type="button" variant="secondary" onClick={() => setAttachFor(null)} disabled={uploading}>
                {t('common.close', 'Fechar')}
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
