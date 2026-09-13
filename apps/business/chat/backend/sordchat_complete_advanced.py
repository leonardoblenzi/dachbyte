from fastapi import FastAPI, HTTPException, Depends, WebSocket, WebSocketDisconnect, UploadFile, File
from fastapi.middleware.cors import CORSMiddleware
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
from fastapi.responses import FileResponse
from sqlalchemy import create_engine, Column, Integer, String, DateTime, Text, Boolean, ForeignKey
from sqlalchemy.ext.declarative import declarative_base
from sqlalchemy.orm import sessionmaker, Session, relationship
from passlib.context import CryptContext
from datetime import datetime, timedelta
from typing import Optional, Dict, List
import jwt
import uvicorn
import json
import asyncio
import os
import uuid
import sqlite3  # Importar sqlite3 para as operações diretas no banco

# Configurações
SECRET_KEY = "voltcorp_secret_key_super_secure_2024"
ALGORITHM = "HS256"
ACCESS_TOKEN_EXPIRE_MINUTES = 1440  # 24 horas

# Configuração do banco de dados
SQLALCHEMY_DATABASE_URL = "sqlite:///./voltcorp.db"
engine = create_engine(SQLALCHEMY_DATABASE_URL, connect_args={"check_same_thread": False})
SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)
Base = declarative_base()

# Configuração de hash de senha
pwd_context = CryptContext(schemes=["bcrypt"], deprecated="auto")


# Modelos do banco de dados
class User(Base):
    __tablename__ = "users"

    id = Column(Integer, primary_key=True, index=True)
    username = Column(String, unique=True, index=True)
    email = Column(String, unique=True, index=True)
    full_name = Column(String)
    hashed_password = Column(String)
    access_level = Column(String, default="usuario")  # usuario, coordenador, master
    is_active = Column(Boolean, default=True)
    created_at = Column(DateTime, default=datetime.utcnow)

    # Relacionamentos
    sent_messages = relationship("Message", foreign_keys="Message.sender_id", back_populates="sender")
    received_messages = relationship("Message", foreign_keys="Message.receiver_id", back_populates="receiver")
    uploaded_files = relationship("FileUpload", back_populates="uploader")


class Message(Base):
    __tablename__ = "messages"

    id = Column(Integer, primary_key=True, index=True)
    content = Column(Text)
    sender_id = Column(Integer, ForeignKey("users.id"))
    receiver_id = Column(Integer, ForeignKey("users.id"), nullable=True)  # None para chat geral
    message_type = Column(String, default="text")  # text, file, image
    file_path = Column(String, nullable=True)
    timestamp = Column(DateTime, default=datetime.utcnow)
    is_read = Column(Boolean, default=False)

    # Relacionamentos
    sender = relationship("User", foreign_keys=[sender_id], back_populates="sent_messages")
    receiver = relationship("User", foreign_keys=[receiver_id], back_populates="received_messages")


class FileUpload(Base):
    __tablename__ = "file_uploads"

    id = Column(Integer, primary_key=True, index=True)
    filename = Column(String)
    file_path = Column(String)
    file_size = Column(Integer)
    content_type = Column(String)
    uploaded_by = Column(Integer, ForeignKey("users.id"))
    upload_date = Column(DateTime, default=datetime.utcnow)

    # Relacionamentos
    uploader = relationship("User", back_populates="uploaded_files")


