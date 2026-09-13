"""
Schemas para tasks
"""

from pydantic import BaseModel
from typing import Optional, List, Dict, Any
from datetime import datetime


class TaskCreate(BaseModel):
    """Schema para criação de task"""
    name: str
    description: Optional[str] = None
    urgency: str = "media"  # baixa, media, alta, urgente
    visibility: str = "departamento"  # departamento, todos
    assigned_to_id: Optional[int] = None
    due_date: Optional[datetime] = None


class TaskUpdate(BaseModel):
    """Schema para atualização de task"""
    name: Optional[str] = None
    description: Optional[str] = None
    urgency: Optional[str] = None
    status: Optional[str] = None  # a_fazer, em_progresso, concluida
    visibility: Optional[str] = None
    assigned_to_id: Optional[int] = None
    due_date: Optional[datetime] = None
    position: Optional[int] = None


class TaskComment(BaseModel):
    """Schema para comentário em task"""
    content: str


class TaskResponse(BaseModel):
    """Schema para resposta de task"""
    id: int
    name: str
    description: Optional[str]
    urgency: str
    status: str
    visibility: str
    created_by_id: int
    assigned_to_id: Optional[int]
    due_date: Optional[datetime]
    position: int
    created_at: datetime
    updated_at: Optional[datetime]
    completed_at: Optional[datetime]

    # Informações dos usuários
    created_by_name: Optional[str] = None
    assigned_to_name: Optional[str] = None

    # Comentários e anexos
    comments: Optional[List[Dict[str, Any]]] = None
    attachments: Optional[List[Dict[str, Any]]] = None

    class Config:
        from_attributes = True