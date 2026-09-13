"""
Schemas para tickets
"""

from pydantic import BaseModel
from typing import Optional, List
from datetime import datetime


class TicketCreate(BaseModel):
    """Schema para criação de ticket"""
    title: str
    description: str
    priority: str = "media"  # baixa, media, alta, urgente
    assigned_to_id: Optional[int] = None


class TicketUpdate(BaseModel):
    """Schema para atualização de ticket"""
    title: Optional[str] = None
    description: Optional[str] = None
    priority: Optional[str] = None
    status: Optional[str] = None  # aberto, encerrado
    assigned_to_id: Optional[int] = None


class TicketResponse(BaseModel):
    """Schema para resposta de ticket"""
    id: int
    title: str
    description: str
    priority: str
    status: str
    created_by_id: int
    assigned_to_id: Optional[int]
    created_at: datetime
    updated_at: Optional[datetime]
    closed_at: Optional[datetime]

    # Informações dos usuários
    created_by_name: Optional[str] = None
    assigned_to_name: Optional[str] = None

    class Config:
        from_attributes = True


class TicketListResponse(BaseModel):
    """Schema para lista de tickets"""
    tickets: List[TicketResponse]
    total: int
    page: int
    per_page: int