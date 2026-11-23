# Achados no app durante a gravação dos vídeos de suporte (nov/2026)

Durante a gravação de 66 vídeos curtos nos 3 idiomas, nos clubes fictícios em produção, apareceram os problemas abaixo. Nenhum foi corrigido na branch dos vídeos. Os marcados "(pelo código)" foram vistos lendo o código, não reproduzidos em produção.

Corrigir os textos da seção 2 e regravar os vídeos afetados não gasta cota do Azure, porque o áudio está em cache. Basta rodar `produzir.py` de novo.

## 1. Funcionamento

| Onde | O que acontece |
|---|---|
| Caixa > Limite de Jogador | O desconto do crédito no prêmio nunca acontece: `PlayerCreditService.deduct_from_prize` não é chamado em lugar nenhum do backend, só nos testes. "Desc. Prêmio" e "quitado pelo prêmio" nunca mudam. |
| Controle do torneio | +30s ou +1m no começo de um nível volta o relógio para o nível anterior (reproduzido pela API no nível 2). |
| Gaveta do operador | O saldo esperado soma cartão e PIX, porque o trigger que espelha a venda na gaveta não filtra o meio de pagamento. Quem conta só o dinheiro fecha com "falta". |
| Relatórios | `report_service.get_reports` filtra `created_at <= end_date` sem fim do dia: com Data Final = hoje, os torneios de hoje somem. "Por meio de entrada" e o Relatório de Jogadores repetem uma linha ou coluna "Buy-in" por torneio, agrupando por id e exibindo por nome. |
| Despesas | O vencimento aparece um dia antes: `fmtDate` em `ExpensesManager.js` lê a data sem hora como UTC. |
| Cash > Fila de espera | Uma cadeira reservada continua contando como lugar livre (`free_seats` só desconta quem está sentado). |
| Cash > Fechar mesa | Mesa sem rake não fecha: `close_table` passa por `add_rake_entry`, que recusa rake 0 e jackpot 0 (pelo código). |
| Fiado > Configuração | "Limite sugerido ao liberar" é salvo, mas o modal de liberar não usa `default_limit` (pelo código). |
| Caixa offline | Se o torneio for escolhido depois que a internet cai, o dia não carrega (`loadTournamentDays` não lê a réplica). Sem cache prévio, os meios de entrada também não vêm. |
| Funcionários > Pagamentos | Pagar e estornar mexem no Caixa Geral com UPDATE direto do navegador sobre o saldo lido antes: duas operações juntas podem perder uma atualização. |
| Detalhe do torneio | "Iniciar Dia" diz que o cronômetro começa, mas só muda o status e `start_time`. |
| Equipes > Fase 1 | A prévia conta só os vivos: "4 jogadores → 4 mesas (4×1)". |
| Cadastro de torneio | Escolher um formato de KO e voltar para Nenhuma mantém "Por posição nas mesas". |
| Dia criado pelo formulário | O card mostra Rake 0% enquanto os meios de entrada têm 20% e 10%. |
| Troca de mesa (Painel de Mesas e Gestão de Mesas) | O bilhete do lugar novo mostra a hora em que o jogador sentou pela primeira vez: `SeatTicket` usa `created_at`, e `PATCH /allocations/{id}` só muda `updated_at`. |

## 2. Português nos clubes em inglês e espanhol

Aparecem nos vídeos en/es.

- **Chaves que faltam nos locales:**
  - `tournaments.playersPlural`/`playersSingular` ("jogadores" em `/torneios`, em todos os vídeos de torneio en/es);
  - `stages.impact*` (excluir etapa);
  - `common.all` ("Todas"/"Todos" nos filtros);
  - `staff.perm.cashierTicketsMaster`.
- **Fixos no código:**
  - "Confirmar"/"Cancelar" em `ToastContext.js`;
  - toast da sangria vindo do backend (`perform_sangria`, com números crus);
  - `cancel_warnings` com "R$";
  - placeholders `email@exemplo.com` e `(00) 00000-0000`;
  - máscara de CPF na premiação;
  - cadastro de jogador abre em "CPF (Brasil)".
- **Dados que nascem em português em qualquer clube:**
  - categorias do bar;
  - categorias de despesa (trigger de `database_migration_expenses_phase1.sql`);
  - níveis de fidelidade (Bronze/Prata/Ouro/Diamante, sem tela para renomear);
  - recompensas "R$ 25 em crédito" mesmo em USD/COP;
  - patrocinador de sistema "Fidelidade".
- **Datas e números em formato pt-BR:**
  - `formatDate` de Etapas, Sangeur, lista do Caixa, tickets, extrato do Financeiro, `CashboxDemonstrativo` e "Pago em" de Funcionários usam `toLocaleString('pt-BR')`;
  - o telão mostra 420,000;
  - `TournamentDayForm` mostra "R$ 500.00".
- **Códigos crus:**
  - meios de pagamento (cash, pix, card, credit) em Relatórios do bar, no detalhe do turno e na comanda;
  - "prize" em Transações Recentes;
  - detalhes do log de Acessos (UUIDs, ISO, "paid/pending").

## 3. Visual

- **Valores em COP não cabem:** cortam nos cartões de totais ("COP$ 3.000.000,...") e quebram linha em Melhores dias, no modal de recebimento e no demonstrativo do turno.
- **Contraste:**
  - o quadro "Cálculo da Sangria" (`.sangria-calculation`) tem texto claro em fundo claro;
  - o selo "n/n inscritos" e o aviso da Fase 1 de equipes também (`TorneioEquipes.css`, `Equipes.css`).
- **Layout:**
  - `EntryTypesEditor`: ajuda numa coluna estreita e primeira linha alta demais;
  - "TOURNAMENTS" sai cortado no trilho em inglês;
  - a barra do topo repete "Torneios > Torneios > Lista".
- **Funcionários:**
  - a aba Pagamentos mostra o botão "+ Novo Grupo";
  - o grupo Admin mostra "Todas" e "+29" juntos.

## 4. Texto

- **Espanhol:**
  - voseo no fiado ("Imprimí", "Confirmá") e em `blindTemplates.reorderHint` ("Arrastrá");
  - "usted" em Segurança e no desafio de 2FA;
  - mistura de "Ciegas"/"Blinds" e "Break"/"Descanso";
  - o bilhete diz "Posición" e o app diz "Asiento";
  - `sangi.noDayOpen` diz "Salón" e o menu diz "Sala".
- **Inglês:**
  - o telão diz "Entry options" e o resto do app "Entry methods";
  - a confirmação diz "Advance Qualifiers Final Day?".
- **Português:** o aviso de incompletos da importação de jogadores diz que e-mail e telefone são exigidos, mas o backend só exige nome e documento.
