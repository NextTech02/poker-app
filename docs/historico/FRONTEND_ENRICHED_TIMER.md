# Frontend - Enriched Timer Integration

## ✅ O que foi implementado

### 1. Shared Hook - useTimerSync
**Arquivo**: `frontend/src/hooks/useTimerSync.js`

Hook compartilhado que sincroniza o timer entre a tela de controle e a tela de broadcast.

**Características**:
- Busca status enriquecido do endpoint `/timer/status-enriched` a cada 5 segundos
- Tick local a cada 1 segundo para countdown suave
- Auto-correção em cada sincronização com o servidor
- Retorna estado com current_blind, next_blind e next_break

**Exports**:
```javascript
export const useTimerSync = (dayId) => {
  // Returns: { timerState, refetch, error, isLoading }
}

export const formatTime = (seconds) => {
  // Returns: "MM:SS"
}

export const formatTimeHuman = (seconds) => {
  // Returns: "1h 20m" ou "15m 30s" ou "45s"
}
```

### 2. Componente Reutilizável - EnrichedTimerDisplay
**Arquivo**: `frontend/src/components/EnrichedTimerDisplay.js`

Componente visual que exibe informações enriquecidas do timer.

**Props**:
- `dayId` (string) - ID do tournament day
- `compact` (boolean) - Modo compacto ou completo (default: false)

**Modo Completo** (compact=false):
- Valores dos blinds atuais (small, big, ante) OU indicador de break
- Preview do próximo nível
- Countdown até o próximo break
- Players ativos/total entries

**Modo Compacto** (compact=true):
- Próximo nível em uma linha
- Countdown de break em uma linha
- Ideal para sidebars

### 3. CSS Styling
**Arquivo**: `frontend/src/components/EnrichedTimerDisplay.css`

Estilos profissionais com:
- Gradientes poker-themed
- Responsivo (mobile, tablet, desktop)
- Animações suaves
- Indicador visual de breaks (dourado)
- Grid layout para valores de blinds

### 4. Integração na Tela de Broadcast
**Arquivo**: `frontend/src/pages/TournamentBroadcast.js`

**Mudanças**:
- Importa `EnrichedTimerDisplay`
- Adiciona componente no sidebar quando `isDayBased` é true
- Substitui o cálculo manual de "intervalo em" pelo countdown de break enriquecido
- Modo compacto para não ocupar muito espaço

**Localização**:
```jsx
{isDayBased && (
  <div className="sidebar-section enriched-timer-section">
    <EnrichedTimerDisplay dayId={id} compact={true} />
  </div>
)}
```

**CSS Adicional**: `frontend/src/pages/TournamentBroadcast.css`
- Estilo para `.sidebar-section.enriched-timer-section`
- Integração com tema existente

### 5. Integração na Tela de Controle
**Arquivo**: `frontend/src/pages/TournamentControl.js`

**Mudanças**:
- Importa `EnrichedTimerDisplay`
- Adiciona card dedicado com informações enriquecidas
- Modo completo para mostrar todos os detalhes
- Posicionado após o grid de estatísticas

**Localização**:
```jsx
{/* Enriched Timer Information */}
<Card className="enriched-timer-card">
  <EnrichedTimerDisplay dayId={dayId} compact={false} />
</Card>
```

**CSS Adicional**: `frontend/src/pages/TournamentControl.css`
- Estilo para `.enriched-timer-card`
- Integração transparente com tema do card

## 🎯 Como Funciona

### Fluxo de Sincronização

```
Backend (Source of Truth)
    ↓ (GET /timer/status-enriched @ 5s)
useTimerSync Hook
    ↓ (timerState)
EnrichedTimerDisplay Component
    ↓ (visual display)
User sees current/next/break info
```

### Sincronização Bidirecional

**Broadcast Screen** ← (sync) → **Backend** ← (sync) → **Control Panel**

Ambas as telas usam o mesmo hook, garantindo sincronização perfeita.

### Cálculos no Frontend

O hook recebe do backend:
- `time_remaining_current_level` - Tempo restante no nível atual (em segundos)
- `next_break.time_until_break` - Tempo até o próximo break (em segundos)

O hook aplica tick local:
```javascript
const timeRemainingAdjusted = Math.max(0, timerState.time_remaining_current_level - localTick);
```

Isso cria countdown suave entre os syncs de 5 segundos.

## 🧪 Como Testar

### 1. Iniciar Backend
```bash
cd backend
uvicorn app.main:app --reload
```

### 2. Iniciar Frontend
```bash
cd frontend
npm start
```

### 3. Navegar para Tournament Day Ativo

1. Acesse: http://localhost:3000
2. Vá para "Torneios"
3. Selecione um torneio com days
4. Inicie um day (status → "active")

### 4. Testar Tela de Broadcast

**URL**: http://localhost:3000/broadcast/{day_id}

**Verificar**:
- Sidebar mostra "Próximo: X/Y" (próximo blind)
- Sidebar mostra "Intervalo em: Xm Ys" (countdown até break)
- Countdown diminui a cada segundo
- Ao dar F5, valores persistem corretamente

### 5. Testar Tela de Controle

**URL**: Clique em "Controle" no card do day ativo

