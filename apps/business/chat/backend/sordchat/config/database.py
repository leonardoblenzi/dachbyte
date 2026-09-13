 
"""
Configuração do banco de dados SQLAlchemy
"""

from sqlalchemy import create_engine, MetaData
from sqlalchemy.ext.declarative import declarative_base
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool
import os
from dotenv import load_dotenv

# Carregar variáveis de ambiente
load_dotenv()

# URL de conexão com o banco
DATABASE_URL = os.getenv("DATABASE_URL", "postgresql://postgres:password@localhost:5432/voltcorp_db")

# Configuração do engine SQLAlchemy
engine = create_engine(
    DATABASE_URL,
    echo=True,  # Log das queries SQL (útil para desenvolvimento)
    pool_pre_ping=True,  # Verifica conexões antes de usar
    pool_recycle=300,  # Reconecta a cada 5 minutos
)

# Configuração da sessão
SessionLocal = sessionmaker(
    autocommit=False,
    autoflush=False,
    bind=engine
)

# Base para os models
Base = declarative_base()

# Metadata para migrations
metadata = MetaData()

def get_database_session():
    """
    Função para obter uma sessão do banco de dados
    Usada como dependência no FastAPI
    """
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()

def create_tables():
    """
    Função para criar todas as tabelas no banco de dados
    """
    Base.metadata.create_all(bind=engine)

def drop_tables():
    """
    Função para remover todas as tabelas (cuidado!)
    """
    Base.metadata.drop_all(bind=engine)