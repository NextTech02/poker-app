# Sistema de Alocação de Jogadores - Instruções

## Visão Geral

Foi implementado um sistema completo de alocação de jogadores em mesas de poker, com duas modalidades:

1. **Alocação Automática**: O sistema aloca automaticamente os jogadores em mesas ao se registrarem
2. **Alocação Manual**: Administradores podem alocar jogadores manualmente via drag-and-drop

## Migrações de Banco de Dados

### 1. Executar Migração de Tabelas
Execute primeiro o arquivo: `database_migration_add_tables.sql`

Esta migração cria a tabela `tables` para gerenciar as mesas dos torneios.

### 2. Executar Migração de Alocações
Execute depois o arquivo: `database_migration_add_seat_allocations.sql`

Esta migração:
- Adiciona o campo `allocation_type` na tabela `tournaments`
- Cria a tabela `seat_allocations` para registrar alocações de assentos

## Funcionalidades Implementadas

### Backend

#### Modelos Criados
1. **Tournament (atualizado)**
   - Novo campo: `allocation_type` (automatic/manual)
   - Localização: `backend/app/models/tournament.py`

2. **Table**
   - Gerencia mesas do torneio
   - Localização: `backend/app/models/table.py`

3. **SeatAllocation**
   - Registra alocação de jogadores em assentos
   - Localização: `backend/app/models/seat_allocation.py`

#### Serviços Criados
1. **TableService**
   - CRUD de mesas
   - Criação em massa de mesas
   - Estatísticas de mesas
   - Localização: `backend/app/services/table_service.py`

2. **AllocationService**
   - Auto-alocação com balanceamento de mesas
   - Alocação manual
   - Listagem de jogadores não alocados
   - Remoção e atualização de alocações
   - Localização: `backend/app/services/allocation_service.py`

#### API Endpoints

**Tables (`/tables`)**
- `POST /tables/tournament/{tournament_id}` - Criar mesa
- `POST /tables/tournament/{tournament_id}/bulk` - Criar múltiplas mesas
- `GET /tables/tournament/{tournament_id}` - Listar mesas do torneio
- `GET /tables/tournament/{tournament_id}/stats` - Estatísticas das mesas
- `GET /tables/{table_id}` - Detalhes da mesa
- `PATCH /tables/{table_id}` - Atualizar mesa
- `DELETE /tables/{table_id}` - Deletar mesa
- `POST /tables/{table_id}/break` - Quebrar mesa

**Allocations (`/allocations`)**
- `POST /allocations/tournament/{tournament_id}/auto?player_id={id}` - Auto-alocar jogador
- `POST /allocations/tournament/{tournament_id}/manual` - Alocar manualmente
- `GET /allocations/tournament/{tournament_id}` - Listar alocações do torneio
- `GET /allocations/tournament/{tournament_id}/unallocated` - Jogadores não alocados
- `GET /allocations/table/{table_id}` - Alocações de uma mesa
- `GET /allocations/{allocation_id}` - Detalhes da alocação
- `PATCH /allocations/{allocation_id}` - Atualizar alocação (mover jogador)
- `DELETE /allocations/{allocation_id}` - Remover alocação

### Frontend

#### Componentes Criados

1. **SeatTicket** (`frontend/src/components/SeatTicket.js`)
   - Componente para exibir e imprimir bilhetes de entrada
   - Mostra: nome do jogador, torneio, mesa e assento
   - Botão de impressão que abre janela com formatação térmica

2. **ManualAllocation** (`frontend/src/pages/ManualAllocation.js`)
   - Interface drag-and-drop para alocação manual
   - Painel lateral com jogadores não alocados
   - Grade de mesas com visualização de assentos
   - Atualização em tempo real (polling a cada 3s)
   - Modal de impressão de bilhete após alocação

#### Formulário de Torneio Atualizado
- Novo campo: **Tipo de Alocação**
  - Automática: Sistema aloca jogadores ao registrá-los
  - Manual: Administrador aloca via drag-and-drop

- **Gerenciamento de Mesas**
  - Input: Lugares por mesa (2-10)
  - Input: Quantidade de mesas (1-50)
  - Botão: "Adicionar X Mesa(s)"
  - Lista visual das mesas adicionadas
  - Edição individual de lugares por mesa
  - Remoção de mesas

#### Nova Rota
- `/alocacao/:tournamentId` - Página de alocação manual

#### Botão de Alocação
- Adicionado aos cards de torneios (status: pending ou active)
- Redireciona para a página de alocação manual

## Como Usar

### 1. Criar Torneio com Mesas

1. Acesse "Novo Torneio"
2. Preencha os dados básicos
3. Escolha o tipo de alocação:
   - **Automática**: Para torneios onde o sistema gerencia assentos
   - **Manual**: Para controle total dos administradores
4. Na seção "Gerenciamento de Mesas":
   - Defina lugares por mesa (ex: 9)
   - Defina quantidade (ex: 10)
   - Clique em "Adicionar 10 Mesas"
5. Ajuste lugares individuais se necessário
6. Clique em "Criar Torneio"

### 2. Alocação Automática

**Quando usar**: Torneios grandes onde o sistema deve gerenciar automaticamente.

