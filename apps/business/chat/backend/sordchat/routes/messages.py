"""
Rotas CRUD para mensagens e chat em tempo real
"""

from fastapi import APIRouter, Depends, HTTPException, status, Query, WebSocket, WebSocketDisconnect
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
from typing import List, Optional, Dict, Any
import psycopg2
from urllib.parse import urlparse
import os
import json
from datetime import datetime, timedelta
from dotenv import load_dotenv

from ..schemas.message import MessageCreate, MessageUpdate, MessageResponse, MessageListResponse
from ..utils.auth import verify_token
from ..utils.permissions import require_permission, Permission, has_permission

load_dotenv()

router = APIRouter(prefix="/messages", tags=["Mensagens"])
security = HTTPBearer()


# Gerenciador de conexões WebSocket
class ConnectionManager:
    def __init__(self):
        self.active_connections: Dict[int, WebSocket] = {}
        self.user_rooms: Dict[int, str] = {}  # user_id -> room_name

    async def connect(self, websocket: WebSocket, user_id: int, room: str = "general"):
        await websocket.accept()
        self.active_connections[user_id] = websocket
        self.user_rooms[user_id] = room

        # Notificar outros usuários que alguém entrou online
        await self.broadcast_user_status(user_id, True, exclude_user=user_id)

    def disconnect(self, user_id: int):
        if user_id in self.active_connections:
            del self.active_connections[user_id]
        if user_id in self.user_rooms:
            del self.user_rooms[user_id]

    async def send_personal_message(self, message: str, user_id: int):
        if user_id in self.active_connections:
            websocket = self.active_connections[user_id]
            try:
                await websocket.send_text(message)
                return True
            except:
                self.disconnect(user_id)
                return False
        return False

    async def broadcast_to_room(self, message: str, room: str, exclude_user: Optional[int] = None):
        disconnected_users = []
        for user_id, websocket in self.active_connections.items():
            if self.user_rooms.get(user_id) == room and user_id != exclude_user:
                try:
                    await websocket.send_text(message)
                except:
                    disconnected_users.append(user_id)

        # Limpar conexões desconectadas
        for user_id in disconnected_users:
            self.disconnect(user_id)

    async def broadcast_user_status(self, user_id: int, is_online: bool, exclude_user: Optional[int] = None):
        message = json.dumps({
            "type": "user_status",
            "user_id": user_id,
            "is_online": is_online,
            "timestamp": datetime.now().isoformat()
        })

        # Broadcast para todos os usuários conectados
        disconnected_users = []
        for connected_user_id, websocket in self.active_connections.items():
            if connected_user_id != exclude_user:
                try:
                    await websocket.send_text(message)
                except:
                    disconnected_users.append(connected_user_id)

        for user_id in disconnected_users:
            self.disconnect(user_id)

    def get_online_users(self) -> List[int]:
        return list(self.active_connections.keys())


# Instância global do gerenciador
manager = ConnectionManager()


def get_db_connection():
    """Obtém conexão com o banco de dados"""
    database_url = os.getenv("DATABASE_URL")
    parsed = urlparse(database_url)

    return psycopg2.connect(
        host=parsed.hostname,
        database=parsed.path[1:],
        user=parsed.username,
        password=parsed.password,
        port=parsed.port or 5432
    )


def get_current_user_from_token(credentials: HTTPAuthorizationCredentials = Depends(security)):
    """Obtém usuário atual do token"""
    token = credentials.credentials
    payload = verify_token(token)

    if not payload:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Token inválido"
        )

    return payload


async def update_user_online_status(user_id: int, is_online: bool):
    """Atualiza status online do usuário no banco"""
    conn = get_db_connection()
    cursor = conn.cursor()

    try:
        cursor.execute("""
                       UPDATE users
                       SET is_online  = %s,
                           updated_at = NOW()
                       WHERE id = %s
                       """, (is_online, user_id))
        conn.commit()
    finally:
        cursor.close()
        conn.close()


@router.websocket("/ws/{token}")
async def websocket_endpoint(websocket: WebSocket, token: str):
    """Endpoint WebSocket para chat em tempo real"""

    # Verificar token
    payload = verify_token(token)
    if not payload:
        await websocket.close(code=status.WS_1008_POLICY_VIOLATION)
        return

    user_id = payload.get("user_id")
    username = payload.get("sub")

    # Conectar usuário
    await manager.connect(websocket, user_id)
    await update_user_online_status(user_id, True)

    try:
        while True:
            # Receber mensagem do cliente
            data = await websocket.receive_text()
            message_data = json.loads(data)

            # Processar diferentes tipos de mensagem
            if message_data.get("type") == "chat_message":
                await handle_chat_message(message_data, user_id, username)
            elif message_data.get("type") == "typing":
                await handle_typing_indicator(message_data, user_id, username)
            elif message_data.get("type") == "join_room":
                await handle_join_room(message_data, user_id)

    except WebSocketDisconnect:
        manager.disconnect(user_id)
        await update_user_online_status(user_id, False)
        await manager.broadcast_user_status(user_id, False, exclude_user=user_id)


