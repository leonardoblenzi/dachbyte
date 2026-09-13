"""
Verificar estrutura do projeto
"""

from pathlib import Path


def check_structure():
    """Verifica se todos os arquivos necessários existem"""

    backend_dir = Path(__file__).parent

    required_files = [
        "sordchat/__init__.py",
        "sordchat/main.py",
        "sordchat/config/__init__.py",
        "sordchat/routes/__init__.py",
        "sordchat/routes/auth.py",
        "sordchat/schemas/__init__.py",
        "sordchat/schemas/auth.py",
        "sordchat/utils/__init__.py",
        "sordchat/utils/auth.py",
        "sordchat/utils/permissions.py",
        ".env",
        "requirements.txt"
    ]

    print("🔍 Verificando estrutura do projeto...")
    print("=" * 40)

    missing_files = []

    for file_path in required_files:
        full_path = backend_dir / file_path
        if full_path.exists():
            print(f"✅ {file_path}")
        else:
            print(f"❌ {file_path}")
            missing_files.append(file_path)

    print("=" * 40)

    if missing_files:
        print(f"❌ {len(missing_files)} arquivos faltando:")
        for file in missing_files:
            print(f"   - {file}")
    else:
        print("✅ Todos os arquivos necessários estão presentes!")

    return len(missing_files) == 0


if __name__ == "__main__":
    check_structure()