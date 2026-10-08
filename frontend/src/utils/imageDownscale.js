/**
 * Reduz uma imagem no navegador antes do upload.
 *
 * Fundo de telão vem do celular do operador: 4000 px de largura e 6 MB. A TV
 * baixa essa imagem a cada carga e o bucket tem teto de 5 MB; a 1920 px em
 * WebP a mesma foto fica em ~300 KB sem perda visível numa TV.
 *
 * Nunca falha "para fora": qualquer problema (navegador sem canvas, formato
 * que não decodifica, jsdom nos testes) devolve o arquivo ORIGINAL com a
 * extensão dele — o upload segue e, no pior caso, o teto do bucket recusa.
 */

export const MAX_WIDTH = 1920;
const SKIP_BELOW_BYTES = 1024 * 1024; // já pequena e já estreita: não mexe

const EXT_BY_TYPE = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };

export const extFromFile = (file) => {
  if (file?.type && EXT_BY_TYPE[file.type]) return EXT_BY_TYPE[file.type];
  const m = /\.([a-z0-9]+)$/i.exec(file?.name || '');
  const ext = m ? m[1].toLowerCase() : 'jpg';
  return ext === 'jpeg' ? 'jpg' : ext;
};

const original = (file) => ({
  blob: file,
  ext: extFromFile(file),
  contentType: file?.type || 'application/octet-stream',
  resized: false,
});

const decode = async (file) => {
  if (typeof createImageBitmap === 'function') {
    return createImageBitmap(file);
  }
  if (typeof Image === 'undefined' || typeof URL?.createObjectURL !== 'function') return null;
  const url = URL.createObjectURL(file);
  try {
    return await new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = reject;
      img.src = url;
    });
  } finally {
    URL.revokeObjectURL(url);
  }
};

const release = (bitmap) => {
  try { if (bitmap && typeof bitmap.close === 'function') bitmap.close(); } catch (_) { /* ignore */ }
};

const toBlob = (canvas, type, quality) => new Promise((resolve) => {
  try {
    canvas.toBlob((b) => resolve(b || null), type, quality);
  } catch (_) {
    resolve(null);
  }
});

/**
 * @returns {Promise<{ blob: Blob, ext: string, contentType: string, resized: boolean }>}
 */
export const downscaleImage = async (file, { maxWidth = MAX_WIDTH, quality = 0.85 } = {}) => {
  if (!file) return original(file);
  try {
    if (typeof document === 'undefined' || typeof document.createElement !== 'function') {
      return original(file);
    }
    const bitmap = await decode(file);
    if (!bitmap) return original(file);
    const width = bitmap.width || bitmap.naturalWidth || 0;
    const height = bitmap.height || bitmap.naturalHeight || 0;
    if (!width || !height) { release(bitmap); return original(file); }
    if (width <= maxWidth && file.size <= SKIP_BELOW_BYTES) { release(bitmap); return original(file); }

    const scale = Math.min(1, maxWidth / width);
    const w = Math.max(1, Math.round(width * scale));
    const h = Math.max(1, Math.round(height * scale));
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext && canvas.getContext('2d');
    if (!ctx) { release(bitmap); return original(file); }
    ctx.drawImage(bitmap, 0, 0, w, h);
    release(bitmap);

    // WebP quando o navegador gera (Chrome, Edge, Firefox, Safari 16+);
    // senão JPEG. Verifica o `type` do blob: navegador que não sabe WebP
    // devolve PNG em silêncio.
    let blob = await toBlob(canvas, 'image/webp', quality);
    let contentType = 'image/webp';
    let ext = 'webp';
    if (!blob || blob.type !== 'image/webp') {
      blob = await toBlob(canvas, 'image/jpeg', quality);
      contentType = 'image/jpeg';
      ext = 'jpg';
    }
    if (!blob) return original(file);
    // Reduzir não pode piorar: imagem já estreita que ficou maior volta ao original.
    if (scale === 1 && blob.size >= file.size) return original(file);
    return { blob, ext, contentType, resized: true, width: w, height: h };
  } catch (_) {
    return original(file);
  }
};
