import React, { useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { useToast } from '../../contexts/ToastContext';
import { BG_PRESETS, isPresetValue, presetValue } from './tvBackgrounds';
import { TV_BG } from './tvDefaults';
import './BackgroundGallery.css';

// Recusas do envio, por CÓDIGO (vindo do hook) → frase reserva em português.
// A tradução de verdade é `broadcastSettings.<código>`; a reserva vale para o
// caso de a chave ainda não existir no idioma.
const ERRO_ENVIO = {
  bgUploadInvalidType: 'Use JPG, PNG ou WebP.',
  bgUploadTooLarge: 'A imagem precisa ter até 5 MB.',
  bgUploadNoOrg: 'Não foi possível identificar o clube.',
  bgUploadError: 'Não foi possível enviar a imagem.',
};

/**
 * Seletor de fundo do telão: "nenhuma" (cor), presets prontos, as imagens da
 * biblioteca do clube (com envio e exclusão) e, por fim, uma URL colada.
 *
 * Tudo grava num campo só (`value` = `broadcast_bg_image_url` ou o do
 * intervalo): `preset:<nome>`, URL pública da biblioteca, URL externa, ou
 * vazio. O escurecimento (`overlay`) é opcional — só o fundo principal tem.
 *
 * `library` é o `useBroadcastBackgrounds()` do pai, compartilhado entre os
 * dois seletores (principal e intervalo) para a lista carregar uma vez só.
 */
const BackgroundGallery = ({
  value,
  onChange,
  library,
  bgColor,
  overlay,
  onOverlayChange,
  showOverlay = false,
  onItemRemoved,
  idPrefix = 'bg',
}) => {
  const { t } = useTranslation();
  const { toast, confirm } = useToast();
  const fileInput = useRef(null);

  const current = value || '';
  const isLegacyData = current.startsWith('data:');
  const isLibrary = library.items.some((i) => i.url === current);
  const isExternal = !!current && !isPresetValue(current) && !isLegacyData && !isLibrary;

  const tt = (key, fallback) => t(`broadcastSettings.${key}`, fallback);

  const handleFile = async (e) => {
    const file = e.target.files && e.target.files[0];
    if (fileInput.current) fileInput.current.value = '';
    if (!file) return;
    try {
      const item = await library.upload(file);
      onChange(item.url);
      toast.success(tt('bgUploaded', 'Imagem enviada.'));
    } catch (err) {
      const code = err && err.code && ERRO_ENVIO[err.code] ? err.code : 'bgUploadError';
      toast.warning(tt(code, ERRO_ENVIO[code]));
    }
  };

  const handleDelete = async (item) => {
    const ok = await confirm(
      tt('bgDeleteConfirm', 'Excluir esta imagem da biblioteca? Os dias que a usam ficarão sem fundo.'),
      { confirmText: tt('bgDelete', 'Excluir') },
    );
    if (!ok) return;
    try {
      await library.remove(item);
      if (current === item.url) onChange('');
      if (onItemRemoved) onItemRemoved(item.url);
      toast.success(tt('bgDeleted', 'Imagem excluída.'));
    } catch (err) {
      toast.error(tt('bgDeleteError', 'Não foi possível excluir a imagem.'));
    }
  };

  const overlayPct = Number.isFinite(Number(overlay)) ? Number(overlay) : 45;

  return (
    <div className="bg-gallery">
      <div className="bg-gallery-grid" role="list">
        <button
          type="button"
          role="listitem"
          className={`bg-tile bg-tile--none${current === '' ? ' is-selected' : ''}`}
          style={{ background: bgColor || TV_BG }}
          onClick={() => onChange('')}
          title={tt('bgNone', 'Nenhuma (cor de fundo)')}
        >
          <span className="bg-tile-caption">{tt('bgNone', 'Nenhuma (cor de fundo)')}</span>
        </button>

        {Object.entries(BG_PRESETS).map(([name, preset]) => (
          <button
            key={name}
            type="button"
            role="listitem"
            className={`bg-tile bg-tile--preset${current === presetValue(name) ? ' is-selected' : ''}`}
            style={{ background: preset.css }}
            onClick={() => onChange(presetValue(name))}
            data-preset={name}
            title={tt(preset.labelKey, name)}
          >
            <span className="bg-tile-caption">{tt(preset.labelKey, name)}</span>
          </button>
        ))}

        {isLegacyData && (
          <div className="bg-tile bg-tile--image bg-tile--legacy is-selected" role="listitem">
            <img src={current} alt="" className="bg-tile-img" />
            <span className="bg-tile-caption">{tt('bgLegacy', 'Imagem antiga')}</span>
          </div>
        )}

        {library.items.map((item) => (
          <div
            key={item.id}
            role="listitem"
            className={`bg-tile bg-tile--image${current === item.url ? ' is-selected' : ''}`}
          >
            <button
              type="button"
              className="bg-tile-pick"
              onClick={() => onChange(item.url)}
              title={item.name}
              aria-label={item.name}
            >
              <img src={item.url} alt={item.name} className="bg-tile-img" loading="lazy" />
            </button>
            <button
              type="button"
              className="bg-tile-delete"
              onClick={() => handleDelete(item)}
              aria-label={`${tt('bgDelete', 'Excluir')} ${item.name}`}
              title={tt('bgDelete', 'Excluir')}
            >
              ×
            </button>
          </div>
        ))}

        <label className={`bg-tile bg-tile--upload${library.uploading ? ' is-busy' : ''}`} role="listitem">
          <input
            ref={fileInput}
            type="file"
            accept="image/jpeg,image/png,image/webp"
            className="bs-hidden"
            onChange={handleFile}
            disabled={library.uploading}
            data-testid={`${idPrefix}-upload-input`}
          />
          <span className="bg-tile-plus">+</span>
          <span className="bg-tile-caption">
            {library.uploading ? tt('bgUploading', 'Enviando…') : tt('bgUpload', 'Enviar imagem')}
          </span>
        </label>
      </div>

      <span className="bs-hint">{tt('bgUploadHint', 'JPG, PNG ou WebP até 5 MB — a imagem é reduzida para 1920 px antes de subir.')}</span>
      {!library.loading && library.items.length === 0 && (
        <span className="bg-gallery-empty">{tt('bgLibraryEmpty', 'Nenhuma imagem enviada ainda.')}</span>
      )}
      {library.error && (
        <span className="bg-gallery-error">{tt('bgLibraryLoadError', 'Não foi possível carregar a biblioteca de imagens.')}</span>
      )}

      <div className="bs-url-row">
        <span className="bs-or-label">{tt('bgImageUrlLabel', 'ou cole uma URL de imagem')}</span>
        <input
          type="text"
          value={isExternal ? current : ''}
          onChange={(e) => onChange(e.target.value)}
          placeholder={tt('bgImageUrlPlaceholder', 'https://exemplo.com/imagem.jpg')}
          className="bs-input"
          data-testid={`${idPrefix}-url-input`}
        />
      </div>

      {showOverlay && (
        <div className="bs-slider-field">
          <div className="bs-slider-header">
            <span className="bs-slider-label">{tt('bgOverlay', 'Escurecimento da imagem')}</span>
            <span className="bs-slider-val">{overlayPct}%</span>
          </div>
          <div className="bs-slider-track-wrap">
            <input
              type="range"
              min={0}
              max={90}
              step={5}
              value={overlayPct}
              onChange={(e) => onOverlayChange(parseInt(e.target.value, 10))}
              className="bs-range"
              style={{ '--pct': `${(overlayPct / 90) * 100}%` }}
              aria-label={tt('bgOverlay', 'Escurecimento da imagem')}
              data-testid={`${idPrefix}-overlay-input`}
            />
          </div>
          <span className="bs-hint">{tt('bgOverlayHint', 'Camada escura sobre a imagem para o texto continuar legível. Não afeta presets nem cor sólida.')}</span>
        </div>
      )}
    </div>
  );
};

export default BackgroundGallery;
