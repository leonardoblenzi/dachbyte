"""
Rotas CRUD para tickets
"""

from fastapi import APIRouter, Depends, HTTPException, status, Query
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
from typing import List, Optional
import psycopg2
from urllib.parse import urlparse
import os
from dotenv import load_dotenv

from ..schemas.ticket import TicketCreate, TicketUpdate, TicketResponse, TicketListResponse
from ..utils.auth import verify_token
from ..utils.permissions import require_permission, Permission, has_permission

load_dotenv()

router = APIRouter(prefix="/tickets", tags=["Tickets"])
security = HTTPBearer()

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

@router.get("/", response_model=TicketListResponse)
async def list_tickets(
    page: int = Query(1, ge=1),
    per_page: int = Query(10, ge=1, le=100),
    status_filter: Optional[str] = Query(None, description="aberto ou encerrado"),
    priority: Optional[str] = Query(None, description="baixa, media, alta, urgente"),
    assigned_to_me: bool = Query(False, description="Apenas tickets atribuídos a mim"),
    created_by_me: bool = Query(False, description="Apenas tickets criados por mim"),
    current_user = Depends(get_current_user_from_token)
):
    """Lista tickets com paginação e filtros"""

    conn = get_db_connection()
    cursor = conn.cursor()

    try:
        # Construir query com filtros baseados em permissões
        where_conditions = []
        params = []

        # Verificar permissões para visualização
        if has_permission(current_user.get("access_level"), Permission.VIEW_ALL_TICKETS):
            # Apenas Master pode ver todos os tickets; coordenador continua restrito aos tickets em que participa
            pass
        else:
            # Usuário padrão só vê seus próprios tickets
            where_conditions.append("(created_by_id = %s OR assigned_to_id = %s)")
            user_id = current_user.get("user_id")
            params.extend([user_id, user_id])

        # Aplicar filtros adicionais
        if status_filter:
            where_conditions.append("t.status = %s")
            params.append(status_filter)

        if priority:
            where_conditions.append("t.priority = %s")
            params.append(priority)

        if assigned_to_me:
            where_conditions.append("t.assigned_to_id = %s")
            params.append(current_user.get("user_id"))

        if created_by_me:
            where_conditions.append("t.created_by_id = %s")
            params.append(current_user.get("user_id"))

        where_clause = "WHERE " + " AND ".join(where_conditions) if where_conditions else ""

        # Contar total
        cursor.execute(f"""
            SELECT COUNT(*)
            FROM tickets t
            {where_clause}
        """, params)

        total = cursor.fetchone()[0]

        # Query principal com paginação
        offset = (page - 1) * per_page
        params.extend([per_page, offset])

        cursor.execute(f"""
            SELECT t.id, t.title, t.description, t.priority, t.status,
                   t.created_by_id, t.assigned_to_id, t.created_at, 
                   t.updated_at, t.closed_at,
                   u1.full_name as created_by_name,
                   u2.full_name as assigned_to_name
            FROM tickets t
            LEFT JOIN users u1 ON t.created_by_id = u1.id
            LEFT JOIN users u2 ON t.assigned_to_id = u2.id
            {where_clause}
            ORDER BY t.created_at DESC
            LIMIT %s OFFSET %s
        """, params)

        tickets = []
        for row in cursor.fetchall():
            tickets.append(TicketResponse(
                id=row[0],
                title=row[1],
                description=row[2],
                priority=row[3],
                status=row[4],
                created_by_id=row[5],
                assigned_to_id=row[6],
                created_at=row[7],
                updated_at=row[8],
                closed_at=row[9],
                created_by_name=row[10],
                assigned_to_name=row[11]
            ))

        return TicketListResponse(
            tickets=tickets,
            total=total,
            page=page,
            per_page=per_page
        )

    finally:
        cursor.close()
        conn.close()

