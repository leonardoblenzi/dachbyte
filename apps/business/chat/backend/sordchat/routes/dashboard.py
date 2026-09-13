"""
Dashboard com estatísticas completas
"""

from fastapi import APIRouter, Depends, HTTPException, status, Query
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
from typing import Dict, Any, List
import psycopg2
from urllib.parse import urlparse
import os
from datetime import datetime, timedelta
from dotenv import load_dotenv

from ..utils.auth import verify_token
from ..utils.permissions import has_permission, Permission

load_dotenv()

router = APIRouter(prefix="/dashboard", tags=["Dashboard"])
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


@router.get("/overview")
async def get_dashboard_overview(
        current_user=Depends(get_current_user_from_token)
):
    """Visão geral do dashboard com todas as estatísticas"""

    conn = get_db_connection()
    cursor = conn.cursor()

    try:
        user_id = current_user.get("user_id")
        access_level = current_user.get("access_level")

        # Estatísticas básicas do sistema
        overview = {}

        # 1. Estatísticas de Usuários
        if has_permission(access_level, Permission.VIEW_ALL_USERS):
            cursor.execute("""
                           SELECT COUNT(*)                                                 as total_users,
                                  COUNT(CASE WHEN is_active = TRUE THEN 1 END)             as active_users,
                                  COUNT(CASE WHEN is_online = TRUE THEN 1 END)             as online_users,
                                  COUNT(CASE WHEN access_level = 'master' THEN 1 END)      as masters,
                                  COUNT(CASE WHEN access_level = 'coordenador' THEN 1 END) as coordinators,
                                  COUNT(CASE WHEN access_level = 'padrao' THEN 1 END)      as standard_users
                           FROM users
                           """)

            user_stats = cursor.fetchone()
            overview["users"] = {
                "total": user_stats[0],
                "active": user_stats[1],
                "online": user_stats[2],
                "masters": user_stats[3],
                "coordinators": user_stats[4],
                "standard": user_stats[5]
            }

        # 2. Estatísticas de Tickets
        ticket_filter = ""
        ticket_params = []

        if not has_permission(access_level, Permission.VIEW_ALL_TICKETS):
            ticket_filter = "WHERE (created_by_id = %s OR assigned_to_id = %s)"
            ticket_params = [user_id, user_id]

        cursor.execute(f"""
            SELECT 
                COUNT(*) as total_tickets,
                COUNT(CASE WHEN status = 'aberto' THEN 1 END) as open_tickets,
                COUNT(CASE WHEN status = 'encerrado' THEN 1 END) as closed_tickets,
                COUNT(CASE WHEN priority = 'urgente' THEN 1 END) as urgent_tickets,
                COUNT(CASE WHEN assigned_to_id = %s THEN 1 END) as my_tickets,
                COUNT(CASE WHEN created_at >= NOW() - INTERVAL '7 days' THEN 1 END) as recent_tickets
            FROM tickets
            {ticket_filter}
        """, ticket_params + [user_id])

        ticket_stats = cursor.fetchone()
        overview["tickets"] = {
            "total": ticket_stats[0],
            "open": ticket_stats[1],
            "closed": ticket_stats[2],
            "urgent": ticket_stats[3],
            "assigned_to_me": ticket_stats[4],
            "recent": ticket_stats[5]
        }

        # 3. Estatísticas de Tasks
        cursor.execute("""
                       SELECT COUNT(*)                                                               as total_tasks,
                              COUNT(CASE WHEN status = 'a_fazer' THEN 1 END)                         as todo_tasks,
                              COUNT(CASE WHEN status = 'em_progresso' THEN 1 END)                    as in_progress_tasks,
                              COUNT(CASE WHEN status = 'concluida' THEN 1 END)                       as completed_tasks,
                              COUNT(CASE WHEN urgency = 'urgente' THEN 1 END)                        as urgent_tasks,
                              COUNT(CASE WHEN assigned_to_id = %s THEN 1 END)                        as my_tasks,
                              COUNT(CASE WHEN due_date < NOW() AND status != 'concluida' THEN 1 END) as overdue_tasks
                       FROM tasks
                       WHERE (created_by_id = %s OR assigned_to_id = %s OR visibility = 'todos')
                       """, (user_id, user_id, user_id))

        task_stats = cursor.fetchone()
        overview["tasks"] = {
            "total": task_stats[0],
            "todo": task_stats[1],
            "in_progress": task_stats[2],
            "completed": task_stats[3],
            "urgent": task_stats[4],
            "assigned_to_me": task_stats[5],
            "overdue": task_stats[6]
        }

        # 4. Estatísticas de Mensagens
        cursor.execute("""
                       SELECT COUNT(*)                                                              as total_messages,
                              COUNT(CASE WHEN receiver_id = %s AND is_read = FALSE THEN 1 END)      as unread_messages,
                              COUNT(CASE WHEN sender_id = %s THEN 1 END)                            as sent_messages,
                              COUNT(CASE WHEN receiver_id = %s THEN 1 END)                          as received_messages,
                              COUNT(CASE WHEN created_at >= NOW() - INTERVAL '24 hours' THEN 1 END) as recent_messages
                       FROM messages
                       WHERE (sender_id = %s OR receiver_id = %s OR receiver_id IS NULL)
                       """, (user_id, user_id, user_id, user_id, user_id))

        message_stats = cursor.fetchone()
        overview["messages"] = {
            "total": message_stats[0],
            "unread": message_stats[1],
            "sent": message_stats[2],
            "received": message_stats[3],
            "recent": message_stats[4]
        }

        # 5. Atividade recente
        cursor.execute("""
            (SELECT 'ticket' as type, title as description, created_at as timestamp
             FROM tickets 
             WHERE created_by_id = %s OR assigned_to_id = %s
             ORDER BY created_at DESC LIMIT 5)
            UNION ALL
            (SELECT 'task' as type, name as description, created_at as timestamp
             FROM tasks 
             WHERE created_by_id = %s OR assigned_to_id = %s
             ORDER BY created_at DESC LIMIT 5)
            UNION ALL
            (SELECT 'message' as type, 
                    CASE WHEN LENGTH(content) > 50 
                         THEN SUBSTRING(content FROM 1 FOR 50) || '...'
                         ELSE content 
                    END as description, 
                    created_at as timestamp
             FROM messages 
             WHERE sender_id = %s
             ORDER BY created_at DESC LIMIT 5)
            ORDER BY timestamp DESC LIMIT 10
        """, (user_id, user_id, user_id, user_id, user_id))

        recent_activity = []
        for row in cursor.fetchall():
            recent_activity.append({
                "type": row[0],
                "description": row[1],
                "timestamp": row[2].isoformat()
            })

        overview["recent_activity"] = recent_activity

        return overview

    finally:
        cursor.close()
        conn.close()