# Funções para inicialização do banco de dados e tabelas (incluindo reactions)
def init_database():
    conn = sqlite3.connect('voltcorp.db')
    cursor = conn.cursor()

    # Criar tabelas via SQLAlchemy
    Base.metadata.create_all(bind=engine)

    # Tabela de reações (já existente)
    cursor.execute('''
                   CREATE TABLE IF NOT EXISTS message_reactions
                   (
                       id
                       INTEGER
                       PRIMARY
                       KEY
                       AUTOINCREMENT,
                       message_id
                       INTEGER
                       NOT
                       NULL,
                       user_id
                       INTEGER
                       NOT
                       NULL,
                       emoji
                       TEXT
                       NOT
                       NULL,
                       created_at
                       TIMESTAMP
                       DEFAULT
                       CURRENT_TIMESTAMP,
                       FOREIGN
                       KEY
                   (
                       message_id
                   ) REFERENCES messages
                   (
                       id
                   ),
                       FOREIGN KEY
                   (
                       user_id
                   ) REFERENCES users
                   (
                       id
                   ),
                       UNIQUE
                   (
                       message_id,
                       user_id,
                       emoji
                   )
                       )
                   ''')

    # NOVAS TABELAS KANBAN

    # Tabela de quadros Kanban
    cursor.execute('''
                   CREATE TABLE IF NOT EXISTS kanban_boards
                   (
                       id
                       INTEGER
                       PRIMARY
                       KEY
                       AUTOINCREMENT,
                       name
                       TEXT
                       NOT
                       NULL,
                       description
                       TEXT,
                       color
                       TEXT
                       DEFAULT
                       '#3B82F6',
                       created_by
                       INTEGER
                       NOT
                       NULL,
                       created_at
                       TIMESTAMP
                       DEFAULT
                       CURRENT_TIMESTAMP,
                       updated_at
                       TIMESTAMP
                       DEFAULT
                       CURRENT_TIMESTAMP,
                       is_active
                       BOOLEAN
                       DEFAULT
                       1,
                       FOREIGN
                       KEY
                   (
                       created_by
                   ) REFERENCES users
                   (
                       id
                   )
                       )
                   ''')

    # Tabela de colunas do Kanban
    cursor.execute('''
                   CREATE TABLE IF NOT EXISTS kanban_columns
                   (
                       id
                       INTEGER
                       PRIMARY
                       KEY
                       AUTOINCREMENT,
                       board_id
                       INTEGER
                       NOT
                       NULL,
                       name
                       TEXT
                       NOT
                       NULL,
                       position
                       INTEGER
                       NOT
                       NULL,
                       color
                       TEXT
                       DEFAULT
                       '#6B7280',
                       created_at
                       TIMESTAMP
                       DEFAULT
                       CURRENT_TIMESTAMP,
                       FOREIGN
                       KEY
                   (
                       board_id
                   ) REFERENCES kanban_boards
                   (
                       id
                   ) ON DELETE CASCADE
                       )
                   ''')

    # Tabela de tarefas/cards
    cursor.execute('''
                   CREATE TABLE IF NOT EXISTS kanban_tasks
                   (
                       id
                       INTEGER
                       PRIMARY
                       KEY
                       AUTOINCREMENT,
                       board_id
                       INTEGER
                       NOT
                       NULL,
                       column_id
                       INTEGER
                       NOT
                       NULL,
                       title
                       TEXT
                       NOT
                       NULL,
                       description
                       TEXT,
                       priority
                       TEXT
                       DEFAULT
                       'medium',
                       category
                       TEXT,
                       due_date
                       TIMESTAMP,
                       assigned_to
                       INTEGER,
                       created_by
                       INTEGER
                       NOT
                       NULL,
                       position
                       INTEGER
                       NOT
                       NULL,
                       created_at
                       TIMESTAMP
                       DEFAULT
                       CURRENT_TIMESTAMP,
                       updated_at
                       TIMESTAMP
                       DEFAULT
                       CURRENT_TIMESTAMP,
                       FOREIGN
                       KEY
                   (
                       board_id
                   ) REFERENCES kanban_boards
                   (
                       id
                   ) ON DELETE CASCADE,
                       FOREIGN KEY
                   (
                       column_id
                   ) REFERENCES kanban_columns
                   (
                       id
                   )
                     ON DELETE CASCADE,
                       FOREIGN KEY
                   (
                       assigned_to
                   ) REFERENCES users
                   (
                       id
                   ),
                       FOREIGN KEY
                   (
                       created_by
                   ) REFERENCES users
                   (
                       id
                   )
                       )
                   ''')

    # Tabela de comentários nas tarefas
    cursor.execute('''
                   CREATE TABLE IF NOT EXISTS kanban_comments
                   (
                       id
                       INTEGER
                       PRIMARY
                       KEY
                       AUTOINCREMENT,
                       task_id
                       INTEGER
                       NOT
                       NULL,
                       user_id
                       INTEGER
                       NOT
                       NULL,
                       content
                       TEXT
                       NOT
                       NULL,
                       created_at
                       TIMESTAMP
                       DEFAULT
                       CURRENT_TIMESTAMP,
                       FOREIGN
                       KEY
                   (
                       task_id
                   ) REFERENCES kanban_tasks
                   (
                       id
                   ) ON DELETE CASCADE,
                       FOREIGN KEY
                   (
                       user_id
                   ) REFERENCES users
                   (
                       id
                   )
                       )
                   ''')

    # Tabela de anexos das tarefas
    cursor.execute('''
                   CREATE TABLE IF NOT EXISTS kanban_attachments
                   (
                       id
                       INTEGER
                       PRIMARY
                       KEY
                       AUTOINCREMENT,
                       task_id
                       INTEGER
                       NOT
                       NULL,
                       filename
                       TEXT
                       NOT
                       NULL,
                       file_path
                       TEXT
                       NOT
                       NULL,
                       file_size
                       INTEGER
                       NOT
                       NULL,
                       content_type
                       TEXT
                       NOT
                       NULL,
                       uploaded_by
                       INTEGER
                       NOT
                       NULL,
                       upload_date
                       TIMESTAMP
                       DEFAULT
                       CURRENT_TIMESTAMP,
                       FOREIGN
                       KEY
                   (
                       task_id
                   ) REFERENCES kanban_tasks
                   (
                       id
                   ) ON DELETE CASCADE,
                       FOREIGN KEY
                   (
                       uploaded_by
                   ) REFERENCES users
                   (
                       id
                   )
                       )
                   ''')

    conn.commit()
    conn.close()


