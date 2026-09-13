"""
Modelo de Tasks do Volt Corp
"""

from sqlalchemy import Column, Integer, String, DateTime, Text, Enum, ForeignKey, Boolean, JSON
from sqlalchemy.orm import relationship
from sqlalchemy.sql import func
from app.config.database import Base
import enum


class TaskUrgency(enum.Enum):
    """Graus de urgência das tasks"""
    BAIXA = "baixa"
    MEDIA = "media"
    ALTA = "alta"
    URGENTE = "urgente"


class TaskStatus(enum.Enum):
    """Status das tasks no Kanban"""
    A_FAZER = "a_fazer"
    EM_PROGRESSO = "em_progresso"
    CONCLUIDA = "concluida"


class TaskVisibility(enum.Enum):
    """Visibilidade das tasks"""
    DEPARTAMENTO = "departamento"
    TODOS = "todos"


class Task(Base):
    """
    Modelo de task do sistema (estilo Trello/Kanban)
    """
    __tablename__ = "tasks"

    # Campos principais
    id = Column(Integer, primary_key=True, index=True)
    name = Column(String(200), nullable=False, index=True)
    description = Column(Text, nullable=True)

    # Configurações da task
    urgency = Column(Enum(TaskUrgency), default=TaskUrgency.MEDIA, nullable=False)
    status = Column(Enum(TaskStatus), default=TaskStatus.A_FAZER, nullable=False)
    visibility = Column(Enum(TaskVisibility), default=TaskVisibility.DEPARTAMENTO, nullable=False)

    # Relacionamentos
    created_by_id = Column(Integer, ForeignKey("users.id"), nullable=False)
    assigned_to_id = Column(Integer, ForeignKey("users.id"), nullable=True)

    # Dados adicionais
    due_date = Column(DateTime(timezone=True), nullable=True)  # Data de entrega opcional
    attachments = Column(JSON, nullable=True)  # Lista de anexos
    comments = Column(JSON, nullable=True)  # Comentários na task

    # Posição no Kanban
    position = Column(Integer, default=0, nullable=False)  # Para ordenação drag & drop

    # Timestamps
    created_at = Column(DateTime(timezone=True), server_default=func.now())
    updated_at = Column(DateTime(timezone=True), onupdate=func.now())
    completed_at = Column(DateTime(timezone=True), nullable=True)

    # Relacionamentos SQLAlchemy
    created_by = relationship("User", foreign_keys=[created_by_id], back_populates="created_tasks")
    assigned_to = relationship("User", foreign_keys=[assigned_to_id], back_populates="assigned_tasks")

    def __repr__(self):
        return f"<Task(id={self.id}, name='{self.name}', status='{self.status.value}')>"
