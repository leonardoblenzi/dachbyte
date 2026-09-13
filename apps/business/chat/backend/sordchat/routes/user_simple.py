"""
Rotas simples para usuários
"""

from fastapi import APIRouter, Depends, HTTPException, status
from fastapi.security import HTTPBearer
from ..utils.auth import verify_token

router = APIRouter(prefix="/users", tags=["Usuários"])
security = HTTPBearer()

def get_current_user_from_token(credentials = Depends(security)):
    token = credentials.credentials
    payload = verify_token(token)
    if not payload:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Token inválido")
    return payload

@router.get("/")
async def list_users(current_user = Depends(get_current_user_from_token)):
    """Lista usuários (versão simples)"""
    return {
        "message": "Endpoint de usuários funcionando",
        "user": current_user.get("sub"),
        "users": [
            {"id": 1, "username": "admin", "name": "Administrador"},
            {"id": 2, "username": "user", "name": "Usuário Teste"}
        ]
    }

@router.get("/me")
async def get_my_profile(current_user = Depends(get_current_user_from_token)):
    """Perfil do usuário atual"""
    return {
        "message": "Seu perfil",
        "user_id": current_user.get("user_id"),
        "username": current_user.get("sub"),
        "access_level": current_user.get("access_level")
    }