async def handle_chat_message(message_data: dict, sender_id: int, sender_username: str):
    """Processa mensagem de chat"""

    conn = get_db_connection()
    cursor = conn.cursor()

    try:
        # Salvar mensagem no banco
        cursor.execute("""
                       INSERT INTO messages (content, sender_id, receiver_id, message_type)
                       VALUES (%s, %s, %s, %s) RETURNING id, content, sender_id, receiver_id, message_type, 
                     is_read, created_at
                       """, (
                           message_data.get("content"),
                           sender_id,
                           message_data.get("receiver_id"),  # None para mensagem pública
                           message_data.get("message_type", "text")
                       ))

        result = cursor.fetchone()
        conn.commit()

        # Buscar nome do remetente
        cursor.execute("SELECT full_name FROM users WHERE id = %s", (sender_id,))
        sender_name = cursor.fetchone()[0]

        # Preparar mensagem para broadcast
        broadcast_message = {
            "type": "new_message",
            "message": {
                "id": result[0],
                "content": result[1],
                "sender_id": result[2],
                "receiver_id": result[3],
                "message_type": result[4],
                "is_read": result[5],
                "created_at": result[6].isoformat(),
                "sender_name": sender_name,
                "sender_username": sender_username
            }
        }

        # Enviar mensagem
        if message_data.get("receiver_id"):
            # Mensagem privada
            await manager.send_personal_message(
                json.dumps(broadcast_message),
                message_data.get("receiver_id")
            )
            # Confirmar para o remetente
            await manager.send_personal_message(
                json.dumps(broadcast_message),
                sender_id
            )
        else:
            # Mensagem pública
            await manager.broadcast_to_room(
                json.dumps(broadcast_message),
                "general"
            )

    finally:
        cursor.close()
        conn.close()


async def handle_typing_indicator(message_data: dict, user_id: int, username: str):
    """Processa indicador de digitação"""

    typing_message = {
        "type": "typing",
        "user_id": user_id,
        "username": username,
        "is_typing": message_data.get("is_typing", False)
    }

    if message_data.get("receiver_id"):
        # Indicador privado
        await manager.send_personal_message(
            json.dumps(typing_message),
            message_data.get("receiver_id")
        )
    else:
        # Indicador público
        await manager.broadcast_to_room(
            json.dumps(typing_message),
            "general",
            exclude_user=user_id
        )


async def handle_join_room(message_data: dict, user_id: int):
    """Processa entrada em sala"""

    room = message_data.get("room", "general")
    manager.user_rooms[user_id] = room


@router.get("/", response_model=MessageListResponse)
async def list_messages(
        page: int = Query(1, ge=1),
        per_page: int = Query(50, ge=1, le=100),
        receiver_id: Optional[int] = Query(None, description="ID do destinatário para mensagens privadas"),
        only_unread: bool = Query(False, description="Apenas mensagens não lidas"),
        current_user=Depends(get_current_user_from_token)
):
    """Lista mensagens com paginação"""

    conn = get_db_connection()
    cursor = conn.cursor()

    try:
        user_id = current_user.get("user_id")
        where_conditions = []
        params = []

        if receiver_id:
            # Mensagens privadas entre dois usuários
            where_conditions.append("""
                ((sender_id = %s AND receiver_id = %s) OR 
                 (sender_id = %s AND receiver_id = %s))
            """)
            params.extend([user_id, receiver_id, receiver_id, user_id])
        else:
            # Mensagens públicas ou recebidas pelo usuário
            if has_permission(current_user.get("access_level"), Permission.VIEW_ALL_MESSAGES):
                # Master pode ver todas as mensagens
                pass
            else:
                where_conditions.append("""
                    (receiver_id IS NULL OR receiver_id = %s OR sender_id = %s)
                """)
                params.extend([user_id, user_id])

        if only_unread:
            where_conditions.append("is_read = FALSE AND receiver_id = %s")
            params.append(user_id)

        where_clause = "WHERE " + " AND ".join(where_conditions) if where_conditions else ""

        # Contar total
        cursor.execute(f"""
            SELECT COUNT(*) FROM messages m {where_clause}
        """, params)

        total = cursor.fetchone()[0]

        # Contar não lidas
        cursor.execute("""
                       SELECT COUNT(*)
                       FROM messages
                       WHERE receiver_id = %s
                         AND is_read = FALSE
                       """, (user_id,))

        unread_count = cursor.fetchone()[0]

        # Query principal
        offset = (page - 1) * per_page
        params.extend([per_page, offset])

        cursor.execute(f"""
            SELECT m.id, m.content, m.sender_id, m.receiver_id, m.message_type,
                   m.is_read, m.is_edited, m.created_at, m.updated_at,
                   m.attachments, m.reactions,
                   u.full_name as sender_name, u.username as sender_username
            FROM messages m
            LEFT JOIN users u ON m.sender_id = u.id
            {where_clause}
            ORDER BY m.created_at DESC
            LIMIT %s OFFSET %s
        """, params)

        messages = []
        for row in cursor.fetchall():
            messages.append(MessageResponse(
                id=row[0],
                content=row[1],
                sender_id=row[2],
                receiver_id=row[3],
                message_type=row[4],
                is_read=row[5],
                is_edited=row[6],
                created_at=row[7],
                updated_at=row[8],
                attachments=json.loads(row[9]) if row[9] else [],
                reactions=json.loads(row[10]) if row[10] else {},
                sender_name=row[11],
                sender_username=row[12]
            ))

        return MessageListResponse(
            messages=messages,
            total=total,
            unread_count=unread_count
        )

    finally:
        cursor.close()
        conn.close()


