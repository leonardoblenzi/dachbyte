"""
Teste individual de imports
"""

import sys
from pathlib import Path

# Adicionar o diretório ao path
backend_dir = Path(__file__).parent
sys.path.insert(0, str(backend_dir))


def test_import(module_name, description):
    """Testa um import específico"""
    try:
        exec(f"import {module_name}")
        print(f"✅ {description}: {module_name}")
        return True
    except ImportError as e:
        print(f"❌ {description}: {module_name} - Erro: {e}")
        return False


def main():
    """Testa todos os imports necessários"""
    print("🧪 Testando imports do Volt Corp...")
    print("=" * 50)

    tests = [
        ("sordchat", "Módulo principal"),
        ("sordchat.main", "Arquivo main"),
        ("sordchat.config", "Configurações"),
        ("sordchat.utils", "Utilitários"),
        ("sordchat.utils.auth", "Autenticação"),
        ("sordchat.utils.permissions", "Permissões"),
        ("sordchat.schemas", "Schemas"),
        ("sordchat.schemas.auth", "Schemas de auth"),
        ("sordchat.routes", "Rotas"),
        ("sordchat.routes.auth", "Rotas de auth"),
    ]

    passed = 0
    total = len(tests)

    for module, description in tests:
        if test_import(module, description):
            passed += 1

    print("=" * 50)
    print(f"📊 Resultado: {passed}/{total} imports funcionando")

    if passed == total:
        print("🎉 Todos os imports estão funcionando!")
    else:
        print("⚠️ Alguns imports falharam. Vamos corrigir!")


if __name__ == "__main__":
    main()