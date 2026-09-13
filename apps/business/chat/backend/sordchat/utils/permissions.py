"""
Sistema de permissões por nível de acesso
"""

from enum import Enum
from typing import List, Optional
from fastapi import HTTPException, status


class UserLevel(Enum):
    """Níveis de acesso dos usuários"""
    PADRAO = "padrao"
    COORDENADOR = "coordenador"
    MASTER = "master"


class Permission:
    """Classe para definir permissões específicas"""

    # Permissões de usuários
    VIEW_ALL_USERS = "view_all_users"
    CREATE_USER = "create_user"
    EDIT_USER = "edit_user"
    DELETE_USER = "delete_user"

    # Permissões de tickets
    VIEW_OWN_TICKETS = "view_own_tickets"
    VIEW_ALL_TICKETS = "view_all_tickets"
    CREATE_TICKET = "create_ticket"
    EDIT_TICKET = "edit_ticket"
    TRANSFER_TICKET = "transfer_ticket"

    # Permissões de mensagens
    SEND_MESSAGE = "send_message"
    VIEW_OWN_MESSAGES = "view_own_messages"
    VIEW_ALL_MESSAGES = "view_all_messages"

    # Permissões de tasks
    VIEW_OWN_TASKS = "view_own_tasks"
    VIEW_DEPARTMENT_TASKS = "view_department_tasks"
    VIEW_ALL_TASKS = "view_all_tasks"
    CREATE_TASK = "create_task"
    EDIT_OWN_TASK = "edit_own_task"
    EDIT_DEPARTMENT_TASKS = "edit_department_tasks"
    EDIT_ALL_TASKS = "edit_all_tasks"

    # Permissões administrativas
    ADMIN_ACCESS = "admin_access"
    VIEW_SESSIONS = "view_sessions"
    MANAGE_SESSIONS = "manage_sessions"


# Mapeamento de permissões por nível
LEVEL_PERMISSIONS = {
    UserLevel.PADRAO: [
        Permission.VIEW_OWN_TICKETS,
        Permission.CREATE_TICKET,
        Permission.SEND_MESSAGE,
        Permission.VIEW_OWN_MESSAGES,
        Permission.VIEW_OWN_TASKS,
        Permission.CREATE_TASK,
        Permission.EDIT_OWN_TASK,
    ],

    UserLevel.COORDENADOR: [
        # Todas as permissões do usuário padrão
        Permission.VIEW_OWN_TICKETS,
        Permission.CREATE_TICKET,
        Permission.SEND_MESSAGE,
        Permission.VIEW_OWN_MESSAGES,
        Permission.VIEW_OWN_TASKS,
        Permission.CREATE_TASK,
        Permission.EDIT_OWN_TASK,

        # Permissões adicionais do coordenador. Tickets continuam privados:
        # coordenacao nao concede leitura automatica dos tickets de outras pessoas.
        Permission.EDIT_TICKET,
        Permission.TRANSFER_TICKET,
        Permission.VIEW_DEPARTMENT_TASKS,
        Permission.EDIT_DEPARTMENT_TASKS,
    ],

    UserLevel.MASTER: [
        # Todas as permissões possíveis
        Permission.VIEW_ALL_USERS,
        Permission.CREATE_USER,
        Permission.EDIT_USER,
        Permission.DELETE_USER,
        Permission.VIEW_OWN_TICKETS,
        Permission.VIEW_ALL_TICKETS,
        Permission.CREATE_TICKET,
        Permission.EDIT_TICKET,
        Permission.TRANSFER_TICKET,
        Permission.SEND_MESSAGE,
        Permission.VIEW_OWN_MESSAGES,
        Permission.VIEW_ALL_MESSAGES,
        Permission.VIEW_OWN_TASKS,
        Permission.VIEW_DEPARTMENT_TASKS,
        Permission.VIEW_ALL_TASKS,
        Permission.CREATE_TASK,
        Permission.EDIT_OWN_TASK,
        Permission.EDIT_DEPARTMENT_TASKS,
        Permission.EDIT_ALL_TASKS,
        Permission.ADMIN_ACCESS,
        Permission.VIEW_SESSIONS,
        Permission.MANAGE_SESSIONS,
    ]
}


def has_permission(user_level: str, required_permission: str) -> bool:
    """
    Verifica se um nível de usuário tem uma permissão específica
    """
    try:
        level_enum = UserLevel(user_level)
        user_permissions = LEVEL_PERMISSIONS.get(level_enum, [])
        return required_permission in user_permissions
    except ValueError:
        return False


def require_permission(user_level: str, required_permission: str):
    """
    Levanta exceção se o usuário não tiver a permissão necessária
    """
    if not has_permission(user_level, required_permission):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail=f"Permissão insuficiente. Necessário: {required_permission}"
        )


def get_user_permissions(user_level: str) -> List[str]:
    """
    Retorna todas as permissões de um nível de usuário
    """
    try:
        level_enum = UserLevel(user_level)
        return LEVEL_PERMISSIONS.get(level_enum, [])
    except ValueError:
        return []
