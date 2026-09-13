"""
Script de inicialização do banco de dados Volt Corp
Versão robusta sem conflitos de import
"""

import os
import sys
from pathlib import Path

# Configurar o path corretamente
current_dir = Path(__file__).parent
sys.path.insert(0, str(current_dir))


def setup_environment():
    """Configura o ambiente para imports"""
    try:
        from dotenv import load_dotenv
        load_dotenv()
        print("✅ Variáveis de ambiente carregadas")
        return True
    except ImportError:
        print("❌ python-dotenv não encontrado")
        return False


def test_database_connection():
    """Testa a conexão com o banco de dados"""
    try:
        import psycopg2
        from urllib.parse import urlparse

        # Obter URL do banco
        database_url = os.getenv("DATABASE_URL", "postgresql://postgres:password@localhost:5432/voltcorp_db")
        parsed = urlparse(database_url)

        # Conectar
        conn = psycopg2.connect(
            host=parsed.hostname,
            database=parsed.path[1:],  # Remove a barra inicial
            user=parsed.username,
            password=parsed.password,
            port=parsed.port or 5432
        )

        cursor = conn.cursor()
        cursor.execute("SELECT version();")
        version = cursor.fetchone()[0]

        print("✅ Conexão com PostgreSQL estabelecida!")
        print(f"📊 Versão: {version[:50]}...")

        cursor.close()
        conn.close()
        return True

    except Exception as e:
        print(f"❌ Erro na conexão: {e}")
        return False


def create_database_tables():
    """Cria as tabelas do banco de dados"""
    try:
        # Import local para evitar conflitos
        from sqlalchemy import create_engine, MetaData, Table, Column, Integer, String, DateTime, Boolean, Text, Enum, \
            ForeignKey, JSON
        from sqlalchemy.sql import func
        import enum

        # URL do banco
        database_url = os.getenv("DATABASE_URL", "postgresql://postgres:password@localhost:5432/voltcorp_db")
        engine = create_engine(database_url, echo=True)

        metadata = MetaData()

        # Definir enums
        class UserLevel(enum.Enum):
            PADRAO = "padrao"
            COORDENADOR = "coordenador"
            MASTER = "master"

        class TicketPriority(enum.Enum):
            BAIXA = "baixa"
            MEDIA = "media"
            ALTA = "alta"
            URGENTE = "urgente"

        class TicketStatus(enum.Enum):
            ABERTO = "aberto"
            ENCERRADO = "encerrado"

        class TaskUrgency(enum.Enum):
            BAIXA = "baixa"
            MEDIA = "media"
            ALTA = "alta"
            URGENTE = "urgente"

        class TaskStatus(enum.Enum):
            A_FAZER = "a_fazer"
            EM_PROGRESSO = "em_progresso"
            CONCLUIDA = "concluida"

        class TaskVisibility(enum.Enum):
            DEPARTAMENTO = "departamento"
            TODOS = "todos"

        # Tabela de usuários
        users_table = Table(
            'users', metadata,
            Column('id', Integer, primary_key=True),
            Column('username', String(50), unique=True, nullable=False),
            Column('email', String(100), unique=True, nullable=False),
            Column('full_name', String(100), nullable=False),
            Column('hashed_password', String(255), nullable=False),
            Column('department', String(100)),
            Column('profile_photo', Text),
            Column('access_level', Enum(UserLevel), default=UserLevel.PADRAO),
            Column('is_active', Boolean, default=True),
            Column('is_online', Boolean, default=False),
            Column('created_at', DateTime(timezone=True), server_default=func.now()),
            Column('updated_at', DateTime(timezone=True), onupdate=func.now()),
            Column('last_login', DateTime(timezone=True))
        )

        # Tabela de tickets
        tickets_table = Table(
            'tickets', metadata,
            Column('id', Integer, primary_key=True),
            Column('title', String(200), nullable=False),
            Column('description', Text, nullable=False),
            Column('priority', Enum(TicketPriority), default=TicketPriority.MEDIA),
            Column('status', Enum(TicketStatus), default=TicketStatus.ABERTO),
            Column('created_by_id', Integer, ForeignKey('users.id'), nullable=False),
            Column('assigned_to_id', Integer, ForeignKey('users.id')),
            Column('created_at', DateTime(timezone=True), server_default=func.now()),
            Column('updated_at', DateTime(timezone=True), onupdate=func.now()),
            Column('closed_at', DateTime(timezone=True))
        )

        # Tabela de mensagens
        messages_table = Table(
            'messages', metadata,
            Column('id', Integer, primary_key=True),
            Column('content', Text, nullable=False),
            Column('sender_id', Integer, ForeignKey('users.id'), nullable=False),
            Column('receiver_id', Integer, ForeignKey('users.id')),
            Column('message_type', String(20), default='text'),
            Column('attachments', JSON),
            Column('reactions', JSON),
            Column('is_read', Boolean, default=False),
            Column('is_edited', Boolean, default=False),
            Column('created_at', DateTime(timezone=True), server_default=func.now()),
            Column('updated_at', DateTime(timezone=True), onupdate=func.now())
        )

        # Tabela de tasks
        tasks_table = Table(
            'tasks', metadata,
            Column('id', Integer, primary_key=True),
            Column('name', String(200), nullable=False),
            Column('description', Text),
            Column('urgency', Enum(TaskUrgency), default=TaskUrgency.MEDIA),
            Column('status', Enum(TaskStatus), default=TaskStatus.A_FAZER),
            Column('visibility', Enum(TaskVisibility), default=TaskVisibility.DEPARTAMENTO),
            Column('created_by_id', Integer, ForeignKey('users.id'), nullable=False),
            Column('assigned_to_id', Integer, ForeignKey('users.id')),
            Column('due_date', DateTime(timezone=True)),
            Column('attachments', JSON),
            Column('comments', JSON),
            Column('position', Integer, default=0),
            Column('created_at', DateTime(timezone=True), server_default=func.now()),
            Column('updated_at', DateTime(timezone=True), onupdate=func.now()),
            Column('completed_at', DateTime(timezone=True))
        )

        # Criar todas as tabelas
        print("🔨 Criando tabelas no banco de dados...")
        metadata.create_all(engine)

        # Verificar tabelas criadas
        from sqlalchemy import inspect
        inspector = inspect(engine)
        tables = inspector.get_table_names()

        print("✅ Tabelas criadas com sucesso!")
        print(f"📊 Tabelas: {', '.join(tables)}")

        return True

    except Exception as e:
        print(f"❌ Erro ao criar tabelas: {e}")
        import traceback
        traceback.print_exc()
        return False


def main():
    """Função principal"""
    print("🚀 Inicializando banco de dados do Volt Corp...")
    print("=" * 50)

    # Passo 1: Configurar ambiente
    if not setup_environment():
        return

    # Passo 2: Testar conexão
    if not test_database_connection():
        print("\n💡 Dicas para resolver:")
        print("1. Verifique se o PostgreSQL está rodando")
        print("2. Confirme se o banco 'voltcorp_db' existe")
        print("3. Verifique a senha no arquivo .env")
        return

    # Passo 3: Criar tabelas
    if create_database_tables():
        print("\n🎉 Banco de dados configurado com sucesso!")
        print("Agora você pode executar a aplicação!")
    else:
        print("\n❌ Falha na criação das tabelas")


if __name__ == "__main__":
    main()