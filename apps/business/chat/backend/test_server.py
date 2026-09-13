"""
Servidor de teste simplificado
"""

from fastapi import FastAPI
import uvicorn

app = FastAPI(title="Volt Corp API - Teste")

@app.get("/")
async def root():
    return {"message": "Volt Corp funcionando!", "status": "OK"}

@app.get("/health")
async def health():
    return {"status": "healthy"}

if __name__ == "__main__":
    print("🚀 Iniciando servidor de teste...")
    uvicorn.run(app, host="127.0.0.1", port=8000, reload=True)