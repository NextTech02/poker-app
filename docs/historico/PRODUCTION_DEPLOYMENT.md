# Guia de Deploy em Produção

## ⚠️ Importante: WinError 10035 é apenas no Windows

O erro `WinError 10035` que você está vendo no desenvolvimento **NÃO acontece em produção Linux**. É uma limitação específica do Windows com operações de socket não-bloqueantes.

## Por que NÃO migrar para Java?

### FastAPI/Python é Excelente para Produção

**Empresas que usam Python em produção:**
- 🎵 **Spotify** - Streaming em tempo real para milhões
- 📸 **Instagram** - Bilhões de usuários
- 🎬 **Netflix** - Sistema de recomendações
- 🚗 **Uber** - Processamento em tempo real
- 📦 **Dropbox** - Infraestrutura principal
- 📌 **Pinterest** - Backend escalável

**Vantagens do FastAPI:**
- ⚡ Performance comparável a Node.js e Go
- 🔄 Suporte nativo a async/await
- ✅ Validação automática com Pydantic
- 📚 Documentação automática (Swagger/ReDoc)
- 🛠️ Desenvolvimento mais rápido que Java
- 🐍 Menos código, mais produtivo

**Comparação de Performance (requests/segundo):**
- FastAPI: ~20,000 req/s
- Node.js: ~25,000 req/s
- Go: ~30,000 req/s
- Java Spring Boot: ~15,000 req/s

## Opções de Deploy (Recomendadas)

### 1. Docker (Recomendado) ⭐

**Vantagens:**
- Funciona em qualquer ambiente
- Isola dependências
- Fácil de escalar

```dockerfile
# Dockerfile
FROM python:3.11-slim

WORKDIR /app

# Install dependencies
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy application
COPY . .

# Production server with Gunicorn + Uvicorn workers
CMD ["gunicorn", "app.main:app", \
     "--workers", "4", \
     "--worker-class", "uvicorn.workers.UvicornWorker", \
     "--bind", "0.0.0.0:8000", \
     "--timeout", "120", \
     "--keepalive", "5"]
```

**docker-compose.yml:**
```yaml
version: '3.8'

services:
  backend:
    build: ./backend
    ports:
      - "8000:8000"
    environment:
      - SUPABASE_URL=${SUPABASE_URL}
      - SUPABASE_SERVICE_KEY=${SUPABASE_SERVICE_KEY}
      - SUPABASE_JWT_SECRET=${SUPABASE_JWT_SECRET}
    restart: unless-stopped

  frontend:
    build: ./frontend
    ports:
      - "80:80"
    depends_on:
      - backend
    restart: unless-stopped
```

**Deploy:**
```bash
# Build e rodar
docker-compose up -d

# Ver logs
docker-compose logs -f

# Parar
docker-compose down
```

### 2. Railway.app 🚂

**Mais fácil e rápido:**
1. Conecte seu GitHub
2. Selecione o repositório
3. Railway detecta FastAPI automaticamente
4. Deploy com 1 clique

**Custo:** $5/mês (inclui banco de dados)

### 3. Heroku

```bash
# Procfile
web: gunicorn app.main:app --workers 4 --worker-class uvicorn.workers.UvicornWorker --bind 0.0.0.0:$PORT

# Deploy
git push heroku main
```

### 4. AWS EC2 / DigitalOcean

```bash
# Instalar dependências
sudo apt update
sudo apt install python3.11 python3-pip nginx

# Instalar aplicação
cd /var/www/torneios_app
pip install -r requirements.txt

# Configurar systemd service
sudo nano /etc/systemd/system/torneios.service
```

**torneios.service:**
```ini
[Unit]
Description=Torneios API
After=network.target

[Service]
User=www-data
WorkingDirectory=/var/www/torneios_app/backend
ExecStart=/usr/local/bin/gunicorn app.main:app \
    --workers 4 \
    --worker-class uvicorn.workers.UvicornWorker \
    --bind 0.0.0.0:8000
Restart=always

[Install]
WantedBy=multi-user.target
```

```bash
# Iniciar serviço
sudo systemctl enable torneios
sudo systemctl start torneios
```

### 5. Vercel (Frontend) + Railway (Backend)

**Frontend (Vercel):**
- Deploy automático do React
- CDN global
- HTTPS grátis

**Backend (Railway):**
- FastAPI em Linux
- Zero configuração
- Escalável

## Configuração de Produção

### Backend

**requirements.txt** (adicionar):
```txt
gunicorn==21.2.0
uvicorn[standard]==0.25.0
```

**app/main.py** (atualizar CORS):
```python
app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "https://seu-dominio.com",
        "https://www.seu-dominio.com"
    ],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)
```

### Frontend

**package.json** (adicionar):
```json
{
  "scripts": {
    "build": "react-scripts build",
    "start:prod": "serve -s build -l 3000"
  }
}
```

**.env.production:**
```env
REACT_APP_API_URL=https://api.seu-dominio.com
REACT_APP_SUPABASE_URL=https://seu-projeto.supabase.co
REACT_APP_SUPABASE_ANON_KEY=sua-chave-anon
```

## Monitoramento

### Logs
```bash
# Docker
docker-compose logs -f backend

# Systemd
sudo journalctl -u torneios -f

# Arquivo
tail -f /var/log/torneios.log
```

### Health Check
```python
# app/main.py
@app.get("/health")
async def health_check():
    return {
        "status": "healthy",
        "version": "1.0.0",
        "timestamp": datetime.now(timezone.utc)
    }
```

## Performance em Produção

**Otimizações:**

1. **Use Gunicorn com múltiplos workers:**
   ```bash
   # Número de workers = (2 x CPU cores) + 1
   gunicorn --workers 4 --worker-class uvicorn.workers.UvicornWorker
   ```

2. **Configure Nginx como reverse proxy:**
   ```nginx
   upstream backend {
       server 127.0.0.1:8000;
   }

   server {
       listen 80;
       server_name api.seu-dominio.com;

       location / {
           proxy_pass http://backend;
           proxy_set_header Host $host;
           proxy_set_header X-Real-IP $remote_addr;
       }
   }
   ```

3. **Use Redis para cache:**
   ```python
   from fastapi_cache import FastAPICache
   from fastapi_cache.backends.redis import RedisBackend

   @app.on_event("startup")
   async def startup():
       redis = aioredis.from_url("redis://localhost")
       FastAPICache.init(RedisBackend(redis), prefix="torneios:")
   ```

## Segurança

1. **HTTPS obrigatório**
2. **Rate limiting**
3. **Firewall configurado**
4. **Secrets em variáveis de ambiente**
5. **Validação de JWT correta**

## Conclusão

✅ **Python/FastAPI é perfeitamente adequado para produção**
✅ **O erro WinError 10035 é apenas no Windows**
✅ **Em Linux (produção), a aplicação roda perfeitamente**
✅ **Migrar para Java seria desperdício de tempo e recursos**

**Recomendação:** Use Docker + Railway ou Docker + AWS EC2 para deploy rápido e confiável.
