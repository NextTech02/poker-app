import React, { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useCurrency } from '../contexts/CurrencyContext';
import './BarProductGrid.css';

/**
 * A grade de produtos da POS: abas de categoria + busca + tiles de toque.
 * Um toque lança UMA unidade na comanda selecionada — o barman toca duas
 * vezes para duas cervejas, como numa máquina de bar.
 *
 * @param {Array}    products    catálogo (ativos)
 * @param {Array}    categories
 * @param {function} onPick(product)
 * @param {boolean}  disabled    sem comanda selecionada
 */
const BarProductGrid = ({ products = [], categories = [], onPick, disabled = false }) => {
  const { t } = useTranslation();
  const { formatCurrency } = useCurrency();
  const [category, setCategory] = useState('');
  const [search, setSearch] = useState('');

  const visiveis = useMemo(() => {
    const termo = search.trim().toLowerCase();
    return products.filter((p) => {
      if (!p.active) return false;
      if (category && p.category_id !== category) return false;
      if (termo && !(p.name || '').toLowerCase().includes(termo) && !(p.sku || '').toLowerCase().includes(termo)) return false;
      return true;
    });
  }, [products, category, search]);

  const categoriasComProduto = categories.filter((c) => c.active && products.some((p) => p.category_id === c.id));

  return (
    <div className={`bpg ${disabled ? 'bpg--disabled' : ''}`}>
      <div className="bpg-toolbar">
        <div className="bpg-tabs" role="tablist">
          <button type="button" role="tab" aria-selected={category === ''}
                  className={category === '' ? 'active' : ''} onClick={() => setCategory('')}>
            {t('common.all', 'Todos')}
          </button>
          {categoriasComProduto.map((c) => (
            <button key={c.id} type="button" role="tab" aria-selected={category === c.id}
                    className={category === c.id ? 'active' : ''} onClick={() => setCategory(c.id)}>
              {c.name}
            </button>
          ))}
        </div>
        <input
          type="search"
          className="bpg-search"
          aria-label={t('common.search', 'Buscar')}
          placeholder={t('bar.searchProduct', 'Nome ou código')}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </div>

      {disabled && (
        <p className="bar-muted bpg-hint">{t('bar.pickTabFirst', 'Escolha ou abra uma comanda para lançar.')}</p>
      )}

      {visiveis.length === 0 ? (
        <p className="bar-muted bpg-hint">{t('bar.noProductsHere', 'Nenhum produto aqui.')}</p>
      ) : (
        <div className="bpg-grid">
          {visiveis.map((p) => (
            <button
              key={p.id}
              type="button"
              className={`bpg-tile ${p.low_stock ? 'bpg-tile--low' : ''}`}
              disabled={disabled}
              onClick={() => onPick?.(p)}
            >
              <span className="bpg-tile__name">{p.name}</span>
              <span className="bpg-tile__price">{formatCurrency(p.price)}</span>
              {p.track_stock && (
                <span className={`bpg-tile__stock ${p.stock_qty <= 0 ? 'bpg-tile__stock--neg' : ''}`}>
                  {p.stock_qty}
                </span>
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  );
};

export default BarProductGrid;