# Função para criar dados padrão do Kanban
def create_default_kanban_data():
    conn = sqlite3.connect('voltcorp.db')
    cursor = conn.cursor()

    # Verificar se já existem quadros
    cursor.execute("SELECT COUNT(*) FROM kanban_boards")
    count = cursor.fetchone()[0]

    if count > 0:
        conn.close()
        return

    # Criar quadro padrão
    cursor.execute("""
                   INSERT INTO kanban_boards (name, description, color, created_by)
                   VALUES ('Projeto Principal', 'Quadro principal para gerenciamento de tarefas', '#3B82F6', 1)
                   """)

    board_id = cursor.lastrowid

    # Criar colunas padrão
    default_columns = [
        ('📋 To Do', 1, '#6B7280'),
        ('�� In Progress', 2, '#F59E0B'),
        ('✅ Done', 3, '#10B981'),
        ('🚫 Blocked', 4, '#EF4444')
    ]

    for name, position, color in default_columns:
        cursor.execute("""
                       INSERT INTO kanban_columns (board_id, name, position, color)
                       VALUES (?, ?, ?, ?)
                       """, (board_id, name, position, color))

    # Pegar IDs das colunas
    cursor.execute("SELECT id, name FROM kanban_columns WHERE board_id = ? ORDER BY position", (board_id,))
    columns = cursor.fetchall()

    # Criar tarefas de exemplo
    example_tasks = [
        (columns[0][0], 'Configurar ambiente de desenvolvimento', 'Instalar dependências e configurar banco de dados',
         'high', 'Setup', None, 1, 1),
        (columns[0][0], 'Criar documentação da API', 'Documentar todos os endpoints da API REST', 'medium',
         'Documentação', None, 1, 2),
        (columns[1][0], 'Implementar autenticação JWT', 'Sistema de login e logout com tokens JWT', 'high', 'Backend',
         None, 1, 1),
        (columns[2][0], 'Criar interface de login', 'Tela de login responsiva com validação', 'medium', 'Frontend',
         None, 1, 1),
    ]

    for column_id, title, description, priority, category, assigned_to, created_by, position in example_tasks:
        cursor.execute("""
                       INSERT INTO kanban_tasks (board_id, column_id, title, description, priority, category, assigned_to, created_by, position)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        """, (board_id, column_id, title, description, priority, category, assigned_to, created_by, position))

    conn.commit()
    conn.close()
    print("✅ Dados padrão do Kanban criados!")


# Instância da aplicação
app = FastAPI(title="Volt Corp API", version="1.0.0")

# Configuração CORS
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Configuração de segurança
security = HTTPBearer()


# Dependência para obter sessão do banco
def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


# Criar sessão global (temporário para desenvolvimento)
session = SessionLocal()


# Funções utilitárias
def verify_password(plain_password, hashed_password):
    return pwd_context.verify(plain_password, hashed_password)


def get_password_hash(password):
    return pwd_context.hash(password)


def create_access_token(data: dict, expires_delta: Optional[timedelta] = None):
    to_encode = data.copy()
    if expires_delta:
        expire = datetime.utcnow() + expires_delta
    else:
        expire = datetime.utcnow() + timedelta(minutes=15)
    to_encode.update({"exp": expire})
    encoded_jwt = jwt.encode(to_encode, SECRET_KEY, algorithm=ALGORITHM)
    return encoded_jwt


def get_current_user(credentials: HTTPAuthorizationCredentials = Depends(security)):
    try:
        token = credentials.credentials
        payload = jwt.decode(token, SECRET_KEY, algorithms=[ALGORITHM])
        user_id: str = payload.get("sub")
        if user_id is None:
            raise HTTPException(status_code=401, detail="Token inválido")
    except jwt.PyJWTError:
        raise HTTPException(status_code=401, detail="Token inválido")

    user = session.query(User).filter(User.id == int(user_id)).first()
    if user is None:
        raise HTTPException(status_code=401, detail="Usuário não encontrado")

    # Retornar um dicionário simples para compatibilidade com as operações SQLite diretas
    return {
        "id": user.id,
        "username": user.username,
        "email": user.email,
        "full_name": user.full_name,
        "access_level": user.access_level,
        "is_active": user.is_active
    }


