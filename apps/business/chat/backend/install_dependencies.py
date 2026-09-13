"""
Script para instalar todas as dependências
"""

import subprocess
import sys
import os


def install_package(package):
    """Instala um pacote usando pip"""
    try:
        subprocess.check_call([sys.executable, "-m", "pip", "install", package])
        return True
    except subprocess.CalledProcessError:
        return False


def main():
    """Instala todas as dependências necessárias"""

    print("🔧 Instalando dependências do Volt Corp...")
    print("=" * 50)

    packages = [
        "fastapi==0.104.1",
        "uvicorn[standard]==0.24.0",
        "psycopg2-binary==2.9.9",
        "python-jose[cryptography]==3.3.0",
        "passlib[bcrypt]==1.7.4",
        "python-multipart==0.0.6",
        "python-dotenv==1.0.0",
        "pydantic[email]==2.5.0",
        "websockets==12.0",
        "requests==2.31.0"
    ]

    successful = 0
    failed = []

    for package in packages:
        print(f"📦 Instalando {package}...")
        if install_package(package):
            print(f"✅ {package} instalado com sucesso")
            successful += 1
        else:
            print(f"❌ Erro ao instalar {package}")
            failed.append(package)

    print("=" * 50)
    print(f"📊 Resultado: {successful}/{len(packages)} pacotes instalados")

    if failed:
        print("❌ Pacotes que falharam:")
        for package in failed:
            print(f"   - {package}")
    else:
        print("🎉 Todas as dependências foram instaladas com sucesso!")
        print("\n🚀 Próximos passos:")
        print("1. python create_users_simple.py")
        print("2. python server_step_by_step.py")
        print("3. python test_websocket.py")


if __name__ == "__main__":
    main()