@router.get("/charts/tickets-by-priority")
async def get_tickets_by_priority_chart(
        current_user=Depends(get_current_user_from_token)
):
    """Dados para gráfico de tickets por prioridade"""

    conn = get_db_connection()
    cursor = conn.cursor()

    try:
        user_id = current_user.get("user_id")
        access_level = current_user.get("access_level")

        ticket_filter = ""
        params = []

        if not has_permission(access_level, Permission.VIEW_ALL_TICKETS):
            ticket_filter = "WHERE (created_by_id = %s OR assigned_to_id = %s)"
            params = [user_id, user_id]

        cursor.execute(f"""
            SELECT priority, COUNT(*) as count
            FROM tickets
            {ticket_filter}
            GROUP BY priority
            ORDER BY 
                CASE priority 
                    WHEN 'urgente' THEN 1
                    WHEN 'alta' THEN 2
                    WHEN 'media' THEN 3
                    WHEN 'baixa' THEN 4
                END
        """, params)

        data = cursor.fetchall()

        return {
            "type": "pie",
            "title": {"text": "Tickets por Prioridade"},
            "series": [
                {"name": row[0].title(), "data": row[1]}
                for row in data
            ]
        }

    finally:
        cursor.close()
        conn.close()


@router.get("/charts/tasks-timeline")
async def get_tasks_timeline_chart(
        days: int = Query(30, ge=7, le=90),
        current_user=Depends(get_current_user_from_token)
):
    """Dados para gráfico de timeline de tasks"""

    conn = get_db_connection()
    cursor = conn.cursor()

    try:
        user_id = current_user.get("user_id")

        cursor.execute("""
                       SELECT
                           DATE (created_at) as date, COUNT (*) as created, COUNT (CASE WHEN status = 'concluida' THEN 1 END) as completed
                       FROM tasks
                       WHERE (created_by_id = %s
                          OR assigned_to_id = %s)
                         AND created_at >= NOW() - INTERVAL '%s days'
                       GROUP BY DATE (created_at)
                       ORDER BY date
                       """, (user_id, user_id, days))

        data = cursor.fetchall()

        categories = [row[0].strftime("%d/%m") for row in data]
        created_data = [row[1] for row in data]
        completed_data = [row[2] for row in data]

        return {
            "type": "line",
            "title": {"text": f"Timeline de Tasks - Últimos {days} dias"},
            "series": [
                {
                    "name": "Criadas",
                    "data": created_data,
                    "type": "line",
                    "marker": {"color": "#3B82F6"}
                },
                {
                    "name": "Concluídas",
                    "data": completed_data,
                    "type": "line",
                    "marker": {"color": "#10B981"}
                }
            ],
            "categories": categories
        }

    finally:
        cursor.close()
        conn.close()


