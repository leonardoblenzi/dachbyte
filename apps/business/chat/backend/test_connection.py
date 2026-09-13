"""
Teste de conexão com o banco de dados
"""

from app.config.database import engine, get_database_session
from sqlalchemy import text

def test_connection():
    """Testa a conexão com o banco de dados"""
    try:
        # Testa a conexão
        with engine.connect() as connection:
            result = connection.execute(text("SELECT version();"))
            version = result.fetchone()[0]
            print(f"✅ Conexão com PostgreSQL estabelecida!")
            print(f"📊 Versão do PostgreSQL: {version}")
            return True
    except Exception as e:
        print(f"❌ Erro na conexão: {e}")
        return False

if __name__ == "__main__":
    test_connection()