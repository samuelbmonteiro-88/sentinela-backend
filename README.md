# Sentinela — Backend

## Deploy no Railway (passo a passo)

### 1. Gerar as chaves VAPID
No terminal do seu computador (precisa ter Node instalado):
```
npx web-push generate-vapid-keys
```
Guarde os dois valores gerados.

### 2. Criar projeto no Railway
1. Acesse railway.app e faça login com GitHub
2. Clique em "New Project" → "Deploy from GitHub repo"
3. Selecione este repositório
4. Railway detecta o Node.js automaticamente

### 3. Adicionar PostgreSQL
1. No projeto Railway, clique em "+ New" → "Database" → "PostgreSQL"
2. O Railway injeta DATABASE_URL automaticamente

### 4. Configurar variáveis de ambiente
No painel Railway → seu serviço → "Variables", adicione:
```
VAPID_PUBLIC_KEY=<valor gerado no passo 1>
VAPID_PRIVATE_KEY=<valor gerado no passo 1>
NODE_ENV=production
```

### 5. Pegar a URL do backend
Railway → seu serviço → "Settings" → "Domains" → copiar a URL
Formato: https://sentinela-backend-xxxx.up.railway.app

### 6. Atualizar o front-end
No index.html do Sentinela, alterar:
```js
const BACKEND_URL = 'https://sentinela-backend-xxxx.up.railway.app';
```

## Rotas disponíveis

| Método | Rota | Descrição |
|--------|------|-----------|
| GET | / | Health check |
| GET | /vapid-public-key | Chave pública para push |
| POST | /device | Registrar device |
| POST | /push/subscribe | Salvar subscription push |
| POST | /checkin | Salvar check-in |
| GET | /historico/:deviceId | Buscar histórico |
| POST | /soneca | Adiar alerta +20min |