@router.get("/charts/messages-activity")
async def get_messages_activity_chart(
        hours: int = Query(24, ge=6, le=168),
        current_user=Depends(get_current_user_from_token)
):
    """Dados para gráfico de atividade de mensagens"""

    conn = get_db_connection()
    cursor = conn.cursor()

    try:
        user_id = current_user.get("user_id")

        cursor.execute("""
                       SELECT EXTRACT(HOUR FROM created_at) as hour,
                COUNT(*) as message_count
                       FROM messages
                       WHERE (sender_id = %s
                          OR receiver_id = %s)
                         AND created_at >= NOW() - INTERVAL '%s hours'
                       GROUP BY EXTRACT (HOUR FROM created_at)
                       ORDER BY hour
                       """, (user_id, user_id, hours))

        data = cursor.fetchall()

        # Preencher todas as horas (0-23)
        hours_data = {int(row[0]): row[1] for row in data}
        categories = [f"{h:02d}:00" for h in range(24)]
        message_counts = [hours_data.get(h, 0) for h in range(24)]

        return {
            "type": "bar",
            "title": {"text": "Atividade de Mensagens por Hora"},
            "series": [
                {
                    "name": "Mensagens",
                    "data": message_counts,
                    "type": "bar",
                    "marker": {"color": "#8B5CF6"}
                }
            ],
            "categories": categories
        }

    finally:
        cursor.close()
        conn.close()


@router.get("/performance")
async def get_performance_metrics(
        current_user=Depends(get_current_user_from_token)
):
    """Métricas de performance do usuário"""

    conn = get_db_connection()
    cursor = conn.cursor()

    try:
        user_id = current_user.get("user_id")

        # Métricas de tickets
        cursor.execute("""
                       SELECT COUNT(*)                                                                  as total_tickets,
                              COUNT(CASE WHEN status = 'encerrado' THEN 1 END)                          as closed_tickets,
                              AVG(EXTRACT(EPOCH FROM (COALESCE(closed_at, NOW()) - created_at)) / 3600) as avg_resolution_hours
                       FROM tickets
                       WHERE assigned_to_id = %s
                       """, (user_id,))

        ticket_metrics = cursor.fetchone()

        # Métricas de tasks
        cursor.execute("""
                       SELECT COUNT(*)                                                                     as total_tasks,
                              COUNT(CASE WHEN status = 'concluida' THEN 1 END)                             as completed_tasks,
                              COUNT(CASE WHEN due_date < NOW() AND status != 'concluida' THEN 1 END)       as overdue_tasks,
                              AVG(EXTRACT(EPOCH FROM (COALESCE(completed_at, NOW()) - created_at)) /
                                  3600)                                                                    as avg_completion_hours
                       FROM tasks
                       WHERE assigned_to_id = %s
                       """, (user_id,))

        task_metrics = cursor.fetchone()

        # Calcular taxas de conclusão
        ticket_completion_rate = 0
        if ticket_metrics[0] > 0:
            ticket_completion_rate = (ticket_metrics[1] / ticket_metrics[0]) * 100

        task_completion_rate = 0
        if task_metrics[0] > 0:
            task_completion_rate = (task_metrics[1] / task_metrics[0]) * 100

        return {
            "tickets": {
                "total": ticket_metrics[0],
                "closed": ticket_metrics[1],
                "completion_rate": round(ticket_completion_rate, 1),
                "avg_resolution_hours": round(ticket_metrics[2] or 0, 1)
            },
            "tasks": {
                "total": task_metrics[0],
                "completed": task_metrics[1],
                "overdue": task_metrics[2],
                "completion_rate": round(task_completion_rate, 1),
                "avg_completion_hours": round(task_metrics[3] or 0, 1)
            }
        }

    finally:
        cursor.close()
        conn.close()