"""
Rotas CRUD para usuários
"""

from fastapi import APIRouter, Depends, HTTPException, status, Query
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
from typing import List, Optional
import psycopg2
from urllib.parse import urlparse
import os
from dotenv import load_dotenv

from ..schemas.user import UserCreate, UserUpdate, UserPasswordUpdate, UserListResponse
from ..schemas.auth import UserResponse
from ..utils.auth import verify_token, get_password_hash, verify_password
from ..utils.permissions import require_permission, Permission

load_dotenv()

router = APIRouter(prefix="/users", tags=["Usuários"])
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


@router.get("/", response_model=List[UserListResponse])
async def list_users(
        page: int = Query(1, ge=1),
        per_page: int = Query(10, ge=1, le=100),
        search: Optional[str] = Query(None),
        department: Optional[str] = Query(None),
        current_user=Depends(get_current_user_from_token)
):
    """Lista usuários com paginação e filtros"""

    # Verificar permissão
    require_permission(current_user.get("access_level"), Permission.VIEW_ALL_USERS)

    conn = get_db_connection()
    cursor = conn.cursor()

    try:
        # Construir query com filtros
        where_conditions = ["is_active = TRUE"]
        params = []

        if search:
            where_conditions.append("(full_name ILIKE %s OR username ILIKE %s OR email ILIKE %s)")
            search_param = f"%{search}%"
            params.extend([search_param, search_param, search_param])

        if department:
            where_conditions.append("department = %s")
            params.append(department)

        where_clause = " AND ".join(where_conditions)

        # Query principal
        offset = (page - 1) * per_page
        params.extend([per_page, offset])

        cursor.execute(f"""
            SELECT id, username, email, full_name, department, 
                   access_level, is_active, is_online, created_at
            FROM users
            WHERE {where_clause}
            ORDER BY full_name
            LIMIT %s OFFSET %s
        """, params)

        users = []
        for row in cursor.fetchall():
            users.append(UserListResponse(
                id=row[0],
                username=row[1],
                email=row[2],
                full_name=row[3],
                department=row[4],
                access_level=row[5],
                is_active=row[6],
                is_online=row[7],
                created_at=row[8]
            ))

        return users

    finally:
        cursor.close()
        conn.close()


@router.post("/", response_model=UserResponse)
async def create_user(
        user_data: UserCreate,
        current_user=Depends(get_current_user_from_token)
):
    """Cria um novo usuário"""

    # Verificar permissão
    require_permission(current_user.get("access_level"), Permission.CREATE_USER)

    conn = get_db_connection()
    cursor = conn.cursor()

    try:
        # Verificar se username ou email já existem
        cursor.execute("""
                       SELECT id
                       FROM users
                       WHERE username = %s
                          OR email = %s
                       """, (user_data.username, user_data.email))

        if cursor.fetchone():
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Username ou email já estão em uso"
            )

        # Hash da senha
        hashed_password = get_password_hash(user_data.password)

        # Inserir usuário
        cursor.execute("""
                       INSERT INTO users (username, email, full_name, hashed_password,
                                          department, access_level)
                       VALUES (%s, %s, %s, %s, %s, %s) RETURNING id, username, email, full_name, department, 
                     access_level, is_active, is_online, created_at, last_login
                       """, (
                           user_data.username,
                           user_data.email,
                           user_data.full_name,
                           hashed_password,
                           user_data.department,
                           user_data.access_level
                       ))

        result = cursor.fetchone()
        conn.commit()

        return UserResponse(
            id=result[0],
            username=result[1],
            email=result[2],
            full_name=result[3],
            department=result[4],
            access_level=result[5],
            is_active=result[6],
            is_online=result[7],
            created_at=result[8],
            last_login=result[9]
        )

    except psycopg2.IntegrityError:
        conn.rollback()
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Dados duplicados"
        )
    finally:
        cursor.close()
        conn.close()


@router.get("/{user_id}", response_model=UserResponse)
async def get_user(
        user_id: int,
        current_user=Depends(get_current_user_from_token)
):
    """Obtém um usuário específico"""

    # Verificar se é o próprio usuário ou tem permissão
    if current_user.get("user_id") != user_id:
        require_permission(current_user.get("access_level"), Permission.VIEW_ALL_USERS)

    conn = get_db_connection()
    cursor = conn.cursor()

    try:
        cursor.execute("""
                       SELECT id,
                              username,
                              email,
                              full_name,
                              department,
                              access_level,
                              is_active,
                              is_online,
                              created_at,
                              last_login
                       FROM users
                       WHERE id = %s
                         AND is_active = TRUE
                       """, (user_id,))

        result = cursor.fetchone()
        if not result:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="Usuário não encontrado"
            )

        return UserResponse(
            id=result[0],
            username=result[1],
            email=result[2],
            full_name=result[3],
            department=result[4],
            access_level=result[5],
            is_active=result[6],
            is_online=result[7],
            created_at=result[8],
            last_login=result[9]
        )

    finally:
        cursor.close()
        conn.close()


