-- ============================================================================
-- Bucket dos vídeos de suporte (treinamento e vídeos curtos, nos 3 idiomas)
-- ----------------------------------------------------------------------------
-- Layout: catalogo.json na raiz e <idioma>/<id>.mp4 | .vtt | .jpg.
-- Quem gera e sobe os arquivos é scripts/videos/ (produzir.py e publicar.py).
--
-- BUCKET PÚBLICO de propósito: o <video> do navegador precisa de uma URL
-- estável que aceite Range para o usuário pular para qualquer ponto, e uma URL
-- assinada expiraria no meio de um treinamento de 40 minutos. Nada sensível
-- mora aqui: os vídeos são gravados num clube fictício.
--
-- SEM POLICY DE ESCRITA, de propósito: só o publicar.py sobe arquivos, com a
-- service_role, que ignora RLS. Nenhum usuário do app pode escrever aqui. A
-- leitura anônima não passa por policy: bucket público serve direto.
--
-- O limite por arquivo daqui não passa do limite GLOBAL do Storage (Dashboard >
-- Storage > Settings). Se o global estiver abaixo do treinamento completo, o
-- upload do arquivo grande é recusado mesmo com este valor.
--
-- Reversível: delete from storage.objects where bucket_id = 'videos-suporte';
--             delete from storage.buckets where id = 'videos-suporte';
-- ============================================================================

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'videos-suporte', 'videos-suporte', true,
  1073741824,  -- 1 GB: teto para o treinamento completo, bem acima do esperado
  array['video/mp4', 'text/vtt', 'image/jpeg', 'application/json']
)
on conflict (id) do update set
  public = true,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;
