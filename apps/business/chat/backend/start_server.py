"""
Launcher local do Volt Corp.
"""

import uvicorn


def main():
    """Inicia o backend SQLite usado pela versao de retomada."""
    print("Iniciando servidor Volt Corp...")
    print("API: http://127.0.0.1:8001")
    print("Docs: http://127.0.0.1:8001/docs")
    print("Pressione Ctrl+C para parar")
    print("=" * 50)

    uvicorn.run(
        "sordchat_fixed:app",
        host="127.0.0.1",
        port=8001,
        reload=False,
        log_level="info",
    )


if __name__ == "__main__":
    main()