@router.post("/", response_model=TicketResponse)
async def create_ticket(
    ticket_data: TicketCreate,
    current_user = Depends(get_current_user_from_token)
):
    """Cria um novo ticket"""

    require_permission(current_user.get("access_level"), Permission.CREATE_TICKET)

    conn = get_db_connection()
    cursor = conn.cursor()

    try:
        # Verificar se o usuário atribuído existe (se fornecido)
        if ticket_data.assigned_to_id:
            cursor.execute("SELECT id FROM users WHERE id = %s AND is_active = TRUE",
                         (ticket_data.assigned_to_id,))
            if not cursor.fetchone():
                raise HTTPException(
                    status_code=status.HTTP_400_BAD_REQUEST,
                    detail="Usuário atribuído não encontrado"
                )

        # Inserir ticket
        cursor.execute("""
            INSERT INTO tickets (title, description, priority, created_by_id, assigned_to_id)
            VALUES (%s, %s, %s, %s, %s)
            RETURNING id, title, description, priority, status, created_by_id, 
                     assigned_to_id, created_at, updated_at, closed_at
        """, (
            ticket_data.title,
            ticket_data.description,
            ticket_data.priority,
            current_user.get("user_id"),
            ticket_data.assigned_to_id
        ))

        result = cursor.fetchone()
        conn.commit()

        # Buscar nomes dos usuários
        cursor.execute("""
            SELECT u1.full_name as created_by_name,
                   u2.full_name as assigned_to_name
            FROM tickets t
            LEFT JOIN users u1 ON t.created_by_id = u1.id
            LEFT JOIN users u2 ON t.assigned_to_id = u2.id
            WHERE t.id = %s
        """, (result[0],))

        names = cursor.fetchone()

        return TicketResponse(
            id=result[0],
            title=result[1],
            description=result[2],
            priority=result[3],
            status=result[4],
            created_by_id=result[5],
            assigned_to_id=result[6],
            created_at=result[7],
            updated_at=result[8],
            closed_at=result[9],
            created_by_name=names[0] if names else None,
            assigned_to_name=names[1] if names else None
        )

    finally:
        cursor.close()
        conn.close()

@router.get("/{ticket_id}", response_model=TicketResponse)
async def get_ticket(
    ticket_id: int,
    current_user = Depends(get_current_user_from_token)
):
    """Obtém um ticket específico"""

    conn = get_db_connection()
    cursor = conn.cursor()

    try:
        cursor.execute("""
            SELECT t.id, t.title, t.description, t.priority, t.status,
                   t.created_by_id, t.assigned_to_id, t.created_at, 
                   t.updated_at, t.closed_at,
                   u1.full_name as created_by_name,
                   u2.full_name as assigned_to_name
            FROM tickets t
            LEFT JOIN users u1 ON t.created_by_id = u1.id
            LEFT JOIN users u2 ON t.assigned_to_id = u2.id
            WHERE t.id = %s
        """, (ticket_id,))

        result = cursor.fetchone()
        if not result:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="Ticket não encontrado"
            )

        # Verificar permissões
        user_id = current_user.get("user_id")
        if not has_permission(current_user.get("access_level"), Permission.VIEW_ALL_TICKETS):
            # Usuário padrão só pode ver tickets próprios ou atribuídos a ele
            if result[5] != user_id and result[6] != user_id:
                raise HTTPException(
                    status_code=status.HTTP_403_FORBIDDEN,
                    detail="Sem permissão para visualizar este ticket"
                )

        return TicketResponse(
            id=result[0],
            title=result[1],
            description=result[2],
            priority=result[3],
            status=result[4],
            created_by_id=result[5],
            assigned_to_id=result[6],
            created_at=result[7],
            updated_at=result[8],
            closed_at=result[9],
            created_by_name=result[10],
            assigned_to_name=result[11]
        )

    finally:
        cursor.close()
        conn.close()

