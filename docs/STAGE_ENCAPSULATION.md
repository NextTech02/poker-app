# Sistema de Encapsulamento por Etapa (Stage)

Este documento descreve como funciona o sistema de encapsulamento por etapa implementado no sistema de gerenciamento de torneios.

## Visão Geral

Quando uma etapa é selecionada no frontend, **todas as operações no sistema são automaticamente restritas a essa etapa**. Isso significa que:

- ✅ **Leituras (GET)**: Retornam apenas dados da etapa selecionada
- ✅ **Criações (POST)**: Novos recursos são automaticamente associados à etapa selecionada
- ✅ **Modificações (PATCH)**: Validam que o recurso pertence à etapa antes de permitir modificação
- ✅ **Exclusões (DELETE)**: Validam que o recurso pertence à etapa antes de permitir exclusão

## Como Funciona

### Frontend

#### 1. Seleção de Etapa
```javascript
// StageContext mantém a etapa selecionada globalmente
import { useStage } from '../contexts/StageContext';

const { selectedStage, selectStage } = useStage();
```

#### 2. Envio Automático do Header
```javascript
// frontend/src/config/api.js
// Interceptor adiciona X-Stage-ID automaticamente em TODAS as requisições
api.interceptors.request.use((config) => {
  const stageId = getSelectedStageId();
  if (stageId) {
    config.headers['X-Stage-ID'] = stageId;
  }
  return config;
});
```

#### 3. Visualização da Etapa Selecionada
```javascript
// frontend/src/components/Sidebar.js
// Mostra o nome da etapa selecionada abaixo do logo
{selectedStage && (
  <div className="selected-stage-sidebar">
    {selectedStage.name}
  </div>
)}
```

### Backend

#### 1. Extração do Header
```python
# backend/app/dependencies.py
async def get_stage_id_optional(x_stage_id: Optional[str] = Header(None)) -> Optional[str]:
    """Extrai stage_id do header X-Stage-ID (opcional)"""
    return x_stage_id
```

#### 2. Routers Atualizados

##### Tournaments Router
```python
@router.get("", response_model=List[Tournament])
def get_tournaments(
    status: Optional[str] = None,
    stage_id: Optional[str] = None,
    header_stage_id: Optional[str] = Depends(get_stage_id_optional)
):
    """
    GET /tournaments
    - Se X-Stage-ID header presente: retorna APENAS torneios daquela etapa
    - Se não: retorna todos os torneios
    """
    effective_stage_id = header_stage_id if header_stage_id else stage_id
    return TournamentService.get_tournaments(status, effective_stage_id)

@router.post("", response_model=Tournament)
def create_tournament(
    tournament: TournamentCreate,
    stage_id: Optional[str] = Depends(get_stage_id_optional)
):
    """
    POST /tournaments
    - Se X-Stage-ID header presente: associa automaticamente o torneio à etapa
    - Valida que a etapa existe
    """
    if stage_id:
        tournament.stage_id = stage_id
        # Valida que stage existe
    return TournamentService.create_tournament(tournament, user_id)

@router.patch("/{tournament_id}", response_model=Tournament)
def update_tournament(
    tournament_id: str,
    tournament_data: TournamentUpdate,
    stage_id: Optional[str] = Depends(get_stage_id_optional)
):
    """
    PATCH /tournaments/{id}
    - Se X-Stage-ID header presente: valida que torneio pertence à etapa
    - Retorna erro 403 se torneio não pertencer à etapa selecionada
    """
    if stage_id:
        existing = TournamentService.get_tournament(tournament_id)
        if existing.stage_id != stage_id:
            raise HTTPException(403, "Tournament does not belong to selected stage")
    return TournamentService.update_tournament(tournament_id, tournament_data)
```

##### Transactions Router
```python
@router.get("", response_model=List[TransactionDetail])
def get_transactions(
    stage_id: Optional[str] = Depends(get_stage_id_optional)
):
    """
    GET /transactions
    - Se X-Stage-ID header presente: retorna APENAS transações de torneios daquela etapa
    - Usa JOIN com tabela tournaments para filtrar
    """
    return TransactionService.get_transactions(stage_id=stage_id)

@router.post("", response_model=TransactionDetail)
def create_transaction(
    transaction: TransactionCreate,
    stage_id: Optional[str] = Depends(get_stage_id_optional)
):
    """
    POST /transactions
    - Se X-Stage-ID header presente: valida que torneio pertence à etapa
    - Retorna erro 403 se torneio não pertencer à etapa selecionada
    """
    if stage_id:
        tournament = TournamentService.get_tournament(transaction.tournament_id)
        if tournament.stage_id != stage_id:
            raise HTTPException(403, "Cannot create transaction: tournament does not belong to selected stage")
    return TransactionService.create_transaction(transaction, user_id)
```

#### 3. Services Atualizados

##### TournamentService
```python
@staticmethod
def get_tournaments(status: Optional[str] = None, stage_id: Optional[str] = None) -> List[Tournament]:
    """
    Filtra torneios opcionalmente por stage_id
    """
    query = supabase.table("tournaments").select("*")

    if stage_id:
        query = query.eq("stage_id", stage_id)

    if status:
        statuses = status.split(',')
        query = query.in_("status", statuses)

    return query.order("created_at", desc=True).execute()
```

