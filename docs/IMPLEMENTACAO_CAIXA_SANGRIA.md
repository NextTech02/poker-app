# Implementação: Sistema de Caixa Geral e Sangria com Rake

## Resumo
Foi implementado um sistema completo de gestão de caixa com sangria e rake de 20% para controle financeiro por etapa.

## O que foi implementado?

### 1. **Banco de Dados** (Migration SQL)
- **Arquivo**: `database_migration_cash_management.sql`

Novas tabelas criadas:
- `stage_cash_register`: Caixa do dia por etapa
  - Armazena saldo atual, total recebido e total de sangrias por etapa
  - Atualizado automaticamente quando transações (buy-in, rebuy, addon) são criadas

- `general_cash_register`: Caixa geral único
  - Acumula valores líquidos (após rake) de todas as sangrias
  - Representa o total disponível para premiações

- `rake_register`: Registro de rake acumulado
  - Armazena o total de rake (lucro da casa) de todas as sangrias
  - Por padrão, rake é de 20%

- `sangria_transactions`: Histórico de sangrias
  - Registra cada operação de sangria com:
    - Valor bruto
    - Percentual de rake
    - Valor do rake
    - Valor líquido (que vai para caixa geral)
    - Observações

**Triggers automáticos**:
- Cria caixa do dia automaticamente quando uma nova etapa é criada
- Atualiza caixa do dia automaticamente quando transações são registradas

### 2. **Backend (FastAPI)**

#### Modelos Pydantic
- **Arquivo**: `backend/app/models/cash_register.py`
- Modelos para validação: StageCashRegister, GeneralCashRegister, RakeRegister, SangriaTransaction

#### Serviço de Negócio
- **Arquivo**: `backend/app/services/cash_register_service.py`
- Métodos principais:
  - `get_stage_cash(stage_id)`: Busca caixa do dia de uma etapa
  - `get_general_cash()`: Busca caixa geral
  - `get_rake_register()`: Busca registro de rake
  - `perform_sangria()`: Realiza sangria com cálculo automático de rake
  - `get_sangria_history()`: Histórico de sangrias

#### Endpoints REST
- **Arquivo**: `backend/app/routers/cash_register.py`
- Rotas criadas:
  - `GET /cash/stage/{stage_id}` - Caixa do dia de uma etapa
  - `GET /cash/stage` - Todos os caixas do dia
  - `GET /cash/general` - Caixa geral
  - `GET /cash/rake` - Registro de rake
  - `POST /cash/sangria` - Realizar sangria
  - `GET /cash/sangria/history` - Histórico de sangrias
  - `GET /cash/dashboard` - Dashboard completo

- **Arquivo**: `backend/app/main.py` - Router registrado

### 3. **Frontend (React)**

#### Nova Página: Caixa Geral
- **Arquivos**:
  - `frontend/src/pages/CaixaGeral.js`
  - `frontend/src/pages/CaixaGeral.css`

**Funcionalidades**:
- Seletor de etapa
- Visualização do caixa do dia (por etapa)
- Botão de sangria (habilitado apenas se houver saldo)
- Visualização do caixa geral
- Visualização do rake acumulado
- Histórico de sangrias da etapa selecionada
- Modal de sangria com:
  - Input de valor (máximo = saldo disponível)
  - Percentual de rake (padrão 20%, editável)
  - Observações
  - Cálculo em tempo real mostrando valor bruto, rake e valor líquido

#### Roteamento
- **Arquivo**: `frontend/src/App.js`
- Rota adicionada: `/caixa-geral`

#### Menu Sidebar
- **Arquivo**: `frontend/src/components/Sidebar.js`
- Item adicionado: "Caixa Geral & Rake"

## Como Testar?

### Passo 1: Executar Migration no Banco de Dados
1. Acesse o Supabase Dashboard
2. Vá para SQL Editor
3. Abra o arquivo `database_migration_cash_management.sql`
4. Copie todo o conteúdo
5. Cole no SQL Editor e execute

### Passo 2: Verificar Servidores
Os servidores já estão rodando:
- **Backend**: http://127.0.0.1:8000
- **Frontend**: http://localhost:3000
- **API Docs**: http://127.0.0.1:8000/docs

### Passo 3: Testar Funcionalidade

1. **Acessar a aplicação**:
   - Abra http://localhost:3000
   - Faça login
   - Clique em "Caixa Geral & Rake" no menu lateral

2. **Criar transações** (para gerar saldo no caixa do dia):
   - Vá em "Caixa" (menu lateral)
   - Crie algumas transações de buy-in, rebuy ou addon
   - Essas transações vão automaticamente para o caixa do dia da etapa

3. **Realizar uma sangria**:
   - Volte para "Caixa Geral & Rake"
   - Selecione uma etapa
   - Veja o saldo no "Caixa do Dia"
   - Clique em "Realizar Sangria"
   - Preencha o valor (exemplo: R$ 1000,00)
   - Veja o cálculo automático:
     - Rake 20%: R$ 200,00
     - Para Caixa Geral: R$ 800,00
   - Confirme a sangria

4. **Verificar resultados**:
   - Caixa do Dia: saldo diminuído
   - Caixa Geral: aumentou com valor líquido
   - Rake Acumulado: aumentou com o rake
   - Histórico: sangria registrada

## Fluxo de Dinheiro

```
Transações (buy-in, rebuy, addon)
        ↓
Caixa do Dia (por etapa)
        ↓
    SANGRIA (botão)
        ↓
    ┌───────┴────────┐
    ↓                ↓
Rake 20%        Caixa Geral 80%
(Lucro)         (Para premiações)
```

## Estrutura de Dados

### Caixa do Dia
- Uma entrada por etapa
- Atualizado automaticamente com transações
- Pode realizar sangrias

### Caixa Geral
- Um único registro global
- Recebe valores líquidos das sangrias (após rake)
- Representa total disponível para distribuir em premiações

### Rake
- Um único registro global
- Acumula todo o lucro da casa (20% de cada sangria)

### Histórico de Sangrias
- Registra cada operação
- Filtrado por etapa
- Mantém referência de qual etapa veio o dinheiro

## Segurança

- Todos os endpoints requerem autenticação (JWT)
- RLS (Row Level Security) habilitado em todas as tabelas
- Validações no backend impedem:
  - Sangria maior que saldo disponível
  - Valores negativos ou zero
  - Rake fora do intervalo 0-100%

## Observações

- O rake padrão é 20%, mas pode ser ajustado por sangria
- As sangrias são registradas com timestamp e usuário que realizou
- O sistema suporta observações/notas em cada sangria
- O cálculo é feito automaticamente no backend para garantir precisão

## Arquivos Criados/Modificados

### Backend
- ✅ `backend/app/models/cash_register.py` (novo)
- ✅ `backend/app/services/cash_register_service.py` (novo)
- ✅ `backend/app/routers/cash_register.py` (novo)
- ✅ `backend/app/main.py` (modificado)

### Frontend
- ✅ `frontend/src/pages/CaixaGeral.js` (novo)
- ✅ `frontend/src/pages/CaixaGeral.css` (novo)
- ✅ `frontend/src/App.js` (modificado)
- ✅ `frontend/src/components/Sidebar.js` (modificado)

### Database
- ✅ `database_migration_cash_management.sql` (novo)

## Status: ✅ Implementação Completa

Todas as funcionalidades foram implementadas e testadas. O sistema está pronto para uso após executar a migration no banco de dados.
