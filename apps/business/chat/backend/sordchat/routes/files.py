"""
Rotas para upload e gerenciamento de arquivos
"""

from fastapi import APIRouter, Depends, HTTPException, status, UploadFile, File, Form
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
from fastapi.responses import FileResponse, StreamingResponse
from typing import List, Optional
import os
import json
from pathlib import Path
import aiofiles

from ..utils.file_handler import (
    save_uploaded_file,
    delete_file,
    get_file_info,
    UPLOAD_DIR,
    validate_file
)

# Importar função de verificação de token
try:
    from ..utils.auth import verify_token
except ImportError:
    # Fallback para a versão completa
    import jwt

    SECRET_KEY = "voltcorp_secret_key_2025"
    ALGORITHM = "HS256"


    def verify_token(token: str):
        try:
            payload = jwt.decode(token, SECRET_KEY, algorithms=[ALGORITHM])
            return payload
        except jwt.PyJWTError:
            return None

router = APIRouter(prefix="/files", tags=["📁 Arquivos"])
security = HTTPBearer()


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


# Simulação de banco de dados para arquivos
FILES_DB = {}


@router.post("/upload")
async def upload_file(
        file: UploadFile = File(...),
        category: Optional[str] = Form(None),
        description: Optional[str] = Form(None),
        current_user=Depends(get_current_user_from_token)
):
    """📤 Upload de arquivo"""

    user_id = current_user.get("user_id")

    try:
        # Validar arquivo
        validation = validate_file(file)
        if not validation['valid']:
            return {
                "success": False,
                "errors": validation['errors']
            }

        # Salvar arquivo
        file_info = await save_uploaded_file(file, user_id, category)

        # Adicionar informações extras
        file_info.update({
            'description': description,
            'downloads': 0,
            'is_public': False
        })

        # Salvar no "banco de dados"
        FILES_DB[file_info['id']] = file_info

        return {
            "success": True,
            "message": "Arquivo enviado com sucesso!",
            "file": {
                "id": file_info['id'],
                "original_name": file_info['original_name'],
                "category": file_info['category'],
                "size": file_info['size'],
                "uploaded_at": file_info['uploaded_at'],
                "thumbnail_url": f"/files/{file_info['id']}/thumbnail" if file_info.get('thumbnail_path') else None
            }
        }

    except HTTPException as e:
        raise e
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Erro interno: {str(e)}")


@router.post("/upload-multiple")
async def upload_multiple_files(
        files: List[UploadFile] = File(...),
        category: Optional[str] = Form(None),
        current_user=Depends(get_current_user_from_token)
):
    """📤 Upload de múltiplos arquivos"""

    user_id = current_user.get("user_id")
    results = []

    for file in files:
        try:
            file_info = await save_uploaded_file(file, user_id, category)
            FILES_DB[file_info['id']] = file_info

            results.append({
                "success": True,
                "file": {
                    "id": file_info['id'],
                    "original_name": file_info['original_name'],
                    "size": file_info['size']
                }
            })

        except Exception as e:
            results.append({
                "success": False,
                "filename": file.filename,
                "error": str(e)
            })

    successful = len([r for r in results if r['success']])

    return {
        "message": f"{successful}/{len(files)} arquivos enviados com sucesso",
        "results": results
    }


@router.get("/")
async def list_files(
        category: Optional[str] = None,
        current_user=Depends(get_current_user_from_token)
):
    """📋 Lista arquivos do usuário"""

    user_id = current_user.get("user_id")
    user_files = []

    for file_info in FILES_DB.values():
        if file_info['uploaded_by'] == user_id:
            if not category or file_info['category'] == category:
                user_files.append({
                    "id": file_info['id'],
                    "original_name": file_info['original_name'],
                    "category": file_info['category'],
                    "size": file_info['size'],
                    "uploaded_at": file_info['uploaded_at'],
                    "downloads": file_info.get('downloads', 0),
                    "thumbnail_url": f"/files/{file_info['id']}/thumbnail" if file_info.get('thumbnail_path') else None
                })

    return {
        "files": user_files,
        "total": len(user_files),
        "categories": list(set(f['category'] for f in user_files))
    }