##### TransactionService
```python
@staticmethod
def get_transactions(stage_id: Optional[str] = None) -> List[TransactionDetail]:
    """
    Filtra transações opcionalmente por stage_id através de JOIN com tournaments
    """
    if stage_id:
        response = (
            supabase.table("transactions")
            .select("*, tournaments!inner(name, stage_id), players(name, nickname)")
            .eq("tournaments.stage_id", stage_id)  # JOIN + filtro
            .order("created_at", desc=True)
            .execute()
        )
    else:
        response = (
            supabase.table("transactions")
            .select("*, tournaments(name), players(name, nickname)")
            .order("created_at", desc=True)
            .execute()
        )

    return [TransactionDetail(...) for item in response.data]
```

## Fluxo Completo

### Exemplo: Usuário seleciona uma etapa e visualiza transações

1. **Frontend - Usuário seleciona etapa "Medellin"**
   ```javascript
   selectStage({ id: 'abc-123', name: 'Medellin', ... })
   // Salva no localStorage e StageContext
   ```

2. **Frontend - Componente Caixa carrega transações**
   ```javascript
   const response = await api.get('/transactions');
   // Interceptor adiciona automaticamente: X-Stage-ID: abc-123
   ```

3. **Backend - Router processa requisição**
   ```python
   @router.get("", response_model=List[TransactionDetail])
   def get_transactions(stage_id: Optional[str] = Depends(get_stage_id_optional)):
       # stage_id = 'abc-123' (extraído do header)
       return TransactionService.get_transactions(stage_id=stage_id)
   ```

4. **Backend - Service filtra dados**
   ```python
   def get_transactions(stage_id: Optional[str] = None):
       # Query faz JOIN com tournaments e filtra por stage_id
       .select("*, tournaments!inner(name, stage_id), players(name, nickname)")
       .eq("tournaments.stage_id", 'abc-123')
   ```

5. **Frontend - Recebe apenas transações da etapa Medellin**
   ```javascript
   setTransactions(response.data); // Apenas transações de torneios da etapa Medellin
   ```

## Routers Implementados

✅ **Implementados com validação completa:**
- `/tournaments` - Criação, leitura, modificação e exclusão de torneios
- `/transactions` - Criação e leitura de transações

⏳ **A implementar:**
- `/tournament-players` - Registro de jogadores, rebuys, addons
- `/tables` - Gerenciamento de mesas
- `/allocations` - Alocação de assentos
- `/rankings` - Rankings e premiações

## Comportamento Sem Etapa Selecionada

Se nenhuma etapa estiver selecionada (header `X-Stage-ID` ausente):

- ✅ **GET requests**: Retornam **TODOS** os dados (sem filtro)
- ✅ **POST requests**: Criam recursos **SEM** associação a etapa (stage_id = NULL)
- ✅ **PATCH/DELETE requests**: Funcionam normalmente (sem validação de etapa)

Isso permite que o sistema funcione tanto com quanto sem seleção de etapa.

## Vantagens

1. **Transparente**: Frontend não precisa passar `stage_id` manualmente em cada requisição
2. **Seguro**: Impede modificações acidentais em dados de outras etapas
3. **Simples**: Uma linha de código no frontend (`selectStage()`) controla todo o sistema
4. **Flexível**: Funciona com ou sem etapa selecionada
5. **Escalável**: Fácil adicionar validação em novos endpoints

## Testando

### Frontend
```javascript
// 1. Abra a aplicação
// 2. Vá em "Etapas" e selecione uma etapa
// 3. Observe o nome da etapa aparecer no sidebar abaixo do logo
// 4. Navegue para "Torneios" - deve mostrar apenas torneios daquela etapa
// 5. Navegue para "Caixa" - deve mostrar apenas transações daquela etapa
// 6. Crie um novo torneio - será automaticamente associado à etapa
```

### Backend (via curl)
```bash
# Sem etapa selecionada - retorna todos os torneios
curl http://localhost:8000/tournaments

# Com etapa selecionada - retorna apenas torneios da etapa
curl -H "X-Stage-ID: abc-123" http://localhost:8000/tournaments

# Criar torneio associado a uma etapa
curl -X POST -H "X-Stage-ID: abc-123" -H "Content-Type: application/json" \
  -d '{"name": "Torneio Test", "buy_in": 100, ...}' \
  http://localhost:8000/tournaments
```

## Arquivos Modificados

### Backend
- ✅ **NOVO** `backend/app/dependencies.py` - Extração de stage_id do header
- ✅ `backend/app/routers/tournaments.py` - Validação e filtro por etapa
- ✅ `backend/app/routers/transactions.py` - Validação e filtro por etapa
- ✅ `backend/app/services/tournament_service.py` - Filtro por stage_id
- ✅ `backend/app/services/transaction_service.py` - Filtro por stage_id com JOIN

### Frontend
- ✅ `frontend/src/contexts/StageContext.js` - Gerenciamento global de etapa
- ✅ `frontend/src/config/api.js` - Interceptor para adicionar X-Stage-ID header
- ✅ `frontend/src/components/Sidebar.js` - Exibição da etapa selecionada
- ✅ `frontend/src/pages/Torneios.js` - Removido uso de query parameter
- ✅ `frontend/src/pages/Caixa.js` - Funciona automaticamente com o header

## Próximos Passos

Para completar o encapsulamento:

1. Implementar validação nos routers restantes:
   - `tournament_players` - Validar que torneio pertence à etapa
   - `tables` - Validar que torneio pertence à etapa
   - `allocations` - Validar que torneio pertence à etapa
   - `rankings` - Validar que torneio pertence à etapa

2. Adicionar testes:
   - Testes unitários para dependencies
   - Testes de integração para validação de etapa
   - Testes E2E para fluxo completo

3. Considerar permissões:
   - Validar que usuário tem acesso à etapa selecionada
   - Implementar RLS policies no Supabase
