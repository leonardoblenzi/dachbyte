"""
Rotas CRUD para tasks
"""

from fastapi import APIRouter, Depends, HTTPException, status, Query
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
from typing import List, Optional, Dict, Any
import psycopg2
from urllib.parse import urlparse
import os
import json
from datetime import datetime
from dotenv import load_dotenv

from ..schemas.task import TaskCreate, TaskUpdate, TaskComment, TaskResponse
from ..utils.auth import verify_token
from ..utils.permissions import require_permission, Permission, has_permission

load_dotenv()

router = APIRouter(prefix="/tasks", tags=["Tasks"])
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

@router.get("/", response_model=List[TaskResponse])
async def list_tasks(
    status_filter: Optional[str] = Query(None, description="a_fazer, em_progresso, concluida"),
    urgency: Optional[str] = Query(None, description="baixa, media, alta, urgente"),
    assigned_to_me: bool = Query(False),
    created_by_me: bool = Query(False),
    current_user = Depends(get_current_user_from_token)
):
    """Lista tasks com filtros baseados em permissões"""

    conn = get_db_connection()
    cursor = conn.cursor()

    try:
        # Construir query baseada em permissões
        where_conditions = []
        params = []

        user_id = current_user.get("user_id")
        access_level = current_user.get("access_level")

        # Filtros de visibilidade baseados em permissões
        if has_permission(access_level, Permission.VIEW_ALL_TASKS):
            # Master pode ver todas as tasks
            pass
        elif has_permission(access_level, Permission.VIEW_DEPARTMENT_TASKS):
            # Coordenador vê tasks do departamento + públicas
            cursor.execute("SELECT department FROM users WHERE id = %s", (user_id,))
            user_dept = cursor.fetchone()
            if user_dept and user_dept[0]:
                where_conditions.append("""
                    (t.visibility = 'todos' OR 
                     (t.visibility = 'departamento' AND 
                      (t.created_by_id IN (SELECT id FROM users WHERE department = %s) OR
                       t.assigned_to_id = %s)) OR
                     t.created_by_id = %s OR t.assigned_to_id = %s)
                """)
                params.extend([user_dept[0], user_id, user_id, user_id])
            else:
                # Se não tem departamento, só vê suas próprias tasks
                where_conditions.append("(t.created_by_id = %s OR t.assigned_to_id = %s)")
                params.extend([user_id, user_id])
        else:
            # Usuário padrão vê apenas suas tasks + públicas atribuídas a ele
            where_conditions.append("""
                (t.created_by_id = %s OR 
                 (t.assigned_to_id = %s AND t.visibility = 'todos'))
            """)
            params.extend([user_id, user_id])

        # Aplicar filtros adicionais
        if status_filter:
            where_conditions.append("t.status = %s")
            params.append(status_filter)

        if urgency:
            where_conditions.append("t.urgency = %s")
            params.append(urgency)

        if assigned_to_me:
            where_conditions.append("t.assigned_to_id = %s")
            params.append(user_id)

        if created_by_me:
            where_conditions.append("t.created_by_id = %s")
            params.append(user_id)

        where_clause = "WHERE " + " AND ".join(where_conditions) if where_conditions else ""

        # Query principal
        cursor.execute(f"""
            SELECT t.id, t.name, t.description, t.urgency, t.status, t.visibility,
                   t.created_by_id, t.assigned_to_id, t.due_date, t.position,
                   t.created_at, t.updated_at, t.completed_at,
                   t.comments, t.attachments,
                   u1.full_name as created_by_name,
                   u2.full_name as assigned_to_name
            FROM tasks t
            LEFT JOIN users u1 ON t.created_by_id = u1.id
            LEFT JOIN users u2 ON t.assigned_to_id = u2.id
            {where_clause}
            ORDER BY t.position ASC, t.created_at DESC
        """, params)

        tasks = []
        for row in cursor.fetchall():
            # Parse JSON fields
            comments = json.loads(row[13]) if row[13] else []
            attachments = json.loads(row[14]) if row[14] else []

            tasks.append(TaskResponse(
                id=row[0],
                name=row[1],
                description=row[2],
                urgency=row[3],
                status=row[4],
                visibility=row[5],
                created_by_id=row[6],
                assigned_to_id=row[7],
                due_date=row[8],
                position=row[9],
                created_at=row[10],
                updated_at=row[11],
                completed_at=row[12],
                comments=comments,
                attachments=attachments,
                created_by_name=row[15],
                assigned_to_name=row[16]
            ))

        return tasks

    finally:
        cursor.close()
        conn.close()

