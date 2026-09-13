"""
Schemas para mensagens - Versão completa
"""

from pydantic import BaseModel
from typing import Optional, List, Dict, Any
from datetime import datetime

class MessageCreate(BaseModel):
    """Schema para criação de mensagem"""
    content: str
    receiver_id: Optional[int] = None  # None = mensagem pública
    message_type: str = "text"  # text, image, file, etc.

class MessageUpdate(BaseModel):
    """Schema para atualização de mensagem"""
    content: str

class MessageReaction(BaseModel):
    """Schema para reação em mensagem"""
    emoji: str  # 👍, ❤️, 😂, etc.

class MessageResponse(BaseModel):
    """Schema para resposta de mensagem"""
    id: int
    content: str
    sender_id: int
    receiver_id: Optional[int]
    message_type: str
    is_read: bool
    is_edited: bool
    created_at: datetime
    updated_at: Optional[datetime]

    # Informações do remetente
    sender_name: Optional[str] = None
    sender_username: Optional[str] = None

    # Reações e anexos
    reactions: Optional[Dict[str, Any]] = None
    attachments: Optional[List[Dict[str, Any]]] = None

    class Config:
        from_attributes = True

class MessageListResponse(BaseModel):
    """Schema para lista de mensagens"""
    messages: List[MessageResponse]
    total: int
    unread_count: int

class ChatRoom(BaseModel):
    """Schema para sala de chat"""
    name: str
    description: Optional[str] = None
    is_private: bool = False
    participants: List[int] = []

class OnlineUser(BaseModel):
    """Schema para usuário online"""
    id: int
    username: str
    full_name: str
    department: Optional[str]
    access_level: str
    last_seen: Optional[datetime] = None

class TypingIndicator(BaseModel):
    """Schema para indicador de digitação"""
    user_id: int
    username: str
    is_typing: bool
    room: str = "general"