# Classe para gerenciar conexões WebSocket
class ConnectionManager:
    def __init__(self):
        self.active_connections: Dict[int, WebSocket] = {}
        self.user_connections: Dict[int, int] = {}  # user_id -> connection_id

    async def connect(self, websocket: WebSocket, user_id: int):
        await websocket.accept()
        connection_id = id(websocket)
        self.active_connections[connection_id] = websocket
        self.user_connections[user_id] = connection_id
        await self.broadcast_user_status(user_id, True)
        await self.send_online_users(websocket)
        return connection_id

    def disconnect(self, user_id: int):
        if user_id in self.user_connections:
            connection_id = self.user_connections[user_id]
            if connection_id in self.active_connections:
                del self.active_connections[connection_id]
            del self.user_connections[user_id]

    async def send_personal_message(self, message: str, user_id: int):
        if user_id in self.user_connections:
            connection_id = self.user_connections[user_id]
            if connection_id in self.active_connections:
                websocket = self.active_connections[connection_id]
                try:
                    await websocket.send_text(message)
                except Exception as e:
                    print(f"Erro ao enviar mensagem pessoal: {e}")
                    self.disconnect(user_id)

    async def broadcast(self, message: str, exclude_user: int = None):
        disconnected = []
        for user_id, connection_id in self.user_connections.items():
            if exclude_user and user_id == exclude_user:
                continue
            if connection_id in self.active_connections:
                websocket = self.active_connections[connection_id]
                try:
                    await websocket.send_text(message)
                except Exception as e:
                    print(f"Erro no broadcast: {e}")
                    disconnected.append(user_id)

        for user_id in disconnected:
            self.disconnect(user_id)

    async def broadcast_user_status(self, user_id: int, is_online: bool):
        try:
            user_db = session.query(User).filter(User.id == user_id).first()
            if user_db:
                message = {
                    "type": "user_status",
                    "user_id": user_id,
                    "username": user_db.username,
                    "full_name": user_db.full_name,
                    "is_online": is_online
                }
                await self.broadcast(json.dumps(message), exclude_user=user_id)
        except Exception as e:
            print(f"Erro ao broadcast status: {e}")

    async def send_online_users(self, websocket: WebSocket):
        try:
            online_users = []
            for user_id in self.user_connections.keys():
                user_db = session.query(User).filter(User.id == user_id).first()
                if user_db:
                    online_users.append({
                        "id": user_db.id,
                        "username": user_db.username,
                        "full_name": user_db.full_name
                    })

            message = {
                "type": "online_users",
                "users": online_users
            }
            await websocket.send_text(json.dumps(message))
        except Exception as e:
            print(f"Erro ao enviar usuários online: {e}")


# Instanciar gerenciador
manager = ConnectionManager()


# Criar usuários padrão
def create_default_users():
    # Verificar se já existem usuários
    existing_users_count = session.query(User).count()
    if existing_users_count > 0:
        return

    default_users = [
        {
            "username": "admin",
            "email": "admin@voltcorp.com",
            "full_name": "Administrador Master",
            "password": "admin123",
            "access_level": "master"
        },
        {
            "username": "coordenador",
            "email": "coord@voltcorp.com",
            "full_name": "Coordenador Sistema",
            "password": "coord123",
            "access_level": "coordenador"
        },
        {
            "username": "usuario",
            "email": "user@voltcorp.com",
            "full_name": "Usuário Padrão",
            "password": "user123",
            "access_level": "usuario"
        }
    ]

    for user_data in default_users:
        hashed_password = get_password_hash(user_data["password"])
        user = User(
            username=user_data["username"],
            email=user_data["email"],
            full_name=user_data["full_name"],
            hashed_password=hashed_password,
            access_level=user_data["access_level"]
        )
        session.add(user)

    session.commit()
    print("✅ Usuários padrão criados!")


# Rotas da API
@app.get("/")
async def root():
    return {
        "message": "Volt Corp API",
        "version": "1.0.0",
        "status": "online"
    }


@app.post("/auth/login")
async def login(credentials: dict):
    username = credentials.get("username")
    password = credentials.get("password")

    if not username or not password:
        raise HTTPException(status_code=400, detail="Username e password são obrigatórios")

    user_db = session.query(User).filter(User.username == username).first()

    if not user_db or not verify_password(password, user_db.hashed_password):
        raise HTTPException(status_code=401, detail="Credenciais inválidas")

    if not user_db.is_active:
        raise HTTPException(status_code=401, detail="Usuário inativo")

    access_token_expires = timedelta(minutes=ACCESS_TOKEN_EXPIRE_MINUTES)
    access_token = create_access_token(
        data={"sub": str(user_db.id)}, expires_delta=access_token_expires
    )

    return {
        "access_token": access_token,
        "token_type": "bearer",
        "user": {
            "id": user_db.id,
            "username": user_db.username,
            "email": user_db.email,
            "full_name": user_db.full_name,
            "access_level": user_db.access_level
        }
    }


@app.post("/auth/logout")
async def logout(current_user: dict = Depends(get_current_user)):
    return {"message": "Logout realizado com sucesso"}


@app.get("/auth/me")
async def get_current_user_info(current_user: dict = Depends(get_current_user)):
    return {
        "id": current_user['id'],
        "username": current_user['username'],
        "email": current_user['email'],
        "full_name": current_user['full_name'],
        "access_level": current_user['access_level']
    }