@router.post("/", response_model=MessageResponse)
async def create_message(
        message_data: MessageCreate,
        current_user=Depends(get_current_user_from_token)
):
    """Cria uma nova mensagem (alternativa ao WebSocket)"""

    require_permission(current_user.get("access_level"), Permission.SEND_MESSAGE)

    conn = get_db_connection()
    cursor = conn.cursor()

    try:
        # Verificar se o destinatário existe (se fornecido)
        if message_data.receiver_id:
            cursor.execute("SELECT id FROM users WHERE id = %s AND is_active = TRUE",
                           (message_data.receiver_id,))
            if not cursor.fetchone():
                raise HTTPException(
                    status_code=status.HTTP_400_BAD_REQUEST,
                    detail="Destinatário não encontrado"
                )

        # Inserir mensagem
        cursor.execute("""
                       INSERT INTO messages (content, sender_id, receiver_id, message_type)
                       VALUES (%s, %s, %s, %s) RETURNING id, content, sender_id, receiver_id, message_type, 
                     is_read, is_edited, created_at, updated_at, attachments, reactions
                       """, (
                           message_data.content,
                           current_user.get("user_id"),
                           message_data.receiver_id,
                           message_data.message_type
                       ))

        result = cursor.fetchone()
        conn.commit()

        # Buscar nome do remetente
        cursor.execute("SELECT full_name, username FROM users WHERE id = %s",
                       (current_user.get("user_id"),))
        sender_info = cursor.fetchone()

        message_response = MessageResponse(
            id=result[0],
            content=result[1],
            sender_id=result[2],
            receiver_id=result[3],
            message_type=result[4],
            is_read=result[5],
            is_edited=result[6],
            created_at=result[7],
            updated_at=result[8],
            attachments=json.loads(result[9]) if result[9] else [],
            reactions=json.loads(result[10]) if result[10] else {},
            sender_name=sender_info[0] if sender_info else None,
            sender_username=sender_info[1] if sender_info else None
        )

        # Enviar via WebSocket se possível
        broadcast_message = {
            "type": "new_message",
            "message": message_response.dict()
        }

        if message_data.receiver_id:
            await manager.send_personal_message(
                json.dumps(broadcast_message),
                message_data.receiver_id
            )
        else:
            await manager.broadcast_to_room(
                json.dumps(broadcast_message),
                "general"
            )

        return message_response

    finally:
        cursor.close()
        conn.close()


