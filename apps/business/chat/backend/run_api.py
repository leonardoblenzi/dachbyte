"""
Volt Corp API - Launcher Final
"""

import uvicorn
import socket
import sys
from pathlib import Path

def is_port_available(port):
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            s.bind(('127.0.0.1', port))
            return True
    except OSError:
        return False

def find_available_port(start_port=8000):
    for port in range(start_port, start_port + 10):
        if is_port_available(port):
            return port
    return None

def main():
    # Adicionar o diretório ao path
    backend_dir = Path(__file__).parent
    sys.path.insert(0, str(backend_dir))

    # Encontrar porta disponível
    port = find_available_port(8000)

    if not port:
        print("❌ Nenhuma porta disponível entre 8000-8009")
        return

    print("🚀 Volt Corp API - Servidor de Produção")
    print(f"📡 API: http://127.0.0.1:{port}")
    print(f"📚 Documentação: http://127.0.0.1:{port}/docs")
    print(f"🔍 Status: http://127.0.0.1:{port}/status")
    print(f"🔧 Porta: {port}")
    print("🔄 Pressione Ctrl+C para parar")
    print("=" * 50)

    # Iniciar servidor
    uvicorn.run(
        "sordchat.main:app",
        host="127.0.0.1",
        port=port,
        reload=True,
        log_level="info",
        reload_dirs=["./sordchat"]
    )

if __name__ == "__main__":
    main()