@router.put("/{ticket_id}", response_model=TicketResponse)
async def update_ticket(
    ticket_id: int,
    ticket_data: TicketUpdate,
    current_user = Depends(get_current_user_from_token)
):
    """Atualiza um ticket"""

    conn = get_db_connection()
    cursor = conn.cursor()

    try:
        # Buscar ticket atual
        cursor.execute("""
            SELECT created_by_id, assigned_to_id, status
            FROM tickets WHERE id = %s
        """, (ticket_id,))

        ticket = cursor.fetchone()
        if not ticket:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="Ticket não encontrado"
            )

        # Verificar permissões
        user_id = current_user.get("user_id")
        can_edit = False

        if has_permission(current_user.get("access_level"), Permission.EDIT_TICKET):
            can_edit = True
        elif ticket[0] == user_id or ticket[1] == user_id:
            # Criador ou responsável pode editar
            can_edit = True

        if not can_edit:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="Sem permissão para editar este ticket"
            )

        # Construir query de atualização
        update_fields = []
        params = []

        if ticket_data.title is not None:
            update_fields.append("title = %s")
            params.append(ticket_data.title)

        if ticket_data.description is not None:
            update_fields.append("description = %s")
            params.append(ticket_data.description)

        if ticket_data.priority is not None:
            update_fields.append("priority = %s")
            params.append(ticket_data.priority)

        if ticket_data.status is not None:
            update_fields.append("status = %s")
            params.append(ticket_data.status)

            # Se está encerrando o ticket, definir closed_at
            if ticket_data.status == "encerrado":
                update_fields.append("closed_at = NOW()")

        if ticket_data.assigned_to_id is not None:
            # Verificar permissão para transferir tickets
            require_permission(current_user.get("access_level"), Permission.TRANSFER_TICKET)

            # Verificar se o usuário existe
            cursor.execute("SELECT id FROM users WHERE id = %s AND is_active = TRUE",
                         (ticket_data.assigned_to_id,))
            if not cursor.fetchone():
                raise HTTPException(
                    status_code=status.HTTP_400_BAD_REQUEST,
                    detail="Usuário atribuído não encontrado"
                )

            update_fields.append("assigned_to_id = %s")
            params.append(ticket_data.assigned_to_id)

        if not update_fields:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Nenhum campo para atualizar"
            )

        update_fields.append("updated_at = NOW()")
        params.append(ticket_id)

        cursor.execute(f"""
            UPDATE tickets 
            SET {', '.join(update_fields)}
            WHERE id = %s
            RETURNING id, title, description, priority, status, created_by_id, 
                     assigned_to_id, created_at, updated_at, closed_at
        """, params)

        result = cursor.fetchone()
        conn.commit()

        # Buscar nomes dos usuários
        cursor.execute("""
            SELECT u1.full_name as created_by_name,
                   u2.full_name as assigned_to_name
            FROM tickets t
            LEFT JOIN users u1 ON t.created_by_id = u1.id
            LEFT JOIN users u2 ON t.assigned_to_id = u2.id
            WHERE t.id = %s
        """, (result[0],))

        names = cursor.fetchone()

        return TicketResponse(
            id=result[0],
            title=result[1],
            description=result[2],
            priority=result[3],
            status=result[4],
            created_by_id=result[5],
            assigned_to_id=result[6],
            created_at=result[7],
            updated_at=result[8],
            closed_at=result[9],
            created_by_name=names[0] if names else None,
            assigned_to_name=names[1] if names else None
        )

    finally:
        cursor.close()
        conn.close()

@router.delete("/{ticket_id}")
async def delete_ticket(
    ticket_id: int,
    current_user = Depends(get_current_user_from_token)
):
    """Exclui um ticket (apenas Master)"""

    require_permission(current_user.get("access_level"), Permission.ADMIN_ACCESS)

    conn = get_db_connection()
    cursor = conn.cursor()

    try:
        cursor.execute("DELETE FROM tickets WHERE id = %s", (ticket_id,))

        if cursor.rowcount == 0:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="Ticket não encontrado"
            )

        conn.commit()

        return {"message": "Ticket excluído com sucesso"}

    finally:
        cursor.close()
        conn.close()

@router.get("/stats/dashboard")
async def get_ticket_stats(
    current_user = Depends(get_current_user_from_token)
):
    """Estatísticas de tickets para dashboard"""

    conn = get_db_connection()
    cursor = conn.cursor()

    try:
        # Filtro baseado em permissões
        user_filter = ""
        params = []

        if not has_permission(current_user.get("access_level"), Permission.VIEW_ALL_TICKETS):
            user_filter = "WHERE (created_by_id = %s OR assigned_to_id = %s)"
            user_id = current_user.get("user_id")
            params = [user_id, user_id]

        # Estatísticas gerais
        cursor.execute(f"""
            SELECT 
                COUNT(*) as total,
                COUNT(CASE WHEN status = 'aberto' THEN 1 END) as abertos,
                COUNT(CASE WHEN status = 'encerrado' THEN 1 END) as encerrados,
                COUNT(CASE WHEN priority = 'urgente' THEN 1 END) as urgentes,
                COUNT(CASE WHEN assigned_to_id = %s THEN 1 END) as meus_tickets
            FROM tickets
            {user_filter}
        """, params + [current_user.get("user_id")])

        stats = cursor.fetchone()

        # Tickets por prioridade
        cursor.execute(f"""
            SELECT priority, COUNT(*) 
            FROM tickets 
            {user_filter}
            GROUP BY priority
        """, params)

        priority_stats = dict(cursor.fetchall())

        return {
            "total": stats[0],
            "abertos": stats[1],
            "encerrados": stats[2],
            "urgentes": stats[3],
            "meus_tickets": stats[4],
            "por_prioridade": priority_stats
        }

    finally:
        cursor.close()
        conn.close()