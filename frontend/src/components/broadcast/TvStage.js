import React, { useLayoutEffect, useRef, useState } from 'react';
import { STAGE_W, STAGE_H } from './tvDefaults';
import { resolveBackground } from './tvBackgrounds';

/**
 * Palco do telão: um retângulo de 1920×1080 (ou maior) escalado para caber na
 * caixa que o contém.
 *
 * É o que faz o MESMO layout servir uma TV 720p, 1080p, 4K e a prévia de
 * 1200px das Configurações, sem media query: todos os tamanhos do CSS são em
 * px do palco, e `transform: scale()` cuida do resto.
 *
 * `fit="viewport"` (TV): a escala é a MENOR das duas razões (nada é cortado)
 * e a dimensão que sobra é esticada — numa tela mais larga que 16:9 o palco
 * alarga, numa mais alta ele cresce. Assim o conteúdo encosta nas bordas da
 * tela de verdade; com o palco fixo em 1920×1080 sobravam faixas vazias nas
 * laterais (janela do navegador, TV com barra) e os tiles ficavam longe do
 * canto. O fundo cobre a caixa inteira de qualquer forma.
 *
 * `fit="width"` (prévia): palco exatamente 1920×1080, escalado pela largura
 * do pai; altura = largura × 9/16.
 */
const TvStage = ({ background, fit = 'viewport', className = '', style, children }) => {
  const rootRef = useRef(null);
  const [stage, setStage] = useState({ scale: 1, width: STAGE_W, height: STAGE_H });

  useLayoutEffect(() => {
    const el = rootRef.current;
    if (!el) return undefined;

    const measure = () => {
      const rect = el.getBoundingClientRect();
      const w = rect.width || (fit === 'viewport' ? window.innerWidth : STAGE_W);
      const h = rect.height || (fit === 'viewport' ? window.innerHeight : (w * STAGE_H) / STAGE_W);
      let scale = fit === 'viewport' ? Math.min(w / STAGE_W, h / STAGE_H) : w / STAGE_W;
      if (!(scale > 0) || !Number.isFinite(scale)) scale = 1;
      // Na TV o palco cobre a tela inteira: a dimensão que a escala não
      // preenche é esticada (nunca abaixo do palco base).
      const width = fit === 'viewport' ? Math.max(STAGE_W, Math.round(w / scale)) : STAGE_W;
      const height = fit === 'viewport' ? Math.max(STAGE_H, Math.round(h / scale)) : STAGE_H;
      setStage({ scale, width, height });
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
      style={{ '--tv-scale': stage.scale, '--tv-overlay': overlay / 100, ...style }}
    >
      <div className="tv-bg" style={bg.style} />
      {overlay > 0 && <div className="tv-bg-overlay" />}
      <div
        className="tv-stage"
        style={{
          width: `${stage.width}px`,
          height: `${stage.height}px`,
          transform: `translate(-50%, -50%) scale(${stage.scale})`,
        }}
      >
        {children}
      </div>
    </div>
  );
};

export default TvStage;