@router.put("/{message_id}", response_model=MessageResponse)
async def update_message(
        message_id: int,
        message_data: MessageUpdate,
        current_user=Depends(get_current_user_from_token)
):
    """Atualiza uma mensagem (apenas o remetente pode editar)"""

    conn = get_db_connection()
    cursor = conn.cursor()

    try:
        # Verificar se a mensagem existe e se o usuário pode editar
        cursor.execute("""
                       SELECT sender_id, receiver_id
                       FROM messages
                       WHERE id = %s
                       """, (message_id,))

        message = cursor.fetchone()
        if not message:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="Mensagem não encontrada"
            )

        if message[0] != current_user.get("user_id"):
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="Apenas o remetente pode editar a mensagem"
            )

        # Atualizar mensagem
        cursor.execute("""
                       UPDATE messages
                       SET content    = %s,
                           is_edited  = TRUE,
                           updated_at = NOW()
                       WHERE id = %s RETURNING id, content, sender_id, receiver_id, message_type, 
                     is_read, is_edited, created_at, updated_at, attachments, reactions
                       """, (message_data.content, message_id))

        result = cursor.fetchone()
        conn.commit()

        # Buscar nome do remetente
        cursor.execute("SELECT full_name, username FROM users WHERE id = %s",
                       (current_user.get("user_id"),))
        sender_info = cursor.fetchone()

        message_response = MessageResponse(
            id=result[0],
            content=result[1],
            sender_id=result[2],
            receiver_id=result[3],
            message_type=result[4],
            is_read=result[5],
            is_edited=result[6],
            created_at=result[7],
            updated_at=result[8],
            attachments=json.loads(result[9]) if result[9] else [],
            reactions=json.loads(result[10]) if result[10] else {},
            sender_name=sender_info[0] if sender_info else None,
            sender_username=sender_info[1] if sender_info else None
        )

        # Notificar via WebSocket
        broadcast_message = {
            "type": "message_updated",
            "message": message_response.dict()
        }

        if message[1]:  # mensagem privada
            await manager.send_personal_message(
                json.dumps(broadcast_message),
                message[1]
            )
        else:  # mensagem pública
            await manager.broadcast_to_room(
                json.dumps(broadcast_message),
                "general"
            )

        return message_response

    finally:
        cursor.close()
        conn.close()


@router.post("/{message_id}/mark-read")
async def mark_message_as_read(
        message_id: int,
        current_user=Depends(get_current_user_from_token)
):
    """Marca uma mensagem como lida"""

    conn = get_db_connection()
    cursor = conn.cursor()

    try:
        cursor.execute("""
                       UPDATE messages
                       SET is_read = TRUE
                       WHERE id = %s
                         AND receiver_id = %s
                       """, (message_id, current_user.get("user_id")))

        if cursor.rowcount == 0:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="Mensagem não encontrada ou você não é o destinatário"
            )

        conn.commit()

        return {"message": "Mensagem marcada como lida"}

    finally:
        cursor.close()
        conn.close()


@router.post("/mark-all-read")
async def mark_all_messages_as_read(
        current_user=Depends(get_current_user_from_token)
):
    """Marca todas as mensagens do usuário como lidas"""

    conn = get_db_connection()
    cursor = conn.cursor()

    try:
        cursor.execute("""
                       UPDATE messages
                       SET is_read = TRUE
                       WHERE receiver_id = %s
                         AND is_read = FALSE
                       """, (current_user.get("user_id"),))

        updated_count = cursor.rowcount
        conn.commit()

        return {"message": f"{updated_count} mensagens marcadas como lidas"}

    finally:
        cursor.close()
        conn.close()


@router.get("/online-users")
async def get_online_users(
        current_user=Depends(get_current_user_from_token)
):
    """Lista usuários online"""

    online_user_ids = manager.get_online_users()

    if not online_user_ids:
        return {"online_users": []}

    conn = get_db_connection()
    cursor = conn.cursor()

    try:
        placeholders = ','.join(['%s'] * len(online_user_ids))
        cursor.execute(f"""
            SELECT id, username, full_name, department, access_level
            FROM users 
            WHERE id IN ({placeholders}) AND is_active = TRUE
            ORDER BY full_name
        """, online_user_ids)

        online_users = []
        for row in cursor.fetchall():
            online_users.append({
                "id": row[0],
                "username": row[1],
                "full_name": row[2],
                "department": row[3],
                "access_level": row[4]
            })

        return {"online_users": online_users}

    finally:
        cursor.close()
        conn.close()


@router.delete("/{message_id}")
async def delete_message(
        message_id: int,
        current_user=Depends(get_current_user_from_token)
):
    """Exclui uma mensagem (apenas remetente ou admin)"""

    conn = get_db_connection()
    cursor = conn.cursor()

    try:
        # Verificar permissões
        cursor.execute("""
                       SELECT sender_id, receiver_id
                       FROM messages
                       WHERE id = %s
                       """, (message_id,))

        message = cursor.fetchone()
        if not message:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="Mensagem não encontrada"
            )

        user_id = current_user.get("user_id")
        can_delete = (
                message[0] == user_id or  # é o remetente
                has_permission(current_user.get("access_level"), Permission.ADMIN_ACCESS)
        )

        if not can_delete:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="Sem permissão para excluir esta mensagem"
            )

        cursor.execute("DELETE FROM messages WHERE id = %s", (message_id,))
        conn.commit()

        # Notificar via WebSocket
        broadcast_message = {
            "type": "message_deleted",
            "message_id": message_id
        }

        if message[1]:  # mensagem privada
            await manager.send_personal_message(
                json.dumps(broadcast_message),
                message[1]
            )
        else:  # mensagem pública
            await manager.broadcast_to_room(
                json.dumps(broadcast_message),
                "general"
            )

        return {"message": "Mensagem excluída com sucesso"}

    finally:
        cursor.close()
        conn.close()
