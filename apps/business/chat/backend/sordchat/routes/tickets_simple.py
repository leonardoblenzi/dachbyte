"""
Rotas simples para tickets
"""

from fastapi import APIRouter, Depends, HTTPException, status
from fastapi.security import HTTPBearer
from ..utils.auth import verify_token

router = APIRouter(prefix="/tickets", tags=["Tickets"])
security = HTTPBearer()

def get_current_user_from_token(credentials = Depends(security)):
    token = credentials.credentials
    payload = verify_token(token)
    if not payload:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Token inválido")
    return payload

@router.get("/")
async def list_tickets(current_user = Depends(get_current_user_from_token)):
    """Lista tickets (versão simples)"""
    return {
        "message": "Endpoint de tickets funcionando",
        "user": current_user.get("sub"),
        "tickets": [
            {"id": 1, "title": "Ticket de teste", "status": "aberto", "priority": "media"},
            {"id": 2, "title": "Outro ticket", "status": "encerrado", "priority": "alta"}
        ]
    }

@router.get("/stats")
async def get_ticket_stats(current_user = Depends(get_current_user_from_token)):
    """Estatísticas de tickets"""
    return {
        "total": 2,
        "abertos": 1,
        "encerrados": 1,
        "meus_tickets": 1
    }