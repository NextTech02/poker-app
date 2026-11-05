# Plano: Estrutura de Dias Classificatórios

## Resumo do Requisito
- Torneio A tem Dia 1 (classificatório) e Dia 2 (final)
- Todos jogadores sobreviventes do Dia 1 avançam para o Dia 2
- Não há novo buy-in - o buy-in do Dia 1 cobre participação no Dia 2
- Jogadores mantêm as fichas que terminaram no Dia 1

## Modelo de Dados

### 1. Alterações na tabela `tournament_days`

```sql
-- Tipo do dia
day_type VARCHAR(20) DEFAULT 'regular'
  CHECK (day_type IN ('regular', 'qualifying', 'final'))

-- Referência para qual dia este classifica (apenas para 'qualifying')
qualifies_to_day_id UUID REFERENCES tournament_days(id) ON DELETE SET NULL
```

### 2. Alterações na tabela `tournament_players`

```sql
-- Fichas ao final do dia (para transferir entre dias)
final_chip_count INTEGER DEFAULT NULL

-- De qual dia o jogador veio (para jogadores no dia final)
qualified_from_day_id UUID REFERENCES tournament_days(id) ON DELETE SET NULL

-- Flag indicando se é uma entrada por classificação (sem buy-in)
is_qualified_entry BOOLEAN DEFAULT FALSE
```

## Fluxo de Uso

### Criação do Torneio
1. Criar Dia 1 como `day_type = 'qualifying'`
2. Criar Dia 2 como `day_type = 'final'`
3. Vincular Dia 1 ao Dia 2 via `qualifies_to_day_id`

### Durante o Dia 1
1. Jogadores fazem buy-in normalmente
2. Ao eliminar jogador, marcar `status = 'eliminated'`
3. Ao finalizar o dia, registrar `final_chip_count` de todos sobreviventes

### Transição para Dia 2
1. Botão "Avançar Classificados" no Dia 1
2. Sistema cria entradas no Dia 2 para todos sobreviventes:
   - `is_qualified_entry = TRUE` (sem cobrar buy-in)
   - `qualified_from_day_id = dia1_id`
   - `starting_chips = final_chip_count do dia anterior`
3. Jogadores aparecem automaticamente no Dia 2

## Arquivos a Modificar

### Database
- [ ] `database_migration_qualifying_days.sql` - Nova migração

### Backend
- [ ] `backend/app/models/tournament_day.py` - Adicionar campos `day_type`, `qualifies_to_day_id`
- [ ] `backend/app/models/tournament_player.py` - Adicionar campos `final_chip_count`, `qualified_from_day_id`, `is_qualified_entry`
- [ ] `backend/app/services/tournament_day_service.py` - Método para finalizar dia e avançar classificados
- [ ] `backend/app/routers/tournament_days.py` - Endpoint para avançar classificados

### Frontend
- [ ] `frontend/src/pages/TournamentDetail.js` - UI para configurar tipo do dia e avançar classificados

## Endpoints Novos

### POST `/tournament-days/{day_id}/advance-qualifiers`
Avança todos jogadores sobreviventes para o dia final vinculado.

**Requisitos:**
- Dia deve ser do tipo 'qualifying'
- Dia deve ter `qualifies_to_day_id` configurado
- Dia deve estar com status 'completed'

**Ações:**
1. Buscar todos jogadores com `status != 'eliminated'` no dia
2. Para cada jogador:
   - Criar entrada no dia final com `is_qualified_entry = TRUE`
   - Copiar `final_chip_count` como `starting_chips` (ou usar campo específico)
   - Marcar `qualified_from_day_id`

### PATCH `/tournament-days/{day_id}/finalize`
Finaliza um dia classificatório, registrando fichas finais dos sobreviventes.

## Considerações

1. **Múltiplos Dia 1**: Suportar Dia 1A, Dia 1B, Dia 1C todos classificando para mesmo Dia 2
2. **Validações**: Impedir avançar se dia final não existir ou não estiver vinculado
3. **Visualização**: Mostrar claramente quais jogadores são "classificados" vs "buy-in direto"
4. **Fichas**: Campo para registrar stack final de cada jogador sobrevivente
