import { useCallback, useEffect, useState } from 'react';
import { supabase } from '../config/supabase';
import { currentOrgId } from '../utils/orgFromToken';
import { downscaleImage } from '../utils/imageDownscale';

/**
 * Biblioteca de fundos do telão da ORGANIZAÇÃO.
 *
 * Direto do navegador para o Supabase (Storage + tabela `broadcast_backgrounds`),
 * como os comprovantes de despesa: o RLS isola o clube pela 1ª pasta do caminho
 * e pela coluna `organization_id` (default `current_org_id()`). Não passa pelo
 * backend de propósito — a galeria não depende de deploy da API.
 *
 * O bucket é PÚBLICO (a TV não faz login); por isso a URL que vai para o dia é
 * a pública, estável, e o telão não precisa de assinatura para carregar.
 */

export const BUCKET = 'broadcast-backgrounds';
export const ALLOWED_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
export const MAX_BYTES = 5 * 1024 * 1024;
const COLUMNS = 'id, path, name, content_type, size_bytes, created_at';

/** Erro com CÓDIGO de tradução (`broadcastSettings.<code>`), nunca frase pronta. */
export class BackgroundError extends Error {
  constructor(code, cause) {
    super(code);
    this.code = code;
    this.cause = cause;
  }
}

export const publicUrlFor = (path) => {
  try {
    return supabase.storage.from(BUCKET).getPublicUrl(path)?.data?.publicUrl || '';
  } catch (_) {
    return '';
  }
};

const withUrl = (row) => ({ ...row, url: publicUrlFor(row.path) });

const newId = () => {
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  } catch (_) { /* cai no fallback */ }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
};

export const useBroadcastBackgrounds = () => {
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState(null);

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const { data, error: err } = await supabase
        .from('broadcast_backgrounds')
        .select(COLUMNS)
        .order('created_at', { ascending: false });
      if (err) throw err;
      setItems((data || []).map(withUrl));
      setError(null);
    } catch (err) {
      setError(err);
      setItems([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { reload(); }, [reload]);

  const upload = useCallback(async (file) => {
    if (!file) throw new BackgroundError('bgUploadError');
    if (!ALLOWED_TYPES.includes(file.type)) throw new BackgroundError('bgUploadInvalidType');
    const org = currentOrgId();
    if (!org) throw new BackgroundError('bgUploadNoOrg');

    setUploading(true);
    try {
      const { blob, ext, contentType } = await downscaleImage(file);
      if (blob.size > MAX_BYTES) throw new BackgroundError('bgUploadTooLarge');

      const path = `${org}/${newId()}.${ext}`;
      const { error: upErr } = await supabase.storage.from(BUCKET).upload(path, blob, {
        contentType,
        upsert: false,
      });
      if (upErr) throw new BackgroundError('bgUploadError', upErr);

      const { data, error: insErr } = await supabase
        .from('broadcast_backgrounds')
        .insert({ path, name: file.name, content_type: contentType, size_bytes: blob.size })
        .select(COLUMNS)
        .single();
      if (insErr || !data) {
        // Sem a linha ninguém vê o arquivo: apaga para não deixar órfão.
        try { await supabase.storage.from(BUCKET).remove([path]); } catch (_) { /* best-effort */ }
        throw new BackgroundError('bgUploadError', insErr);
      }

      const item = withUrl(data);
      setItems((prev) => [item, ...prev]);
      return item;
    } finally {
      setUploading(false);
    }
  }, []);

  const remove = useCallback(async (item) => {
    // Arquivo antes do registro: se o Storage falhar, o metadado fica e dá
    // para tentar de novo (em vez de virar órfão invisível).
    const { error: rmErr } = await supabase.storage.from(BUCKET).remove([item.path]);
    if (rmErr) throw new BackgroundError('bgDeleteError', rmErr);
    const { error: delErr } = await supabase.from('broadcast_backgrounds').delete().eq('id', item.id);
    if (delErr) throw new BackgroundError('bgDeleteError', delErr);
    setItems((prev) => prev.filter((i) => i.id !== item.id));
  }, []);

  return { items, loading, uploading, error, upload, remove, reload };
};

export default useBroadcastBackgrounds;
