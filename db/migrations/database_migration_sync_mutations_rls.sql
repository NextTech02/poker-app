-- SEGURANÇA: sync_mutations estava com RLS DESLIGADO — a tabela ficava totalmente
-- exposta às roles anon/authenticated. A anon key é pública (vai no bundle do
-- frontend), então qualquer pessoa podia ler/alterar o ledger de sincronização.
--
-- Quem usa a tabela: APENAS o backend (app/services/sync_service.py), que se
-- conecta com a SERVICE_ROLE key. A service_role IGNORA RLS por definição, logo
-- ligar RLS *sem políticas* mantém o backend funcionando e bloqueia todo o resto.
-- O frontend nunca toca nesta tabela (usa IndexedDB + POST /sync/batch).
--
-- Deny-by-default: nenhuma policy = nenhum acesso para anon/authenticated.

ALTER TABLE public.sync_mutations ENABLE ROW LEVEL SECURITY;
