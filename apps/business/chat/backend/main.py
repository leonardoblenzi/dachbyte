"""
Volt Corp - Sistema Corporativo de Mensagens, Tickets e Tasks
Arquivo principal da API FastAPI
"""

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
import uvicorn
from datetime import datetime

# Importar rotas
from .routes import auth

# Configuração da aplicação
app = FastAPI(
    title="Volt Corp API",
    description="API para sistema corporativo de mensagens, tickets e controle de tarefas",
    version="1.0.0",
    docs_url="/docs",
    redoc_url="/redoc"
)

# Configuração CORS
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Incluir rotas
app.include_router(auth.router)

# Rota inicial
@app.get("/")
async def root():
    """Rota inicial para verificar se a API está funcionando"""
    return {
        "message": "Volt Corp API está funcionando!",
        "timestamp": datetime.now().isoformat(),
        "version": "1.0.0",
        "endpoints": {
            "docs": "/docs",
            "auth": "/auth",
            "health": "/health"
        }
    }

# Rota de health check
@app.get("/health")
async def health_check():
    """Verificação de saúde da API"""
    return {
        "status": "healthy",
        "timestamp": datetime.now().isoformat()
    }

# Manipuladores de exceção
@app.exception_handler(404)
async def not_found_handler(request, exc):
    return JSONResponse(
        status_code=404,
        content={"message": "Endpoint não encontrado", "detail": str(exc)}
    )

@app.exception_handler(500)
async def internal_error_handler(request, exc):
    return JSONResponse(
        status_code=500,
        content={"message": "Erro interno do servidor", "detail": str(exc)}
    )

if __name__ == "__main__":
    uvicorn.run(
        "sordchat.main:app",
        host="127.0.0.1",
        port=8000,
        reload=True,
        log_level="info"
    )