@router.put("/{user_id}", response_model=UserResponse)
async def update_user(
        user_id: int,
        user_data: UserUpdate,
        current_user=Depends(get_current_user_from_token)
):
    """Atualiza um usuário"""

    # Verificar se é o próprio usuário ou tem permissão
    if current_user.get("user_id") != user_id:
        require_permission(current_user.get("access_level"), Permission.EDIT_USER)

    conn = get_db_connection()
    cursor = conn.cursor()

    try:
        # Construir query de atualização dinamicamente
        update_fields = []
        params = []

        if user_data.full_name is not None:
            update_fields.append("full_name = %s")
            params.append(user_data.full_name)

        if user_data.email is not None:
            update_fields.append("email = %s")
            params.append(user_data.email)

        if user_data.department is not None:
            update_fields.append("department = %s")
            params.append(user_data.department)

        # Apenas usuários com permissão podem alterar nível de acesso
        if user_data.access_level is not None:
            require_permission(current_user.get("access_level"), Permission.EDIT_USER)
            update_fields.append("access_level = %s")
            params.append(user_data.access_level)

        if user_data.is_active is not None:
            require_permission(current_user.get("access_level"), Permission.EDIT_USER)
            update_fields.append("is_active = %s")
            params.append(user_data.is_active)

        if not update_fields:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Nenhum campo para atualizar"
            )

        update_fields.append("updated_at = NOW()")
        params.append(user_id)

        cursor.execute(f"""
            UPDATE users 
            SET {', '.join(update_fields)}
            WHERE id = %s
            RETURNING id, username, email, full_name, department, 
                     access_level, is_active, is_online, created_at, last_login
        """, params)

        result = cursor.fetchone()
        if not result:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="Usuário não encontrado"
            )

        conn.commit()

        return UserResponse(
            id=result[0],
            username=result[1],
            email=result[2],
            full_name=result[3],
            department=result[4],
            access_level=result[5],
            is_active=result[6],
            is_online=result[7],
            created_at=result[8],
            last_login=result[9]
        )

    finally:
        cursor.close()
        conn.close()


@router.post("/{user_id}/change-password")
async def change_password(
        user_id: int,
        password_data: UserPasswordUpdate,
        current_user=Depends(get_current_user_from_token)
):
    """Altera a senha do usuário"""

    # Verificar se é o próprio usuário ou tem permissão
    if current_user.get("user_id") != user_id:
        require_permission(current_user.get("access_level"), Permission.EDIT_USER)

    conn = get_db_connection()
    cursor = conn.cursor()

    try:
        # Buscar senha atual
        cursor.execute("""
                       SELECT hashed_password
                       FROM users
                       WHERE id = %s
                       """, (user_id,))

        result = cursor.fetchone()
        if not result:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="Usuário não encontrado"
            )

        # Verificar senha atual (apenas se for o próprio usuário)
        if current_user.get("user_id") == user_id:
            if not verify_password(password_data.current_password, result[0]):
                raise HTTPException(
                    status_code=status.HTTP_400_BAD_REQUEST,
                    detail="Senha atual incorreta"
                )

        # Atualizar senha
        new_hash = get_password_hash(password_data.new_password)
        cursor.execute("""
                       UPDATE users
                       SET hashed_password = %s,
                           updated_at      = NOW()
                       WHERE id = %s
                       """, (new_hash, user_id))

        conn.commit()

        return {"message": "Senha alterada com sucesso"}

    finally:
        cursor.close()
        conn.close()


@router.delete("/{user_id}")
async def delete_user(
        user_id: int,
        current_user=Depends(get_current_user_from_token)
):
    """Desativa um usuário (soft delete)"""

    require_permission(current_user.get("access_level"), Permission.DELETE_USER)

    # Não permitir auto-exclusão
    if current_user.get("user_id") == user_id:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Não é possível desativar sua própria conta"
        )

    conn = get_db_connection()
    cursor = conn.cursor()

    try:
        cursor.execute("""
                       UPDATE users
                       SET is_active  = FALSE,
                           updated_at = NOW()
                       WHERE id = %s
                       """, (user_id,))

        if cursor.rowcount == 0:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="Usuário não encontrado"
            )

        conn.commit()

        return {"message": "Usuário desativado com sucesso"}

    finally:
        cursor.close()
        conn.close()