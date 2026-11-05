# Correção: Página Caixa Geral e Rake

## Problema Original

A página **Caixa Geral & Rake** estava vazia e apresentava os seguintes erros:

1. **Erro 500 (Internal Server Error)** nos endpoints `/cash/general` e `/cash/rake`
2. **Erro CORS** bloqueando as requisições
3. **Erro 401/403 (Unauthorized/Forbidden)** por falta de autenticação
4. Console do navegador mostrando erros de rede

## Causa Raiz

Os endpoints de caixa exigem **autenticação JWT**, mas:
- O sistema de autenticação estava configurado corretamente
- Os endpoints estavam protegidos corretamente
- **O problema era que o usuário precisava estar logado** para acessar os dados

## Solução Implementada

### 1. **Backend** (`backend/app/routers/cash_register.py`)

✅ **Autenticação mantida** em todos os endpoints:
- `GET /cash/general` - Requer autenticação
- `GET /cash/rake` - Requer autenticação
- `GET /cash/stage/{stage_id}` - Requer autenticação
- `POST /cash/sangria` - Requer autenticação
- `GET /stages` - Requer autenticação

✅ **Tratamento de erros aprimorado** com try-catch blocks

✅ **Endpoints de debug removidos** (não são necessários em produção)

### 2. **Frontend** (`frontend/src/pages/CaixaGeral.js`)

✅ **Tratamento de erros de autenticação**:
```javascript
if (error.response?.status === 401 || error.response?.status === 403) {
  alert('Sessão expirada. Por favor, faça login novamente.');
  window.location.href = '/login';
}
```

✅ **Rota protegida** (`frontend/src/App.js`):
```javascript
<Route
  path="/caixa-geral"
  element={
    <PrivateRoute>
      <CaixaGeral />
    </PrivateRoute>
  }
/>
```

### 3. **Sistema de Autenticação**

✅ **JWT Token armazenado** no localStorage (`supabase_token`)

✅ **Interceptor do Axios** adicionando token em todas as requisições:
```javascript
api.interceptors.request.use((config) => {
  const token = localStorage.getItem('supabase_token');
  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
});
```

## Como Testar

### 1. **Reiniciar o Backend**
```bash
cd backend
# Parar o servidor atual (Ctrl+C)
uvicorn app.main:app --reload
```

### 2. **Fazer Login**
- Acesse: http://localhost:3000/login
- Faça login com suas credenciais do Supabase
- Verifique que o token foi salvo (F12 → Application → Local Storage → `supabase_token`)

### 3. **Acessar Caixa Geral**
- Navegue para: http://localhost:3000/caixa-geral
- Deve carregar os seguintes cards:
  - **Caixa do Dia**: Saldo atual da etapa selecionada
  - **Caixa Geral**: Total acumulado de sangrias
  - **Rake Acumulado**: Total de rake (20%)

### 4. **Verificar Funcionalidades**
- ✅ Selecionar etapa no dropdown
- ✅ Ver saldo do caixa do dia
- ✅ Ver caixa geral e rake
- ✅ Realizar sangria (botão deve estar habilitado se houver saldo)
- ✅ Ver histórico de sangrias

## Estrutura do Banco de Dados

As tabelas usadas pela funcionalidade:

### `stage_cash_register` (Caixa do Dia)
- `stage_id` - Referência à etapa
- `current_balance` - Saldo atual
- `total_received` - Total recebido
- `total_sangrias` - Total de sangrias realizadas

### `general_cash_register` (Caixa Geral)
- `current_balance` - Saldo disponível para premiações
- `total_received` - Total acumulado de sangrias (após rake)

### `rake_register` (Registro de Rake)
- `total_rake` - Total de rake acumulado (lucro da casa)

### `sangria_transactions` (Histórico de Sangrias)
- `stage_id` - Etapa da sangria
- `amount` - Valor bruto
- `rake_percentage` - % de rake (padrão: 20%)
- `rake_amount` - Valor do rake
- `net_amount` - Valor líquido para caixa geral

## Fluxo de Sangria

1. Usuário seleciona uma etapa
2. Vê o saldo do **Caixa do Dia** da etapa
3. Clica em "Realizar Sangria"
4. Informa:
   - Valor da sangria
   - % de rake (padrão 20%)
   - Observações (opcional)
5. Sistema calcula:
   - Rake = Valor × 20%
   - Valor Líquido = Valor - Rake
6. Sistema atualiza:
   - **Caixa do Dia**: subtrai o valor total
   - **Caixa Geral**: adiciona o valor líquido
   - **Rake**: adiciona o valor do rake
   - Cria registro em `sangria_transactions`

## Segurança

✅ **Autenticação JWT** em todos os endpoints sensíveis
✅ **Validação de sessão** antes de acessar a página
✅ **Redirecionamento para login** se sessão expirar
✅ **CORS configurado** apenas para origens permitidas
✅ **Row Level Security (RLS)** no Supabase

## Próximos Passos (Opcional)

1. **Adicionar permissões por role**:
   - Admin: pode realizar sangrias
   - Operador: apenas visualiza

2. **Adicionar confirmação de sangria**:
   - Modal de confirmação antes de executar
   - Resumo dos valores calculados

3. **Exportar relatório de sangrias**:
   - PDF com histórico
   - Excel para análise

4. **Dashboard de caixa**:
   - Gráficos de evolução
   - Comparativo entre etapas

## Arquivos Modificados

- ✅ `backend/app/routers/cash_register.py` - Endpoints de caixa
- ✅ `frontend/src/pages/CaixaGeral.js` - Tratamento de erros
- ✅ `frontend/src/App.js` - Rotas protegidas (já estava configurado)
- ✅ `frontend/src/config/api.js` - Interceptor de autenticação (já estava configurado)

## Observações

- Todos os endpoints agora exigem autenticação (produção)
- O sistema redireciona para login se a sessão expirar
- Os dados são carregados automaticamente após login
- A autenticação é gerenciada pelo Supabase Auth