# WebSocket endpoint
@app.websocket("/messages/ws/{token}")
async def websocket_endpoint(websocket: WebSocket, token: str):
    user = None  # Será um dicionário simples com os dados do usuário
    try:
        # Verificar token
        payload = jwt.decode(token, SECRET_KEY, algorithms=[ALGORITHM])
        user_id = payload.get("sub")

        if not user_id:
            await websocket.close(code=1008)  # Protocol Error
            return

        user_db = session.query(User).filter(User.id == int(user_id)).first()
        if not user_db:
            await websocket.close(code=1008)  # Protocol Error
            return

        # Converter objeto User para dicionário para uso consistente com outras funções
        user = {
            "id": user_db.id,
            "username": user_db.username,
            "full_name": user_db.full_name
        }

        # Conectar usuário
        await manager.connect(websocket, user["id"])
        print(f"✅ {user['username']} conectado ao WebSocket")

        # Mensagem de boas-vindas
        welcome_message = {
            "type": "connection",
            "message": f"Conectado como {user['full_name']}! 🎉"
        }
        await websocket.send_text(json.dumps(welcome_message))

        # Enviar histórico (com reações)
        conn = sqlite3.connect('voltcorp.db')
        cursor = conn.cursor()
        cursor.execute("""
                       SELECT m.*, u.full_name
                       FROM messages m
                                JOIN users u ON m.sender_id = u.id
                       ORDER BY m.timestamp DESC LIMIT 50
                       """)
        messages_data = []

        for row in reversed(cursor.fetchall()):
            message_id = row[0]

            # Buscar reações da mensagem
            cursor.execute("""
                           SELECT r.emoji,
                                  COUNT(*) as count, 
                       GROUP_CONCAT(u2.full_name) as users,
                       GROUP_CONCAT(r.user_id) as user_ids
                           FROM message_reactions r
                               JOIN users u2
                           ON r.user_id = u2.id
                           WHERE r.message_id = ?
                           GROUP BY r.emoji
                           """, (message_id,))

            reactions = []
            for reaction_row in cursor.fetchall():
                user_ids = [int(uid) for uid in reaction_row[3].split(',') if reaction_row[3]]
                reactions.append({
                    'emoji': reaction_row[0],
                    'count': reaction_row[1],
                    'users': reaction_row[2].split(',') if reaction_row[2] else [],
                    'user_ids': user_ids,
                    'reacted_by_me': user['id'] in user_ids  # Verifica se o usuário atual reagiu
                })

            messages_data.append({
                "id": row[0],
                "content": row[1],
                "sender_id": row[2],
                "sender_name": row[8],
                "receiver_id": row[3],
                "message_type": row[4],
                "timestamp": row[6],
                "file_path": row[5],
                "reactions": reactions  # Adiciona as reações à mensagem
            })

        conn.close()

        history_message = {
            "type": "message_history",
            "messages": messages_data
        }
        await websocket.send_text(json.dumps(history_message))

        # Loop principal
        while True:
            try:
                data = await websocket.receive_text()
                message_data = json.loads(data)

                if message_data["type"] == "chat_message":
                    # Nova mensagem
                    new_message_db = Message(
                        content=message_data["content"],
                        sender_id=user["id"],
                        receiver_id=message_data.get("receiver_id"),
                        message_type=message_data.get("message_type", "text"),
                        file_path=message_data.get("file_path")
                    )

                    session.add(new_message_db)
                    session.commit()

                    # Broadcast
                    broadcast_message = {
                        "type": "new_message",
                        "message": {
                            "id": new_message_db.id,
                            "content": new_message_db.content,
                            "sender_id": user["id"],
                            "sender_name": user["full_name"],
                            "receiver_id": new_message_db.receiver_id,
                            "message_type": new_message_db.message_type,
                            "timestamp": new_message_db.timestamp.isoformat(),
                            "file_path": new_message_db.file_path,
                            "reactions": []  # Novas mensagens começam sem reações
                        }
                    }

                    if new_message_db.receiver_id:
                        await manager.send_personal_message(json.dumps(broadcast_message), new_message_db.receiver_id)
                        await manager.send_personal_message(json.dumps(broadcast_message), user["id"])
                    else:
                        await manager.broadcast(json.dumps(broadcast_message))

                elif message_data["type"] == "typing":
                    # Indicador de digitação
                    typing_message = {
                        "type": "typing",
                        "user_id": user["id"],
                        "username": user["username"],
                        "is_typing": message_data["is_typing"]
                    }

                    if message_data.get("receiver_id"):
                        await manager.send_personal_message(json.dumps(typing_message), message_data["receiver_id"])
                    else:
                        await manager.broadcast(json.dumps(typing_message), exclude_user=user["id"])

                elif message_data["type"] == "ping":
                    pong_message = {"type": "pong"}
                    await websocket.send_text(json.dumps(pong_message))

            except WebSocketDisconnect:
                break
            except Exception as e:
                print(f"Erro no WebSocket loop: {e}")
                break

    except Exception as e:
        print(f"Erro na conexão WebSocket inicial: {e}")
    finally:
        if user:  # Verifica se o objeto 'user' foi definido
            manager.disconnect(user["id"])
            await manager.broadcast_user_status(user["id"], False)


