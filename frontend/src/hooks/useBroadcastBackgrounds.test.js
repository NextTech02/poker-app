/**
 * Biblioteca de fundos do clube: Storage + tabela, direto do navegador.
 * O que se cerca: o caminho começa pela organização do token (é o que o RLS
 * compara), a imagem é reduzida antes de subir, e nenhuma falha deixa arquivo
 * órfão (insert falhou → objeto removido) nem metadado sem arquivo (remove
 * falhou → linha fica).
 */
import { renderHook, act, waitFor } from '@testing-library/react';
import { supabase } from '../config/supabase';
import { downscaleImage } from '../utils/imageDownscale';
import { useBroadcastBackgrounds, BackgroundError, publicUrlFor, BUCKET } from './useBroadcastBackgrounds';

jest.mock('../config/supabase', () => ({ supabase: { from: jest.fn(), storage: { from: jest.fn() } } }));
jest.mock('../utils/imageDownscale', () => ({ downscaleImage: jest.fn() }));

const ROWS = [
  { id: 'b1', path: 'org-1/a.webp', name: 'a.webp', content_type: 'image/webp', size_bytes: 100, created_at: '2026-10-01' },
  { id: 'b2', path: 'org-1/b.webp', name: 'b.webp', content_type: 'image/webp', size_bytes: 200, created_at: '2026-09-01' },
];

let tabela;
let storage;

/** Builder encadeável e "thenable": `await q` resolve `q._result`. */
const builder = (rows) => {
  const q = { _result: { data: rows, error: null }, calls: [] };
  ['select', 'order', 'eq', 'single'].forEach((m) => {
    q[m] = jest.fn((...a) => { q.calls.push([m, ...a]); return q; });
  });
  q.insert = jest.fn((row) => {
    q.calls.push(['insert', row]);
    q._result = q.insertResult || { data: { id: 'novo', created_at: '2026-10-08', ...row }, error: null };
    return q;
  });
  q.delete = jest.fn(() => {
    q.calls.push(['delete']);
    q._result = q.deleteResult || { error: null };
    return q;
  });
  q.then = (ok, ko) => Promise.resolve(q._result).then(ok, ko);
  return q;
};

const arquivo = (nome = 'foto.png', tipo = 'image/png', bytes = 10) =>
  new File(['x'.repeat(bytes)], nome, { type: tipo });

beforeEach(() => {
  tabela = builder(ROWS);
  storage = {
    upload: jest.fn(async () => ({ error: null })),
    remove: jest.fn(async () => ({ error: null })),
    getPublicUrl: jest.fn((p) => ({ data: { publicUrl: `https://cdn/${p}` } })),
  };
  supabase.from.mockImplementation(() => tabela);
  supabase.storage.from.mockImplementation(() => storage);
  downscaleImage.mockImplementation(async (f) => ({ blob: f, ext: 'webp', contentType: 'image/webp' }));
  localStorage.setItem('supabase_token', `x.${btoa(JSON.stringify({ organization_id: 'org-1', sub: 'u1' }))}.y`);
});

afterEach(() => localStorage.clear());

const montar = async () => {
  const r = renderHook(() => useBroadcastBackgrounds());
  await waitFor(() => expect(r.result.current.loading).toBe(false));
  return r;
};

describe('listagem', () => {
  it('carrega as imagens do clube com a URL pública, mais recente primeiro', async () => {
    const { result } = await montar();
    expect(supabase.from).toHaveBeenCalledWith('broadcast_backgrounds');
    expect(tabela.order).toHaveBeenCalledWith('created_at', { ascending: false });
    expect(result.current.items.map((i) => i.url)).toEqual(['https://cdn/org-1/a.webp', 'https://cdn/org-1/b.webp']);
    expect(result.current.error).toBeNull();
  });

  it('falha na leitura vira erro e lista vazia, sem estourar', async () => {
    tabela._result = { data: null, error: new Error('rls') };
    const { result } = await montar();
    expect(result.current.items).toEqual([]);
    expect(result.current.error).toBeTruthy();
  });

  it('publicUrlFor usa o bucket público', () => {
    expect(publicUrlFor('org-1/x.webp')).toBe('https://cdn/org-1/x.webp');
    expect(supabase.storage.from).toHaveBeenCalledWith(BUCKET);
  });
});

