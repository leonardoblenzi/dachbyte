"""
Servidor mínimo para teste
"""

from fastapi import FastAPI
import uvicorn

app = FastAPI(title="Volt Corp - Teste")

@app.get("/")
def read_root():
    return {"message": "Volt Corp funcionando!", "status": "OK"}

@app.get("/test")
def test_endpoint():
    return {"test": "API está respondendo corretamente"}

if __name__ == "__main__":
    print("🧪 Servidor de teste iniciando...")
    uvicorn.run(app, host="127.0.0.1", port=8000)