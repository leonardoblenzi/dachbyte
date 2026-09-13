"""
Rotas simples para mensagens
"""

from fastapi import APIRouter, Depends, HTTPException, status, WebSocket
from fastapi.security import HTTPBearer
from ..utils.auth import verify_token

router = APIRouter(prefix="/messages", tags=["Mensagens"])
security = HTTPBearer()


def get_current_user_from_token(credentials=Depends(security)):
    token = credentials.credentials
    payload = verify_token(token)
    if not payload:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Token inválido")
    return payload


@router.get("/")
async def list_messages(current_user=Depends(get_current_user_from_token)):
    """Lista mensagens (versão simples)"""
    return {
        "message": "Endpoint de mensagens funcionando",
        "user": current_user.get("sub"),
        "messages": [
            {"id": 1, "content": "Olá!", "sender": "admin", "timestamp": "2025-01-15T10:00:00"},
            {"id": 2, "content": "Como vai?", "sender": "user", "timestamp": "2025-01-15T10:01:00"}
        ],
        "unread_count": 0
    }


@router.get("/online-users")
async def get_online_users(current_user=Depends(get_current_user_from_token)):
    """Lista usuários online"""
    return {
        "online_users": [
            {"id": 1, "username": "admin", "name": "Administrador"},
            {"id": 2, "username": "user", "name": "Usuário"}
        ]
    }


@router.websocket("/ws/{token}")
async def websocket_endpoint(websocket: WebSocket, token: str):
    """WebSocket simples para teste"""

    # Verificar token
    payload = verify_token(token)
    if not payload:
        await websocket.close(code=1008)
        return

    await websocket.accept()

    try:
        await websocket.send_text(f"Conectado como {payload.get('sub')}")

        while True:
            data = await websocket.receive_text()
            await websocket.send_text(f"Echo: {data}")

    except Exception as e:
        print(f"WebSocket error: {e}")
    finally:
        await websocket.close()