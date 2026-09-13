"""
Modelo de Tickets do Volt Corp
"""

from sqlalchemy import Column, Integer, String, DateTime, Text, Enum, ForeignKey, Boolean
from sqlalchemy.orm import relationship
from sqlalchemy.sql import func
from app.config.database import Base
import enum


class TicketPriority(enum.Enum):
    """Prioridades dos tickets"""
    BAIXA = "baixa"
    MEDIA = "media"
    ALTA = "alta"
    URGENTE = "urgente"


class TicketStatus(enum.Enum):
    """Status dos tickets"""
    ABERTO = "aberto"
    ENCERRADO = "encerrado"


class Ticket(Base):
    """
    Modelo de ticket do sistema
    """
    __tablename__ = "tickets"

    # Campos principais
    id = Column(Integer, primary_key=True, index=True)
    title = Column(String(200), nullable=False, index=True)
    description = Column(Text, nullable=False)

    # Prioridade e status
    priority = Column(Enum(TicketPriority), default=TicketPriority.MEDIA, nullable=False)
    status = Column(Enum(TicketStatus), default=TicketStatus.ABERTO, nullable=False)

    # Relacionamentos
    created_by_id = Column(Integer, ForeignKey("users.id"), nullable=False)
    assigned_to_id = Column(Integer, ForeignKey("users.id"), nullable=True)

    # Timestamps
    created_at = Column(DateTime(timezone=True), server_default=func.now())
    updated_at = Column(DateTime(timezone=True), onupdate=func.now())
    closed_at = Column(DateTime(timezone=True), nullable=True)

    # Relacionamentos SQLAlchemy
    created_by = relationship("User", foreign_keys=[created_by_id], back_populates="created_tickets")
    assigned_to = relationship("User", foreign_keys=[assigned_to_id], back_populates="assigned_tickets")

    def __repr__(self):
        return f"<Ticket(id={self.id}, title='{self.title}', priority='{self.priority.value}')>"