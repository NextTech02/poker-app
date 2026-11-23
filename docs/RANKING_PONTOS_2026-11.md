# Ranking de pontos (Manual de Ranking NSOP) — nov/2026

O clube soma pontos dos jogadores em vários torneios: por **etapa** e por
**temporada** (um grupo de etapas). A regra é a do *Manual de Ranking de
Torneos* do NSOP ("Versión Nueva"). Antes disso o sistema só classificava
dentro de cada torneio.

## A conta

Por torneio, cada posição **premiada** (ITM) vale

```
PONTOS = ARREDONDAR[ (100 ÷ √posição) × FJ × FB ]
FJ = máx(0,75 ; mín(1,50 ; (N ÷ 50)^0,17))     N = jogadores únicos
FB = máx(0,75 ; mín(1,40 ; (B ÷ 350)^0,16))    B = buy-in oficial, sem a taxa
```

- Fora do ITM vale 0. Torneio com menos de 12 jogadores únicos não dá pontos.
- Recompra, add-on, prêmio, bounty e acordo de divisão **não** dão ponto.
- Só o resultado final é arredondado (meio para cima, como o Excel).
- Os números (100, 50, 0,17, 0,75...) são os sugeridos pelo manual; o clube
  ajusta em **Ranking → Regras** antes da temporada (`ranking_rules`).
- O buy-in de referência (350) está em **soles**. Clube de outra moeda que não
  salvou as próprias regras vê um aviso na aba Regras e na aba Ranking do torneio:
  em pesos colombianos todo torneio bateria no teto do fator, e os pontos congelam.

Vale para qualquer clube com o módulo Torneio: entra no menu de quem tem a
permissão `points_ranking` (o grupo do dono, em todos os clubes) e só conta
torneio marcado como pontuável, que nasce desmarcado.

Conferido contra o manual: com 50 jogadores e S/350, 1º = 100, 2º = 71,
3º = 58...; Main Event (180, S/700) = 139/98/80; Turbo (40, S/120) = 81/57/47
(`backend/tests/test_ranking_pontos_regras.py`).

**Etapa:** soma todos os torneios oficializados dela. **Temporada:** soma só os
N melhores resultados de cada jogador (o manual sugere 8; vazio = todos).

**Empate:** mais 1ºs → mais 2ºs → mais 3ºs → mais mesas finais (top 9) → maior
pontuação num só torneio. Persistindo, a posição é compartilhada ("2=").
Os critérios olham todos os torneios do período, inclusive os descartados.

## De onde vem cada número

| Dado | Fonte | Por quê |
|---|---|---|
| N | pessoas distintas inscritas no torneio, em qualquer dia, sem as canceladas | reentrada e Dia 1A + 1B são a mesma pessoa |
| B | o que a direção gravar no torneio; vazio = o meio de entrada de buy-in mais caro que vale 1 entrada | o manual pede o buy-in **anunciado**, igual para todos; a promoção é mais barata, o "Doble" vale 2 entradas, a taxa é outra categoria |
| T | as linhas da premiação do torneio (1..T) | é o ITM oficial |
| posições | a **direção confirma** quem ficou em cada posição premiada ao oficializar | ver abaixo |

### Por que a direção confirma as posições

Hoje nenhuma fonte automática é confiável sozinha:

- `tournament_players.final_position` só fica certo no fim, ninguém recebe o
  1º lugar, no modo de eliminação "em lote" não há posição nenhuma, e um
  jogador no Dia 1A e no 1B ganha duas posições;
- na premiação, o jogador só é ligado à posição quando é **pago**.

Então a tela propõe (o jogador pago naquela posição; na falta, quem a
eliminação colocou lá) e a direção confere. Como só o ITM pontua, são poucas
linhas por torneio.

## Oficializar e corrigir

Na **Premiação** do torneio, aba **Ranking** (permissão `points_ranking`):

1. marcar **Torneio pontuável** (o manual pede que esteja no calendário anunciado);
2. conferir o **buy-in oficial**;
3. conferir o jogador de cada posição premiada e **Oficializar resultados**.

O servidor recusa: torneio não pontuável, sem premiação, posição sem jogador,
o mesmo jogador em duas posições, jogador que não jogou o torneio (ou teve a
inscrição cancelada).

Oficializar grava a **foto** (`tournament_ranking_results`: posição, pontos,
N, B, T e os fatores usados) e carimba `tournaments.ranking_official_at/_by`.
Depois disso **nada recalcula**: mudar a premiação, a eliminação ou as regras
do clube não mexe nos pontos daquele torneio ("una vez cerrado un torneo, sus
resultados no se recalculan"). Corrigir exige **Reabrir** com motivo
(`ranking_reopen_reason`); o log de atividade guarda quem, quando, o antes e o
depois.

## Telas

- **Torneios → Ranking** (`/ranking`): abas Etapa (abre na etapa selecionada),
  Temporadas (criar/editar: nome, melhores resultados, etapas) e Regras.
  Lista os torneios pontuáveis ainda não oficializados, com link para a aba
  Ranking de cada um. Exporta PDF e Excel.
- **Premiação → Ranking**: o torneio no ranking (acima).

## Banco

`db/migrations/database_migration_ranking_pontos.sql`: `ranking_rules`,
colunas `ranking_*` em `tournaments`, `tournament_ranking_results`,
`ranking_seasons` e `ranking_season_stages`; RLS por organização + 2FA, log de
atividade e a permissão `points_ranking` (dada a quem já tem `employees` e aos
clubes novos). Sem FK para `players`, `tournament_players` e `stages`, de
propósito (embed ambíguo no PostgREST, ver `torneio_equipes`).

Enquanto a migração não roda, as rotas respondem 503 com
`ranking_migracao_pendente` e as telas dizem que o ranking ainda não está
ativo; o resto do sistema não muda.

## Fora desta versão

- Página pública / telão do ranking (o manual pede publicar; hoje há o PDF).
- Rankings por categoria (Omaha, High Roller, novatos).
- Consertar a classificação por eliminação (`final_position`): ajudaria a
  proposta de posições, mas não é necessária para o ranking.
- Usar o % de premiação reservado com destino "ranking" como prêmio da
  temporada.
