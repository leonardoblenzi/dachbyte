"""
Schemas para operações de usuários
"""

from pydantic import BaseModel, EmailStr
from typing import Optional, List
from datetime import datetime

class UserCreate(BaseModel):
    """Schema para criação de usuário"""
    username: str
    email: EmailStr
    full_name: str
    password: str
    department: Optional[str] = None
    access_level: str = "padrao"

class UserUpdate(BaseModel):
    """Schema para atualização de usuário"""
    full_name: Optional[str] = None
    email: Optional[EmailStr] = None
    department: Optional[str] = None
    access_level: Optional[str] = None
    is_active: Optional[bool] = None

class UserPasswordUpdate(BaseModel):
    """Schema para atualização de senha"""
    current_password: str
    new_password: str

class UserListResponse(BaseModel):
    """Schema para lista de usuários"""
    id: int
    username: str
    email: str
    full_name: str
    department: Optional[str]
    access_level: str
    is_active: bool
    is_online: bool
    created_at: datetime

    class Config:
        from_attributes = True