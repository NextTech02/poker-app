import React from 'react';
import './Button.css';

const Button = ({
  children,
  variant = 'primary',
  size = 'medium',
  onClick,
  disabled = false,
  type = 'button',
  className = '',
  // `title` era descartado em silêncio. Vários pontos passam a dica esperando
  // que ela apareça — e num botão cujo conteúdo é só um ícone (📎) ela é o
  // ÚNICO nome acessível que existe.
  title,
  'aria-label': ariaLabel,
}) => {
  return (
    <button
      type={type}
      className={`btn btn-${variant} btn-${size} ${className}`}
      onClick={onClick}
      disabled={disabled}
      title={title}
      aria-label={ariaLabel}
    >
      {children}
    </button>
  );
};

export default Button;