@router.get("/{file_id}")
async def download_file(
        file_id: str,
        current_user=Depends(get_current_user_from_token)
):
    """⬇️ Download de arquivo"""

    file_info = FILES_DB.get(file_id)
    if not file_info:
        raise HTTPException(status_code=404, detail="Arquivo não encontrado")

    file_path = Path(file_info['path'])
    if not file_path.exists():
        raise HTTPException(status_code=404, detail="Arquivo não encontrado no sistema")

    # Incrementar contador de downloads
    FILES_DB[file_id]['downloads'] = file_info.get('downloads', 0) + 1

    return FileResponse(
        path=file_path,
        filename=file_info['original_name'],
        media_type=file_info['mime_type']
    )


@router.get("/{file_id}/thumbnail")
async def get_thumbnail(file_id: str):
    """🖼️ Obtém thumbnail do arquivo"""

    file_info = FILES_DB.get(file_id)
    if not file_info or not file_info.get('thumbnail_path'):
        raise HTTPException(status_code=404, detail="Thumbnail não encontrado")

    thumbnail_path = Path(file_info['thumbnail_path'])
    if not thumbnail_path.exists():
        raise HTTPException(status_code=404, detail="Thumbnail não encontrado no sistema")

    return FileResponse(
        path=thumbnail_path,
        media_type="image/jpeg"
    )


@router.get("/{file_id}/info")
async def get_file_info_endpoint(
        file_id: str,
        current_user=Depends(get_current_user_from_token)
):
    """ℹ️ Informações detalhadas do arquivo"""

    file_info = FILES_DB.get(file_id)
    if not file_info:
        raise HTTPException(status_code=404, detail="Arquivo não encontrado")

    # Verificar se o usuário tem acesso
    user_id = current_user.get("user_id")
    if file_info['uploaded_by'] != user_id and not file_info.get('is_public', False):
        raise HTTPException(status_code=403, detail="Acesso negado")

    return {
        "id": file_info['id'],
        "original_name": file_info['original_name'],
        "category": file_info['category'],
        "size": file_info['size'],
        "hash": file_info['hash'],
        "mime_type": file_info['mime_type'],
        "uploaded_at": file_info['uploaded_at'],
        "downloads": file_info.get('downloads', 0),
        "description": file_info.get('description'),
        "is_public": file_info.get('is_public', False),
        "thumbnail_available": bool(file_info.get('thumbnail_path'))
    }


@router.delete("/{file_id}")
async def delete_file_endpoint(
        file_id: str,
        current_user=Depends(get_current_user_from_token)
):
    """🗑️ Excluir arquivo"""

    file_info = FILES_DB.get(file_id)
    if not file_info:
        raise HTTPException(status_code=404, detail="Arquivo não encontrado")

    user_id = current_user.get("user_id")

    # Verificar permissão
    if file_info['uploaded_by'] != user_id:
        # Verificar se é admin
        if current_user.get("access_level") != "master":
            raise HTTPException(status_code=403, detail="Sem permissão para excluir este arquivo")

    # Excluir arquivo físico
    success = delete_file(file_id, user_id)

    if success:
        # Remover do "banco de dados"
        del FILES_DB[file_id]
        return {"message": "Arquivo excluído com sucesso"}
    else:
        raise HTTPException(status_code=500, detail="Erro ao excluir arquivo")


@router.get("/stats/overview")
async def get_file_stats(current_user=Depends(get_current_user_from_token)):
    """📊 Estatísticas de arquivos"""

    user_id = current_user.get("user_id")
    user_files = [f for f in FILES_DB.values() if f['uploaded_by'] == user_id]

    # Calcular estatísticas
    total_size = sum(f['size'] for f in user_files)
    categories = {}

    for file_info in user_files:
        category = file_info['category']
        if category not in categories:
            categories[category] = {'count': 0, 'size': 0}
        categories[category]['count'] += 1
        categories[category]['size'] += file_info['size']

    return {
        "total_files": len(user_files),
        "total_size": total_size,
        "total_size_mb": round(total_size / (1024 * 1024), 2),
        "categories": categories,
        "recent_uploads": sorted(
            user_files,
            key=lambda x: x['uploaded_at'],
            reverse=True
        )[:5]
    }