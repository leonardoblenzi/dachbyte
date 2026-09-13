"""
Sistema de upload e gerenciamento de arquivos
"""

import os
import uuid
import aiofiles
from pathlib import Path
from typing import List, Optional, Dict, Any
from fastapi import UploadFile, HTTPException
from PIL import Image
import magic
import hashlib
from datetime import datetime

# Configurações
UPLOAD_DIR = Path("uploads")
MAX_FILE_SIZE = 10 * 1024 * 1024  # 10MB
ALLOWED_EXTENSIONS = {
    'images': ['.jpg', '.jpeg', '.png', '.gif', '.bmp', '.webp'],
    'documents': ['.pdf', '.doc', '.docx', '.txt', '.rtf', '.odt'],
    'spreadsheets': ['.xls', '.xlsx', '.csv', '.ods'],
    'presentations': ['.ppt', '.pptx', '.odp'],
    'archives': ['.zip', '.rar', '.7z', '.tar', '.gz'],
    'audio': ['.mp3', '.wav', '.ogg', '.m4a'],
    'video': ['.mp4', '.avi', '.mkv', '.mov', '.wmv']
}


# Criar diretórios se não existirem
def create_upload_directories():
    """Cria diretórios de upload"""
    base_dir = UPLOAD_DIR
    subdirs = ['images', 'documents', 'temp', 'thumbnails', 'avatars']

    for subdir in subdirs:
        dir_path = base_dir / subdir
        dir_path.mkdir(parents=True, exist_ok=True)

    print("✅ Diretórios de upload criados")


def get_file_category(filename: str) -> str:
    """Determina a categoria do arquivo baseado na extensão"""
    ext = Path(filename).suffix.lower()

    for category, extensions in ALLOWED_EXTENSIONS.items():
        if ext in extensions:
            return category

    return 'other'


def validate_file(file: UploadFile) -> Dict[str, Any]:
    """Valida arquivo antes do upload"""
    errors = []
    warnings = []

    # Verificar tamanho
    if hasattr(file, 'size') and file.size > MAX_FILE_SIZE:
        errors.append(f"Arquivo muito grande. Máximo: {MAX_FILE_SIZE // (1024 * 1024)}MB")

    # Verificar extensão
    ext = Path(file.filename).suffix.lower()
    all_extensions = []
    for exts in ALLOWED_EXTENSIONS.values():
        all_extensions.extend(exts)

    if ext not in all_extensions:
        errors.append(f"Tipo de arquivo não permitido: {ext}")

    # Verificar nome do arquivo
    if not file.filename or len(file.filename) > 255:
        errors.append("Nome do arquivo inválido")

    category = get_file_category(file.filename)

    return {
        'valid': len(errors) == 0,
        'errors': errors,
        'warnings': warnings,
        'category': category,
        'extension': ext
    }


async def save_uploaded_file(file: UploadFile, user_id: int, category: str = None) -> Dict[str, Any]:
    """Salva arquivo no sistema"""

    # Validar arquivo
    validation = validate_file(file)
    if not validation['valid']:
        raise HTTPException(status_code=400, detail=validation['errors'])

    # Gerar nome único
    file_id = str(uuid.uuid4())
    original_name = file.filename
    ext = Path(original_name).suffix.lower()
    safe_filename = f"{file_id}{ext}"

    # Determinar categoria e diretório
    file_category = category or validation['category']
    upload_subdir = UPLOAD_DIR / file_category
    file_path = upload_subdir / safe_filename

    # Calcular hash do arquivo
    file_hash = hashlib.md5()
    file_size = 0

    try:
        # Salvar arquivo
        async with aiofiles.open(file_path, 'wb') as f:
            content = await file.read()
            file_size = len(content)
            file_hash.update(content)
            await f.write(content)

        # Criar thumbnail se for imagem
        thumbnail_path = None
        if file_category == 'images':
            thumbnail_path = await create_thumbnail(file_path, file_id)

        # Informações do arquivo
        file_info = {
            'id': file_id,
            'original_name': original_name,
            'filename': safe_filename,
            'category': file_category,
            'size': file_size,
            'hash': file_hash.hexdigest(),
            'path': str(file_path),
            'thumbnail_path': thumbnail_path,
            'uploaded_by': user_id,
            'uploaded_at': datetime.now().isoformat(),
            'mime_type': file.content_type or 'application/octet-stream'
        }

        return file_info

    except Exception as e:
        # Limpar arquivo se houver erro
        if file_path.exists():
            file_path.unlink()
        raise HTTPException(status_code=500, detail=f"Erro ao salvar arquivo: {str(e)}")


async def create_thumbnail(image_path: Path, file_id: str) -> Optional[str]:
    """Cria thumbnail para imagens"""
    try:
        thumbnail_dir = UPLOAD_DIR / 'thumbnails'
        thumbnail_path = thumbnail_dir / f"{file_id}_thumb.jpg"

        with Image.open(image_path) as img:
            # Converter para RGB se necessário
            if img.mode in ('RGBA', 'LA', 'P'):
                img = img.convert('RGB')

            # Criar thumbnail
            img.thumbnail((300, 300), Image.Resampling.LANCZOS)
            img.save(thumbnail_path, 'JPEG', quality=85)

        return str(thumbnail_path)

    except Exception as e:
        print(f"Erro ao criar thumbnail: {e}")
        return None


def get_file_info(file_id: str) -> Optional[Dict[str, Any]]:
    """Obtém informações de um arquivo"""
    # Em produção, isso viria do banco de dados
    # Por enquanto, vamos simular
    return None


def delete_file(file_id: str, user_id: int) -> bool:
    """Exclui arquivo do sistema"""
    try:
        # Encontrar arquivo (em produção, consultar banco)
        for category_dir in UPLOAD_DIR.iterdir():
            if category_dir.is_dir():
                for file_path in category_dir.glob(f"{file_id}.*"):
                    file_path.unlink()

                    # Remover thumbnail se existir
                    thumbnail_path = UPLOAD_DIR / 'thumbnails' / f"{file_id}_thumb.jpg"
                    if thumbnail_path.exists():
                        thumbnail_path.unlink()

                    return True
        return False

    except Exception as e:
        print(f"Erro ao excluir arquivo: {e}")
        return False


# Inicializar diretórios
create_upload_directories()