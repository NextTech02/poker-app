import React from 'react';
import './Segmented.css';

/**
 * Controle segmentado do sistema visual: um grupo de opções exclusivas
 * (filtro de status, período, modo). É a versão em botões do `.seg` do
 * protótipo — um `aria-pressed` por opção, e o grupo nomeado por `ariaLabel`
 * para o leitor de tela saber do que se trata.
 *
 * `options`: [{ value, label, count? }]. `count` é opcional (aparece como
 * contador discreto ao lado do rótulo).
 */
const Segmented = ({ options, value, onChange, ariaLabel, className = '' }) => (
  <div className={`seg ${className}`} role="group" aria-label={ariaLabel}>
    {options.map((opcao) => {
      const ativa = opcao.value === value;
      return (
        <button
          key={opcao.value}
          type="button"
          className={`seg__btn${ativa ? ' seg__btn--on' : ''}`}
          aria-pressed={ativa}
          onClick={() => onChange(opcao.value)}
        >
          {opcao.label}
          {opcao.count != null && <span className="seg__cnt">{opcao.count}</span>}
        </button>
      );
    })}
  </div>
);

export default Segmented;