**Verificar**:
- Card "Enriched Timer Information" aparece após as estatísticas
- Mostra blinds atuais detalhados (small/big/ante)
- Mostra "Próximo Nível" com valores
- Mostra "Próximo Intervalo" com countdown
- Countdown sincroniza com broadcast screen

### 6. Testar Sincronização

**Abrir duas abas**:
1. Tab 1: Broadcast Screen
2. Tab 2: Control Panel

**Verificar**:
- Ambas mostram mesmo countdown
- Ao avançar nível no Control, Broadcast atualiza em até 5 segundos
- Pause no Control congela countdown em ambas as telas

### 7. Testar com Breaks

**Criar blinds com break**:
```sql
-- No Supabase SQL Editor
INSERT INTO blinds (tournament_id, level, small_blind, big_blind, ante, duration, is_break)
VALUES
  ('your-tournament-id', 1, 25, 50, 0, 10, false),
  ('your-tournament-id', 2, 50, 100, 0, 10, false),
  ('your-tournament-id', 3, NULL, NULL, NULL, 15, true),  -- BREAK
  ('your-tournament-id', 4, 75, 150, 0, 10, false);
```

**Verificar**:
- Quando no nível 1, mostra "Intervalo em: 20m" (10m do nível 1 + 10m do nível 2)
- Quando no nível 2, mostra "Intervalo em: 10m" (restante do nível 2)
- Quando atinge nível 3, mostra "INTERVALO" com duração de 15 minutos
- Próximo nível mostra "Intervalo (15min)"

## 📊 Estrutura de Dados

### Resposta do Backend

```json
{
  "current_level": 2,
  "elapsed_time": 720,
  "is_paused": false,
  "timer_started_at": "2024-01-15T10:30:00Z",

  "current_blind": {
    "id": "uuid",
    "level": 2,
    "small_blind": 50,
    "big_blind": 100,
    "ante": 0,
    "duration": 10,
    "is_break": false
  },

  "next_blind": {
    "level": 3,
    "small_blind": null,
    "big_blind": null,
    "ante": null,
    "duration": 15,
    "is_break": true
  },

  "time_remaining_current_level": 480,

  "next_break": {
    "level": 3,
    "duration": 900,
    "time_until_break": 480
  },

  "active_players": 48,
  "total_entries": 50
}
```

### Estado do Hook

```javascript
const { timerState, refetch, error, isLoading } = useTimerSync(dayId);

// timerState contém a resposta acima com ajuste local
// timerState.time_remaining_current_level já considera localTick
// timerState.next_break.time_until_break já considera localTick
```

## 🔄 Compatibilidade

**Backward Compatible**:
- Telas antigas continuam funcionando
- Novo componente só aparece quando `isDayBased` é true
- Não quebra funcionalidade existente

**Progressive Enhancement**:
- Se backend não tiver campo `is_break`, funciona normalmente (sem breaks)
- Se não houver próximo break, não mostra seção de break
- Graceful degradation em caso de erro de API

## 🐛 Troubleshooting

### Countdown não aparece
- Verificar se migration de `is_break` foi aplicada
- Verificar se existem blinds cadastrados para o tournament
- Verificar console do browser para erros de API

### Countdown não sincroniza
- Verificar se backend está rodando (http://localhost:8000/docs)
- Verificar network tab no DevTools (deve ter requests a cada 5s)
- Verificar se `dayId` está correto

### Valores errados
- Verificar cálculos no backend (ver logs)
- Testar endpoint diretamente: `GET /tournament-days/{day_id}/timer/status-enriched`
- Comparar com cálculo manual

### Estilo quebrado
- Verificar se todos os arquivos CSS foram criados
- Limpar cache do browser (Ctrl+Shift+R)
- Verificar console do browser para erros de CSS

## 🎨 Customização

### Mudar cores do tema

Editar `EnrichedTimerDisplay.css`:
```css
.enriched-timer-full {
  background: linear-gradient(135deg, #SUA_COR_1 0%, #SUA_COR_2 100%);
}
```

### Mudar intervalo de sync

Editar `useTimerSync.js`:
```javascript
const interval = setInterval(() => {
  fetchStatus();
}, 3000); // Trocar 5000 por 3000 para sync a cada 3s
```

### Adicionar mais informações

1. Adicionar no backend em `get_enriched_timer_status()`
2. Retornar no endpoint `/timer/status-enriched`
3. Usar no componente `EnrichedTimerDisplay.js`

## 📝 Próximos Passos

- [ ] Adicionar testes unitários para o hook
- [ ] Adicionar testes E2E para sincronização
- [ ] Adicionar loading states mais elaborados
- [ ] Adicionar animações de transição entre níveis
- [ ] Adicionar notificação sonora quando break se aproxima
- [ ] Adicionar configuração de intervalo de sync no UI
- [ ] Adicionar modo "offline" com fallback para localStorage

## 🚀 Deploy

Nenhuma configuração adicional necessária para deploy. Os arquivos criados serão incluídos automaticamente no build do React:

```bash
cd frontend
npm run build
```

O build incluirá:
- `useTimerSync.js` no bundle
- `EnrichedTimerDisplay.js` no bundle
- `EnrichedTimerDisplay.css` no bundle
- Integrações em TournamentBroadcast e TournamentControl
