"""
Teste simplificado do banco de dados
"""

import os
import psycopg2
from dotenv import load_dotenv

# Carregar variáveis de ambiente
load_dotenv()


def create_tables_simple():
    """Cria as tabelas usando SQL direto"""
    try:
        # Conectar ao banco
        database_url = os.getenv("DATABASE_URL", "postgresql://postgres:password@localhost:5432/voltcorp_db")

        # Extrair informações da URL
        from urllib.parse import urlparse
        parsed = urlparse(database_url)

        conn = psycopg2.connect(
            host=parsed.hostname,
            database=parsed.path[1:],
            user=parsed.username,
            password=parsed.password,
            port=parsed.port or 5432
        )

        cursor = conn.cursor()

        # SQL para criar as tabelas
        create_tables_sql = """
        -- Criar tipos enum
        DO $$ BEGIN
            CREATE TYPE user_level AS ENUM ('padrao', 'coordenador', 'master');
        EXCEPTION
            WHEN duplicate_object THEN null;
        END $$;

        DO $$ BEGIN
            CREATE TYPE ticket_priority AS ENUM ('baixa', 'media', 'alta', 'urgente');
        EXCEPTION
            WHEN duplicate_object THEN null;
        END $$;

        DO $$ BEGIN
            CREATE TYPE ticket_status AS ENUM ('aberto', 'encerrado');
        EXCEPTION
            WHEN duplicate_object THEN null;
        END $$;

        DO $$ BEGIN
            CREATE TYPE task_urgency AS ENUM ('baixa', 'media', 'alta', 'urgente');
        EXCEPTION
            WHEN duplicate_object THEN null;
        END $$;

        DO $$ BEGIN
            CREATE TYPE task_status AS ENUM ('a_fazer', 'em_progresso', 'concluida');
        EXCEPTION
            WHEN duplicate_object THEN null;
        END $$;

        DO $$ BEGIN
            CREATE TYPE task_visibility AS ENUM ('departamento', 'todos');
        EXCEPTION
            WHEN duplicate_object THEN null;
        END $$;

        -- Tabela de usuários
        CREATE TABLE IF NOT EXISTS users (
            id SERIAL PRIMARY KEY,
            username VARCHAR(50) UNIQUE NOT NULL,
            email VARCHAR(100) UNIQUE NOT NULL,
            full_name VARCHAR(100) NOT NULL,
            hashed_password VARCHAR(255) NOT NULL,
            department VARCHAR(100),
            profile_photo TEXT,
            access_level user_level DEFAULT 'padrao',
            is_active BOOLEAN DEFAULT TRUE,
            is_online BOOLEAN DEFAULT FALSE,
            created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
            updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
            last_login TIMESTAMP WITH TIME ZONE
        );

        -- Tabela de tickets
        CREATE TABLE IF NOT EXISTS tickets (
            id SERIAL PRIMARY KEY,
            title VARCHAR(200) NOT NULL,
            description TEXT NOT NULL,
            priority ticket_priority DEFAULT 'media',
            status ticket_status DEFAULT 'aberto',
            created_by_id INTEGER REFERENCES users(id) NOT NULL,
            assigned_to_id INTEGER REFERENCES users(id),
            created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
            updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
            closed_at TIMESTAMP WITH TIME ZONE
        );

        -- Tabela de mensagens
        CREATE TABLE IF NOT EXISTS messages (
            id SERIAL PRIMARY KEY,
            content TEXT NOT NULL,
            sender_id INTEGER REFERENCES users(id) NOT NULL,
            receiver_id INTEGER REFERENCES users(id),
            message_type VARCHAR(20) DEFAULT 'text',
            attachments JSONB,
            reactions JSONB,
            is_read BOOLEAN DEFAULT FALSE,
            is_edited BOOLEAN DEFAULT FALSE,
            created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
            updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
        );

        -- Tabela de tasks
        CREATE TABLE IF NOT EXISTS tasks (
            id SERIAL PRIMARY KEY,
            name VARCHAR(200) NOT NULL,
            description TEXT,
            urgency task_urgency DEFAULT 'media',
            status task_status DEFAULT 'a_fazer',
            visibility task_visibility DEFAULT 'departamento',
            created_by_id INTEGER REFERENCES users(id) NOT NULL,
            assigned_to_id INTEGER REFERENCES users(id),
            due_date TIMESTAMP WITH TIME ZONE,
            attachments JSONB,
            comments JSONB,
            position INTEGER DEFAULT 0,
            created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
            updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
            completed_at TIMESTAMP WITH TIME ZONE
        );

        -- Criar índices para performance
        CREATE INDEX IF NOT EXISTS idx_users_username ON users(username);
        CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
        CREATE INDEX IF NOT EXISTS idx_tickets_created_by ON tickets(created_by_id);
        CREATE INDEX IF NOT EXISTS idx_tickets_assigned_to ON tickets(assigned_to_id);
        CREATE INDEX IF NOT EXISTS idx_messages_sender ON messages(sender_id);
        CREATE INDEX IF NOT EXISTS idx_messages_receiver ON messages(receiver_id);
        CREATE INDEX IF NOT EXISTS idx_tasks_created_by ON tasks(created_by_id);
        CREATE INDEX IF NOT EXISTS idx_tasks_assigned_to ON tasks(assigned_to_id);
        """

        print("🔨 Criando tabelas no banco de dados...")
        cursor.execute(create_tables_sql)
        conn.commit()

        # Verificar tabelas criadas
        cursor.execute("""
                       SELECT table_name
                       FROM information_schema.tables
                       WHERE table_schema = 'public'
                         AND table_type = 'BASE TABLE'
                       ORDER BY table_name;
                       """)

        tables = cursor.fetchall()
        table_names = [table[0] for table in tables]

        print("✅ Tabelas criadas com sucesso!")
        print(f"📊 Tabelas: {', '.join(table_names)}")

        # Inserir usuário master padrão
        cursor.execute("""
                       INSERT INTO users (username, email, full_name, hashed_password, access_level)
                       VALUES ('admin', 'admin@voltcorp.com', 'Administrador', '$2b$12$dummy.hash.for.testing',
                               'master') ON CONFLICT (username) DO NOTHING;
                       """)
        conn.commit()

        print("👤 Usuário administrador criado (username: admin)")

        cursor.close()
        conn.close()

        return True

    except Exception as e:
        print(f"❌ Erro ao criar tabelas: {e}")
        return False


def main():
    """Função principal"""
    print("🚀 Criando banco de dados do Volt Corp (Método Simplificado)...")
    print("=" * 60)

    if create_tables_simple():
        print("\n🎉 Banco de dados configurado com sucesso!")
        print("📋 Próximos passos:")
        print("1. Testar o servidor FastAPI")
        print("2. Implementar autenticação")
        print("3. Criar as rotas da API")
    else:
        print("\n❌ Falha na configuração do banco")


if __name__ == "__main__":
    main()