describe('envio', () => {
  it('reduz, sobe em {org}/{uuid}.{ext}, grava a linha e põe no topo da lista', async () => {
    const { result } = await montar();
    let item;
    await act(async () => { item = await result.current.upload(arquivo()); });

    expect(downscaleImage).toHaveBeenCalled();
    const [path, blob, opts] = storage.upload.mock.calls[0];
    expect(path).toMatch(/^org-1\/[A-Za-z0-9-]+\.webp$/);
    expect(blob).toBeInstanceOf(File);
    expect(opts).toEqual({ contentType: 'image/webp', upsert: false });

    expect(tabela.insert).toHaveBeenCalledWith({ path, name: 'foto.png', content_type: 'image/webp', size_bytes: 10 });
    expect(item.url).toBe(`https://cdn/${path}`);
    expect(result.current.items[0].id).toBe('novo');
    expect(result.current.items.length).toBe(3);
    expect(result.current.uploading).toBe(false);
  });

  it('tipo que não é imagem suportada é recusado antes de qualquer rede', async () => {
    const { result } = await montar();
    await expect(result.current.upload(arquivo('a.gif', 'image/gif'))).rejects.toMatchObject({ code: 'bgUploadInvalidType' });
    expect(storage.upload).not.toHaveBeenCalled();
  });

  it('sem organização no token não sobe', async () => {
    localStorage.clear();
    const { result } = await montar();
    await expect(result.current.upload(arquivo())).rejects.toMatchObject({ code: 'bgUploadNoOrg' });
    expect(storage.upload).not.toHaveBeenCalled();
  });

  it('acima de 5 MB depois da redução é recusado', async () => {
    downscaleImage.mockImplementation(async (f) => ({ blob: { size: 6 * 1024 * 1024 }, ext: 'webp', contentType: 'image/webp' }));
    const { result } = await montar();
    await expect(result.current.upload(arquivo())).rejects.toMatchObject({ code: 'bgUploadTooLarge' });
    expect(storage.upload).not.toHaveBeenCalled();
  });

  it('falha no Storage vira erro com código', async () => {
    storage.upload = jest.fn(async () => ({ error: new Error('413') }));
    const { result } = await montar();
    await expect(result.current.upload(arquivo())).rejects.toBeInstanceOf(BackgroundError);
    expect(tabela.insert).not.toHaveBeenCalled();
  });

  it('se a linha não grava, o arquivo já enviado é removido (sem órfão)', async () => {
    tabela.insertResult = { data: null, error: new Error('rls') };
    const { result } = await montar();
    await expect(result.current.upload(arquivo())).rejects.toMatchObject({ code: 'bgUploadError' });
    const [path] = storage.upload.mock.calls[0];
    expect(storage.remove).toHaveBeenCalledWith([path]);
    expect(result.current.items.length).toBe(2);
  });

  it('sem arquivo não faz nada', async () => {
    const { result } = await montar();
    await expect(result.current.upload(null)).rejects.toMatchObject({ code: 'bgUploadError' });
  });
});

describe('exclusão', () => {
  it('remove o arquivo e depois a linha, e tira da lista', async () => {
    const { result } = await montar();
    await act(async () => { await result.current.remove(result.current.items[0]); });
    expect(storage.remove).toHaveBeenCalledWith(['org-1/a.webp']);
    expect(tabela.delete).toHaveBeenCalled();
    expect(tabela.eq).toHaveBeenCalledWith('id', 'b1');
    expect(result.current.items.map((i) => i.id)).toEqual(['b2']);
  });

  it('se o Storage falhar a linha FICA (dá para tentar de novo)', async () => {
    storage.remove = jest.fn(async () => ({ error: new Error('fora') }));
    const { result } = await montar();
    await expect(result.current.remove(result.current.items[0])).rejects.toMatchObject({ code: 'bgDeleteError' });
    expect(tabela.delete).not.toHaveBeenCalled();
    expect(result.current.items.length).toBe(2);
  });

  it('falha ao apagar a linha também vira erro', async () => {
    tabela.deleteResult = { error: new Error('rls') };
    const { result } = await montar();
    await expect(result.current.remove(result.current.items[0])).rejects.toMatchObject({ code: 'bgDeleteError' });
  });
});
