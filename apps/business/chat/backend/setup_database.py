"""
Script para configurar o banco de dados do Volt Corp
"""

import sys
import os

# Adiciona o diretório atual ao path para imports locais
sys.path.append(os.path.dirname(os.path.abspath(__file__)))

# Agora podemos importar nossos módulos
try:
    from app.config.database import create_tables, engine
    from app.models import user, ticket, message, task


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
            import traceback
            traceback.print_exc()


    if __name__ == "__main__":
        main()

except ImportError as e:
    print(f"❌ Erro de import: {e}")
    print("Verifique se você está na pasta correta e se o ambiente virtual está ativo.")