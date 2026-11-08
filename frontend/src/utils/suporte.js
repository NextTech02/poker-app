import { supabase } from '../config/supabase';

/**
 * VÍDEOS DE SUPORTE — o que mora no bucket e como o app acha.
 *
 *   videos-suporte/catalogo.json
 *   videos-suporte/<idioma>/<id>.mp4 | .vtt | .jpg
 *
 * O catálogo fica no bucket, e não no código, para que publicar ou regravar um
 * vídeo não dependa de deploy. Quem gera os arquivos é `scripts/videos/`.
 */
export const BUCKET_SUPORTE = 'videos-suporte';
export const IDIOMA_PADRAO = 'pt-BR';
const IDIOMAS = ['pt-BR', 'en-US', 'es-ES'];

/** O idioma do app pode chegar curto (`pt`) ou de uma região sem vídeo (`es-MX`). */
export const idiomaDosVideos = (idioma) => {
  const texto = idioma || '';
  const prefixo = texto.slice(0, 2).toLowerCase();
  return IDIOMAS.find((i) => i === texto)
    || IDIOMAS.find((i) => i.startsWith(prefixo))
    || IDIOMA_PADRAO;
};

export const textoNoIdioma = (campo, idioma) => campo?.[idioma] ?? campo?.[IDIOMA_PADRAO] ?? '';

/** Um vídeo ainda não gravado neste idioma abre na versão em português. */
export const idiomaDoVideo = (video, idioma) => (
  video?.duracao?.[idioma] != null ? idioma : IDIOMA_PADRAO
);

export const urlDoArquivo = (caminho) => {
  try {
    return supabase.storage.from(BUCKET_SUPORTE).getPublicUrl(caminho)?.data?.publicUrl || '';
  } catch (_) {
    return '';
  }
};

export const arquivosDoVideo = (video, idioma) => {
  const base = `${idiomaDoVideo(video, idioma)}/${video.id}`;
  return {
    video: urlDoArquivo(`${base}.mp4`),
    legenda: urlDoArquivo(`${base}.vtt`),
    capa: urlDoArquivo(`${base}.jpg`),
  };
};

const semAcento = (texto) => String(texto || '')
  .normalize('NFD')
  .replace(/[̀-ͯ]/g, '')
  .toLowerCase();

/** Quem procura digita "cartao" ou "sangria": acento e caixa não podem atrapalhar. */
export const filtrarVideos = (videos, { area, busca }, idioma) => {
  const termo = semAcento(busca).trim();
  return videos.filter((video) => {
    if (area && video.area !== area) return false;
    if (!termo) return true;
    const alvo = `${textoNoIdioma(video.titulo, idioma)} ${textoNoIdioma(video.descricao, idioma)}`;
    return semAcento(alvo).includes(termo);
  });
};

export const formatarDuracao = (segundos) => {
  const total = Math.round(Number(segundos) || 0);
  if (total <= 0) return '';
  const horas = Math.floor(total / 3600);
  const minutos = Math.floor((total % 3600) / 60);
  const resto = String(total % 60).padStart(2, '0');
  return horas ? `${horas}:${String(minutos).padStart(2, '0')}:${resto}` : `${minutos}:${resto}`;
};

/**
 * `null` quando não há catálogo: o bucket ainda não existe, está vazio ou a
 * rede falhou. Para a tela é o mesmo caso, "vídeos em breve", e é o que deixa
 * o app ir ao ar antes da migração do bucket sem quebrar.
 */
export const carregarCatalogo = async () => {
  const url = urlDoArquivo('catalogo.json');
  if (!url) return null;
  try {
    const resposta = await fetch(url, { cache: 'no-cache' });
    if (!resposta.ok) return null;
    const dados = await resposta.json();
    return Array.isArray(dados?.videos) ? dados : null;
  } catch (_) {
    return null;
  }
};
