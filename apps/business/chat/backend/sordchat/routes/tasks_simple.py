"""
Rotas simples para tasks
"""

from fastapi import APIRouter, Depends, HTTPException, status
from fastapi.security import HTTPBearer
from ..utils.auth import verify_token

router = APIRouter(prefix="/tasks", tags=["Tasks"])
security = HTTPBearer()

def get_current_user_from_token(credentials = Depends(security)):
    token = credentials.credentials
    payload = verify_token(token)
    if not payload:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Token inválido")
    return payload

@router.get("/")
async def list_tasks(current_user = Depends(get_current_user_from_token)):
    """Lista tasks (versão simples)"""
    return {
        "message": "Endpoint de tasks funcionando",
        "user": current_user.get("sub"),
        "tasks": [
            {"id": 1, "name": "Task de teste", "status": "a_fazer", "urgency": "media"},
            {"id": 2, "name": "Outra task", "status": "concluida", "urgency": "baixa"}
        ]
    }

@router.get("/stats")
async def get_task_stats(current_user = Depends(get_current_user_from_token)):
    """Estatísticas de tasks"""
    return {
        "total": 2,
        "a_fazer": 1,
        "concluidas": 1,
        "minhas_tasks": 2
    }