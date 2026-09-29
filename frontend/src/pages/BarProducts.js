import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import api from '../config/api';
import Sidebar from '../components/Sidebar';
import Button from '../components/Button';
import Card from '../components/Card';
import Segmented from '../components/Segmented';
import EmptyState from '../components/EmptyState';
import { SkeletonTableRow } from '../components/SkeletonLoader';
import { useToast } from '../contexts/ToastContext';
import { useCurrency } from '../contexts/CurrencyContext';
import { useEscapeKey } from '../hooks/useEscapeKey';
import './CashFloor.css';
import './Bar.css';

/**
 * PRODUTOS do bar: o catálogo e o estoque.
 *
 * O catálogo é da organização — a cerveja é a mesma todo turno. A comanda
 * COPIA nome, preço e custo no item (snapshot): mudar o preço aqui amanhã não
 * reescreve a comanda de ontem, e é por isso que editar um produto em uso é
 * seguro.
 *
 * ESTOQUE SÓ MUDA POR MOVIMENTO (entrada, ajuste, perda). A venda baixa e o
 * cancelamento devolve, por trigger no banco. O formulário do produto não tem
 * campo de estoque de propósito: editar o número à mão desalinharia o ledger
 * sem ninguém saber quando.
 *
 * CUSTO MÉDIO PONDERADO. Cada entrada com custo entra na média com o estoque
 * que já existe (trigger bar_stock_weighted_cost no banco): 24 un a 4,50 e
 * depois 24 a 5,00 dão 4,75 — e não 5,00 para tudo, que recusteava o estoque
 * antigo pelo último preço.
 */
const PRODUTO_VAZIO = {
  name: '', category_id: '', description: '', price: '', cost_price: '0',
  sku: '', track_stock: false, min_stock: '0', active: true, sort_order: '0',
};
const CATEGORIA_VAZIA = { name: '', sort_order: '0', active: true };
const ESTOQUE_VAZIO = { kind: 'in', quantity: '', cost_mode: 'unit', unit_cost: '', total_cost: '', notes: '' };