# Upload de arquivos
@app.post("/files/upload")
async def upload_file(file: UploadFile = File(...), current_user: dict = Depends(get_current_user)):
    try:
        # Verificações
        allowed_types = [
            'image/jpeg', 'image/png', 'image/gif', 'image/webp',
            'application/pdf', 'text/plain',
            'application/msword',  # .doc
            'application/vnd.openxmlformats-officedocument.wordprocessingml.document'  # .docx
        ]

        if file.content_type not in allowed_types:
            raise HTTPException(status_code=400, detail="Tipo de arquivo não permitido")

        content = await file.read()
        if len(content) > 10 * 1024 * 1024:  # 10MB
            raise HTTPException(status_code=400, detail="Arquivo muito grande")

        # Salvar arquivo
        upload_dir = "uploads"
        os.makedirs(upload_dir, exist_ok=True)

        file_extension = file.filename.split('.')[-1] if '.' in file.filename else ''
        unique_filename = f"{uuid.uuid4()}.{file_extension}"
        file_path = os.path.join(upload_dir, unique_filename)

        with open(file_path, "wb") as f:
            f.write(content)

        # Salvar no banco
        file_record = FileUpload(
            filename=file.filename,
            file_path=file_path,
            file_size=len(content),
            content_type=file.content_type,
            uploaded_by=current_user['id']
        )

        session.add(file_record)
        session.commit()

        return {
            "id": file_record.id,
            "filename": file.filename,
            "file_path": file_path,
            "file_size": len(content),
            "content_type": file.content_type
        }

    except Exception as e:
        session.rollback()
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/files/download/{file_id}")
async def download_file(file_id: int, current_user: dict = Depends(get_current_user)):
    file_record = session.query(FileUpload).filter(FileUpload.id == file_id).first()

    if not file_record:
        raise HTTPException(status_code=404, detail="Arquivo não encontrado")

    if not os.path.exists(file_record.file_path):
        raise HTTPException(status_code=404, detail="Arquivo não existe")

    return FileResponse(
        path=file_record.file_path,
        filename=file_record.filename,
        media_type=file_record.content_type
    )


# Endpoint para adicionar/remover reação
@app.post("/messages/{message_id}/reactions")
async def toggle_reaction(
        message_id: int,
        reaction_data: dict,
        current_user: dict = Depends(get_current_user)
):
    try:
        emoji = reaction_data.get('emoji')
        if not emoji:
            raise HTTPException(status_code=400, detail="Emoji é obrigatório")

        conn = sqlite3.connect('voltcorp.db')
        cursor = conn.cursor()

        # Verificar se a mensagem existe
        cursor.execute("SELECT id FROM messages WHERE id = ?", (message_id,))
        if not cursor.fetchone():
            conn.close()
            raise HTTPException(status_code=404, detail="Mensagem não encontrada")

        # Verificar se a reação já existe
        cursor.execute(
            "SELECT id FROM message_reactions WHERE message_id = ? AND user_id = ? AND emoji = ?",
            (message_id, current_user['id'], emoji)
        )
        existing_reaction = cursor.fetchone()

        if existing_reaction:
            # Remover reação existente
            cursor.execute(
                "DELETE FROM message_reactions WHERE message_id = ? AND user_id = ? AND emoji = ?",
                (message_id, current_user['id'], emoji)
            )
            action = "removed"
        else:
            # Adicionar nova reação
            cursor.execute(
                "INSERT INTO message_reactions (message_id, user_id, emoji) VALUES (?, ?, ?)",
                (message_id, current_user['id'], emoji)
            )
            action = "added"

        conn.commit()

        # Buscar todas as reações da mensagem
        cursor.execute("""
                       SELECT r.emoji,
                              COUNT(*) as count, 
                   GROUP_CONCAT(u.full_name) as users,
                   GROUP_CONCAT(r.user_id) as user_ids
                       FROM message_reactions r
                           JOIN users u
                       ON r.user_id = u.id
                       WHERE r.message_id = ?
                       GROUP BY r.emoji
                       """, (message_id,))

        reactions = []
        for row in cursor.fetchall():
            user_ids = [int(uid) for uid in row[3].split(',') if
                        row[3]]  # Converte IDs de usuários para lista de inteiros
            reactions.append({
                'emoji': row[0],
                'count': row[1],
                'users': row[2].split(',') if row[2] else [],
                'user_ids': user_ids,
                'reacted_by_me': current_user['id'] in user_ids  # Indica se o usuário atual reagiu
            })

        conn.close()

        # Broadcast da atualização de reação via WebSocket
        reaction_update = {
            "type": "reaction_update",
            "message_id": message_id,
            "reactions": reactions,
            "action": action,
            "user_name": current_user['full_name'],
            "emoji": emoji
        }

        await manager.broadcast(json.dumps(reaction_update))

        return {
            "message": f"Reação {action}",
            "reactions": reactions
        }

    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


# Endpoint para buscar reações de uma mensagem
@app.get("/messages/{message_id}/reactions")
async def get_message_reactions(
        message_id: int,
        current_user: dict = Depends(get_current_user)
):
    try:
        conn = sqlite3.connect('voltcorp.db')
        cursor = conn.cursor()

        cursor.execute("""
                       SELECT r.emoji,
                              COUNT(*) as count, 
                   GROUP_CONCAT(u.full_name) as users,
                   GROUP_CONCAT(r.user_id) as user_ids
                       FROM message_reactions r
                           JOIN users u
                       ON r.user_id = u.id
                       WHERE r.message_id = ?
                       GROUP BY r.emoji
                       """, (message_id,))

        reactions = []
        for row in cursor.fetchall():
            user_ids = [int(uid) for uid in row[3].split(',') if row[3]]
            reactions.append({
                'emoji': row[0],
                'count': row[1],
                'users': row[2].split(',') if row[2] else [],
                'user_ids': user_ids,
                'reacted_by_me': current_user['id'] in user_ids
            })

        conn.close()
        return reactions

    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


# ==================== ENDPOINTS KANBAN ====================

