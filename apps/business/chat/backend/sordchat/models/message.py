"""
Modelo de Mensagens do Volt Corp
"""

from sqlalchemy import Column, Integer, String, DateTime, Text, ForeignKey, Boolean, JSON
from sqlalchemy.orm import relationship
from sqlalchemy.sql import func
from app.config.database import Base


class Message(Base):
    """
    Modelo de mensagem do sistema
    """
    __tablename__ = "messages"

    # Campos principais
    id = Column(Integer, primary_key=True, index=True)
    content = Column(Text, nullable=False)

    # Relacionamentos
    sender_id = Column(Integer, ForeignKey("users.id"), nullable=False)
    receiver_id = Column(Integer, ForeignKey("users.id"), nullable=True)  # NULL para mensagens em grupo

    # Metadados da mensagem
    message_type = Column(String(20), default="text", nullable=False)  # text, image, file, emoji
    attachments = Column(JSON, nullable=True)  # Lista de anexos
    reactions = Column(JSON, nullable=True)  # Reações com emojis

    # Status
    is_read = Column(Boolean, default=False, nullable=False)
    is_edited = Column(Boolean, default=False, nullable=False)

    # Timestamps
    created_at = Column(DateTime(timezone=True), server_default=func.now())
    updated_at = Column(DateTime(timezone=True), onupdate=func.now())

    # Relacionamentos SQLAlchemy
    sender = relationship("User", foreign_keys=[sender_id], back_populates="sent_messages")
    receiver = relationship("User", foreign_keys=[receiver_id], back_populates="received_messages")

    def __repr__(self):
        return f"<Message(id={self.id}, sender_id={self.sender_id}, type='{self.message_type}')>"
