"""
Modelo de Usuários do Volt Corp
"""

from sqlalchemy import Column, Integer, String, DateTime, Boolean, Text, Enum
from sqlalchemy.sql import func
from app.config.database import Base
import enum


class UserLevel(enum.Enum):
    """Níveis de acesso dos usuários"""
    PADRAO = "padrao"
    COORDENADOR = "coordenador"
    MASTER = "master"


class User(Base):
    """
    Modelo de usuário do sistema
    """
    __tablename__ = "users"

    # Campos principais
    id = Column(Integer, primary_key=True, index=True)
    username = Column(String(50), unique=True, index=True, nullable=False)
    email = Column(String(100), unique=True, index=True, nullable=False)
    full_name = Column(String(100), nullable=False)

    # Autenticação
    hashed_password = Column(String(255), nullable=False)

    # Informações do perfil
    department = Column(String(100), nullable=True)
    profile_photo = Column(Text, nullable=True)  # URL ou caminho da foto

    # Nível de acesso
    access_level = Column(Enum(UserLevel), default=UserLevel.PADRAO, nullable=False)

    # Status
    is_active = Column(Boolean, default=True, nullable=False)
    is_online = Column(Boolean, default=False, nullable=False)

    # Timestamps
    created_at = Column(DateTime(timezone=True), server_default=func.now())
    updated_at = Column(DateTime(timezone=True), onupdate=func.now())
    last_login = Column(DateTime(timezone=True), nullable=True)

    # Relacionamentos SQLAlchemy
    created_tickets = relationship("Ticket", foreign_keys="Ticket.created_by_id", back_populates="created_by")
    assigned_tickets = relationship("Ticket", foreign_keys="Ticket.assigned_to_id", back_populates="assigned_to")

    sent_messages = relationship("Message", foreign_keys="Message.sender_id", back_populates="sender")
    received_messages = relationship("Message", foreign_keys="Message.receiver_id", back_populates="receiver")

    created_tasks = relationship("Task", foreign_keys="Task.created_by_id", back_populates="created_by")
    assigned_tasks = relationship("Task", foreign_keys="Task.assigned_to_id", back_populates="assigned_to")

    def _repr_(self):
        return f"<User(id={self.id}, username='{self.username}', level='{self.access_level.value}')>"
