import React, { useLayoutEffect, useRef, useState } from 'react';
import { STAGE_W, STAGE_H } from './tvDefaults';
import { resolveBackground } from './tvBackgrounds';

/**
 * Palco do telão: um retângulo fixo de 1920×1080 escalado para caber na caixa
 * que o contém.
 *
 * É o que faz o MESMO layout servir uma TV 720p, 1080p, 4K e a prévia de
 * 1200px das Configurações, sem media query: todos os tamanhos do CSS são em
 * px do palco, e `transform: scale()` cuida do resto. O fundo (imagem, preset
 * ou cor) cobre a caixa INTEIRA, não só o palco — numa tela que não é 16:9 as
 * faixas sobrando continuam com o fundo, não pretas.
 *
 * `fit="viewport"` (TV): ocupa a janela toda e centraliza (letterbox).
 * `fit="width"` (prévia): escala pela largura do pai; altura = largura × 9/16.
 */
const TvStage = ({ background, fit = 'viewport', className = '', style, children }) => {
  const rootRef = useRef(null);
  const [scale, setScale] = useState(1);

  useLayoutEffect(() => {
    const el = rootRef.current;
    if (!el) return undefined;

    const measure = () => {
      const rect = el.getBoundingClientRect();
      const w = rect.width || (fit === 'viewport' ? window.innerWidth : STAGE_W);
      const h = rect.height || (fit === 'viewport' ? window.innerHeight : (w * STAGE_H) / STAGE_W);
      const next = fit === 'viewport' ? Math.min(w / STAGE_W, h / STAGE_H) : w / STAGE_W;
      setScale(next > 0 && Number.isFinite(next) ? next : 1);
    };

    measure();
    let observer = null;
    if (typeof ResizeObserver !== 'undefined') {
      observer = new ResizeObserver(measure);
      observer.observe(el);
    }
    window.addEventListener('resize', measure);
    return () => {
      if (observer) observer.disconnect();
      window.removeEventListener('resize', measure);
    };
  }, [fit]);

  const bg = background || resolveBackground(null, null);
  const overlay = Number(bg.overlay) || 0;

  return (
    <div
      ref={rootRef}
      className={`tv-root tv-root--${fit} ${className}`.trim()}
      data-bg-kind={bg.kind}
      style={{ '--tv-scale': scale, '--tv-overlay': overlay / 100, ...style }}
    >
      <div className="tv-bg" style={bg.style} />
      {overlay > 0 && <div className="tv-bg-overlay" />}
      <div className="tv-stage" style={{ transform: `translate(-50%, -50%) scale(${scale})` }}>
        {children}
      </div>
    </div>
  );
};

export default TvStage;
