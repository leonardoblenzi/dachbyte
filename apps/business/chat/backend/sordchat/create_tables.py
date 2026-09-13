"""
Script para criar todas as tabelas no banco de dados
"""

from config.database import create_tables, engine
from models import user, ticket, message, task

def main():
    """Cria todas as tabelas no banco de dados"""
    try:
        print("🔨 Criando tabelas no banco de dados...")
        create_tables()
        print("✅ Tabelas criadas com sucesso!")

        # Verificar se as tabelas foram criadas
        from sqlalchemy import inspect
        inspector = inspect(engine)
        tables = inspector.get_table_names()

        print(f"📊 Tabelas criadas: {', '.join(tables)}")

    except Exception as e:
        print(f"❌ Erro ao criar tabelas: {e}")

if __name__ == "__main__":
    main()