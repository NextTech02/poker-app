/**
 * Fundo do telão: o que `broadcast_bg_image_url` pode conter e como vira CSS.
 *
 * Um campo só, quatro formas:
 *   - `preset:<nome>`  → gradiente pronto (sem imagem embutida no bundle);
 *   - `data:...`       → imagem antiga em base64 (dias salvos antes da
 *                        biblioteca; continua funcionando);
 *   - `http(s)://...`  → imagem da biblioteca do clube (Storage) ou URL colada;
 *   - vazio            → cor sólida escolhida ou, se ela ainda for a cor padrão
 *                        de alguma época, o gradiente marinho do app.
 *
 * O escurecimento (`overlay`, 0–90 %) só se aplica a IMAGEM: os presets já
 * nascem escuros, e sobre cor sólida não faz sentido.
 */
import { TV_BG } from './tvDefaults';

export const PRESET_PREFIX = 'preset:';

export const BG_PRESETS = {
  navy:     { labelKey: 'bgPresetNavy',     css: 'linear-gradient(160deg, #0a0f2a 0%, #0b1020 45%, #121a3a 100%)' },
  graphite: { labelKey: 'bgPresetGraphite', css: 'linear-gradient(160deg, #14161c 0%, #0b0c10 50%, #1c1f29 100%)' },
  felt:     { labelKey: 'bgPresetFelt',     css: 'radial-gradient(ellipse at 50% 35%, #0f5a3c 0%, #073a27 55%, #04281b 100%)' },
  aceblind: { labelKey: 'bgPresetAceblind', css: 'linear-gradient(160deg, #140b30 0%, #0b0a12 50%, #2a1457 100%)' },
};

export const DEFAULT_BG_CSS = BG_PRESETS.navy.css;

// Cores de fundo que já foram "o padrão" em alguma versão: nenhum clube as
// escolheu, então valem como "sem cor" e caem no gradiente atual.
const LEGACY_BG_COLORS = new Set(['#0a0e13', '#0a0f17', '#0b0a12', TV_BG]);

const clampOverlay = (n) => {
  const v = Number(n);
  if (!Number.isFinite(v)) return 45;
  return Math.min(90, Math.max(0, Math.round(v)));
};

export const isPresetValue = (value) => typeof value === 'string' && value.startsWith(PRESET_PREFIX);
export const presetName = (value) => (isPresetValue(value) ? value.slice(PRESET_PREFIX.length) : null);
export const presetValue = (name) => `${PRESET_PREFIX}${name}`;

/**
 * @returns {{ kind: 'default'|'color'|'preset'|'image', style: object, overlay: number }}
 */
export const resolveBackground = (value, bgColor, overlay = 45) => {
  const v = typeof value === 'string' ? value.trim() : '';
  if (isPresetValue(v)) {
    const preset = BG_PRESETS[presetName(v)];
    if (preset) return { kind: 'preset', style: { background: preset.css }, overlay: 0 };
  } else if (v) {
    return {
      kind: 'image',
      style: {
        backgroundImage: `url(${v})`,
        backgroundSize: 'cover',
        backgroundPosition: 'center',
        backgroundRepeat: 'no-repeat',
      },
      overlay: clampOverlay(overlay),
    };
  }
  const color = typeof bgColor === 'string' ? bgColor.trim().toLowerCase() : '';
  if (color && !LEGACY_BG_COLORS.has(color)) {
    return { kind: 'color', style: { background: bgColor.trim() }, overlay: 0 };
  }
  return { kind: 'default', style: { background: DEFAULT_BG_CSS }, overlay: 0 };
};
