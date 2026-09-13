"""
Schemas de autenticação e usuários
"""

from pydantic import BaseModel, EmailStr
from typing import Optional
from datetime import datetime

class UserLogin(BaseModel):
    """Schema para login do usuário"""
    username: str
    password: str

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

class UserResponse(BaseModel):
    """Schema para resposta de usuário (sem senha)"""
    id: int
    username: str
    email: str
    full_name: str
    department: Optional[str]
    access_level: str
    is_active: bool
    is_online: bool
    created_at: datetime
    last_login: Optional[datetime]

    class Config:
        from_attributes = True

class Token(BaseModel):
    """Schema para token de acesso"""
    access_token: str
    token_type: str = "bearer"
    user: UserResponse

class TokenData(BaseModel):
    """Schema para dados do token"""
    username: Optional[str] = None
    user_id: Optional[int] = None
    access_level: Optional[str] = None