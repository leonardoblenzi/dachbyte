"""
Dashboard simples
"""

from fastapi import APIRouter, Depends, HTTPException, status
from fastapi.security import HTTPBearer
from ..utils.auth import verify_token

router = APIRouter(prefix="/dashboard", tags=["Dashboard"])
security = HTTPBearer()

def get_current_user_from_token(credentials = Depends(security)):
    token = credentials.credentials
    payload = verify_token(token)
    if not payload:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Token inválido")
    return payload

@router.get("/overview")
async def get_dashboard_overview(current_user = Depends(get_current_user_from_token)):
    """Visão geral do dashboard"""
    return {
        "message": "Dashboard funcionando",
        "user": current_user.get("sub"),
        "stats": {
            "tickets": {"total": 5, "abertos": 2, "encerrados": 3},
            "tasks": {"total": 8, "a_fazer": 3, "concluidas": 5},
            "messages": {"total": 15, "unread": 2}
        }
    }

@router.get("/performance")
async def get_performance_metrics(current_user = Depends(get_current_user_from_token)):
    """Métricas de performance"""
    return {
        "completion_rate": 85.5,
        "avg_response_time": "2.3 horas",
        "tickets_resolved": 12,
        "tasks_completed": 8
    }