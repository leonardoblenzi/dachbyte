"""
Sistema de Push Notifications
"""

import json
import asyncio
from typing import Dict, List, Optional, Any
from datetime import datetime, timedelta
from dataclasses import dataclass
import uuid

# Simulação de banco de dados para notificações
NOTIFICATIONS_DB = {}
USER_SUBSCRIPTIONS = {}


@dataclass
class Notification:
    id: str
    user_id: int
    title: str
    message: str
    type: str  # info, success, warning, error
    data: Optional[Dict[str, Any]] = None
    read: bool = False
    created_at: str = None
    expires_at: str = None

    def __post_init__(self):
        if self.created_at is None:
            self.created_at = datetime.now().isoformat()
        if self.expires_at is None:
            self.expires_at = (datetime.now() + timedelta(days=7)).isoformat()


class NotificationManager:
    def __init__(self):
        self.websocket_connections = {}  # user_id -> websocket

    def set_websocket_manager(self, manager):
        """Define o gerenciador de WebSocket"""
        self.websocket_manager = manager

    async def create_notification(
            self,
            user_id: int,
            title: str,
            message: str,
            notification_type: str = "info",
            data: Optional[Dict[str, Any]] = None,
            send_push: bool = True
    ) -> str:
        """Cria uma nova notificação"""

        notification_id = str(uuid.uuid4())

        notification = Notification(
            id=notification_id,
            user_id=user_id,
            title=title,
            message=message,
            type=notification_type,
            data=data or {}
        )

        # Salvar no "banco de dados"
        if user_id not in NOTIFICATIONS_DB:
            NOTIFICATIONS_DB[user_id] = []

        NOTIFICATIONS_DB[user_id].append(notification)

        # Enviar via WebSocket se o usuário estiver online
        if hasattr(self, 'websocket_manager'):
            await self._send_websocket_notification(user_id, notification)

        # Enviar push notification se solicitado
        if send_push:
            await self._send_push_notification(user_id, notification)

        return notification_id

    async def _send_websocket_notification(self, user_id: int, notification: Notification):
        """Envia notificação via WebSocket"""
        try:
            if hasattr(self, 'websocket_manager'):
                message = {
                    "type": "notification",
                    "notification": {
                        "id": notification.id,
                        "title": notification.title,
                        "message": notification.message,
                        "type": notification.type,
                        "data": notification.data,
                        "created_at": notification.created_at
                    }
                }

                await self.websocket_manager.send_personal_message(
                    json.dumps(message), user_id
                )
                print(f"📱 Notificação WebSocket enviada para usuário {user_id}")

        except Exception as e:
            print(f"❌ Erro ao enviar notificação WebSocket: {e}")

    async def _send_push_notification(self, user_id: int, notification: Notification):
        """Envia push notification"""
        try:
            # Verificar se o usuário tem subscription
            subscription = USER_SUBSCRIPTIONS.get(user_id)
            if not subscription:
                print(f"⚠️ Usuário {user_id} não tem subscription para push notifications")
                return

            # Simular envio de push notification
            # Em produção, usar serviços como Firebase, OneSignal, etc.
            print(f"🔔 Push notification enviada para usuário {user_id}: {notification.title}")

        except Exception as e:
            print(f"❌ Erro ao enviar push notification: {e}")

    def get_user_notifications(
            self,
            user_id: int,
            unread_only: bool = False,
            limit: int = 50
    ) -> List[Dict[str, Any]]:
        """Obtém notificações do usuário"""

        user_notifications = NOTIFICATIONS_DB.get(user_id, [])

        if unread_only:
            user_notifications = [n for n in user_notifications if not n.read]

        # Ordenar por data (mais recentes primeiro)
        user_notifications.sort(key=lambda x: x.created_at, reverse=True)

        # Limitar quantidade
        user_notifications = user_notifications[:limit]

        return [
            {
                "id": n.id,
                "title": n.title,
                "message": n.message,
                "type": n.type,
                "data": n.data,
                "read": n.read,
                "created_at": n.created_at,
                "expires_at": n.expires_at
            }
            for n in user_notifications
        ]

    def mark_as_read(self, user_id: int, notification_id: str) -> bool:
        """Marca notificação como lida"""

        user_notifications = NOTIFICATIONS_DB.get(user_id, [])

        for notification in user_notifications:
            if notification.id == notification_id:
                notification.read = True
                return True

        return False

    def mark_all_as_read(self, user_id: int) -> int:
        """Marca todas as notificações como lidas"""

        user_notifications = NOTIFICATIONS_DB.get(user_id, [])
        count = 0

        for notification in user_notifications:
            if not notification.read:
                notification.read = True
                count += 1

        return count

    def delete_notification(self, user_id: int, notification_id: str) -> bool:
        """Exclui uma notificação"""

        user_notifications = NOTIFICATIONS_DB.get(user_id, [])

        for i, notification in enumerate(user_notifications):
            if notification.id == notification_id:
                del user_notifications[i]
                return True

        return False

    def get_unread_count(self, user_id: int) -> int:
        """Obtém quantidade de notificações não lidas"""

        user_notifications = NOTIFICATIONS_DB.get(user_id, [])
        return len([n for n in user_notifications if not n.read])

    def subscribe_user(self, user_id: int, subscription_data: Dict[str, Any]):
        """Registra subscription do usuário para push notifications"""

        USER_SUBSCRIPTIONS[user_id] = {
            "endpoint": subscription_data.get("endpoint"),
            "keys": subscription_data.get("keys", {}),
            "created_at": datetime.now().isoformat()
        }

        print(f"✅ Usuário {user_id} inscrito para push notifications")

    def unsubscribe_user(self, user_id: int):
        """Remove subscription do usuário"""

        if user_id in USER_SUBSCRIPTIONS:
            del USER_SUBSCRIPTIONS[user_id]
            print(f"❌ Usuário {user_id} removido das push notifications")