# Listar todos os quadros
@app.get("/kanban/boards")
async def get_boards(current_user: dict = Depends(get_current_user)):
    try:
        conn = sqlite3.connect('voltcorp.db')
        cursor = conn.cursor()

        cursor.execute("""
                       SELECT b.*, u.full_name as created_by_name
                       FROM kanban_boards b
                                JOIN users u ON b.created_by = u.id
                       WHERE b.is_active = 1
                       ORDER BY b.created_at DESC
                       """)

        boards = []
        for row in cursor.fetchall():
            boards.append({
                'id': row[0],
                'name': row[1],
                'description': row[2],
                'color': row[3],
                'created_by': row[4],
                'created_at': row[5],
                'updated_at': row[6],
                'is_active': row[7],
                'created_by_name': row[8]
            })

        conn.close()
        return boards

    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


# Obter quadro específico com colunas e tarefas
@app.get("/kanban/boards/{board_id}")
async def get_board(board_id: int, current_user: dict = Depends(get_current_user)):
    try:
        conn = sqlite3.connect('voltcorp.db')
        cursor = conn.cursor()

        # Buscar quadro
        cursor.execute("""
                       SELECT b.*, u.full_name as created_by_name
                       FROM kanban_boards b
                                JOIN users u ON b.created_by = u.id
                       WHERE b.id = ?
                         AND b.is_active = 1
                       """, (board_id,))

        board_row = cursor.fetchone()
        if not board_row:
            conn.close()
            raise HTTPException(status_code=404, detail="Quadro não encontrado")

        board = {
            'id': board_row[0],
            'name': board_row[1],
            'description': board_row[2],
            'color': board_row[3],
            'created_by': board_row[4],
            'created_at': board_row[5],
            'updated_at': board_row[6],
            'is_active': board_row[7],
            'created_by_name': board_row[8]
        }

        # Buscar colunas
        cursor.execute("""
                       SELECT *
                       FROM kanban_columns
                       WHERE board_id = ?
                       ORDER BY position
                       """, (board_id,))

        columns = []
        for col_row in cursor.fetchall():
            column_id = col_row[0]

            # Buscar tarefas da coluna
            cursor.execute("""
                           SELECT t.*, u1.full_name as assigned_to_name, u2.full_name as created_by_name
                           FROM kanban_tasks t
                                    LEFT JOIN users u1 ON t.assigned_to = u1.id
                                    JOIN users u2 ON t.created_by = u2.id
                           WHERE t.column_id = ?
                           ORDER BY t.position
                           """, (column_id,))

            tasks = []
            for task_row in cursor.fetchall():
                tasks.append({
                    'id': task_row[0],
                    'board_id': task_row[1],
                    'column_id': task_row[2],
                    'title': task_row[3],
                    'description': task_row[4],
                    'priority': task_row[5],
                    'category': task_row[6],
                    'due_date': task_row[7],
                    'assigned_to': task_row[8],
                    'created_by': task_row[9],
                    'position': task_row[10],
                    'created_at': task_row[11],
                    'updated_at': task_row[12],
                    'assigned_to_name': task_row[13],
                    'created_by_name': task_row[14]
                })

            columns.append({
                'id': col_row[0],
                'board_id': col_row[1],
                'name': col_row[2],
                'position': col_row[3],
                'color': col_row[4],
                'created_at': col_row[5],
                'tasks': tasks
            })

        board['columns'] = columns
        conn.close()
        return board

    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


# Criar novo quadro
@app.post("/kanban/boards")
async def create_board(board_data: dict, current_user: dict = Depends(get_current_user)):
    try:
        name = board_data.get('name')
        description = board_data.get('description', '')
        color = board_data.get('color', '#3B82F6')

        if not name:
            raise HTTPException(status_code=400, detail="Nome do quadro é obrigatório")

        conn = sqlite3.connect('voltcorp.db')
        cursor = conn.cursor()

        cursor.execute("""
                       INSERT INTO kanban_boards (name, description, color, created_by)
                       VALUES (?, ?, ?, ?)
                       """, (name, description, color, current_user['id']))

        board_id = cursor.lastrowid

        # Criar colunas padrão
        default_columns = [
            ('📋 To Do', 1, '#6B7280'),
            ('🔄 In Progress', 2, '#F59E0B'),
            ('✅ Done', 3, '#10B981')
        ]

        for col_name, position, col_color in default_columns:
            cursor.execute("""
                           INSERT INTO kanban_columns (board_id, name, position, color)
                           VALUES (?, ?, ?, ?)
                           """, (board_id, col_name, position, col_color))

        conn.commit()
        conn.close()

        # Broadcast via WebSocket
        board_update = {
            "type": "kanban_board_created",
            "board_id": board_id,
            "name": name,
            "created_by": current_user['full_name']
        }
        await manager.broadcast(json.dumps(board_update))

        return {"message": "Quadro criado com sucesso", "board_id": board_id}

    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