@router.post("/", response_model=TaskResponse)
async def create_task(
    task_data: TaskCreate,
    current_user = Depends(get_current_user_from_token)
):
    """Cria uma nova task"""

    require_permission(current_user.get("access_level"), Permission.CREATE_TASK)

    conn = get_db_connection()
    cursor = conn.cursor()

    try:
        # Verificar se o usuário atribuído existe
        if task_data.assigned_to_id:
            cursor.execute("SELECT id FROM users WHERE id = %s AND is_active = TRUE",
                         (task_data.assigned_to_id,))
            if not cursor.fetchone():
                raise HTTPException(
                    status_code=status.HTTP_400_BAD_REQUEST,
                    detail="Usuário atribuído não encontrado"
                )

        # Obter próxima posição
        cursor.execute("SELECT COALESCE(MAX(position), 0) + 1 FROM tasks")
        next_position = cursor.fetchone()[0]

        # Inserir task
        cursor.execute("""
            INSERT INTO tasks (name, description, urgency, visibility, created_by_id, 
                             assigned_to_id, due_date, position, comments, attachments)
            VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
            RETURNING id, name, description, urgency, status, visibility, created_by_id,
                     assigned_to_id, due_date, position, created_at, updated_at, 
                     completed_at, comments, attachments
        """, (
            task_data.name,
            task_data.description,
            task_data.urgency,
            task_data.visibility,
            current_user.get("user_id"),
            task_data.assigned_to_id,
            task_data.due_date,
            next_position,
            json.dumps([]),  # comments vazios
            json.dumps([])   # attachments vazios
        ))

        result = cursor.fetchone()
        conn.commit()

        # Buscar nomes dos usuários
        cursor.execute("""
            SELECT u1.full_name as created_by_name,
                   u2.full_name as assigned_to_name
            FROM tasks t
            LEFT JOIN users u1 ON t.created_by_id = u1.id
            LEFT JOIN users u2 ON t.assigned_to_id = u2.id
            WHERE t.id = %s
        """, (result[0],))

        names = cursor.fetchone()

        return TaskResponse(
            id=result[0],
            name=result[1],
            description=result[2],
            urgency=result[3],
            status=result[4],
            visibility=result[5],
            created_by_id=result[6],
            assigned_to_id=result[7],
            due_date=result[8],
            position=result[9],
            created_at=result[10],
            updated_at=result[11],
            completed_at=result[12],
            comments=json.loads(result[13]) if result[13] else [],
            attachments=json.loads(result[14]) if result[14] else [],
            created_by_name=names[0] if names else None,
            assigned_to_name=names[1] if names else None
        )

    finally:
        cursor.close()
        conn.close()

@router.get("/{task_id}", response_model=TaskResponse)
async def get_task(
    task_id: int,
    current_user = Depends(get_current_user_from_token)
):
    """Obtém uma task específica"""

    conn = get_db_connection()
    cursor = conn.cursor()

    try:
        cursor.execute("""
            SELECT t.id, t.name, t.description, t.urgency, t.status, t.visibility,
                   t.created_by_id, t.assigned_to_id, t.due_date, t.position,
                   t.created_at, t.updated_at, t.completed_at,
                   t.comments, t.attachments,
                   u1.full_name as created_by_name,
                   u2.full_name as assigned_to_name
            FROM tasks t
            LEFT JOIN users u1 ON t.created_by_id = u1.id
            LEFT JOIN users u2 ON t.assigned_to_id = u2.id
            WHERE t.id = %s
        """, (task_id,))

        result = cursor.fetchone()
        if not result:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="Task não encontrada"
            )

        # Verificar permissões de visualização
        user_id = current_user.get("user_id")
        access_level = current_user.get("access_level")

        can_view = False

        if has_permission(access_level, Permission.VIEW_ALL_TASKS):
            can_view = True
        elif result[6] == user_id or result[7] == user_id:  # criador ou responsável
            can_view = True
        elif result[5] == "todos":  # task pública
            can_view = True
        elif has_permission(access_level, Permission.VIEW_DEPARTMENT_TASKS):
            # Verificar se é do mesmo departamento
            cursor.execute("""
                SELECT u1.department, u2.department
                FROM users u1, users u2
                WHERE u1.id = %s AND u2.id = %s
            """, (user_id, result[6]))
            depts = cursor.fetchone()
            if depts and depts[0] and depts[0] == depts[1]:
                can_view = True

        if not can_view:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="Sem permissão para visualizar esta task"
            )

        return TaskResponse(
            id=result[0],
            name=result[1],
            description=result[2],
            urgency=result[3],
            status=result[4],
            visibility=result[5],
            created_by_id=result[6],
            assigned_to_id=result[7],
            due_date=result[8],
            position=result[9],
            created_at=result[10],
            updated_at=result[11],
            completed_at=result[12],
            comments=json.loads(result[13]) if result[13] else [],
            attachments=json.loads(result[14]) if result[14] else [],
            created_by_name=result[15],
            assigned_to_name=result[16]
        )

    finally:
        cursor.close()
        conn.close()

