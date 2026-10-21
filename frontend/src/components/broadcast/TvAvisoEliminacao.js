import React from 'react';
import { DURACAO_DO_AVISO_MS } from '../../hooks/useAvisoDeEliminacao';
import './TvAvisoEliminacao.css';

/**
 * Faixa animada de JOGADOR ELIMINADO na parte de baixo do telão: sobe, fica
 * o tempo de o salão ler e desce. Vai DENTRO do palco (px de 1920×1080), por
 * cima da tela — inclusive da barra de prêmios, que volta quando ela sai.
 *
 * Quem usa passa `key={aviso.id}`: cada eliminação monta de novo e a
 * animação recomeça do zero.
 */
const TvAvisoEliminacao = ({ aviso, rotulo, destaque, duracaoMs = DURACAO_DO_AVISO_MS }) => {
  if (!aviso) return null;
  return (
    <div
      className="tv-elim"
      role="status"
      aria-live="polite"
      style={{
        '--tv-elim-ms': `${duracaoMs}ms`,
        ...(destaque ? { '--tv-elim-accent': destaque } : {}),
      }}
    >
      <div className="tv-elim-card">
        <span className="tv-elim-label">{rotulo}</span>
        <span className="tv-elim-name">{aviso.nome}</span>
      </div>
    </div>
  );
};

export default TvAvisoEliminacao;