# Criar nova tarefa
@app.post("/kanban/tasks")
async def create_task(task_data: dict, current_user: dict = Depends(get_current_user)):
    try:
        title = task_data.get('title')
        description = task_data.get('description', '')
        board_id = task_data.get('board_id')
        column_id = task_data.get('column_id')
        priority = task_data.get('priority', 'medium')
        category = task_data.get('category', '')
        due_date = task_data.get('due_date')
        assigned_to = task_data.get('assigned_to')

        if not title or not board_id or not column_id:
            raise HTTPException(status_code=400, detail="Título, quadro e coluna são obrigatórios")

        conn = sqlite3.connect('voltcorp.db')
        cursor = conn.cursor()

        # Obter próxima posição
        cursor.execute("SELECT COALESCE(MAX(position), 0) + 1 FROM kanban_tasks WHERE column_id = ?", (column_id,))
        position = cursor.fetchone()[0]

        cursor.execute("""
                       INSERT INTO kanban_tasks (board_id, column_id, title, description, priority, category, due_date,
                                                 assigned_to, created_by, position)
                       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                       """, (board_id, column_id, title, description, priority, category, due_date, assigned_to,
                             current_user['id'], position))

        task_id = cursor.lastrowid
        conn.commit()
        conn.close()

        # Broadcast via WebSocket
        task_update = {
            "type": "kanban_task_created",
            "task_id": task_id,
            "board_id": board_id,
            "column_id": column_id,
            "title": title,
            "created_by": current_user['full_name']
        }
        await manager.broadcast(json.dumps(task_update))

        return {"message": "Tarefa criada com sucesso", "task_id": task_id}

    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


# Mover tarefa (drag & drop)
@app.put("/kanban/tasks/{task_id}/move")
async def move_task(task_id: int, move_data: dict, current_user: dict = Depends(get_current_user)):
    try:
        new_column_id = move_data.get('column_id')
        new_position = move_data.get('position')

        if not new_column_id or new_position is None:
            raise HTTPException(status_code=400, detail="Coluna e posição são obrigatórias")

        conn = sqlite3.connect('voltcorp.db')
        cursor = conn.cursor()

        # Atualizar tarefa
        cursor.execute("""
                       UPDATE kanban_tasks
                       SET column_id  = ?,
                           position   = ?,
                           updated_at = CURRENT_TIMESTAMP
                       WHERE id = ?
                       """, (new_column_id, new_position, task_id))

        conn.commit()
        conn.close()

        # Broadcast via WebSocket
        move_update = {
            "type": "kanban_task_moved",
            "task_id": task_id,
            "new_column_id": new_column_id,
            "new_position": new_position,
            "moved_by": current_user['full_name']
        }
        await manager.broadcast(json.dumps(move_update))

        return {"message": "Tarefa movida com sucesso"}

    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


# Atualizar tarefa
@app.put("/kanban/tasks/{task_id}")
async def update_task(task_id: int, task_data: dict, current_user: dict = Depends(get_current_user)):
    try:
        conn = sqlite3.connect('voltcorp.db')
        cursor = conn.cursor()

        # Construir query dinamicamente
        update_fields = []
        update_values = []

        for field in ['title', 'description', 'priority', 'category', 'due_date', 'assigned_to']:
            if field in task_data:
                update_fields.append(f"{field} = ?")
                update_values.append(task_data[field])

        if not update_fields:
            raise HTTPException(status_code=400, detail="Nenhum campo para atualizar")

        update_values.append(task_id)

        cursor.execute(f"""
            UPDATE kanban_tasks 
            SET {', '.join(update_fields)}, updated_at = CURRENT_TIMESTAMP
            WHERE id = ?
        """, update_values)

        conn.commit()
        conn.close()

        # Broadcast via WebSocket
        update_notification = {
            "type": "kanban_task_updated",
            "task_id": task_id,
            "updated_by": current_user['full_name']
        }
        await manager.broadcast(json.dumps(update_notification))

        return {"message": "Tarefa atualizada com sucesso"}

    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


# Deletar tarefa
@app.delete("/kanban/tasks/{task_id}")
async def delete_task(task_id: int, current_user: dict = Depends(get_current_user)):
    try:
        conn = sqlite3.connect('voltcorp.db')
        cursor = conn.cursor()

        cursor.execute("DELETE FROM kanban_tasks WHERE id = ?", (task_id,))

        if cursor.rowcount == 0:
            conn.close()
            raise HTTPException(status_code=404, detail="Tarefa não encontrada")

        conn.commit()
        conn.close()

        # Broadcast via WebSocket
        delete_notification = {
            "type": "kanban_task_deleted",
            "task_id": task_id,
            "deleted_by": current_user['full_name']
        }
        await manager.broadcast(json.dumps(delete_notification))

        return {"message": "Tarefa deletada com sucesso"}

    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

if __name__ == "__main__":
    init_database()
    create_default_users()
    create_default_kanban_data()  # Adicionar esta linha
    print("🚀 Iniciando Volt Corp Backend...")
    print("📡 WebSocket: ws://127.0.0.1:8001/messages/ws/{token}")
    print("🌐 API Docs: http://127.0.0.1:8001/docs")
    print("📋 Kanban: Quadros e tarefas disponíveis!")
    uvicorn.run(app, host="127.0.0.1", port=8001)