# Instância global do gerenciador
notification_manager = NotificationManager()


# Funções de conveniência para diferentes tipos de notificação
async def notify_new_ticket(user_id: int, ticket_title: str, ticket_id: int):
    """Notificação de novo ticket"""
    await notification_manager.create_notification(
        user_id=user_id,
        title="🎫 Novo Ticket",
        message=f"Ticket criado: {ticket_title}",
        notification_type="info",
        data={"ticket_id": ticket_id, "action": "view_ticket"}
    )


async def notify_ticket_assigned(user_id: int, ticket_title: str, ticket_id: int):
    """Notificação de ticket atribuído"""
    await notification_manager.create_notification(
        user_id=user_id,
        title="🎯 Ticket Atribuído",
        message=f"Você foi designado para: {ticket_title}",
        notification_type="warning",
        data={"ticket_id": ticket_id, "action": "view_ticket"}
    )


async def notify_task_completed(user_id: int, task_name: str, task_id: int):
    """Notificação de task concluída"""
    await notification_manager.create_notification(
        user_id=user_id,
        title="✅ Task Concluída",
        message=f"Task finalizada: {task_name}",
        notification_type="success",
        data={"task_id": task_id, "action": "view_task"}
    )


async def notify_new_message(user_id: int, sender_name: str, message_preview: str):
    """Notificação de nova mensagem"""
    await notification_manager.create_notification(
        user_id=user_id,
        title="💬 Nova Mensagem",
        message=f"{sender_name}: {message_preview[:50]}...",
        notification_type="info",
        data={"action": "open_chat"}
    )


async def notify_system_update(user_id: int, update_info: str):
    """Notificação de atualização do sistema"""
    await notification_manager.create_notification(
        user_id=user_id,
        title="🔄 Atualização do Sistema",
        message=update_info,
        notification_type="info",
        data={"action": "view_changelog"}
    )