**Como funciona**:
1. Quando um jogador se registra (buy-in/rebuy), o sistema:
   - Encontra a mesa com menos jogadores
   - Aloca em um assento aleatório disponível
   - Gera bilhete de entrada automaticamente
   - Atualiza contadores de assentos ocupados

**Integração necessária**:
```javascript
// No componente de registro de jogador (Caixa.js ou similar)
// Após registrar buy-in/rebuy com sucesso:

if (tournament.allocation_type === 'automatic') {
  try {
    const allocation = await api.post(
      `/allocations/tournament/${tournamentId}/auto?player_id=${playerId}`
    );

    // Mostrar bilhete para impressão
    setShowTicket(allocation.data);
  } catch (error) {
    console.error('Erro na alocação automática:', error);
  }
}
```

### 3. Alocação Manual

**Quando usar**: Torneios onde há controle específico de alocação ou necessidade de rebalanceamento.

**Como usar**:
1. No card do torneio, clique em "Alocar Jogadores"
2. Na página de alocação:
   - **Painel esquerdo**: Jogadores não alocados
   - **Área principal**: Grade de mesas com assentos
3. Para alocar:
   - Arraste o card do jogador
   - Solte sobre um assento vazio (destacado em verde)
   - Bilhete de impressão aparece automaticamente
4. Para remover alocação:
   - Clique no "X" no assento ocupado
5. Para realocar:
   - Arraste o jogador para outro assento vazio

### 4. Imprimir Bilhetes

O bilhete de entrada contém:
- Nome do torneio
- Nome do jogador
- **Mesa e Assento** (destaque)
- Data/hora da alocação
- ID da alocação

**Formato**:
- Otimizado para impressora térmica 80mm
- Layout de cupom com bordas tracejadas
- Informações centralizadas e legíveis

## Fluxo de Trabalho Recomendado

### Para Torneios Automáticos:
1. Criar torneio com allocation_type = "automatic"
2. Adicionar mesas necessárias
3. Registrar jogadores normalmente
4. Sistema aloca automaticamente
5. Imprimir bilhete ao alocar
6. Usar página de alocação manual apenas para ajustes

### Para Torneios Manuais:
1. Criar torneio com allocation_type = "manual"
2. Adicionar mesas necessárias
3. Registrar jogadores (ficam em lista de espera)
4. Acessar "Alocar Jogadores"
5. Alocar via drag-and-drop conforme estratégia
6. Imprimir bilhetes conforme necessário
7. Rebalancear durante o torneio se necessário

## Funcionalidades de Rebalanceamento

A página de alocação manual está **sempre disponível** para torneios ativos ou pendentes, independentemente do tipo de alocação escolhido.

**Casos de uso**:
- Mesas desbalanceadas durante o torneio
- Jogadores eliminados causando mesas com poucos jogadores
- Necessidade de quebrar mesas e redistribuir jogadores
- Correção de alocações incorretas

## Estatísticas e Monitoramento

**Por Mesa**:
- Total de assentos
- Assentos ocupados
- Taxa de ocupação

**Por Torneio**:
- Total de jogadores alocados
- Total de jogadores não alocados
- Distribuição por mesa
- Mesas cheias/vazias

## Notas Técnicas

### Regras de Negócio
1. Um jogador só pode estar alocado em um assento por torneio
2. Um assento só pode ter um jogador
3. Ao realocar, a alocação anterior é automaticamente removida
4. Contador de `occupied_seats` é atualizado automaticamente
5. Auto-alocação balanceia mesas (menor número de jogadores primeiro)
6. Assento é escolhido aleatoriamente entre os disponíveis

### Segurança
- Todos os endpoints requerem autenticação
- Validações de capacidade de mesa
- Verificação de disponibilidade de assento
- Prevenção de alocações duplicadas

### Performance
- Polling de 3 segundos na página de alocação manual
- Indexes em tabelas para queries rápidas
- Lazy loading de dados relacionados

## Troubleshooting

### Problema: Bilhete não imprime
**Solução**: Verifique se o navegador permite pop-ups. A impressão abre uma nova janela.

### Problema: Drag-and-drop não funciona
**Solução**: Certifique-se de estar arrastando sobre um assento vazio (destacado em verde).

### Problema: Jogador aparece como não alocado mas já está em uma mesa
**Solução**: Recarregue a página. Pode haver delay no polling.

### Problema: Erro "All tables are full"
**Solução**: Adicione mais mesas através da edição do torneio ou remova jogadores alocados.

## Próximos Passos Sugeridos

1. **Integrar auto-alocação com registro de jogadores**
   - Modificar `Caixa.js` para chamar endpoint de auto-alocação
   - Mostrar modal de bilhete após alocação

2. **Adicionar quebra automática de mesas**
   - Endpoint para quebrar mesa e redistribuir jogadores
   - Botão "Quebrar Mesa" na interface

3. **Adicionar QR Code aos bilhetes**
   - Usar biblioteca como `qrcode.react`
   - Incluir ID da alocação no QR Code
   - Permitir scan para validação

4. **Dashboard de alocações**
   - Visualização geral de todas as mesas
   - Heatmap de ocupação
   - Alertas de desbalanceamento

5. **Histórico de movimentações**
   - Log de todas as alocações/remoções/realocações
   - Auditoria de quem fez cada ação
