import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import api from '../config/api';
import { useToast } from '../contexts/ToastContext';
import { useCurrency } from '../contexts/CurrencyContext';
import Button from './Button';
import EmptyState from './EmptyState';
// Reaproveita o visual da aba de despesas: mesma natureza de lançamento.
import './ExpensesManager.css';

// Aba "Outras receitas": bar/cozinha, patrocínio, aluguel de espaço. Faturamento
// que não passa pelo caixa de torneio e ficava fora do DRE.

const EMPTY = {
  stage_id: '', tournament_id: '', source: 'Bar/Cozinha',
  description: '', amount: '', status: 'pendente', to_cash: true, notes: '',
};

// Sugestões — o campo é livre, o cliente pode digitar outra origem.
const SOURCES = ['Bar/Cozinha', 'Patrocínio', 'Aluguel de espaço', 'Venda de produtos', 'Outros'];

export default function RevenuesManager() {
  const { t } = useTranslation();
  const { toast, confirm } = useToast();
  const { formatCurrency } = useCurrency();

  const [stages, setStages] = useState([]);
  const [tournaments, setTournaments] = useState([]);
  const [revenues, setRevenues] = useState([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);

  const [filters, setFilters] = useState({ stage_id: '', status: '' });
  const [showForm, setShowForm] = useState(false);
  const [editing, setEditing] = useState(null);
  const [form, setForm] = useState(EMPTY);
  const [errors, setErrors] = useState({});

  // Acessibilidade: o fundo escuro fecha no clique, mas quem usa só o teclado
  // precisa do Esc para sair do modal.
  useEffect(() => {
    if (!showForm) return undefined;
    const onKeyDown = (ev) => {
      if (ev.key === 'Escape' && !busy) setShowForm(false);
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [showForm, busy]);

  useEffect(() => {
    Promise.all([
      api.get('/stages').catch(() => ({ data: [] })),
      api.get('/tournaments').catch(() => ({ data: [] })),
    ]).then(([s, tr]) => {
      setStages(s.data || []);
      setTournaments(tr.data || []);
    });
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = {};
      if (filters.stage_id) params.stage_id = filters.stage_id;
      if (filters.status) params.status = filters.status;
      const res = await api.get('/revenues', { params });
      setRevenues(res.data || []);
    } catch (err) {
      toast.error(err.userMessage || t('revenues.loadError', 'Erro ao carregar as receitas'));
    } finally {
      setLoading(false);
    }
  }, [filters, toast, t]);

  useEffect(() => { load(); }, [load]);

  const totals = useMemo(() => {
    let total = 0, received = 0, pending = 0;
    for (const r of revenues) {
      const v = Number(r.amount) || 0;
      total += v;
      if (r.status === 'recebido') received += v; else pending += v;
    }
    return { total, received, pending };
  }, [revenues]);

  const openNew = () => {
    setEditing(null);
    setForm({ ...EMPTY, stage_id: filters.stage_id || '' });
    setErrors({});
    setShowForm(true);
  };

  const openEdit = (r) => {
    setEditing(r);
    setForm({
      stage_id: r.stage_id || '',
      tournament_id: r.tournament_id || '',
      source: r.source || 'Outros',
      description: r.description || '',
      amount: String(r.amount ?? ''),
      status: r.status || 'pendente',
      to_cash: r.to_cash !== false,
      notes: r.notes || '',
    });
    setErrors({});
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
      const body = {
        stage_id: form.stage_id,
        tournament_id: form.tournament_id || null,
        source: form.source || 'Outros',
        description: form.description.trim(),
        amount: Number(form.amount),
        status: form.status,
        to_cash: !!form.to_cash,
        notes: form.notes.trim() || null,
      };
      if (editing) {
        const { stage_id, ...patch } = body; // etapa não muda depois de criada
        await api.patch(`/revenues/${editing.id}`, patch);
        toast.success(t('revenues.updated', 'Receita atualizada.'));
      } else {
        await api.post('/revenues', body);
        toast.success(t('revenues.created', 'Receita registrada.'));
      }
      setShowForm(false);
      load();
    } catch (err) {
      toast.error(err.userMessage || t('revenues.saveError', 'Não foi possível salvar a receita'));
    } finally {
      setBusy(false);
    }
  };

  const toggleReceived = async (r) => {
    setBusy(true);
    try {
      await api.patch(`/revenues/${r.id}`, {
        status: r.status === 'recebido' ? 'pendente' : 'recebido',
      });
      load();
    } catch (err) {
      toast.error(err.userMessage || t('revenues.saveError', 'Não foi possível salvar a receita'));
    } finally {
      setBusy(false);
    }
  };

  const remove = async (r) => {
    const ok = await confirm(
      t('revenues.confirmDelete', 'Excluir "{{d}}"? Esta ação não pode ser desfeita.', { d: r.description }),
      { title: t('revenues.deleteTitle', 'Excluir receita?'), variant: 'danger', confirmText: t('common.delete', 'Excluir') }
    );
    if (!ok) return;
    setBusy(true);
    try {
      await api.delete(`/revenues/${r.id}`);
      toast.success(t('revenues.deleted', 'Receita excluída.'));
      load();
    } catch (err) {
      toast.error(err.userMessage || t('revenues.deleteError', 'Não foi possível excluir'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="exp-wrap">
      <div className="exp-totals">
        <div className="exp-total-box">
          <span className="exp-total-label">{t('expenses.total', 'Total')}</span>
          <span className="exp-total-value">{formatCurrency(totals.total)}</span>
        </div>
        <div className="exp-total-box">
          <span className="exp-total-label">{t('revenues.received', 'Recebido')}</span>
          <span className="exp-total-value exp-paid">{formatCurrency(totals.received)}</span>
        </div>
        <div className="exp-total-box">
          <span className="exp-total-label">{t('revenues.pending', 'A receber')}</span>
          <span className="exp-total-value exp-pending">{formatCurrency(totals.pending)}</span>
        </div>
      </div>

      <div className="exp-toolbar">
        <div className="form-group">
          <label>{t('expenses.filterStage', 'Etapa')}</label>
          <select value={filters.stage_id} onChange={(e) => setFilters(p => ({ ...p, stage_id: e.target.value }))}>
            <option value="">{t('expenses.allStages', 'Todas as etapas')}</option>
            {stages.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        </div>
        <div className="form-group">
          <label>{t('common.status', 'Status')}</label>
          <select value={filters.status} onChange={(e) => setFilters(p => ({ ...p, status: e.target.value }))}>
            <option value="">{t('expenses.allStatus', 'Todos')}</option>
            <option value="pendente">{t('revenues.statusPending', 'A receber')}</option>
            <option value="recebido">{t('revenues.statusReceived', 'Recebido')}</option>
          </select>
        </div>
        <div className="exp-toolbar-actions">
          <Button onClick={openNew}>+ {t('revenues.new', 'Nova receita')}</Button>
        </div>
      </div>

      {loading ? (
        <p className="exp-loading">{t('common.loading', 'Carregando...')}</p>
      ) : revenues.length === 0 ? (
        <EmptyState
          title={t('revenues.emptyTitle', 'Nenhuma receita registrada')}
          subtitle={t('revenues.emptyDesc', 'Registre bar, patrocínio e outras entradas para o DRE mostrar todo o faturamento.')}
        />
      ) : (
        <div className="table-container">
          <table className="exp-table">
            <thead>
              <tr>
                <th>{t('expenses.colDescription', 'Descrição')}</th>
                <th>{t('revenues.colSource', 'Origem')}</th>
                <th>{t('expenses.colStage', 'Etapa')}</th>
                <th className="exp-num">{t('expenses.colAmount', 'Valor')}</th>
                <th>{t('common.status', 'Status')}</th>
                <th>{t('common.actions', 'Ações')}</th>
              </tr>
            </thead>
            <tbody>
              {revenues.map((r) => (
                <tr key={r.id}>
                  <td>
                    <div className="exp-desc">{r.description}</div>
                    {(r.tournament_name || r.to_cash === false) && (
                      <div className="exp-sub">
                        {r.tournament_name}
                        {r.to_cash === false && (
                          <span className="exp-tag-outside">{t('revenues.outsideTag', 'fora do caixa')}</span>
                        )}
                      </div>
                    )}
                  </td>
                  <td>{r.source}</td>
                  <td>{r.stage_name || '—'}</td>
                  <td className="exp-num">{formatCurrency(r.amount)}</td>
                  <td>
                    <button
                      type="button"
                      className={`exp-status exp-status--${r.status === 'recebido' ? 'pago' : 'pendente'}`}
                      onClick={() => toggleReceived(r)}
                      disabled={busy}
                      title={t('expenses.toggleHint', 'Clique para alternar')}
                    >
                      {r.status === 'recebido'
                        ? t('revenues.statusReceived', 'Recebido')
                        : t('revenues.statusPending', 'A receber')}
                    </button>
                  </td>
                  <td>
                    <div className="exp-actions">
                      <Button size="small" variant="secondary" onClick={() => openEdit(r)} disabled={busy}>
                        {t('common.edit', 'Editar')}
                      </Button>
                      <Button size="small" variant="danger" onClick={() => remove(r)} disabled={busy}>
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

      {showForm && (
        <div
          className="exp-modal-overlay"
          role="presentation"
          onClick={(ev) => { if (ev.target === ev.currentTarget && !busy) setShowForm(false); }}
        >
          <div className="exp-modal" role="dialog" aria-modal="true">
            <h2>{editing ? t('revenues.editTitle', 'Editar receita') : t('revenues.new', 'Nova receita')}</h2>
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
                  placeholder={t('revenues.descPlaceholder', 'Ex: vendas do bar - sábado')}
                />
                {errors.description && <span className="exp-error">{errors.description}</span>}
              </div>

              <div className="exp-row">
                <div className="exp-field">
                  <label>{t('revenues.colSource', 'Origem')}</label>
                  <input
                    list="rev-sources"
                    value={form.source}
                    onChange={(e) => setForm({ ...form, source: e.target.value })}
                  />
                  <datalist id="rev-sources">
                    {SOURCES.map(s => <option key={s} value={s} />)}
                  </datalist>
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
                    <option value="pendente">{t('revenues.statusPending', 'A receber')}</option>
                    <option value="recebido">{t('revenues.statusReceived', 'Recebido')}</option>
                  </select>
                </div>
              </div>

              <label className="exp-check">
                <input
                  type="checkbox"
                  checked={!form.to_cash}
                  onChange={(e) => setForm({ ...form, to_cash: !e.target.checked })}
                />
                <span>{t('revenues.notToCash', 'Recebido por fora (banco) — não entra no caixa geral')}</span>
              </label>

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
    </div>
  );
}