@router.put("/{task_id}", response_model=TaskResponse)
async def update_task(
    task_id: int,
    task_data: TaskUpdate,
    current_user = Depends(get_current_user_from_token)
):
    """Atualiza uma task"""

    conn = get_db_connection()
    cursor = conn.cursor()

    try:
        # Buscar task atual
        cursor.execute("""
            SELECT created_by_id, assigned_to_id, status, visibility
            FROM tasks WHERE id = %s
        """, (task_id,))

        task = cursor.fetchone()
        if not task:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="Task não encontrada"
            )

        # Verificar permissões de edição
        user_id = current_user.get("user_id")
        access_level = current_user.get("access_level")

        can_edit = False

        if has_permission(access_level, Permission.EDIT_ALL_TASKS):
            can_edit = True
        elif task[0] == user_id and has_permission(access_level, Permission.EDIT_OWN_TASK):
            can_edit = True
        elif task[1] == user_id:  # responsável pode editar
            can_edit = True
        elif has_permission(access_level, Permission.EDIT_DEPARTMENT_TASKS):
            # Verificar se é do mesmo departamento
            cursor.execute("""
                SELECT u1.department, u2.department
                FROM users u1, users u2
                WHERE u1.id = %s AND u2.id = %s
            """, (user_id, task[0]))
            depts = cursor.fetchone()
            if depts and depts[0] and depts[0] == depts[1]:
                can_edit = True

        if not can_edit:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="Sem permissão para editar esta task"
            )

        # Construir query de atualização
        update_fields = []
        params = []

        if task_data.name is not None:
            update_fields.append("name = %s")
            params.append(task_data.name)

        if task_data.description is not None:
            update_fields.append("description = %s")
            params.append(task_data.description)

        if task_data.urgency is not None:
            update_fields.append("urgency = %s")
            params.append(task_data.urgency)

        if task_data.status is not None:
            update_fields.append("status = %s")
            params.append(task_data.status)

            # Se está concluindo a task
            if task_data.status == "concluida":
                update_fields.append("completed_at = NOW()")
            elif task[2] == "concluida" and task_data.status != "concluida":
                # Se estava concluída e agora não está mais
                update_fields.append("completed_at = NULL")

        if task_data.visibility is not None:
            update_fields.append("visibility = %s")
            params.append(task_data.visibility)

        if task_data.assigned_to_id is not None:
            # Verificar se o usuário existe
            cursor.execute("SELECT id FROM users WHERE id = %s AND is_active = TRUE",
                         (task_data.assigned_to_id,))
            if not cursor.fetchone():
                raise HTTPException(
                    status_code=status.HTTP_400_BAD_REQUEST,
                    detail="Usuário atribuído não encontrado"
                )

            update_fields.append("assigned_to_id = %s")
            params.append(task_data.assigned_to_id)

        if task_data.due_date is not None:
            update_fields.append("due_date = %s")
            params.append(task_data.due_date)

        if task_data.position is not None:
            update_fields.append("position = %s")
            params.append(task_data.position)

        if not update_fields:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Nenhum campo para atualizar"
            )

        update_fields.append("updated_at = NOW()")
        params.append(task_id)

        cursor.execute(f"""
            UPDATE tasks 
            SET {', '.join(update_fields)}
            WHERE id = %s
            RETURNING id, name, description, urgency, status, visibility, created_by_id,
                     assigned_to_id, due_date, position, created_at, updated_at, 
                     completed_at, comments, attachments
        """, params)

        result = cursor.fetchone()
        conn.commit()

        # Buscar nomes dos usuários
        cursor.execute("""
            SELECT u1.full_name as created_by_name,
                   u2.full_name as assigned_to_name
            FROM tasks t
            LEFT JOIN users u1 ON t.created_by_id = u1.id
            LEFT JOIN users u2 ON t.assigned_to_id = u2.id
            WHERE t.id = %s
        """, (result[0],))

        names = cursor.fetchone()

        return TaskResponse(
            id=result[0],
            name=result[1],
            description=result[2],
            urgency=result[3],
            status=result[4],
            visibility=result[5],
            created_by_id=result[6],
            assigned_to_id=result[7],
            due_date=result[8],
            position=result[9],
            created_at=result[10],
            updated_at=result[11],
            completed_at=result[12],
            comments=json.loads(result[13]) if result[13] else [],
            attachments=json.loads(result[14]) if result[14] else [],
            created_by_name=names[0] if names else None,
            assigned_to_name=names[1] if names else None
        )

    finally:
        cursor.close()
        conn.close()

