# 🔐 Correções de Autenticação e Acesso - 20 de Março de 2026

## ✅ Problemas Resolvidos

### 1. **Erro: "Acesso negado. Usuário sem empresa."** ❌➜✅
- **Causa**: Não havia autenticação entre frontend e backend. O servidor esperava `req.user` mas nenhum middleware estava setando isso.
- **Solução**: 
  - Criado middleware JWT (`src/middleware/auth.ts`)
  - Login agora retorna um token JWT de 7 dias
  - Frontend armazena o token em localStorage/sessionStorage
  - Todas as requisições autenticadas incluem `Authorization: Bearer <token>` no header

### 2. **Não era possível trocar de empresa após cadastro** ❌➜✅
- **Causa**: Não havia endpoint para mudar a empresa do usuário
- **Solução**:
  - Criado endpoint `POST /api/users/switch-company` 
  - Componente `CompanySwitcher` adicionado no Sidebar
  - Usuário pode trocar de empresa e o token é regenerado com a nova empresa

## 📋 Mudanças Implementadas

### Backend (Server)
1. **Novo arquivo**: `server/src/middleware/auth.ts`
   - Middleware `authenticateToken` para verificar JWT
   - Função `generateToken` para criar tokens JWT

2. **Modificado**: `server/src/controllers/userController.ts`
   - Login agora gera e retorna JWT token
   - Novo endpoint `switchUserCompany` para trocar empresa

3. **Modificado**: `server/src/routes/users.ts`
   - Adicionado middleware de autenticação em rotas protegidas
   - Nova rota: `POST /api/users/switch-company`

4. **Modificado**: `server/src/index.ts`
   - Aplicado middleware de autenticação em rotas protegidas

### Frontend
1. **Novo arquivo**: `utils/authFetch.ts`
   - Função `fetchWithAuth()` para fazer requisições com token JWT
   - Função `apiRequest()` wrapper para requisições autenticadas

2. **Novo arquivo**: `components/CompanySwitcher.tsx`
   - Dropdown para trocar de empresa
   - Carrega lista de empresas disponíveis
   - Chama endpoint para trocar empresa e recebe novo token

3. **Modificado**: `contexts/AuthContext.tsx`
   - Agora armazena e gerencia o token JWT
   - Adicionado método `setUser()` para atualizar usuário e token

4. **Modificado**: `App.tsx`
   - Importado `fetchWithAuth`
   - Requisições de pedidos agora usam `fetchWithAuth`

5. **Modificado**: `components/AdminPanel.tsx`
   - Todas as chamadas fetch agora usam `fetchWithAuth`

6. **Modificado**: `components/OrderList.tsx`
   - Sincronização agora usa `fetchWithAuth`

7. **Modificado**: `components/Sidebar.tsx`
   - Adicionado componente `CompanySwitcher`

## 🔧 Como Usar

### Para usuários:
1. Login normalmente com email e senha
2. Token JWT é salvo automaticamente
3. Para trocar de empresa: 
   - Clique no nome da empresa no Sidebar (próximo ao botão "Sincronizar")
   - Selecione a nova empresa na dropdown
   - Página recarrega automaticamente com os dados da nova empresa

### Para desenvolvedores:
- Use `fetchWithAuth()` em vez de `fetch()` para requisições autenticadas
- O token é incluído automaticamente no header `Authorization: Bearer <token>`
- Tokens expiram em 7 dias

## 📌 Notas Importantes

- Os tokens JWT são armazenados de forma **persistente** em `localStorage` ou `sessionStorage` conforme o usuário escolhe ao fazer login
- Se o usuário logou com "Lembrar-me", o token persiste entre abas do navegador
- Sessão sem "Lembrar-me" fica apenas em `sessionStorage` e é perdida ao fechar o navegador
- Todas as requisições à API agora requerem autenticação (exceto `/api/users/login`)

## 🚀 Próximos Passos (Opcional)

- Implementar refresh tokens para renovar tokens expirados
- Adicionar logout em todas as abas (usando storage events)
- Implementar role-based access control (RBAC) mais fino
- Adicionar verificação de permissões mais granulares
