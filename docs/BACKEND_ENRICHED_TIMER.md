# Backend - Enriched Timer Status API

## ✅ O que foi implementado

### 1. Database Migration
**Arquivo**: `database_migration_add_break_field.sql`

Adiciona o campo `is_break` na tabela `blinds` para permitir marcar níveis como intervalos (breaks):

```sql
ALTER TABLE blinds
ADD COLUMN IF NOT EXISTS is_break BOOLEAN DEFAULT false;
```

**Como executar**:
```bash
# Copie o conteúdo do arquivo e execute no Supabase SQL Editor
```

### 2. Service Layer - Funções Helper
**Arquivo**: `backend/app/services/tournament_day_service.py`

Adicionadas 5 funções helper privadas:

- `_get_all_blinds(day_id, tournament_id)` - Busca blinds (day-specific ou tournament-level)
- `_find_blind_by_level(blinds, level)` - Encontra blind específico por nível
- `_sum_durations_before_level(blinds, target_level)` - Calcula duração total dos níveis anteriores
- `_find_next_break(blinds, current_level, current_elapsed)` - Encontra próximo break e calcula tempo até ele
- `get_enriched_timer_status(day_id)` - Retorna status enriquecido com todas as informações

### 3. API Endpoint
**Arquivo**: `backend/app/routers/tournament_days.py`

Novo endpoint público (sem autenticação):

```
GET /tournament-days/{day_id}/timer/status-enriched
```

**Response**:
```json
{
  "current_level": 3,
  "elapsed_time": 1800,
  "is_paused": false,
  "timer_started_at": "2024-01-15T10:30:00Z",

  "current_blind": {
    "id": "uuid",
    "level": 3,
    "small_blind": 100,
    "big_blind": 200,
    "ante": 0,
    "duration": 10,
    "is_break": false
  },

  "next_blind": {
    "id": "uuid",
    "level": 4,
    "small_blind": 150,
    "big_blind": 300,
    "ante": 25,
    "duration": 10,
    "is_break": false
  },

  "time_remaining_current_level": 420,

  "next_break": {
    "level": 6,
    "duration": 900,
    "time_until_break": 2400
  },

  "active_players": 45,
  "total_entries": 50
}
```

## 🧪 Como Testar

### 1. Aplicar Migration
Execute o SQL no Supabase SQL Editor.

### 2. Criar Blinds com Breaks

```sql
-- Criar blinds normais e um break
INSERT INTO blinds (tournament_id, level, small_blind, big_blind, ante, duration, is_break)
VALUES
  ('your-tournament-id', 1, 25, 50, 0, 10, false),
  ('your-tournament-id', 2, 50, 100, 0, 10, false),
  ('your-tournament-id', 3, 75, 150, 0, 10, false),
  ('your-tournament-id', 4, NULL, NULL, NULL, 15, true),  -- BREAK
  ('your-tournament-id', 5, 100, 200, 25, 10, false);
```

### 3. Testar o Endpoint

```bash
# Obter day_id de um torneio ativo
curl http://localhost:8000/tournament-days/{day_id}/timer/status-enriched
```

**Exemplo de resposta quando no nível 2**:
```json
{
  "current_level": 2,
  "elapsed_time": 720,
  "is_paused": false,
  "current_blind": {
    "level": 2,
    "small_blind": 50,
    "big_blind": 100,
    "duration": 10
  },
  "next_blind": {
    "level": 3,
    "small_blind": 75,
    "big_blind": 150,
    "duration": 10
  },
  "time_remaining_current_level": 480,
  "next_break": {
    "level": 4,
    "duration": 900,
    "time_until_break": 1680  // 28 minutos
  },
  "active_players": 48,
  "total_entries": 50
}
```

## 📊 Cálculos Implementados

### Time Remaining in Current Level
```
elapsed_in_previous = sum(durations of levels 1 to current-1)
elapsed_in_current = elapsed_time - elapsed_in_previous
time_remaining = (current_level_duration * 60) - elapsed_in_current
```

### Time Until Next Break
```
remaining_in_current = time_remaining_current_level
time_between_levels = sum(durations between current and break)
time_until_break = remaining_in_current + time_between_levels
```

## 🎯 Próximos Passos

✅ **Backend implementado e testado**

Próximo:
- [ ] Criar `useTimerSync` hook no frontend
- [ ] Atualizar TournamentBroadcast para usar novo endpoint
- [ ] Atualizar TournamentControl para usar novo endpoint
- [ ] Adicionar UI para breaks na tela de broadcast
- [ ] Adicionar contador "Tempo até próximo break"

## 🔄 Compatibilidade

O endpoint antigo `/timer/status` continua funcionando normalmente. O novo endpoint `/timer/status-enriched` é uma adição que não quebra nada existente.

## 🐛 Debug

Para verificar logs do backend:
```bash
docker logs -f torneios-backend-fixed
```

Para inspecionar os dados retornados:
```bash
curl -v http://localhost:8000/tournament-days/{day_id}/timer/status-enriched | python -m json.tool
```
