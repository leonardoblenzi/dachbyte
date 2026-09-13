"""
Configurações do Volt Corp
"""

import os
from pathlib import Path

# Configurações básicas
APP_NAME = "Volt Corp"
VERSION = "1.0.0"
DEBUG = os.getenv("DEBUG", "false").lower() == "true"

# Configurações de segurança
SECRET_KEY = os.getenv("SECRET_KEY", "voltcorp_secret_key_2025")
ALGORITHM = "HS256"
ACCESS_TOKEN_EXPIRE_HOURS = 24

# Configurações de upload
UPLOAD_DIR = Path("uploads")
MAX_FILE_SIZE = 10 * 1024 * 1024  # 10MB
MAX_FILES_PER_USER = 100
ALLOWED_EXTENSIONS = {
    'images': ['.jpg', '.jpeg', '.png', '.gif', '.bmp', '.webp'],
    'documents': ['.pdf', '.doc', '.docx', '.txt', '.rtf', '.odt'],
    'spreadsheets': ['.xls', '.xlsx', '.csv', '.ods'],
    'presentations': ['.ppt', '.pptx', '.odp'],
    'archives': ['.zip', '.rar', '.7z', '.tar', '.gz'],
    'audio': ['.mp3', '.wav', '.ogg', '.m4a'],
    'video': ['.mp4', '.avi', '.mkv', '.mov', '.wmv']
}

# Configurações de notificações
NOTIFICATION_EXPIRE_DAYS = 30
MAX_NOTIFICATIONS_PER_USER = 1000
ENABLE_PUSH_NOTIFICATIONS = True

# Configurações de WebSocket
WEBSOCKET_PING_INTERVAL = 30
WEBSOCKET_PING_TIMEOUT = 10

# Configurações de banco de dados
DATABASE_URL = os.getenv("DATABASE_URL", "postgresql://user:password@localhost/voltcorp")

# Configurações de email (para futuras implementações)
SMTP_SERVER = os.getenv("SMTP_SERVER", "smtp.gmail.com")
SMTP_PORT = int(os.getenv("SMTP_PORT", "587"))
SMTP_USERNAME = os.getenv("SMTP_USERNAME", "")
SMTP_PASSWORD = os.getenv("SMTP_PASSWORD", "")

# Configurações de logs
LOG_LEVEL = os.getenv("LOG_LEVEL", "INFO")
LOG_FILE = os.getenv("LOG_FILE", "voltcorp.log")

# Configurações de CORS
CORS_ORIGINS = [
    "http://localhost:3000",
    "http://localhost:3001",
    "http://127.0.0.1:3000",
    "http://127.0.0.1:3001",
]

print(f"✅ Configurações carregadas para {APP_NAME} v{VERSION}")