const novoId = () => (window.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`);

const numero = (v) => {
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : null;
};

/** Custo unitário da entrada, pelo modo escolhido (unitário ou total da nota). */
export const custoDaEntrada = (form) => {
  const qtd = parseInt(form.quantity, 10);
  if (form.cost_mode === 'total') {
    const total = numero(form.total_cost);
    return total !== null && qtd > 0 ? total / qtd : null;
  }
  return numero(form.unit_cost);
};

/** A mesma conta do trigger do banco — só para a prévia na tela. */
export const custoMedioApos = ({ estoque, custoAtual, quantidade, custoEntrada }) => {
  const saldo = Math.max(Number(estoque) || 0, 0);
  const atual = Number(custoAtual) || 0;
  if (!(quantidade > 0) || custoEntrada === null) return null;
  if (saldo === 0 || atual === 0) return custoEntrada;
  return (saldo * atual + quantidade * custoEntrada) / (saldo + quantidade);
};

const BarProducts = () => {
  const { t, i18n } = useTranslation();
  const { toast } = useToast();
  const { formatCurrency } = useCurrency();

  const [tab, setTab] = useState('products');
  const [products, setProducts] = useState([]);
  const [categories, setCategories] = useState([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [categoryFilter, setCategoryFilter] = useState('');

  const [editing, setEditing] = useState(null);       // produto: {} | row | null
  const [form, setForm] = useState(PRODUTO_VAZIO);
  const [editingCat, setEditingCat] = useState(null); // categoria
  const [catForm, setCatForm] = useState(CATEGORIA_VAZIA);
  const [stockFor, setStockFor] = useState(null);     // produto do movimento
  const [stockForm, setStockForm] = useState(ESTOQUE_VAZIO);
  const [movements, setMovements] = useState(null);   // histórico do produto aberto
  const [submitting, setSubmitting] = useState(false);

  const algumModal = !!(editing || editingCat || stockFor);
  useEscapeKey(algumModal, () => {
    if (submitting) return;
    setEditing(null); setEditingCat(null); setStockFor(null);
  });

  const load = useCallback(async () => {
    try {
      const [p, c] = await Promise.all([
        api.get('/bar/products', { _silentError: true }).catch(() => ({ data: [] })),
        api.get('/bar/categories', { _silentError: true }).catch(() => ({ data: [] })),
      ]);
      setProducts(p.data || []);
      setCategories(c.data || []);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { setLoading(true); load(); }, [load]);

  const visiveis = useMemo(() => {
    const termo = search.trim().toLowerCase();
    return products.filter((p) => {
      if (categoryFilter && p.category_id !== categoryFilter) return false;
      if (!termo) return true;
      return (p.name || '').toLowerCase().includes(termo) || (p.sku || '').toLowerCase().includes(termo);
    });
  }, [products, search, categoryFilter]);

  const estoqueBaixo = useMemo(() => products.filter((p) => p.low_stock).length, [products]);

  const dataHora = (iso) => {
    if (!iso) return '—';
    try {
      return new Date(iso).toLocaleString(i18n?.language, { dateStyle: 'short', timeStyle: 'short' });
    } catch {
      return iso;
    }
  };

  // ── Produto ──
  const abrirNovo = () => { setForm(PRODUTO_VAZIO); setEditing({}); };
  const abrirEdicao = (p) => {
    setForm({
      name: p.name, category_id: p.category_id || '', description: p.description || '',
      price: String(p.price), cost_price: String(p.cost_price ?? 0), sku: p.sku || '',
      track_stock: !!p.track_stock, min_stock: String(p.min_stock ?? 0),
      active: p.active, sort_order: String(p.sort_order ?? 0),
    });
    setEditing(p);
  };

  const salvar = async (e) => {
    e.preventDefault();
    setSubmitting(true);
    const corpo = {
      name: form.name,
      category_id: form.category_id || null,
      description: form.description || null,
      price: parseFloat(form.price),
      cost_price: parseFloat(form.cost_price || 0),
      sku: form.sku || null,
      track_stock: form.track_stock,
      min_stock: parseInt(form.min_stock || 0, 10),
      active: form.active,
      sort_order: parseInt(form.sort_order || 0, 10),
    };
    try {
      if (editing?.id) await api.patch(`/bar/products/${editing.id}`, corpo);
      else await api.post('/bar/products', corpo);
      toast.success(t('bar.productSaved', 'Produto salvo'));
      setEditing(null);
      await load();
    } catch (err) {
      toast.error(err.userMessage || t('bar.productError', 'Não foi possível salvar o produto'));
    } finally {
      setSubmitting(false);
    }
  };

  const remover = async (p) => {
    try {
      const res = await api.delete(`/bar/products/${p.id}`);
      toast.success(res.data?.deactivated
        ? t('bar.productDeactivated', 'Produto desativado (já foi vendido)')
        : t('bar.productRemoved', 'Produto removido'));
      await load();
    } catch (err) {
      toast.error(err.userMessage || t('bar.productError', 'Não foi possível salvar o produto'));
    }
  };

  // ── Estoque ──
  const abrirEstoque = async (p) => {
    setStockForm(ESTOQUE_VAZIO);
    setStockFor(p);
    setMovements(null);
    const res = await api
      .get(`/bar/products/${p.id}/stock-movements`, { params: { limit: 20 }, _silentError: true })
      .catch(() => ({ data: [] }));
    setMovements(res?.data || []);
  };

  const custoEntrada = stockForm.kind === 'in' ? custoDaEntrada(stockForm) : null;
  const previaDoCusto = stockFor && stockForm.kind === 'in'
    ? custoMedioApos({
      estoque: stockFor.stock_qty,
      custoAtual: stockFor.cost_price,
      quantidade: parseInt(stockForm.quantity, 10),
      custoEntrada,
    })
    : null;

  const lancarEstoque = async (e) => {
    e.preventDefault();
    setSubmitting(true);
    const entrada = stockForm.kind === 'in';
    const porTotal = entrada && stockForm.cost_mode === 'total';
    try {
      await api.post(`/bar/products/${stockFor.id}/stock-movements`, {
        kind: stockForm.kind,
        quantity: parseInt(stockForm.quantity, 10),
        unit_cost: entrada && !porTotal ? numero(stockForm.unit_cost) : null,
        total_cost: porTotal ? numero(stockForm.total_cost) : null,
        notes: stockForm.notes || null,
        client_mutation_id: novoId(),
      });
      toast.success(t('bar.stockSaved', 'Estoque atualizado'));
      setStockFor(null);
      await load();
    } catch (err) {
      toast.error(err.userMessage || t('bar.stockError', 'Não foi possível lançar o estoque'));
    } finally {
      setSubmitting(false);
    }
  };

  const rotuloDoMovimento = (kind) => ({
    in: t('bar.kindIn', 'Entrada'),
    adjustment: t('bar.kindAdjustmentShort', 'Ajuste'),
    loss: t('bar.kindLossShort', 'Perda'),
    sale: t('bar.kindSale', 'Venda'),
    cancel_restore: t('bar.kindCancelRestore', 'Devolução'),
  }[kind] || kind);

  // ── Categoria ──
  const abrirNovaCat = () => { setCatForm(CATEGORIA_VAZIA); setEditingCat({}); };
  const abrirEdicaoCat = (c) => {
    setCatForm({ name: c.name, sort_order: String(c.sort_order ?? 0), active: c.active });
    setEditingCat(c);
  };
  const salvarCat = async (e) => {
    e.preventDefault();
    setSubmitting(true);
    const corpo = { name: catForm.name, sort_order: parseInt(catForm.sort_order || 0, 10), active: catForm.active };
    try {
      if (editingCat?.id) await api.patch(`/bar/categories/${editingCat.id}`, corpo);
      else await api.post('/bar/categories', corpo);
      toast.success(t('bar.categorySaved', 'Categoria salva'));
      setEditingCat(null);
      await load();
    } catch (err) {
      toast.error(err.userMessage || t('bar.categoryError', 'Não foi possível salvar a categoria'));
    } finally {
      setSubmitting(false);
    }
  };
  const removerCat = async (c) => {
    try {
      await api.delete(`/bar/categories/${c.id}`);
      toast.success(t('bar.categoryRemoved', 'Categoria removida'));
      await load();
    } catch (err) {
      toast.error(err.userMessage || t('bar.categoryError', 'Não foi possível salvar a categoria'));
    }
  };

  const estoqueCelula = (p) => {
    if (!p.track_stock) return <span className="bar-muted">{t('bar.noStockControl', 'sem controle')}</span>;
    const neg = p.stock_qty < 0;
    return (
      <>
        <strong>{p.stock_qty}</strong>
        <span className="bar-muted"> / {t('bar.minShort', 'mín.')} {p.min_stock}</span>
        {p.low_stock && (
          <>
            {' '}
            <span className={`badge badge-plain ${neg ? 'badge-danger' : 'badge-warning'}`}>
              {neg ? t('bar.negativeStock', 'negativo') : t('bar.lowStock', 'baixo')}
            </span>
          </>
        )}
      </>
    );
  };

  const statusBadge = (ativo, rotuloAtivo, rotuloInativo) => (
    <span className={`badge ${ativo ? 'badge-success' : 'badge-secondary'}`}>
      {ativo ? rotuloAtivo : rotuloInativo}
    </span>
  );

  return (
    <div className="app-container">
      <Sidebar />
      <main className="main-content bar-page">
        <div className="page-header">
          <div>
            <h1>{t('bar.products', 'Produtos')}</h1>
            <p>
              {t('bar.productsSubtitle', 'Catálogo e estoque do bar. A comanda guarda um retrato do preço na venda — editar aqui não muda comandas já lançadas.')}
            </p>
          </div>
          {tab === 'products' ? (
            <Button variant="primary" onClick={abrirNovo}>
              {t('bar.newProduct', 'Novo produto')}
            </Button>
          ) : (
            <Button variant="primary" onClick={abrirNovaCat}>
              {t('bar.newCategory', 'Nova categoria')}
            </Button>
          )}
        </div>

        <Segmented
          className="bar-seg"
          ariaLabel={t('bar.productsSections', 'Seções do catálogo')}
          options={[
            { value: 'products', label: t('bar.products', 'Produtos') },
            { value: 'categories', label: t('bar.categories', 'Categorias') },
          ]}
          value={tab}
          onChange={setTab}
        />

        {tab === 'products' && (
          <>
            {estoqueBaixo > 0 && (
              <p className="bar-warning">
                {t('bar.lowStockWarning', '{{count}} produto(s) com estoque no mínimo ou abaixo.', { count: estoqueBaixo })}
              </p>
            )}
            <div className="bar-filters">
              <div className="form-group">
                <label htmlFor="bp-search">{t('common.search', 'Buscar')}</label>
                <input id="bp-search" type="text" value={search} onChange={(e) => setSearch(e.target.value)}
                       placeholder={t('bar.searchProduct', 'Nome ou código')} />
              </div>
              <div className="form-group">
                <label htmlFor="bp-cat">{t('bar.category', 'Categoria')}</label>
                <select id="bp-cat" value={categoryFilter} onChange={(e) => setCategoryFilter(e.target.value)}>
                  <option value="">{t('common.all', 'Todas')}</option>
                  {categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                </select>
              </div>
            </div>

            {loading ? (
              <Card className="bar-card">
                <table className="bar-table"><tbody>
                  <SkeletonTableRow cols={6} /><SkeletonTableRow cols={6} />
                </tbody></table>
              </Card>
            ) : products.length === 0 ? (
              <EmptyState
                icon={null}
                title={t('bar.noProductsTitle', 'Nenhum produto cadastrado')}
                subtitle={t('bar.noProducts', 'Cadastre os produtos do bar (nome, preço, custo) para começar a lançar comandas.')}
                ctaLabel={t('bar.newProduct', 'Novo produto')}
                onCta={abrirNovo}
              />
            ) : (
              <Card className="bar-card">
                <table className="bar-table">
                  <thead>
                    <tr>
                      <th>{t('bar.product', 'Produto')}</th>
                      <th>{t('bar.category', 'Categoria')}</th>
                      <th className="bar-num">{t('bar.price', 'Preço')}</th>
                      <th className="bar-num">{t('bar.avgCost', 'Custo médio')}</th>
                      <th>{t('bar.stock', 'Estoque')}</th>
                      <th>{t('common.status', 'Status')}</th>
                      <th className="bar-th-actions" aria-label={t('common.actions', 'Ações')} />
                    </tr>
                  </thead>
                  <tbody>
                    {visiveis.map((p) => (
                      <tr key={p.id} className={`${p.active ? '' : 'bar-inactive'} ${p.low_stock ? 'bar-low-stock' : ''}`}>
                        <td>
                          <strong>{p.name}</strong>
                          {p.sku && <div className="bar-muted">{p.sku}</div>}
                        </td>
                        <td>{p.category_name || '—'}</td>
                        <td className="bar-num">{formatCurrency(p.price)}</td>
                        <td className="bar-num">{formatCurrency(p.cost_price || 0)}</td>
                        <td>{estoqueCelula(p)}</td>
                        <td>{statusBadge(p.active, t('common.active', 'Ativo'), t('common.inactive', 'Inativo'))}</td>
                        <td>
                          <div className="bar-actions">
                            {p.track_stock && (
                              <Button variant="secondary" size="small" onClick={() => abrirEstoque(p)}>
                                {t('bar.stockMovement', 'Estoque')}
                              </Button>
                            )}
                            <Button variant="secondary" size="small" onClick={() => abrirEdicao(p)}>
                              {t('common.edit', 'Editar')}
                            </Button>
                            <Button variant="danger" size="small" onClick={() => remover(p)}>
                              {t('common.delete', 'Excluir')}
                            </Button>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </Card>
            )}
          </>
        )}

        {tab === 'categories' && (
          loading ? (
            <Card className="bar-card">
              <table className="bar-table"><tbody><SkeletonTableRow cols={4} /></tbody></table>
            </Card>
          ) : categories.length === 0 ? (
            <EmptyState
              icon={null}
              title={t('bar.noCategoriesTitle', 'Nenhuma categoria')}
              subtitle={t('bar.noCategories', 'Categorias agrupam os produtos na tela de comandas (Bebidas, Cervejas, Petiscos...).')}
              ctaLabel={t('bar.newCategory', 'Nova categoria')}
              onCta={abrirNovaCat}
            />
          ) : (
            <Card className="bar-card">
              <table className="bar-table">
                <thead>
                  <tr>
                    <th>{t('bar.category', 'Categoria')}</th>
                    <th className="bar-num">{t('bar.order', 'Ordem')}</th>
                    <th className="bar-num">{t('bar.products', 'Produtos')}</th>
                    <th>{t('common.status', 'Status')}</th>
                    <th className="bar-th-actions" aria-label={t('common.actions', 'Ações')} />
                  </tr>
                </thead>
                <tbody>
                  {categories.map((c) => (
                    <tr key={c.id} className={c.active ? '' : 'bar-inactive'}>
                      <td><strong>{c.name}</strong></td>
                      <td className="bar-num">{c.sort_order}</td>
                      <td className="bar-num">{c.products_count}</td>
                      <td>{statusBadge(c.active, t('common.active', 'Ativa'), t('common.inactive', 'Inativa'))}</td>
                      <td>
                        <div className="bar-actions">
                          <Button variant="secondary" size="small" onClick={() => abrirEdicaoCat(c)}>
                            {t('common.edit', 'Editar')}
                          </Button>
                          <Button variant="danger" size="small" onClick={() => removerCat(c)}
                                  disabled={c.products_count > 0}
                                  title={c.products_count > 0 ? t('bar.categoryHasProducts', 'Mova os produtos antes de remover') : undefined}>
                            {t('common.delete', 'Excluir')}
                          </Button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Card>
          )
        )}

        {editing && (
          <div className="modal-overlay"
               onClick={(e) => { if (e.target === e.currentTarget && !submitting) setEditing(null); }}>
            <div className="modal" role="dialog" aria-modal="true">
              <h2>{editing.id ? t('bar.editProduct', 'Editar produto') : t('bar.newProduct', 'Novo produto')}</h2>
              <form onSubmit={salvar}>
                <div className="form-group">
                  <label htmlFor="bp-name">{t('bar.productName', 'Nome')}</label>
                  <input id="bp-name" type="text" value={form.name} required
                         onChange={(e) => setForm({ ...form, name: e.target.value })} />
                </div>
                <div className="bar-row">
                  <div className="form-group">
                    <label htmlFor="bp-category">{t('bar.category', 'Categoria')}</label>
                    <select id="bp-category" value={form.category_id}
                            onChange={(e) => setForm({ ...form, category_id: e.target.value })}>
                      <option value="">—</option>
                      {categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                    </select>
                  </div>
                  <div className="form-group">
                    <label htmlFor="bp-sku">{t('bar.sku', 'Código')}</label>
                    <input id="bp-sku" type="text" value={form.sku}
                           onChange={(e) => setForm({ ...form, sku: e.target.value })} />
                  </div>
                </div>
                <div className="bar-row">
                  <div className="form-group">
                    <label htmlFor="bp-price">{t('bar.price', 'Preço')}</label>
                    <input id="bp-price" type="number" step="0.01" min="0" required value={form.price}
                           onChange={(e) => setForm({ ...form, price: e.target.value })} />
                  </div>
                  <div className="form-group">
                    <label htmlFor="bp-cost">{t('bar.cost', 'Custo')}</label>
                    <input id="bp-cost" type="number" step="0.0001" min="0" value={form.cost_price}
                           onChange={(e) => setForm({ ...form, cost_price: e.target.value })} />
                    <small className="form-hint">
                      {t('bar.costHintAvg', 'Custo médio do estoque, usado na margem dos relatórios. As entradas de estoque com custo recalculam a média sozinhas.')}
                    </small>
                  </div>
                </div>
                <div className="form-group">
                  <label htmlFor="bp-desc">{t('bar.description', 'Descrição')}</label>
                  <input id="bp-desc" type="text" value={form.description}
                         onChange={(e) => setForm({ ...form, description: e.target.value })} />
                </div>
                <div className="bar-row">
                  <div className="form-group bar-check">
                    <label htmlFor="bp-track">
                      <input id="bp-track" type="checkbox" checked={form.track_stock}
                             onChange={(e) => setForm({ ...form, track_stock: e.target.checked })} />
                      {' '}{t('bar.trackStock', 'Controlar estoque')}
                    </label>
                  </div>
                  {form.track_stock && (
                    <div className="form-group">
                      <label htmlFor="bp-min">{t('bar.minStock', 'Estoque mínimo')}</label>
                      <input id="bp-min" type="number" min="0" value={form.min_stock}
                             onChange={(e) => setForm({ ...form, min_stock: e.target.value })} />
                    </div>
                  )}
                  <div className="form-group">
                    <label htmlFor="bp-order">{t('bar.order', 'Ordem')}</label>
                    <input id="bp-order" type="number" value={form.sort_order}
                           onChange={(e) => setForm({ ...form, sort_order: e.target.value })} />
                  </div>
                </div>
                {form.track_stock && (
                  <p className="bar-note">
                    {t('bar.stockNote', 'O estoque muda por Entrada, Ajuste ou Perda (botão Estoque na lista) — a venda baixa e o cancelamento devolve sozinhos. A venda nunca é bloqueada por estoque: se ficar negativo, é a contagem que está errada.')}
                  </p>
                )}
                <div className="form-group bar-check">
                  <label htmlFor="bp-active">
                    <input id="bp-active" type="checkbox" checked={form.active}
                           onChange={(e) => setForm({ ...form, active: e.target.checked })} />
                    {' '}{t('common.active', 'Ativo')}
                  </label>
                </div>
                <div className="modal-actions">
                  <Button variant="secondary" onClick={() => setEditing(null)} disabled={submitting}>
                    {t('common.cancel', 'Cancelar')}
                  </Button>
                  <Button type="submit" variant="primary" disabled={submitting}>
                    {submitting ? t('common.saving', 'Salvando...') : t('common.save', 'Salvar')}
                  </Button>
                </div>
              </form>
            </div>
          </div>
        )}

        {stockFor && (
          <div className="modal-overlay"
               onClick={(e) => { if (e.target === e.currentTarget && !submitting) setStockFor(null); }}>
            <div className="modal bar-modal-wide" role="dialog" aria-modal="true">
              <h2>{t('bar.stockMovementTitle', 'Estoque: {{name}}', { name: stockFor.name })}</h2>
              <form onSubmit={lancarEstoque}>
                <p className="bar-muted bar-stock-now">
                  <span>{t('bar.currentStock', 'Estoque atual: {{qty}}', { qty: stockFor.stock_qty })}</span>
                  <span>{t('bar.currentAvgCost', 'Custo médio: {{value}}', { value: formatCurrency(stockFor.cost_price || 0) })}</span>
                </p>
                <div className="bar-row">
                  <div className="form-group">
                    <label htmlFor="bs-kind">{t('bar.movementKind', 'Tipo')}</label>
                    <select id="bs-kind" value={stockForm.kind}
                            onChange={(e) => setStockForm({ ...stockForm, kind: e.target.value })}>
                      <option value="in">{t('bar.kindIn', 'Entrada')}</option>
                      <option value="adjustment">{t('bar.kindAdjustment', 'Ajuste (±)')}</option>
                      <option value="loss">{t('bar.kindLoss', 'Perda / quebra')}</option>
                    </select>
                  </div>
                  <div className="form-group">
                    <label htmlFor="bs-qty">{t('bar.quantity', 'Quantidade')}</label>
                    <input id="bs-qty" type="number" step="1" required value={stockForm.quantity}
                           min={stockForm.kind === 'adjustment' ? undefined : '1'}
                           onChange={(e) => setStockForm({ ...stockForm, quantity: e.target.value })} />
                  </div>
                </div>

                {stockForm.kind === 'in' && (
                  <>
                    <Segmented
                      className="bar-seg bar-seg--sm"
                      ariaLabel={t('bar.costModeLabel', 'Como informar o custo')}
                      options={[
                        { value: 'unit', label: t('bar.costModeUnit', 'Por unidade') },
                        { value: 'total', label: t('bar.costModeTotal', 'Total da nota') },
                      ]}
                      value={stockForm.cost_mode}
                      onChange={(v) => setStockForm({ ...stockForm, cost_mode: v })}
                    />
                    {stockForm.cost_mode === 'unit' ? (
                      <div className="form-group">
                        <label htmlFor="bs-cost">{t('bar.unitCost', 'Custo unitário')}</label>
                        <input id="bs-cost" type="number" step="0.0001" min="0" value={stockForm.unit_cost}
                               onChange={(e) => setStockForm({ ...stockForm, unit_cost: e.target.value })} />
                      </div>
                    ) : (
                      <div className="form-group">
                        <label htmlFor="bs-total">{t('bar.totalCost', 'Total da nota')}</label>
                        <input id="bs-total" type="number" step="0.01" min="0" value={stockForm.total_cost}
                               onChange={(e) => setStockForm({ ...stockForm, total_cost: e.target.value })} />
                        {custoEntrada !== null && (
                          <small className="form-hint">
                            {t('bar.unitFromTotal', '= {{value}} por unidade', { value: formatCurrency(custoEntrada) })}
                          </small>
                        )}
                      </div>
                    )}
                    <p className="bar-note">
                      {previaDoCusto !== null
                        ? t('bar.avgCostPreview', 'Novo custo médio: {{value}} (antes {{before}}).', {
                          value: formatCurrency(previaDoCusto),
                          before: formatCurrency(stockFor.cost_price || 0),
                        })
                        : t('bar.unitCostHintAvg', 'Se informado, o custo entra na média ponderada com o estoque atual. Sem custo, a média não muda.')}
                    </p>
                  </>
                )}

                <div className="form-group">
                  <label htmlFor="bs-notes">{t('bar.notes', 'Observação')}</label>
                  <input id="bs-notes" type="text" value={stockForm.notes}
                         onChange={(e) => setStockForm({ ...stockForm, notes: e.target.value })} />
                </div>
                <div className="modal-actions">
                  <Button variant="secondary" onClick={() => setStockFor(null)} disabled={submitting}>
                    {t('common.cancel', 'Cancelar')}
                  </Button>
                  <Button type="submit" variant="primary" disabled={submitting}>
                    {submitting ? t('common.saving', 'Salvando...') : t('bar.registerMovement', 'Lançar')}
                  </Button>
                </div>
              </form>

              <section className="bar-history" aria-label={t('bar.movementHistory', 'Últimas movimentações')}>
                <h3>{t('bar.movementHistory', 'Últimas movimentações')}</h3>
                {movements === null ? (
                  <p className="bar-muted">{t('common.loading', 'Carregando...')}</p>
                ) : movements.length === 0 ? (
                  <p className="bar-muted">{t('bar.noMovements', 'Nenhuma movimentação ainda.')}</p>
                ) : (
                  <div className="bar-history__scroll">
                    <table className="bar-table bar-table--compact">
                      <thead>
                        <tr>
                          <th>{t('bar.date', 'Data')}</th>
                          <th>{t('bar.movementKind', 'Tipo')}</th>
                          <th className="bar-num">{t('bar.quantity', 'Quantidade')}</th>
                          <th className="bar-num">{t('bar.unitCost', 'Custo unitário')}</th>
                          <th className="bar-num">{t('bar.total', 'Total')}</th>
                          <th>{t('bar.notes', 'Observação')}</th>
                        </tr>
                      </thead>
                      <tbody>
                        {movements.map((m) => {
                          const total = m.total_cost ?? (m.unit_cost != null ? m.unit_cost * Math.abs(m.quantity) : null);
                          return (
                            <tr key={m.id}>
                              <td className="bar-nw">{dataHora(m.created_at)}</td>
                              <td>{rotuloDoMovimento(m.kind)}</td>
                              <td className="bar-num">{m.quantity > 0 ? `+${m.quantity}` : m.quantity}</td>
                              <td className="bar-num">{m.unit_cost != null ? formatCurrency(m.unit_cost) : '—'}</td>
                              <td className="bar-num">{m.kind === 'in' && total != null ? formatCurrency(total) : '—'}</td>
                              <td>{m.notes || ''}</td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                )}
              </section>
            </div>
          </div>
        )}

        {editingCat && (
          <div className="modal-overlay"
               onClick={(e) => { if (e.target === e.currentTarget && !submitting) setEditingCat(null); }}>
            <div className="modal" role="dialog" aria-modal="true">
              <h2>{editingCat.id ? t('bar.editCategory', 'Editar categoria') : t('bar.newCategory', 'Nova categoria')}</h2>
              <form onSubmit={salvarCat}>
                <div className="form-group">
                  <label htmlFor="bc-name">{t('bar.categoryName', 'Nome')}</label>
                  <input id="bc-name" type="text" value={catForm.name} required
                         onChange={(e) => setCatForm({ ...catForm, name: e.target.value })} />
                </div>
                <div className="bar-row">
                  <div className="form-group">
                    <label htmlFor="bc-order">{t('bar.order', 'Ordem')}</label>
                    <input id="bc-order" type="number" value={catForm.sort_order}
                           onChange={(e) => setCatForm({ ...catForm, sort_order: e.target.value })} />
                  </div>
                  <div className="form-group bar-check">
                    <label htmlFor="bc-active">
                      <input id="bc-active" type="checkbox" checked={catForm.active}
                             onChange={(e) => setCatForm({ ...catForm, active: e.target.checked })} />
                      {' '}{t('common.active', 'Ativa')}
                    </label>
                  </div>
                </div>
                <div className="modal-actions">
                  <Button variant="secondary" onClick={() => setEditingCat(null)} disabled={submitting}>
                    {t('common.cancel', 'Cancelar')}
                  </Button>
                  <Button type="submit" variant="primary" disabled={submitting}>
                    {submitting ? t('common.saving', 'Salvando...') : t('common.save', 'Salvar')}
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

export default BarProducts;