@router.post("/{task_id}/comments")
async def add_comment(
    task_id: int,
    comment_data: TaskComment,
    current_user = Depends(get_current_user_from_token)
):
    """Adiciona um comentário à task"""

    conn = get_db_connection()
    cursor = conn.cursor()

    try:
        # Verificar se a task existe e se o usuário pode comentar
        cursor.execute("""
            SELECT created_by_id, assigned_to_id, comments
            FROM tasks WHERE id = %s
        """, (task_id,))

        task = cursor.fetchone()
        if not task:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="Task não encontrada"
            )

        # Buscar informações do usuário
        cursor.execute("""
            SELECT full_name FROM users WHERE id = %s
        """, (current_user.get("user_id"),))

        user_info = cursor.fetchone()

        # Preparar novo comentário
        new_comment = {
            "id": datetime.now().timestamp(),
            "content": comment_data.content,
            "author_id": current_user.get("user_id"),
            "author_name": user_info[0] if user_info else "Usuário",
            "created_at": datetime.now().isoformat()
        }

        # Atualizar comentários
        current_comments = json.loads(task[2]) if task[2] else []
        current_comments.append(new_comment)

        cursor.execute("""
            UPDATE tasks 
            SET comments = %s, updated_at = NOW()
            WHERE id = %s
        """, (json.dumps(current_comments), task_id))

        conn.commit()

        return {"message": "Comentário adicionado com sucesso", "comment": new_comment}

    finally:
        cursor.close()
        conn.close()

@router.get("/stats/dashboard")
async def get_task_stats(
    current_user = Depends(get_current_user_from_token)
):
    """Estatísticas de tasks para dashboard"""

    conn = get_db_connection()
    cursor = conn.cursor()

    try:
        user_id = current_user.get("user_id")

        # Estatísticas das minhas tasks
        cursor.execute("""
            SELECT 
                COUNT(*) as total,
                COUNT(CASE WHEN status = 'a_fazer' THEN 1 END) as a_fazer,
                COUNT(CASE WHEN status = 'em_progresso' THEN 1 END) as em_progresso,
                COUNT(CASE WHEN status = 'concluida' THEN 1 END) as concluidas,
                COUNT(CASE WHEN urgency = 'urgente' THEN 1 END) as urgentes,
                COUNT(CASE WHEN due_date < NOW() AND status != 'concluida' THEN 1 END) as atrasadas
            FROM tasks
            WHERE assigned_to_id = %s OR created_by_id = %s
        """, (user_id, user_id))

        stats = cursor.fetchone()

        return {
            "minhas_tasks": {
                "total": stats[0],
                "a_fazer": stats[1],
                "em_progresso": stats[2],
                "concluidas": stats[3],
                "urgentes": stats[4],
                "atrasadas": stats[5]
            }
        }

    finally:
        cursor.close()
        conn.close()