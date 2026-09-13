"""
Rotas de autenticação
"""

from fastapi import APIRouter, Depends, HTTPException, status
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
from datetime import datetime
import psycopg2
from urllib.parse import urlparse
import os
from dotenv import load_dotenv

from ..schemas.auth import UserLogin, Token, UserResponse
from ..utils.auth import verify_password, create_access_token, verify_token, create_user_token_data

load_dotenv()

router = APIRouter(prefix="/auth", tags=["Autenticação"])
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

def get_user_by_username(username: str):
    """Busca usuário por username"""
    conn = get_db_connection()
    cursor = conn.cursor()

    try:
        cursor.execute("""
            SELECT id, username, email, full_name, hashed_password, 
                   department, access_level, is_active, is_online, 
                   created_at, last_login
            FROM users 
            WHERE username = %s AND is_active = TRUE
        """, (username,))

        result = cursor.fetchone()
        if result:
            return {
                'id': result[0],
                'username': result[1],
                'email': result[2],
                'full_name': result[3],
                'hashed_password': result[4],
                'department': result[5],
                'access_level': result[6],
                'is_active': result[7],
                'is_online': result[8],
                'created_at': result[9],
                'last_login': result[10]
            }
        return None
    finally:
        cursor.close()
        conn.close()

def update_user_login(user_id: int):
    """Atualiza o último login e status online do usuário"""
    conn = get_db_connection()
    cursor = conn.cursor()

    try:
        cursor.execute("""
            UPDATE users 
            SET last_login = NOW(), is_online = TRUE 
            WHERE id = %s
        """, (user_id,))
        conn.commit()
    finally:
        cursor.close()
        conn.close()

@router.post("/login", response_model=Token)
async def login(user_data: UserLogin):
    """Endpoint de login"""
    user = get_user_by_username(user_data.username)

    if not user:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Usuário ou senha incorretos",
            headers={"WWW-Authenticate": "Bearer"},
        )

    if not verify_password(user_data.password, user['hashed_password']):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Usuário ou senha incorretos",
            headers={"WWW-Authenticate": "Bearer"},
        )

    update_user_login(user['id'])

    token_data = create_user_token_data(
        user_id=user['id'],
        username=user['username'],
        access_level=user['access_level']
    )

    access_token = create_access_token(data=token_data)

    user_response = UserResponse(
        id=user['id'],
        username=user['username'],
        email=user['email'],
        full_name=user['full_name'],
        department=user['department'],
        access_level=user['access_level'],
        is_active=user['is_active'],
        is_online=True,
        created_at=user['created_at'],
        last_login=datetime.now()
    )

    return Token(
        access_token=access_token,
        user=user_response
    )

@router.post("/logout")
async def logout(credentials: HTTPAuthorizationCredentials = Depends(security)):
    """Endpoint de logout"""
    token = credentials.credentials
    payload = verify_token(token)

    if not payload:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Token inválido"
        )

    user_id = payload.get("user_id")
    if user_id:
        conn = get_db_connection()
        cursor = conn.cursor()

        try:
            cursor.execute("""
                UPDATE users 
                SET is_online = FALSE 
                WHERE id = %s
            """, (user_id,))
            conn.commit()
        finally:
            cursor.close()
            conn.close()

    return {"message": "Logout realizado com sucesso"}

@router.get("/me", response_model=UserResponse)
async def get_current_user(credentials: HTTPAuthorizationCredentials = Depends(security)):
    """Retorna informações do usuário atual"""
    token = credentials.credentials
    payload = verify_token(token)

    if not payload:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Token inválido"
        )

    username = payload.get("sub")
    user = get_user_by_username(username)

    if not user:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Usuário não encontrado"
        )

    return UserResponse(
        id=user['id'],
        username=user['username'],
        email=user['email'],
        full_name=user['full_name'],
        department=user['department'],
        access_level=user['access_level'],
        is_active=user['is_active'],
        is_online=user['is_online'],
        created_at=user['created_at'],
        last_login=user['last_login']
    )

@router.get("/permissions")
async def get_user_permissions(credentials: HTTPAuthorizationCredentials = Depends(security)):
    """Retorna as permissões do usuário atual"""
    token = credentials.credentials
    payload = verify_token(token)

    if not payload:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Token inválido"
        )

    access_level = payload.get("access_level")

    from ..utils.permissions import get_user_permissions
    permissions = get_user_permissions(access_level)

    return {
        "access_level": access_level,
        "permissions": permissions
    }