import { useEffect, useState } from 'react';
import api from '../config/api';
import { supabase } from '../config/supabase';
import { currentOrgId } from '../utils/orgFromToken';
import { downscaleImage } from '../utils/imageDownscale';
import { brandingFinal } from '../utils/bilhete';
import { BUCKET, publicUrlFor } from './useBroadcastBackgrounds';

/**
 * Imagem, cidade, sede e enfeites do bilhete de inscrição.
 *
 * Padrão do CLUBE em `app_settings` (lido direto do Supabase, como a moeda);
 * troca por TORNEIO nos campos `ticket_*` do torneio. Cache em memória: o
 * Caixa imprime dezenas de bilhetes por noite e o layout não muda entre eles.
 * Falhou (sem rede, banco sem a migração)? O bilhete sai sem a imagem.
 *
 * A imagem fica no bucket público dos fundos do telão, na pasta
 * `<org>/bilhete/` — as políticas do bucket já isolam o clube pela 1ª pasta.
 */
const COLUNAS_DO_CLUBE = 'id, ticket_logo_path, ticket_city, ticket_venue, ticket_ornaments';
const VALIDADE_MS = 60 * 1000;

let cacheDoClube = null; // { quando, valor }
const cacheDosTorneios = new Map(); // id -> { quando, valor }

export const invalidarBrandingDoBilhete = () => {
  cacheDoClube = null;
  cacheDosTorneios.clear();
};

export const lerBilheteDoClube = async () => {
  if (cacheDoClube && Date.now() - cacheDoClube.quando < VALIDADE_MS) return cacheDoClube.valor;
  let valor = {};
  try {
    const { data, error } = await supabase.from('app_settings').select(COLUNAS_DO_CLUBE).limit(1).maybeSingle();
    if (!error && data) valor = data;
  } catch (_) { /* sem rede ou sem a migração: bilhete sem imagem */ }
  cacheDoClube = { quando: Date.now(), valor };
  return valor;
};

const lerBilheteDoTorneio = async (tournamentId) => {
  if (!tournamentId) return {};
  const guardado = cacheDosTorneios.get(tournamentId);
  if (guardado && Date.now() - guardado.quando < VALIDADE_MS) return guardado.valor;
  let valor = {};
  try {
    const res = await api.get(`/tournaments/${tournamentId}`, { _silentError: true });
    const t = res?.data || {};
    valor = { ticket_logo_path: t.ticket_logo_path, ticket_city: t.ticket_city, ticket_venue: t.ticket_venue };
  } catch (_) { /* fica o do clube */ }
  cacheDosTorneios.set(tournamentId, { quando: Date.now(), valor });
  return valor;
};

export const carregarBrandingDoBilhete = async (tournamentId) => {
  const [clube, torneio] = await Promise.all([lerBilheteDoClube(), lerBilheteDoTorneio(tournamentId)]);
  return brandingFinal(clube, torneio, publicUrlFor);
};

export const useBrandingDoBilhete = (tournamentId) => {
  const [branding, setBranding] = useState(null);
  useEffect(() => {
    let vivo = true;
    carregarBrandingDoBilhete(tournamentId).then((b) => { if (vivo) setBranding(b); });
    return () => { vivo = false; };
  }, [tournamentId]);
  return branding;
};

const novoId = () => {
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  } catch (_) { /* fallback abaixo */ }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
};

export const TIPOS_DE_IMAGEM = ['image/jpeg', 'image/png', 'image/webp'];

/** Sobe a imagem do bilhete e devolve o CAMINHO no bucket. Erro → `code` de tradução. */
export const enviarImagemDoBilhete = async (arquivo) => {
  const erro = (code) => Object.assign(new Error(code), { code });
  if (!arquivo || !TIPOS_DE_IMAGEM.includes(arquivo.type)) throw erro('logoInvalidType');
  const org = currentOrgId();
  if (!org) throw erro('logoUploadError');
  const { blob, ext, contentType } = await downscaleImage(arquivo, { maxWidth: 900 });
  if (blob.size > 2 * 1024 * 1024) throw erro('logoTooLarge');
  const caminho = `${org}/bilhete/${novoId()}.${ext}`;
  const { error } = await supabase.storage.from(BUCKET).upload(caminho, blob, { contentType, upsert: false });
  if (error) throw erro('logoUploadError');
  return caminho;
};

export { publicUrlFor };
