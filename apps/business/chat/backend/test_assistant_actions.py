import asyncio
import os
import hashlib
import io
import json
import shutil
import tempfile
import unittest
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock, patch


TEST_DATABASE_PATH = Path(tempfile.gettempdir()) / f"voltchat-assistant-{uuid.uuid4().hex}.db"
TEST_UPLOAD_DIR = Path(tempfile.mkdtemp(prefix="voltchat-uploads-"))
os.environ["DATABASE_URL"] = f"sqlite:///{TEST_DATABASE_PATH.as_posix()}"
os.environ["AUTO_SEED_USERS"] = "true"
os.environ["SECRET_KEY"] = "assistant-test-secret"
os.environ["UPLOAD_DIR"] = str(TEST_UPLOAD_DIR)

from fastapi.testclient import TestClient
from openpyxl import load_workbook
from starlette.websockets import WebSocketDisconnect

import sordchat_fixed as api


class AssistantActionsTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.client_context = TestClient(api.app)
        cls.client = cls.client_context.__enter__()
        with api.SessionLocal() as db:
            finance = (
                db.query(api.Department)
                .filter(api.Department.company_id == api.DEFAULT_COMPANY_ID, api.Department.name == "Financeiro")
                .one()
            )
            for username, full_name in [("ana", "Ana Souza"), ("carlos", "Carlos Lima")]:
                user = api.User(
                    username=username,
                    email=f"{username}@example.com",
                    full_name=full_name,
                    hashed_password=api.get_password_hash("test123"),
                    access_level="usuario",
                    department="Financeiro",
                    status=api.ACTIVE_STATUS,
                    is_active=True,
                )
                db.add(user)
                db.flush()
                db.add(
                    api.CompanyUser(
                        id=str(uuid.uuid4()),
                        company_id=api.DEFAULT_COMPANY_ID,
                        user_id=user.id,
                        department_id=finance.id,
                        role="user",
                        status=api.ACTIVE_STATUS,
                    )
                )
            company_admin = api.User(
                username="empresa_admin",
                email="empresa.admin@example.com",
                full_name="Administrador da Empresa",
                hashed_password=api.get_password_hash("empresa123"),
                access_level="usuario",
                department="Financeiro",
                status=api.ACTIVE_STATUS,
                is_active=True,
            )
            db.add(company_admin)
            db.flush()
            db.add(api.CompanyUser(
                id=str(uuid.uuid4()),
                company_id=api.DEFAULT_COMPANY_ID,
                user_id=company_admin.id,
                department_id=finance.id,
                role="company_admin",
                status=api.ACTIVE_STATUS,
            ))
            db.commit()
        cls.admin_headers = cls.login("admin", "VoltAdmin@172839")
        cls.user_headers = cls.login("usuario", "user123")
        cls.coordinator_headers = cls.login("coordenador", "coord123")
        cls.company_admin_headers = cls.login("empresa_admin", "empresa123")

    @classmethod
    def tearDownClass(cls):
        cls.client_context.__exit__(None, None, None)
        api.engine.dispose()
        TEST_DATABASE_PATH.unlink(missing_ok=True)
        shutil.rmtree(TEST_UPLOAD_DIR, ignore_errors=True)

    @classmethod
    def login(cls, username, password):
        response = cls.client.post("/auth/login", json={"username": username, "password": password})
        assert response.status_code == 200, response.text
        return {"Authorization": f"Bearer {response.json()['access_token']}"}

    def test_whatsapp_module_is_restricted_to_platform_admin(self):
        self.assertEqual(
            self.client.get("/whatsapp/overview", headers=self.user_headers).status_code,
            403,
        )
        self.assertEqual(
            self.client.get("/whatsapp/overview", headers=self.company_admin_headers).status_code,
            403,
        )
        with api.SessionLocal() as db:
            admin = db.query(api.User).filter(api.User.username == "admin").one()
            self.assertTrue(api.is_admin(admin))

    def test_expired_websocket_token_closes_cleanly_without_server_error(self):
        expired_token = api.create_access_token(
            {"sub": "1"}, expires_delta=timedelta(seconds=-1)
        )

        with self.client.websocket_connect(
            f"/messages/ws/{expired_token}"
        ) as websocket:
            with self.assertRaises(WebSocketDisconnect) as closed:
                websocket.receive_text()

        self.assertEqual(closed.exception.code, 1008)

    def test_chat_attention_opens_recipient_and_enforces_limits(self):
        with api.SessionLocal() as db:
            sender = db.query(api.User).filter(api.User.username == "ana").one()
            receiver = db.query(api.User).filter(api.User.username == "carlos").one()
            sender_id, receiver_id = sender.id, receiver.id
            db.query(api.ChatAttentionLimit).filter(
                api.ChatAttentionLimit.sender_id == sender_id,
                api.ChatAttentionLimit.receiver_id == receiver_id,
            ).delete(synchronize_session=False)
            db.commit()

        sender_token = api.create_access_token({"sub": str(sender_id)})
        receiver_token = api.create_access_token({"sub": str(receiver_id)})

        def receive_type(socket, expected_type, attempts=8):
            for _ in range(attempts):
                payload = socket.receive_json()
                if payload.get("type") == expected_type:
                    return payload
            self.fail(f"Evento {expected_type} nao recebido.")

        with self.client.websocket_connect(f"/messages/ws/{sender_token}") as sender_ws:
            with self.client.websocket_connect(f"/messages/ws/{receiver_token}") as receiver_ws:
                sender_ws.send_json({"type": "attention_request", "receiver_id": receiver_id})
                request = receive_type(receiver_ws, "attention_request")
                result = receive_type(sender_ws, "attention_result")
                self.assertEqual(request["from_user"]["id"], sender_id)
                self.assertTrue(result["success"])
                self.assertEqual(result["cooldown_seconds"], 300)

                sender_ws.send_json({"type": "attention_request", "receiver_id": receiver_id})
                cooldown = receive_type(sender_ws, "attention_result")
                self.assertFalse(cooldown["success"])
                self.assertEqual(cooldown["code"], "cooldown")
                self.assertGreater(cooldown["retry_after"], 0)

                with api.SessionLocal() as db:
                    limit = db.query(api.ChatAttentionLimit).filter(
                        api.ChatAttentionLimit.sender_id == sender_id,
                        api.ChatAttentionLimit.receiver_id == receiver_id,
                    ).one()
                    limit.daily_count = 10
                    limit.last_sent_at = datetime.utcnow() - timedelta(minutes=6)
                    limit.blocked_until = None
                    db.commit()

                sender_ws.send_json({"type": "attention_request", "receiver_id": receiver_id})
                blocked = receive_type(sender_ws, "attention_result")
                self.assertFalse(blocked["success"])
                self.assertEqual(blocked["code"], "blocked")
                self.assertEqual(
                    blocked["message"],
                    "Botao bloqueado por 24h por abuso de uso da funcao".replace(
                        "Botao", "Bot\u00e3o"
                    ).replace("funcao", "fun\u00e7\u00e3o"),
                )
                self.assertGreaterEqual(blocked["retry_after"], 24 * 60 * 60 - 1)

        with api.SessionLocal() as db:
            db.query(api.ChatAttentionLimit).filter(
                api.ChatAttentionLimit.sender_id == sender_id,
                api.ChatAttentionLimit.receiver_id == receiver_id,
            ).delete(synchronize_session=False)
            db.commit()
    def test_startup_migrations_skip_versions_already_applied(self):
        fake_conn = MagicMock()

        def execute(statement, parameters=None):
            if statement == "SELECT version FROM schema_migrations":
                return [("010_multi_tenant_platform",)]
            return []

        fake_conn.exec_driver_sql.side_effect = execute
        fake_transaction = MagicMock()
        fake_transaction.__enter__.return_value = fake_conn
        fake_engine = MagicMock()
        fake_engine.begin.return_value = fake_transaction

        with patch.object(api, "DATABASE_URL", "postgresql://migration-test"), patch.object(api, "engine", fake_engine):
            api.run_startup_migrations()

        executed_statements = [call.args[0] for call in fake_conn.exec_driver_sql.call_args_list]
        self.assertFalse(any("INSERT INTO companies (id, name, cnpj, responsible_name, status)" in sql for sql in executed_statements))
        self.assertTrue(any("pg_advisory_xact_lock" in sql for sql in executed_statements))
        self.assertTrue(
            any("ALTER TABLE tickets" in sql and "image_data TEXT" in sql for sql in executed_statements)
        )
        repair_statement = next(
            sql for sql in executed_statements
            if "ticket_daily_summary" in sql and "UPDATE messages" in sql
        )
        self.assertIn("POSITION(CHR(195) IN content) > 0", repair_statement)
        self.assertNotIn("LIKE '%'", repair_statement)
    def test_user_can_update_own_profile_with_compact_avatar(self):
        response = self.client.put(
            "/auth/profile",
            headers=self.user_headers,
            json={
                "email": "usuario.perfil@example.com",
                "phone_extension": "2042",
                "birthday": "21-04-90",
                "profile_photo": "data:image/webp;base64,AAAA",
            },
        )
        self.assertEqual(response.status_code, 200, response.text)
        profile = response.json()["user"]
        self.assertEqual(profile["phone_extension"], "2042")
        self.assertEqual(profile["birthday"], "21-04-90")
        self.assertTrue(profile["profile_photo"].startswith("data:image/webp;base64,"))
        invalid = self.client.put(
            "/auth/profile",
            headers=self.user_headers,
            json={"birthday": "04-21"},
        )
        self.assertEqual(invalid.status_code, 400, invalid.text)

    def test_inline_chat_message_limit_is_one_thousand_characters(self):
        self.assertEqual(api.INLINE_CHAT_MESSAGE_MAX_LENGTH, 1000)

    def test_meeting_reminder_scheduler_waits_until_the_next_due_milestone(self):
        now = datetime(2026, 8, 13, 12, 0, tzinfo=timezone.utc)
        starts_at = now + timedelta(days=2, hours=3)
        meeting = {
            "starts_at": starts_at,
            "ends_at": starts_at + timedelta(hours=1),
            "reminder_day_sent": False,
            "reminder_30m_sent": False,
            "start_alert_sent": False,
        }

        self.assertEqual(
            api.next_pending_meeting_reminder_at([meeting], now),
            starts_at - timedelta(days=1),
        )

        meeting.update({
            "reminder_day_sent": True,
            "reminder_30m_sent": True,
            "start_alert_sent": True,
        })
        self.assertIsNone(api.next_pending_meeting_reminder_at([meeting], now))

    def test_message_edit_accepts_one_thousand_characters_and_rejects_more(self):
        with api.SessionLocal() as db:
            user = db.query(api.User).filter(api.User.username == "usuario").one()
            company = db.query(api.Company).filter(api.Company.id == api.DEFAULT_COMPANY_ID).one()
            company.allow_user_message_editing = True
            message = api.Message(
                company_id=api.DEFAULT_COMPANY_ID,
                content="Mensagem editavel",
                sender_id=user.id,
                receiver_id=None,
                timestamp=datetime.utcnow(),
            )
            db.add(message)
            db.commit()
            message_id = message.id

        accepted = self.client.patch(
            f"/messages/{message_id}",
            headers=self.user_headers,
            json={"content": "a" * 1000},
        )
        self.assertEqual(accepted.status_code, 200, accepted.text)
        self.assertEqual(accepted.json()["content"], "a" * 1000)

        rejected = self.client.patch(
            f"/messages/{message_id}",
            headers=self.user_headers,
            json={"content": "b" * 1001},
        )
        self.assertEqual(rejected.status_code, 400, rejected.text)
        self.assertIn("1000 caracteres", rejected.json()["detail"])


    def test_admins_can_edit_and_safely_delete_user(self):
        username = "managed_" + uuid.uuid4().hex[:8]
        created = self.client.post("/users/", headers=self.company_admin_headers, json={
            "company_id": api.DEFAULT_COMPANY_ID,
            "full_name": "Usuario Gerenciado",
            "username": username,
            "email": username + "@example.com",
            "password": "SenhaInicial123",
            "department": "Financeiro",
            "role": "user",
        })
        self.assertEqual(created.status_code, 200, created.text)
        user_id = created.json()["id"]

        master_edit = self.client.put("/users/" + str(user_id), headers=self.admin_headers, json={
            "company_id": api.DEFAULT_COMPANY_ID,
            "nickname": "Gerenciado",
        })
        self.assertEqual(master_edit.status_code, 200, master_edit.text)

        company_edit = self.client.put("/users/" + str(user_id), headers=self.company_admin_headers, json={
            "company_id": api.DEFAULT_COMPANY_ID,
            "full_name": "Usuario Editado",
            "email": "editado." + username + "@example.com",
            "phone_extension": "9090",
            "birthday": "24/09/2003",
            "password": "NovaSenha123",
        })
        self.assertEqual(company_edit.status_code, 200, company_edit.text)
        self.assertEqual(company_edit.json()["full_name"], "Usuario Editado")
        self.assertTrue(company_edit.json()["must_change_password"])

        deleted = self.client.delete(
            "/users/" + str(user_id) + "?company_id=" + api.DEFAULT_COMPANY_ID,
            headers=self.company_admin_headers,
        )
        self.assertEqual(deleted.status_code, 200, deleted.text)
        self.assertTrue(deleted.json()["account_deactivated"])
        with api.SessionLocal() as db:
            user = db.query(api.User).filter(api.User.id == user_id).one()
            membership = db.query(api.CompanyUser).filter(
                api.CompanyUser.user_id == user_id,
                api.CompanyUser.company_id == api.DEFAULT_COMPANY_ID,
            ).one()
            self.assertFalse(user.is_active)
            self.assertEqual(membership.status, api.INACTIVE_STATUS)
            audit = db.query(api.AuditLog).filter(
                api.AuditLog.action == "usuario_excluido",
                api.AuditLog.entity_id == str(user_id),
            ).one()
            self.assertTrue(audit.metadata_json["history_preserved"])
    def test_chat_contacts_are_available_to_regular_users(self):
        response = self.client.get("/chat/contacts", headers=self.user_headers)
        self.assertEqual(response.status_code, 200, response.text)
        usernames = {item["username"] for item in response.json()}
        self.assertIn("admin", usernames)
        self.assertNotIn("usuario", usernames)

    def test_master_admin_can_select_company_chat_contacts(self):
        company_id = str(uuid.uuid4())
        department_id = str(uuid.uuid4())
        username = f"tenant_contact_{uuid.uuid4().hex[:8]}"
        with api.SessionLocal() as db:
            db.add(api.Company(
                id=company_id,
                name="Empresa de Contato",
                tenant_global_id=f"tenant-{company_id}",
                status=api.ACTIVE_STATUS,
            ))
            db.add(api.Department(
                id=department_id,
                company_id=company_id,
                name="Atendimento",
                status=api.ACTIVE_STATUS,
            ))
            contact = api.User(
                username=username,
                email=f"{username}@example.com",
                full_name="Contato do Tenant",
                hashed_password=api.get_password_hash("test123"),
                access_level="usuario",
                department="Atendimento",
                status=api.ACTIVE_STATUS,
                is_active=True,
            )
            db.add(contact)
            db.flush()
            db.add(api.CompanyUser(
                id=str(uuid.uuid4()),
                company_id=company_id,
                user_id=contact.id,
                department_id=department_id,
                role="user",
                status=api.ACTIVE_STATUS,
            ))
            db.commit()

        response = self.client.get(
            f"/chat/contacts?company_id={company_id}",
            headers=self.admin_headers,
        )
        self.assertEqual(response.status_code, 200, response.text)
        usernames = {item["username"] for item in response.json()}
        self.assertEqual(usernames, {username})

    def test_message_reply_and_reaction_are_persisted(self):
        with api.SessionLocal() as db:
            admin = db.query(api.User).filter(api.User.username == "admin").one()
            user = db.query(api.User).filter(api.User.username == "usuario").one()
            parent = api.Message(
                company_id=api.DEFAULT_COMPANY_ID,
                content="Mensagem original para resposta",
                sender_id=admin.id,
                receiver_id=user.id,
            )
            db.add(parent)
            db.flush()
            reply = api.Message(
                company_id=api.DEFAULT_COMPANY_ID,
                content="Resposta vinculada",
                sender_id=user.id,
                receiver_id=admin.id,
                reply_to_id=parent.id,
            )
            db.add(reply)
            db.commit()
            reply_id = reply.id

            serialized = api.serialize_message(reply, db)
            self.assertEqual(serialized["reply_to"]["id"], parent.id)
            self.assertEqual(serialized["reply_to"]["content"], parent.content)
            self.assertEqual(serialized["reactions"], [])

        added = self.client.post(
            f"/messages/{reply_id}/reactions",
            headers=self.admin_headers,
            json={"emoji": "👍"},
        )
        self.assertEqual(added.status_code, 200, added.text)
        self.assertEqual(added.json()["action"], "added")
        self.assertEqual(added.json()["reactions"][0]["emoji"], "👍")
        self.assertEqual(added.json()["reactions"][0]["count"], 1)

        removed = self.client.post(
            f"/messages/{reply_id}/reactions",
            headers=self.admin_headers,
            json={"emoji": "👍"},
        )
        self.assertEqual(removed.status_code, 200, removed.text)
        self.assertEqual(removed.json()["action"], "removed")
        self.assertEqual(removed.json()["reactions"], [])

    def test_mark_messages_read_notifies_sender_after_database_session_closes(self):
        with api.SessionLocal() as db:
            sender = db.query(api.User).filter(api.User.username == "admin").one()
            receiver = db.query(api.User).filter(api.User.username == "usuario").one()
            sender_id = sender.id
            db.query(api.Message).filter(
                api.Message.company_id == api.DEFAULT_COMPANY_ID,
                api.Message.sender_id == sender_id,
                api.Message.receiver_id == receiver.id,
            ).update({"is_read": True}, synchronize_session=False)
            message = api.Message(
                company_id=api.DEFAULT_COMPANY_ID,
                content="Mensagem para confirmar leitura",
                sender_id=sender_id,
                receiver_id=receiver.id,
                is_read=False,
            )
            db.add(message)
            db.commit()
            message_id = message.id

        with patch.object(api.manager, "send_personal_message", new=AsyncMock()) as notify:
            response = self.client.post(
                "/messages/read",
                headers=self.user_headers,
                json={"sender_id": sender_id},
            )

        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json()["message_ids"], [message_id])
        notify.assert_awaited_once()
        event = json.loads(notify.await_args.args[0])
        self.assertEqual(event, {"type": "message_read", "message_ids": [message_id]})
        self.assertEqual(notify.await_args.args[1], sender_id)
        with api.SessionLocal() as db:
            self.assertTrue(db.get(api.Message, message_id).is_read)

    def test_company_admin_internal_control_selects_user_and_reads_conversations(self):
        with api.SessionLocal() as db:
            ana = db.query(api.User).filter(api.User.username == "ana").one()
            carlos = db.query(api.User).filter(api.User.username == "carlos").one()
            message = api.Message(
                company_id=api.DEFAULT_COMPANY_ID,
                content="Conversa para controle interno",
                sender_id=ana.id,
                receiver_id=carlos.id,
            )
            db.add(message)
            db.commit()
            ana_id = ana.id
            carlos_id = carlos.id

        coordinator_overview = self.client.get("/coordinator/overview", headers=self.coordinator_headers)
        self.assertEqual(coordinator_overview.status_code, 200, coordinator_overview.text)
        self.assertFalse(coordinator_overview.json()["can_view_messages"])
        self.assertEqual(coordinator_overview.json()["messages"], [])

        denied = self.client.get(
            f"/company-admin/internal-control/users/{ana_id}/conversations",
            headers=self.coordinator_headers,
        )
        self.assertEqual(denied.status_code, 403, denied.text)

        conversations = self.client.get(
            f"/company-admin/internal-control/users/{ana_id}/conversations",
            headers=self.company_admin_headers,
        )
        self.assertEqual(conversations.status_code, 200, conversations.text)
        payload = conversations.json()
        self.assertEqual(payload["user"]["id"], ana_id)
        direct = next(item for item in payload["conversations"] if item["key"] == f"direct:{carlos_id}")
        self.assertEqual(direct["last_message"]["content"], "Conversa para controle interno")

        messages = self.client.get(
            f"/company-admin/internal-control/users/{ana_id}/messages?kind=direct&conversation_id={carlos_id}",
            headers=self.company_admin_headers,
        )
        self.assertEqual(messages.status_code, 200, messages.text)
        self.assertTrue(messages.json()["read_only"])
        self.assertEqual(messages.json()["messages"][-1]["content"], "Conversa para controle interno")

        with api.SessionLocal() as db:
            audit_actions = {
                row.action
                for row in db.query(api.AuditLog).filter(
                    api.AuditLog.actor_user_id == db.query(api.User.id).filter(api.User.username == "empresa_admin").scalar(),
                    api.AuditLog.entity_id == str(ana_id),
                ).all()
            }
        self.assertIn("controle_interno_usuario_acessado", audit_actions)
        self.assertIn("controle_interno_conversa_visualizada", audit_actions)

    def test_general_chat_is_disabled_for_all_clients(self):
        denied = self.client.put(
            "/chat/settings",
            headers=self.coordinator_headers,
            json={"general_chat_name": "Nome indevido"},
        )
        self.assertEqual(denied.status_code, 403, denied.text)

        disabled = self.client.put(
            "/chat/settings",
            headers=self.company_admin_headers,
            json={"general_chat_name": "Comunicacao Interna"},
        )
        self.assertEqual(disabled.status_code, 410, disabled.text)

        settings = self.client.get("/chat/settings", headers=self.coordinator_headers)
        self.assertEqual(settings.status_code, 200, settings.text)
        self.assertFalse(settings.json()["general_chat_enabled"])
        self.assertNotIn("general_chat_name", settings.json())

    def test_only_coordinator_or_admin_can_create_groups(self):
        denied = self.client.post(
            "/groups/",
            headers=self.user_headers,
            json={"name": "Grupo indevido", "department": "TI"},
        )
        self.assertEqual(denied.status_code, 403, denied.text)

        allowed = self.client.post(
            "/groups/",
            headers=self.coordinator_headers,
            json={"name": "Grupo Coordenacao", "department": "TI"},
        )
        self.assertEqual(allowed.status_code, 200, allowed.text)

    def test_group_is_visible_to_members_and_can_be_deleted_by_coordinator(self):
        with api.SessionLocal() as db:
            user_id = db.query(api.User).filter(api.User.username == "usuario").one().id

        created = self.client.post(
            "/groups/",
            headers=self.coordinator_headers,
            json={"name": "Grupo dos Participantes", "department": "TI", "member_ids": [user_id]},
        )
        self.assertEqual(created.status_code, 200, created.text)
        group = created.json()
        self.assertIn(user_id, group["member_ids"])
        self.assertTrue(any(member["id"] == user_id for member in group["members"]))

        member_groups = self.client.get("/groups/", headers=self.user_headers)
        self.assertEqual(member_groups.status_code, 200, member_groups.text)
        self.assertTrue(any(item["id"] == group["id"] for item in member_groups.json()))

        denied = self.client.delete(f"/groups/{group['id']}", headers=self.user_headers)
        self.assertEqual(denied.status_code, 403, denied.text)

        deleted = self.client.delete(f"/groups/{group['id']}", headers=self.coordinator_headers)
        self.assertEqual(deleted.status_code, 200, deleted.text)
        member_groups = self.client.get("/groups/", headers=self.user_headers)
        self.assertFalse(any(item["id"] == group["id"] for item in member_groups.json()))


    def test_archives_expired_history_with_database_datetime(self):
        with api.SessionLocal() as db:
            admin = db.query(api.User).filter(api.User.username == "admin").one()
            user = db.query(api.User).filter(api.User.username == "usuario").one()
            message = api.Message(
                company_id=api.DEFAULT_COMPANY_ID,
                content="mensagem antiga para teste de arquivamento",
                sender_id=admin.id,
                receiver_id=user.id,
                timestamp=datetime.now(timezone.utc) - timedelta(days=31),
            )
            db.add(message)
            db.commit()
            message_id = message.id
            user_id = user.id

        api.archive_due_chat_history()

        with api.SessionLocal() as db:
            self.assertIsNone(db.get(api.Message, message_id))
            backup = (
                db.query(api.ChatHistoryBackup)
                .filter(api.ChatHistoryBackup.company_id == api.DEFAULT_COMPANY_ID)
                .order_by(api.ChatHistoryBackup.id.desc())
                .first()
            )
            self.assertIsNotNone(backup)
            self.assertEqual(backup.message_count, 1)
            self.assertEqual(backup.format_version, 2)
            self.assertEqual(len(backup.checksum_sha256), 64)
            backup_count = db.query(api.ChatHistoryBackup).count()
            backup_id = backup.id

        listed = self.client.get(
            f"/platform/chat-backups?company_id={api.DEFAULT_COMPANY_ID}&user_id={user_id}",
            headers=self.admin_headers,
        )
        self.assertEqual(listed.status_code, 200, listed.text)
        selected = next(item for item in listed.json()["backups"] if item["id"] == backup_id)
        self.assertEqual(selected["relevant_message_count"], 1)
        self.assertEqual(selected["integrity"], "verified")

        restored = self.client.post(
            f"/platform/chat-backups/{backup_id}/restore",
            headers=self.admin_headers,
            json={"company_id": api.DEFAULT_COMPANY_ID, "user_id": user_id},
        )
        self.assertEqual(restored.status_code, 200, restored.text)
        self.assertEqual(restored.json()["restored"], 1)

        repeated = self.client.post(
            f"/platform/chat-backups/{backup_id}/restore",
            headers=self.admin_headers,
            json={"company_id": api.DEFAULT_COMPANY_ID, "user_id": user_id},
        )
        self.assertEqual(repeated.status_code, 200, repeated.text)
        self.assertEqual(repeated.json()["restored"], 0)
        self.assertEqual(repeated.json()["skipped"], 1)

        api.archive_due_chat_history()

        with api.SessionLocal() as db:
            self.assertEqual(db.query(api.ChatHistoryBackup).count(), backup_count)

    def test_virtual_assistants_route_actions_and_use_preferred_name(self):
        updated = self.client.put(
            "/assistant/preferences",
            headers=self.user_headers,
            json={"address_name": "Rapha"},
        )
        self.assertEqual(updated.status_code, 200, updated.text)
        self.assertEqual(updated.json()["address_name"], "Rapha")
        self.assertTrue(updated.json()["configured"])

        ticket = self.client.post(
            "/assistant/requests",
            headers=self.user_headers,
            json={"message": "Abra um ticekt para TI sobre acesso bloqueado", "execute": False},
        )
        self.assertEqual(ticket.status_code, 200, ticket.text)
        self.assertEqual(ticket.json()["assistant_name"], api.BOLT_NAME)
        self.assertIn("Rapha", ticket.json()["reply"])

        task = self.client.post(
            "/assistant/requests",
            headers=self.user_headers,
            json={"message": "Crie uma tarefa para revisar meu cadastro", "execute": False},
        )
        self.assertEqual(task.status_code, 200, task.text)
        self.assertEqual(task.json()["assistant_name"], api.MITTY_NAME)
        self.assertIn("Rapha", task.json()["reply"])

        restored = self.client.put(
            "/assistant/preferences",
            headers=self.user_headers,
            json={"address_name": ""},
        )
        self.assertEqual(restored.status_code, 200, restored.text)
        self.assertFalse(restored.json()["configured"])

    def test_personal_sticker_lifecycle_and_message_serialization(self):
        fake_webp = b"RIFF" + (16).to_bytes(4, "little") + b"WEBPVP8 " + b"sticker"
        image_data = "data:image/webp;base64," + api.base64.b64encode(fake_webp).decode("ascii")
        created = self.client.post(
            "/stickers",
            headers=self.user_headers,
            json={"name": "Minha reacao", "image_data": image_data},
        )
        self.assertEqual(created.status_code, 200, created.text)
        sticker = created.json()
        self.assertEqual(sticker["source"], f"sticker:{sticker['id']}")

        listed = self.client.get("/stickers", headers=self.user_headers)
        self.assertEqual(listed.status_code, 200, listed.text)
        self.assertTrue(any(item["id"] == sticker["id"] for item in listed.json()))

        renamed = self.client.put(
            f"/stickers/{sticker['id']}",
            headers=self.user_headers,
            json={"name": "Reacao editada"},
        )
        self.assertEqual(renamed.status_code, 200, renamed.text)
        self.assertEqual(renamed.json()["name"], "Reacao editada")

        with api.SessionLocal() as db:
            sender = db.query(api.User).filter(api.User.username == "usuario").one()
            receiver = db.query(api.User).filter(api.User.username == "ana").one()
            message = api.Message(
                company_id=api.DEFAULT_COMPANY_ID,
                content="Reacao editada",
                sender_id=sender.id,
                receiver_id=receiver.id,
                message_type="sticker",
                file_path=f"sticker:{sticker['id']}",
            )
            db.add(message)
            db.commit()
            db.refresh(message)
            serialized = api.serialize_message(message, db)
            self.assertEqual(serialized["sticker_id"], sticker["id"])
            self.assertEqual(serialized["sticker_name"], "Reacao editada")
            message_id = message.id

        ana_headers = self.login("ana", "test123")
        favorite = self.client.post(
            "/stickers/favorite",
            headers=ana_headers,
            json={"message_id": message_id},
        )
        self.assertEqual(favorite.status_code, 200, favorite.text)
        self.assertTrue(favorite.json()["favorited"])
        self.assertEqual(favorite.json()["source_reference"], f"sticker:{sticker['id']}")
        repeated_favorite = self.client.post(
            "/stickers/favorite", headers=ana_headers, json={"message_id": message_id}
        )
        self.assertEqual(repeated_favorite.status_code, 200, repeated_favorite.text)
        self.assertTrue(repeated_favorite.json()["already_saved"])
        ana_stickers = self.client.get("/stickers", headers=ana_headers)
        self.assertEqual(
            sum(item.get("source_reference") == f"sticker:{sticker['id']}" for item in ana_stickers.json()),
            1,
        )

        removed = self.client.delete(f"/stickers/{sticker['id']}", headers=self.user_headers)
        self.assertEqual(removed.status_code, 200, removed.text)
        image = self.client.get(f"/stickers/{sticker['id']}/image", headers=self.user_headers)
        self.assertEqual(image.status_code, 200, image.text)
        self.assertEqual(image.content, fake_webp)

    def test_sticker_creation_policy_is_enforced_per_company(self):
        disabled = self.client.patch(
            "/company-admin/settings",
            headers=self.company_admin_headers,
            json={"allow_user_sticker_creation": False},
        )
        self.assertEqual(disabled.status_code, 200, disabled.text)
        self.assertFalse(disabled.json()["allow_user_sticker_creation"])

        user_config = self.client.get("/stickers/config", headers=self.user_headers)
        self.assertEqual(user_config.status_code, 200, user_config.text)
        self.assertFalse(user_config.json()["allow_user_creation"])
        self.assertFalse(user_config.json()["can_create"])

        fake_webp = b"RIFF" + (16).to_bytes(4, "little") + b"WEBPVP8 " + b"sticker"
        image_data = "data:image/webp;base64," + api.base64.b64encode(fake_webp).decode("ascii")
        blocked = self.client.post(
            "/stickers",
            headers=self.user_headers,
            json={"name": "Bloqueada", "image_data": image_data},
        )
        self.assertEqual(blocked.status_code, 403, blocked.text)
        self.assertEqual(self.client.get("/stickers", headers=self.user_headers).json(), [])

        admin_config = self.client.get("/stickers/config", headers=self.company_admin_headers)
        self.assertTrue(admin_config.json()["can_create"])
        admin_sticker = self.client.post(
            "/stickers",
            headers=self.company_admin_headers,
            json={"name": "Figurinha do admin", "image_data": image_data},
        )
        self.assertEqual(admin_sticker.status_code, 200, admin_sticker.text)

        restored = self.client.patch(
            "/company-admin/settings",
            headers=self.company_admin_headers,
            json={"allow_user_sticker_creation": True},
        )
        self.assertEqual(restored.status_code, 200, restored.text)
        self.assertTrue(restored.json()["allow_user_sticker_creation"])

    def test_mitty_does_not_treat_an_agenda_invitation_as_a_summary(self):
        command = "Mitty reuniao com o escritorio hoje sobre VoltChat as 16h incluir o Leo na agenda"
        self.assertFalse(api.is_mitty_summary_request(command))

    def test_mitty_resolves_a_unique_short_participant_name(self):
        leonardo = type("UserRef", (), {
            "id": 7, "email": "leonardo@example.com", "username": "leonardo",
            "full_name": "Leonardo Lenzi", "nickname": "",
        })()
        wellington = type("UserRef", (), {
            "id": 8, "email": "wellington@example.com", "username": "wellington",
            "full_name": "Wellington Biruel", "nickname": "",
        })()

        resolved = api.infer_assignees("inclua o Leo na agenda", [leonardo, wellington])
        self.assertEqual([user.id for user in resolved], [7])
    def test_mitty_keeps_meeting_subject_and_recognizes_short_internal_name(self):
        leonardo = type("UserRef", (), {
            "id": 7, "email": "leonardo@example.com", "username": "leonardo",
            "full_name": "Leonardo Lenzi", "nickname": "",
        })()
        command = "reuni\u00e3o hoje apresentar voltchat para o escrit\u00f3rio com o leo \u00e0s 16h"
        assignees = api.infer_assignees(command, [leonardo])
        subject = api.extract_assistant_subject(command, "meeting")
        subject = api.remove_meeting_assignees(subject, assignees)

        self.assertEqual([user.id for user in assignees], [7])
        self.assertIsNone(api.extract_external_meeting_counterpart(command, assignees))
        self.assertEqual(subject, "apresentar voltchat para o escrit\u00f3rio")
    def test_mitty_accepts_flexible_time_formats(self):
        future = (datetime.now(api.BOLT_DAILY_SUMMARY_TIMEZONE) + timedelta(days=90)).strftime("%d/%m/%Y")
        cases = {
            "as 14h": (14, 0),
            "as 14h30": (14, 30),
            "as 14:30": (14, 30),
            "as 1430": (14, 30),
            "as 9h": (9, 0),
            "as 930": (9, 30),
            "as 14 30": (14, 30),
            "as 14 horas e 30 minutos": (14, 30),
        }
        for time_text, expected in cases.items():
            with self.subTest(time_text=time_text):
                starts_at, _ = api.infer_assistant_schedule(f"reuniao em {future} {time_text}")
                local = starts_at.astimezone(api.BOLT_DAILY_SUMMARY_TIMEZONE)
                self.assertEqual((local.hour, local.minute), expected)

    def test_mitty_separates_agenda_title_date_time_and_participants(self):
        future_date = (datetime.now(api.BOLT_DAILY_SUMMARY_TIMEZONE) + timedelta(days=90)).strftime("%d/%m/%Y")
        command = f"Mitty marque uma reuniao ECF Shopee dia {future_date} as 11h com o Leonardo e o Wellington com o link https://meet.google.com/fpj-eeac-rir"
        with api.SessionLocal() as db:
            finance = db.query(api.Department).filter(
                api.Department.company_id == api.DEFAULT_COMPANY_ID,
                api.Department.name == "Financeiro",
            ).one()
            for username, full_name in [("leonardo", "Leonardo Lenzi"), ("wellington", "Wellington Biruel")]:
                if db.query(api.User).filter(api.User.username == username).first():
                    continue
                participant = api.User(
                    username=username,
                    email=f"{username}@example.com",
                    full_name=full_name,
                    hashed_password=api.get_password_hash("test123"),
                    access_level="usuario",
                    department="Financeiro",
                    status=api.ACTIVE_STATUS,
                    is_active=True,
                )
                db.add(participant)
                db.flush()
                db.add(api.CompanyUser(
                    id=str(uuid.uuid4()),
                    company_id=api.DEFAULT_COMPANY_ID,
                    user_id=participant.id,
                    department_id=finance.id,
                    role="user",
                    status=api.ACTIVE_STATUS,
                ))
            db.commit()
        response = self.client.post(
            "/assistant/chat",
            headers=self.admin_headers,
            json={"assistant_username": api.MITTY_USERNAME, "message": command, "execute": False},
        )
        self.assertEqual(response.status_code, 200, response.text)
        payload = response.json()
        self.assertEqual(payload["intent"], "meeting")
        self.assertEqual(payload["plan"]["subject"], "ECF Shopee")
        self.assertEqual(payload["plan"]["title"], "Reunião: ECF Shopee")
        starts_at = datetime.fromisoformat(payload["plan"]["starts_at"])
        local_start = starts_at.astimezone(api.BOLT_DAILY_SUMMARY_TIMEZONE)
        expected_date = datetime.strptime(future_date, "%d/%m/%Y")
        self.assertEqual((local_start.day, local_start.month, local_start.hour, local_start.minute), (expected_date.day, expected_date.month, 11, 0))
        self.assertEqual(
            set(payload["plan"]["assigned_to_names"]),
            {"Leonardo Lenzi", "Wellington Biruel"},
        )
        self.assertNotIn("31/07", payload["plan"]["title"])
        self.assertNotIn("Wellington", payload["plan"]["title"])
        self.assertEqual(payload["plan"]["link_url"], "https://meet.google.com/fpj-eeac-rir")
        self.assertIn("Link: https://meet.google.com/fpj-eeac-rir", payload["confirmation_summary"])
        self.assertTrue(payload["requires_confirmation"])

        confirmed = self.client.post(
            "/assistant/chat",
            headers=self.admin_headers,
            json={
                "assistant_username": api.MITTY_USERNAME,
                "message": command,
                "display_message": "Confirmo",
                "execute": True,
                "confirmed": True,
            },
        )
        self.assertEqual(confirmed.status_code, 200, confirmed.text)
        self.assertTrue(confirmed.json()["executed"])
        self.assertEqual(confirmed.json()["meeting"]["title"], "Reunião: ECF Shopee")
        self.assertEqual(confirmed.json()["meeting"]["link_url"], "https://meet.google.com/fpj-eeac-rir")
        confirmed_start = datetime.fromisoformat(confirmed.json()["meeting"]["starts_at"])
        self.assertEqual(
            (confirmed_start.astimezone(api.BOLT_DAILY_SUMMARY_TIMEZONE).hour, confirmed_start.astimezone(api.BOLT_DAILY_SUMMARY_TIMEZONE).minute),
            (11, 0),
        )
    def test_assistant_collects_missing_information_before_review(self):
        first_command = "Agende uma reuniao com Ana amanha sobre planejamento"
        missing_time = self.client.post(
            "/assistant/requests",
            headers=self.admin_headers,
            json={"message": first_command, "execute": False},
        )
        self.assertEqual(missing_time.status_code, 200, missing_time.text)
        first_payload = missing_time.json()
        self.assertTrue(first_payload["needs_input"])
        self.assertIn("time", first_payload["missing_fields"])
        self.assertFalse(first_payload["requires_confirmation"])

        completed = self.client.post(
            "/assistant/requests",
            headers=self.admin_headers,
            json={
                "message": first_payload["command"] + "\n1430",
                "execute": False,
            },
        )
        self.assertEqual(completed.status_code, 200, completed.text)
        completed_payload = completed.json()
        self.assertFalse(completed_payload["needs_input"])
        self.assertTrue(completed_payload["requires_confirmation"])
        self.assertEqual(completed_payload["intent"], "meeting")

        missing_urgency = self.client.post(
            "/assistant/requests",
            headers=self.admin_headers,
            json={"message": "Abra um ticket para TI sobre acesso bloqueado", "execute": False},
        )
        self.assertEqual(missing_urgency.status_code, 200, missing_urgency.text)
        self.assertTrue(missing_urgency.json()["needs_input"])
        self.assertIn("urgency", missing_urgency.json()["missing_fields"])

    def test_assistant_answers_greetings_without_forcing_an_action(self):
        greetings = ["Oi", "Bom dia", "Tudo bem?", "Obrigado", "Obrigdo", "Ola Mitty"]
        replies = []
        for greeting in greetings:
            response = self.client.post(
                "/assistant/requests",
                headers=self.user_headers,
                json={"message": greeting},
            )
            self.assertEqual(response.status_code, 200, response.text)
            payload = response.json()
            self.assertEqual(payload["intent"], "conversation")
            self.assertFalse(payload["needs_input"])
            self.assertTrue(payload["executed"])
            self.assertFalse(payload["continue_context"])
            replies.append(payload["reply"])
        self.assertTrue(all(not reply.startswith("Ei,") for reply in replies))

        for assistant_username, message, expected_name in [
            (api.BOLT_USERNAME, "Obrigado Volt", api.BOLT_NAME),
            (api.MITTY_USERNAME, "Ola Mitty", api.MITTY_NAME),
        ]:
            response = self.client.post(
                "/assistant/chat",
                headers=self.user_headers,
                json={"assistant_username": assistant_username, "message": message},
            )
            self.assertEqual(response.status_code, 200, response.text)
            self.assertEqual(response.json()["intent"], "conversation")
            self.assertEqual(response.json()["assistant_name"], expected_name)

    def test_mitty_edits_personal_task_and_meeting_after_confirmation(self):
        task_response = self.client.post(
            "/tasks/",
            headers=self.user_headers,
            json={"title": "Revisar contrato", "description": "Versao inicial", "priority": "medium"},
        )
        self.assertEqual(task_response.status_code, 200, task_response.text)
        task_id = task_response.json()["id"]
        task_command = f"Mitty edite a tarefa #{task_id} titulo para Revisar contrato final prioridade alta"
        task_preview = self.client.post(
            "/assistant/requests",
            headers=self.user_headers,
            json={"message": task_command},
        )
        self.assertEqual(task_preview.status_code, 200, task_preview.text)
        self.assertEqual(task_preview.json()["intent"], "task_edit")
        self.assertTrue(task_preview.json()["requires_confirmation"])
        self.assertFalse(task_preview.json()["executed"])
        task_confirmed = self.client.post(
            "/assistant/requests",
            headers=self.user_headers,
            json={"message": task_command, "execute": True, "confirmed": True},
        )
        self.assertEqual(task_confirmed.status_code, 200, task_confirmed.text)
        self.assertTrue(task_confirmed.json()["executed"])
        self.assertEqual(task_confirmed.json()["task"]["title"], "Revisar contrato final")
        self.assertEqual(task_confirmed.json()["task"]["priority"], "high")

        starts = datetime.now(timezone.utc) + timedelta(days=60)
        ends = starts + timedelta(hours=1)
        meeting_response = self.client.post(
            "/meetings",
            headers=self.user_headers,
            json={
                "title": "Planejamento semanal",
                "meeting_type": "reminder",
                "starts_at": starts.isoformat(),
                "ends_at": ends.isoformat(),
            },
        )
        self.assertEqual(meeting_response.status_code, 200, meeting_response.text)
        meeting_id = meeting_response.json()["id"]
        target_day = (datetime.now(api.BOLT_DAILY_SUMMARY_TIMEZONE) + timedelta(days=75)).strftime("%d/%m/%Y")
        meeting_command = f"Mitty remarque a reuniao {meeting_id} para {target_day} as 16h"
        preview = self.client.post(
            "/assistant/chat",
            headers=self.user_headers,
            json={"assistant_username": api.MITTY_USERNAME, "message": meeting_command},
        )
        self.assertEqual(preview.status_code, 200, preview.text)
        self.assertEqual(preview.json()["intent"], "meeting_edit")
        self.assertTrue(preview.json()["requires_confirmation"])
        with patch.object(api, "dispatch_meeting_reminder", new=AsyncMock()):
            confirmed = self.client.post(
                "/assistant/chat",
                headers=self.user_headers,
                json={
                    "assistant_username": api.MITTY_USERNAME,
                    "message": meeting_command,
                    "execute": True,
                    "confirmed": True,
                },
            )
        self.assertEqual(confirmed.status_code, 200, confirmed.text)
        self.assertTrue(confirmed.json()["executed"])
        local_start = datetime.fromisoformat(confirmed.json()["meeting"]["starts_at"]).astimezone(api.BOLT_DAILY_SUMMARY_TIMEZONE)
        self.assertEqual((local_start.hour, local_start.minute), (16, 0))
        with patch.object(api, "dispatch_meeting_reminder", new=AsyncMock()):
            manual_edit = self.client.patch(
                f"/meetings/{meeting_id}",
                headers=self.user_headers,
                json={
                    "title": "Planejamento atualizado manualmente",
                    "description": "Descricao revisada no formulario",
                    "link_url": "https://meet.google.com/teste-edicao",
                },
            )
        self.assertEqual(manual_edit.status_code, 200, manual_edit.text)
        self.assertEqual(manual_edit.json()["title"], "Planejamento atualizado manualmente")
        self.assertEqual(manual_edit.json()["link_url"], "https://meet.google.com/teste-edicao")

    def test_mitty_schedules_meeting_and_notifies_participant(self):
        future = (datetime.now(api.BOLT_DAILY_SUMMARY_TIMEZONE) + timedelta(days=90)).strftime("%d/%m/%Y")
        command = f"Agende uma reuniao com Ana em {future} as 14:30 sobre planejamento trimestral"
        preview = self.client.post(
            "/assistant/requests",
            headers=self.admin_headers,
            json={"message": command, "execute": False},
        )
        self.assertEqual(preview.status_code, 200, preview.text)
        self.assertEqual(preview.json()["assistant_name"], api.MITTY_NAME)
        self.assertEqual(preview.json()["intent"], "meeting")
        self.assertTrue(preview.json()["requires_confirmation"])

        with patch.object(api, "dispatch_meeting_reminder", new=AsyncMock()):
            created = self.client.post(
                "/assistant/requests",
                headers=self.admin_headers,
                json={"message": command, "execute": True, "confirmed": True},
            )
        self.assertEqual(created.status_code, 200, created.text)
        payload = created.json()
        self.assertTrue(payload["executed"])
        self.assertEqual(payload["meeting"]["meeting_type"], "video")
        with api.SessionLocal() as db:
            mitty = db.query(api.User).filter(api.User.username == api.MITTY_USERNAME).one()
            ana = db.query(api.User).filter(api.User.username == "ana").one()
            notification = db.query(api.Message).filter(
                api.Message.sender_id == mitty.id,
                api.Message.receiver_id == ana.id,
                api.Message.message_type == "meeting_invitation",
            ).order_by(api.Message.id.desc()).first()
            self.assertIsNotNone(notification)
            self.assertIn("planejamento trimestral", notification.content)
    def test_ticket_word_does_not_accidentally_select_ti(self):
        response = self.client.post(
            "/assistant/requests",
            headers=self.admin_headers,
            json={"message": "Abra um ticket para Financeiro sobre reembolso pendente", "execute": False},
        )
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json()["plan"]["departments"], ["Financeiro"])

    def test_department_mentioned_in_problem_is_not_assigned(self):
        response = self.client.post(
            "/assistant/requests",
            headers=self.admin_headers,
            json={
                "message": "Abra um ticket urgente para TI: notebook da equipe comercial esta travando",
                "execute": False,
            },
        )
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json()["plan"]["departments"], ["TI"])

    def test_assistant_contacts_answer_summaries_and_persist_chat(self):
        ticket_response = self.client.post(
            "/assistant/chat",
            headers=self.user_headers,
            json={
                "assistant_username": api.BOLT_USERNAME,
                "message": "Volt, quantos tickets tenho em aberto e quantos aguardam minha resposta?",
            },
        )
        self.assertEqual(ticket_response.status_code, 200, ticket_response.text)
        self.assertEqual(ticket_response.json()["intent"], "ticket_summary")
        self.assertEqual(ticket_response.json()["assistant_name"], "Volt")
        self.assertEqual(len(ticket_response.json()["chat_messages"]), 2)

        command = "Abra um ticket leve para TI sobre acesso ao painel pelo chat do Volt"
        preview = self.client.post(
            "/assistant/chat",
            headers=self.user_headers,
            json={"assistant_username": api.BOLT_USERNAME, "message": command},
        )
        self.assertEqual(preview.status_code, 200, preview.text)
        self.assertTrue(preview.json()["requires_confirmation"])
        uploaded = self.client.post(
            "/files/upload",
            headers=self.user_headers,
            files={"file": ("evidencia-chat.txt", b"evidencia", "text/plain")},
        )
        self.assertEqual(uploaded.status_code, 200, uploaded.text)
        confirmed = self.client.post(
            "/assistant/chat",
            headers=self.user_headers,
            json={
                "assistant_username": api.BOLT_USERNAME,
                "message": command,
                "display_message": "Confirmo",
                "urgency": preview.json()["plan"]["ticket_priority"],
                "execute": True,
                "confirmed": True,
                "attachment_file_id": uploaded.json()["id"],
            },
        )
        self.assertEqual(confirmed.status_code, 200, confirmed.text)
        self.assertTrue(confirmed.json()["executed"])
        self.assertIsNotNone(confirmed.json()["ticket"]["id"])
        self.assertEqual(confirmed.json()["ticket"]["attachment_file_id"], uploaded.json()["id"])
        created_task = self.client.post(
            "/tasks/",
            headers=self.user_headers,
            json={"title": "Revisar agenda pessoal", "status": "backlog"},
        )
        self.assertEqual(created_task.status_code, 200, created_task.text)
        schedule_response = self.client.post(
            "/assistant/chat",
            headers=self.user_headers,
            json={
                "assistant_username": api.MITTY_USERNAME,
                "message": "Mitty, quais minhas tarefas em aberto?",
            },
        )
        self.assertEqual(schedule_response.status_code, 200, schedule_response.text)
        self.assertEqual(schedule_response.json()["intent"], "schedule_summary")
        self.assertGreaterEqual(schedule_response.json()["schedule_summary"]["task_count"], 1)
        self.assertIn("Revisar agenda pessoal", schedule_response.json()["reply"])

        with api.SessionLocal() as db:
            user_id = db.query(api.User.id).filter(api.User.username == "usuario").scalar()
            assistant_ids = {
                row[0]
                for row in db.query(api.User.id).filter(
                    api.User.username.in_([api.BOLT_USERNAME, api.MITTY_USERNAME])
                ).all()
            }
            persisted = db.query(api.Message).filter(
                api.Message.message_type == "assistant_chat",
                api.Message.sender_id.in_(assistant_ids),
                api.Message.receiver_id == user_id,
            ).count()
            self.assertGreaterEqual(persisted, 2)

    def test_direct_chat_never_executes_the_other_assistant_responsibility(self):
        future = (datetime.now(api.BOLT_DAILY_SUMMARY_TIMEZONE) + timedelta(days=120)).strftime("%d/%m/%Y")
        with api.SessionLocal() as db:
            meetings_before = db.execute(api.text("SELECT COUNT(*) FROM meetings")).scalar()
            tickets_before = db.query(api.Ticket).count()

        wrong_volt = self.client.post(
            "/assistant/chat",
            headers=self.user_headers,
            json={
                "assistant_username": api.BOLT_USERNAME,
                "message": f"Agende uma reuniao com Ana em {future} as 14h sobre planejamento",
                "execute": True,
                "confirmed": True,
            },
        )
        self.assertEqual(wrong_volt.status_code, 200, wrong_volt.text)
        self.assertFalse(wrong_volt.json()["executed"])
        self.assertIn("Mitty", wrong_volt.json()["reply"])

        wrong_mitty = self.client.post(
            "/assistant/chat",
            headers=self.user_headers,
            json={
                "assistant_username": api.MITTY_USERNAME,
                "message": "Abra um ticket leve para TI sobre acesso bloqueado",
                "execute": True,
                "confirmed": True,
            },
        )
        self.assertEqual(wrong_mitty.status_code, 200, wrong_mitty.text)
        self.assertFalse(wrong_mitty.json()["executed"])
        self.assertIn("Volt", wrong_mitty.json()["reply"])

        with api.SessionLocal() as db:
            self.assertEqual(db.execute(api.text("SELECT COUNT(*) FROM meetings")).scalar(), meetings_before)
            self.assertEqual(db.query(api.Ticket).count(), tickets_before)

    def test_task_assignment_to_other_user_is_rejected_even_with_common_words(self):
        response = self.client.post(
            "/assistant/requests",
            headers=self.admin_headers,
            json={
                "message": "Crie uma tarefa para Ana no Financeiro verificar falta de acesso ao suporte",
                "execute": False,
            },
        )
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json()["intent"], "task")
        self.assertTrue(response.json()["needs_input"])
        self.assertIn("Tarefas sao pessoais", response.json()["reply"])

    def test_creates_group_ticket_with_all_assignments(self):
        response = self.client.post(
            "/assistant/requests",
            headers=self.admin_headers,
            json={
                "message": "Abra um ticket grupal urgente para TI e Financeiro sobre acesso e atribua para Ana e Carlos",
                "execute": True,
                "confirmed": True,
                "urgency": "Urgente",
            },
        )
        self.assertEqual(response.status_code, 200, response.text)
        payload = response.json()
        self.assertTrue(payload["executed"])
        self.assertEqual(payload["ticket"]["priority"], "Urgente")
        self.assertEqual({item["name"] for item in payload["ticket"]["assigned_users"]}, {"Ana Souza", "Carlos Lima"})
        self.assertEqual({item["name"] for item in payload["ticket"]["assigned_departments"]}, {"TI", "Financeiro"})
        self.assertTrue(payload["ticket"]["is_group_ticket"])

    def test_assistant_rejects_delegated_task_per_person(self):
        response = self.client.post(
            "/assistant/requests",
            headers=self.admin_headers,
            json={
                "message": "Crie uma tarefa para Ana e Carlos revisar contratos no Financeiro ate amanha",
                "execute": True,
                "confirmed": True,
            },
        )
        self.assertEqual(response.status_code, 200, response.text)
        payload = response.json()
        self.assertFalse(payload["executed"])
        self.assertTrue(payload["needs_input"])
        self.assertIn("Tarefas sao pessoais", payload["reply"])

    def test_regular_user_can_open_ticket_for_another_department(self):
        response = self.client.post(
            "/assistant/requests",
            headers=self.user_headers,
            json={
                "message": "Abra um ticket para Financeiro sobre reembolso",
                "execute": True,
                "confirmed": True,
                "urgency": "Moderado",
            },
        )
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json()["ticket"]["department"], "Financeiro")

    def test_rejects_destructive_commands_and_clarifies_unknown_requests(self):
        destructive = self.client.post(
            "/assistant/requests",
            headers=self.admin_headers,
            json={"message": "Feche o ticket 123", "execute": True},
        )
        self.assertEqual(destructive.status_code, 400, destructive.text)

        unknown = self.client.post(
            "/assistant/requests",
            headers=self.admin_headers,
            json={"message": "Preciso de ajuda com uma coisa", "execute": False},
        )
        self.assertEqual(unknown.status_code, 200, unknown.text)
        self.assertTrue(unknown.json()["needs_input"])
        self.assertIn("action", unknown.json()["missing_fields"])

    def test_asks_for_correction_when_assignee_is_unknown(self):
        response = self.client.post(
            "/assistant/requests",
            headers=self.admin_headers,
            json={"message": "Abra um ticket para TI e atribua para Pessoa Inexistente", "execute": True},
        )
        self.assertEqual(response.status_code, 200, response.text)
        self.assertTrue(response.json()["needs_input"])
        self.assertIn("details", response.json()["missing_fields"])
        self.assertIn("Nao encontrei", response.json()["reply"])

    def test_understands_ticket_typos_and_requires_urgency_and_confirmation(self):
        preview = self.client.post(
            "/assistant/requests",
            headers=self.admin_headers,
            json={"message": "Abra um ticekt para TI sobre computador travando", "execute": False},
        )
        self.assertEqual(preview.status_code, 200, preview.text)
        payload = preview.json()
        self.assertEqual(payload["intent"], "ticket")
        self.assertFalse(payload["executed"])
        self.assertTrue(payload["requires_urgency"])
        self.assertIn("Extrema Urgência", payload["plan"]["urgency_options"])

        not_confirmed = self.client.post(
            "/assistant/requests",
            headers=self.admin_headers,
            json={
                "message": "Abra um tiket para TI sobre computador travando",
                "execute": True,
                "urgency": "Alto",
            },
        )
        self.assertEqual(not_confirmed.status_code, 200, not_confirmed.text)
        self.assertFalse(not_confirmed.json()["executed"])

    def test_bolt_notifies_ticket_participants_with_ticket_id(self):
        response = self.client.post(
            "/assistant/requests",
            headers=self.admin_headers,
            json={
                "message": "Abra um ticket para Ana no Financeiro sobre reembolso",
                "execute": True,
                "confirmed": True,
                "urgency": "Extrema Urgência",
            },
        )
        self.assertEqual(response.status_code, 200, response.text)
        ticket_id = response.json()["ticket"]["id"]
        with api.SessionLocal() as db:
            bolt = db.query(api.User).filter(api.User.username == api.BOLT_USERNAME).one()
            messages = db.query(api.Message).filter(api.Message.sender_id == bolt.id).all()
            self.assertTrue(any(f"ticket #{ticket_id}" in message.content for message in messages))

    def test_bolt_answers_personal_open_ticket_summary(self):
        with api.SessionLocal() as db:
            user = db.query(api.User).filter(api.User.username == "usuario").one()
            user_id = user.id

        created = self.client.post(
            "/tickets/",
            headers=self.admin_headers,
            json={
                "title": "Resumo pessoal aguardando resposta",
                "description": "Ticket usado para validar o resumo do Bolt",
                "priority": "Alto",
                "department": "TI",
                "assigned_to_ids": [user_id],
                "assigned_departments": ["TI"],
            },
        )
        self.assertEqual(created.status_code, 200, created.text)
        ticket_id = created.json()["id"]

        admin_message = self.client.post(
            f"/tickets/{ticket_id}/messages",
            headers=self.admin_headers,
            json={"content": "Precisamos da sua confirmação."},
        )
        self.assertEqual(admin_message.status_code, 200, admin_message.text)

        response = self.client.post(
            "/assistant/requests",
            headers=self.user_headers,
            json={"message": "Quantos ticekts tenho em aberto e quais aguardam minha resposta?"},
        )
        self.assertEqual(response.status_code, 200, response.text)
        payload = response.json()
        self.assertEqual(payload["intent"], "ticket_summary")
        self.assertTrue(payload["executed"])
        self.assertFalse(payload["requires_confirmation"])
        ticket_summary = payload["ticket_summary"]
        item = next(ticket for ticket in ticket_summary["tickets"] if ticket["id"] == ticket_id)
        self.assertTrue(item["awaiting_user_response"])
        self.assertEqual(item["waiting_label"], "Aguardando sua resposta")
        self.assertIn(f"#{ticket_id}", payload["reply"])

        user_message = self.client.post(
            f"/tickets/{ticket_id}/messages",
            headers=self.user_headers,
            json={"content": "Confirmado, já estou verificando."},
        )
        self.assertEqual(user_message.status_code, 200, user_message.text)

        updated = self.client.post(
            "/assistant/requests",
            headers=self.user_headers,
            json={"message": "Quais tickets estão aguardando minha resposta?"},
        )
        self.assertEqual(updated.status_code, 200, updated.text)
        updated_item = next(
            ticket for ticket in updated.json()["ticket_summary"]["tickets"]
            if ticket["id"] == ticket_id
        )
        self.assertFalse(updated_item["awaiting_user_response"])
        self.assertEqual(updated_item["waiting_label"], "Aguardando resposta de outro participante")

    def test_bolt_daily_ticket_summary_is_idempotent(self):
        summary_date = "2099-07-16"
        first = api.prepare_bolt_daily_ticket_summaries(
            summary_date=summary_date,
            company_id=api.DEFAULT_COMPANY_ID,
        )
        second = api.prepare_bolt_daily_ticket_summaries(
            summary_date=summary_date,
            company_id=api.DEFAULT_COMPANY_ID,
        )

        self.assertGreater(len(first), 0)
        self.assertEqual(second, [])
        with api.SessionLocal() as db:
            records = db.query(api.BoltDailyTicketSummary).filter(
                api.BoltDailyTicketSummary.company_id == api.DEFAULT_COMPANY_ID,
                api.BoltDailyTicketSummary.summary_date == summary_date,
            ).all()
            self.assertEqual(len(records), len(first))
            self.assertEqual(len({record.user_id for record in records}), len(records))
            messages = db.query(api.Message).filter(
                api.Message.message_type == "ticket_daily_summary",
                api.Message.id.in_([record.message_id for record in records]),
            ).all()
            self.assertEqual(len(messages), len(records))
            self.assertTrue(all("Resumo diário do Volt" in message.content for message in messages))

            db.query(api.BoltDailyTicketSummary).filter(
                api.BoltDailyTicketSummary.summary_date == summary_date,
            ).delete(synchronize_session=False)
            db.query(api.Message).filter(
                api.Message.message_type == "ticket_daily_summary",
            ).delete(synchronize_session=False)
            db.commit()
    def test_ticket_control_report_scopes_coordinator_and_company_admin(self):
        with api.SessionLocal() as db:
            coordinator = db.query(api.User).filter(api.User.username == "coordenador").one()
            coordinator_department = api.user_department_name(db, coordinator, api.DEFAULT_COMPANY_ID)
            coordinator_id = coordinator.id
            coordinator_name = coordinator.full_name

        created = self.client.post(
            "/tickets/",
            headers=self.coordinator_headers,
            json={
                "title": "Ticket exclusivo do relatorio",
                "description": "Medir resposta e fechamento",
                "priority": "Alto",
                "department": coordinator_department,
                "assigned_to_ids": [coordinator_id],
                "assigned_departments": [coordinator_department],
            },
        )
        self.assertEqual(created.status_code, 200, created.text)
        ticket_id = created.json()["id"]

        response_message = self.client.post(
            f"/tickets/{ticket_id}/messages",
            headers=self.company_admin_headers,
            json={"content": "Primeira resposta do atendimento"},
        )
        self.assertEqual(response_message.status_code, 200, response_message.text)
        missing_reason = self.client.post(
            f"/tickets/{ticket_id}/close",
            headers=self.coordinator_headers,
            json={"message": ""},
        )
        self.assertEqual(missing_reason.status_code, 400, missing_reason.text)

        closed = self.client.post(
            f"/tickets/{ticket_id}/close",
            headers=self.coordinator_headers,
            json={"message": "Solicitacao resolvida e validada"},
        )
        self.assertEqual(closed.status_code, 200, closed.text)
        self.assertEqual(closed.json()["closed_by_id"], coordinator_id)
        self.assertEqual(closed.json()["close_reason"], "Solicitacao resolvida e validada")

        coordinator_report = self.client.get(
            "/tickets/reports/control",
            headers=self.coordinator_headers,
        )
        self.assertEqual(coordinator_report.status_code, 200, coordinator_report.text)
        coordinator_payload = coordinator_report.json()
        self.assertEqual(coordinator_payload["scope"]["type"], "department")
        self.assertEqual(len(coordinator_payload["sections"]), 1)
        self.assertEqual(coordinator_payload["sections"][0]["department"], coordinator_department)
        detail = next(item for item in coordinator_payload["sections"][0]["tickets"] if item["id"] == ticket_id)
        self.assertEqual(detail["closed_by_name"], coordinator_name)
        self.assertEqual(detail["close_reason"], "Solicitacao resolvida e validada")
        self.assertTrue(any(item["average_response_minutes"] is not None for item in coordinator_payload["sections"][0]["users"]))

        company_report = self.client.get(
            "/tickets/reports/control",
            headers=self.company_admin_headers,
        )
        self.assertEqual(company_report.status_code, 200, company_report.text)
        company_payload = company_report.json()
        self.assertEqual(company_payload["scope"]["type"], "company")
        self.assertIsNone(company_payload["sections"][0]["department"])
        self.assertTrue(any(section["department"] == coordinator_department for section in company_payload["sections"]))

        forbidden = self.client.get("/tickets/reports/control", headers=self.user_headers)
        self.assertEqual(forbidden.status_code, 403, forbidden.text)
    def test_personal_task_has_no_department_dependency_and_only_deletes_when_done(self):

        created = self.client.post(
            "/tasks/",
            headers=self.user_headers,
            json={
                "title": "Tarefa sem prazo",
                "description": "Tarefa pessoal sem setor",
                "priority": "medium",
                "status": "backlog",
            },
        )
        self.assertEqual(created.status_code, 200, created.text)
        task = created.json()
        self.assertEqual(task["category"], "Pessoal")
        self.assertEqual(task["assigned_to_id"], task["created_by_id"])
        self.assertIsNone(task["due_date"])

        with api.SessionLocal() as db:
            other_user_id = db.query(api.User.id).filter(api.User.username == "ana").scalar()
        delegated = self.client.post(
            "/tasks/",
            headers=self.user_headers,
            json={"title": "Tarefa indevida", "assigned_to_id": other_user_id},
        )
        self.assertEqual(delegated.status_code, 403, delegated.text)
        self.assertIn("nao podem ser criadas", delegated.json()["detail"])

        rejected = self.client.delete(f"/tasks/{task['id']}", headers=self.user_headers)
        self.assertEqual(rejected.status_code, 400, rejected.text)
        self.assertIn("Conclua", rejected.json()["detail"])

        completed = self.client.patch(
            f"/tasks/{task['id']}",
            headers=self.user_headers,
            json={"status": "done"},
        )
        self.assertEqual(completed.status_code, 200, completed.text)

        removed = self.client.delete(f"/tasks/{task['id']}", headers=self.user_headers)
        self.assertEqual(removed.status_code, 200, removed.text)
        with api.SessionLocal() as db:
            self.assertIsNone(db.query(api.TaskItem).filter(api.TaskItem.id == task["id"]).first())
            audit = db.query(api.AuditLog).filter(
                api.AuditLog.action == "tarefa_removida",
                api.AuditLog.entity_id == str(task["id"]),
            ).one()
            self.assertEqual(audit.metadata_json["status"], "done")

    def test_ticket_messages_support_replies_and_reactions(self):
        created = self.client.post(
            "/tickets/",
            headers=self.admin_headers,
            json={
                "title": "Assunto personalizado",
                "description": "Validar conversa interna",
                "priority": "Alto",
                "channel": "Interno",
                "department": "Financeiro",
                "assigned_departments": ["Financeiro"],
            },
        )
        self.assertEqual(created.status_code, 200, created.text)
        ticket_id = created.json()["id"]

        original = self.client.post(
            f"/tickets/{ticket_id}/messages",
            headers=self.admin_headers,
            json={"content": "Mensagem original"},
        )
        self.assertEqual(original.status_code, 200, original.text)
        original_id = original.json()["id"]

        reply = self.client.post(
            f"/tickets/{ticket_id}/messages",
            headers=self.admin_headers,
            json={"content": "Mensagem respondida", "reply_to_id": original_id},
        )
        self.assertEqual(reply.status_code, 200, reply.text)
        self.assertEqual(reply.json()["reply_to"]["id"], original_id)

        reaction = self.client.post(
            f"/tickets/{ticket_id}/messages/{original_id}/reactions",
            headers=self.admin_headers,
            json={"emoji": "\U0001F44D"},
        )
        self.assertEqual(reaction.status_code, 200, reaction.text)
        self.assertEqual(reaction.json()["reactions"][0]["count"], 1)

        messages = self.client.get(f"/tickets/{ticket_id}/messages", headers=self.admin_headers)
        self.assertEqual(messages.status_code, 200, messages.text)
        serialized_original = next(item for item in messages.json() if item["id"] == original_id)
        self.assertEqual(serialized_original["reactions"][0]["emoji"], "\U0001F44D")
    def test_admin_can_delete_message_and_write_json_audit(self):
        with api.SessionLocal() as db:
            admin = db.query(api.User).filter(api.User.username == "admin").one()
            user = db.query(api.User).filter(api.User.username == "usuario").one()
            message = api.Message(
                company_id=api.DEFAULT_COMPANY_ID,
                content="mensagem descartavel",
                sender_id=admin.id,
                receiver_id=user.id,
            )
            db.add(message)
            db.commit()
            message_id = message.id
            user_id = user.id

        response = self.client.delete(f"/messages/{message_id}", headers=self.admin_headers)
        self.assertEqual(response.status_code, 200, response.text)
        with api.SessionLocal() as db:
            audit = db.query(api.AuditLog).filter(api.AuditLog.entity_id == str(message_id)).one()
            self.assertEqual(audit.metadata_json, {})

        repeated = self.client.delete(f"/messages/{message_id}", headers=self.admin_headers)
        self.assertEqual(repeated.status_code, 200, repeated.text)
        self.assertTrue(repeated.json()["already_deleted"])

    def test_admin_can_clear_direct_chat_history_and_write_json_audit(self):
        with api.SessionLocal() as db:
            admin = db.query(api.User).filter(api.User.username == "admin").one()
            ana = db.query(api.User).filter(api.User.username == "ana").one()
            db.add(api.Message(
                company_id=api.DEFAULT_COMPANY_ID,
                content="mensagem direta descartavel",
                sender_id=admin.id,
                receiver_id=ana.id,
            ))
            db.commit()
            ana_id = ana.id

        response = self.client.delete(
            f"/messages/history/clear?receiver_id={ana_id}",
            headers=self.admin_headers,
        )
        self.assertEqual(response.status_code, 200, response.text)
        self.assertGreaterEqual(response.json()["deleted"], 1)

        general = self.client.delete("/messages/history/clear", headers=self.admin_headers)
        self.assertEqual(general.status_code, 400, general.text)

    def test_upload_and_download_attachment_round_trip(self):
        content = b"VoltChat attachment integration test"
        upload = self.client.post(
            "/files/upload",
            headers=self.admin_headers,
            files={"file": ("validacao.txt", content, "text/plain")},
        )
        self.assertEqual(upload.status_code, 200, upload.text)
        payload = upload.json()
        self.assertEqual(payload["filename"], "validacao.txt")
        self.assertEqual(payload["file_size"], len(content))
        self.assertIsNotNone(payload["expires_at"])

        download = self.client.get(f"/files/download/{payload['id']}", headers=self.admin_headers)
        self.assertEqual(download.status_code, 200, download.text)
        self.assertEqual(download.content, content)

    def test_upload_and_download_recorded_audio_round_trip(self):
        content = b"\x1a\x45\xdf\xa3voltchat-opus-audio"
        upload = self.client.post(
            "/files/upload",
            headers=self.user_headers,
            files={"file": ("audio-teste.webm", content, "audio/webm;codecs=opus")},
        )
        self.assertEqual(upload.status_code, 200, upload.text)
        payload = upload.json()
        self.assertEqual(payload["filename"], "audio-teste.webm")
        self.assertTrue(payload["content_type"].startswith("audio/webm"))
        self.assertIsNotNone(payload["expires_at"])

        download = self.client.get(f"/files/download/{payload['id']}", headers=self.user_headers)
        self.assertEqual(download.status_code, 200, download.text)
        self.assertEqual(download.content, content)
    def test_desktop_release_metadata_comes_from_r2_manifest_only(self):
        content = b"voltchat-r2-release"
        digest = hashlib.sha256(content).hexdigest()
        manifest = {
            "version": "0.1.37",
            "platform": "windows",
            "filename": "VoltChat-Setup-0.1.37.exe",
            "content_type": "application/x-msdownload",
            "file_size": len(content),
            "sha256": digest,
            "storage_key": "desktop/releases/windows/0.1.37/release.exe",
            "published_at": "2026-08-06T18:00:00+00:00",
        }
        r2 = MagicMock()
        r2.get_object.return_value = {
            "Body": MagicMock(read=MagicMock(return_value=json.dumps(manifest).encode("utf-8")))
        }
        signed_url = "https://account.r2.cloudflarestorage.com/voltchat-release?X-Amz-Signature=test"
        r2.generate_presigned_url.return_value = signed_url

        with patch.object(api, "r2_client", return_value=r2):
            metadata = self.client.get("/downloads/desktop/latest/meta")
            head = self.client.head("/downloads/desktop/latest", follow_redirects=False)
            download = self.client.get("/downloads/desktop/latest", follow_redirects=False)

        self.assertEqual(metadata.status_code, 200, metadata.text)
        self.assertEqual(metadata.json()["version"], "0.1.37")
        self.assertEqual(metadata.json()["source"], "cloudflare-r2")
        self.assertEqual(metadata.json()["sha256"], digest)
        self.assertEqual(metadata.json()["download_url"], signed_url)
        self.assertEqual(head.status_code, 307)
        self.assertEqual(download.status_code, 307)
        self.assertEqual(download.headers["location"], signed_url)

    def test_desktop_release_manifest_does_not_query_release_tables(self):
        digest = hashlib.sha256(b"r2-only").hexdigest()
        manifest = {
            "version": "0.1.37",
            "filename": "VoltChat-Setup-0.1.37.exe",
            "file_size": 7,
            "sha256": digest,
            "storage_key": "desktop/releases/windows/0.1.37/release.exe",
        }
        r2 = MagicMock()
        r2.get_object.return_value = {
            "Body": MagicMock(read=MagicMock(return_value=json.dumps(manifest).encode("utf-8")))
        }
        r2.generate_presigned_url.return_value = "https://account.r2.cloudflarestorage.com/release.exe?sig=test"

        with patch.object(api, "r2_client", return_value=r2), patch.object(api, "SessionLocal") as session_local:
            metadata = self.client.get("/downloads/desktop/latest/meta")

        self.assertEqual(metadata.status_code, 200, metadata.text)
        session_local.assert_not_called()

    def test_desktop_package_accepts_legacy_download_url_fallback(self):
        original_package_url = api.DESKTOP_PACKAGE_EXTERNAL_URL
        original_release_url = api.DESKTOP_RELEASE_EXTERNAL_URL
        api.DESKTOP_PACKAGE_EXTERNAL_URL = ""
        api.DESKTOP_RELEASE_EXTERNAL_URL = "https://drive.usercontent.google.com/download?id=voltchat-package"
        try:
            head = self.client.head("/downloads/desktop/package", follow_redirects=False)
            download = self.client.get("/downloads/desktop/package", follow_redirects=False)
        finally:
            api.DESKTOP_PACKAGE_EXTERNAL_URL = original_package_url
            api.DESKTOP_RELEASE_EXTERNAL_URL = original_release_url

        self.assertEqual(head.status_code, 307, head.text)
        self.assertEqual(download.status_code, 307, download.text)
        self.assertEqual(
            download.headers["location"],
            "https://drive.usercontent.google.com/download?id=voltchat-package",
        )

    def test_normalizes_naive_and_aware_database_datetimes_to_utc(self):
        naive = datetime(2026, 7, 14, 8, 15)
        aware = datetime(2026, 7, 14, 5, 15, tzinfo=timezone.utc).astimezone()

        normalized_naive = api.ensure_utc_datetime(naive)
        normalized_aware = api.ensure_utc_datetime(aware)

        self.assertEqual(normalized_naive.tzinfo, timezone.utc)
        self.assertEqual(normalized_naive.hour, 8)
        self.assertEqual(normalized_aware.tzinfo, timezone.utc)
        self.assertEqual(normalized_aware, aware.astimezone(timezone.utc))

    def test_platform_routes_company_edit_hub_link_and_total_delete(self):
        create_company = self.client.post(
            "/platform/companies",
            headers=self.admin_headers,
            json={"name": "Tenant Rotas", "cnpj": "12.345.678/0001-90", "status": "active"},
        )
        self.assertEqual(create_company.status_code, 200, create_company.text)
        company = create_company.json()
        company_id = company["id"]
        self.assertEqual(company["tenant_global_id"], company_id)

        for path in ["/platform/overview", "/platform/companies", f"/platform/departments?company_id={company_id}", "/platform/department-links"]:
            response = self.client.get(path, headers=self.admin_headers)
            self.assertEqual(response.status_code, 200, f"{path}: {response.text}")

        update_company = self.client.patch(
            f"/platform/companies/{company_id}",
            headers=self.admin_headers,
            json={"name": "Tenant Rotas Editado", "phone_primary": "11999990000"},
        )
        self.assertEqual(update_company.status_code, 200, update_company.text)
        self.assertEqual(update_company.json()["name"], "Tenant Rotas Editado")

        first_department = self.client.post(
            "/platform/departments", headers=self.admin_headers,
            json={"company_id": company_id, "name": "Campo"},
        )
        second_department = self.client.post(
            "/platform/departments", headers=self.admin_headers,
            json={"company_id": company_id, "name": "Escritorio"},
        )
        self.assertEqual(first_department.status_code, 200, first_department.text)
        self.assertEqual(second_department.status_code, 200, second_department.text)
        department_id = first_department.json()["id"]

        department_link = self.client.post(
            "/platform/department-links",
            headers=self.admin_headers,
            json={
                "source_department_id": department_id,
                "target_department_id": second_department.json()["id"],
                "label": "Fluxo",
            },
        )
        self.assertEqual(department_link.status_code, 200, department_link.text)
        remove_department_link = self.client.delete(
            f"/platform/department-links/{department_link.json()['id']}", headers=self.admin_headers
        )
        self.assertEqual(remove_department_link.status_code, 200, remove_department_link.text)

        def fake_hub_sync(company_record, user_record, role):
            company_record.tenant_global_id = company_record.id
            company_record.hub_enabled = True
            company_record.hub_synced_at = datetime.utcnow()
            return {"ok": True}

        with patch.object(api, "sync_hub_identity", side_effect=fake_hub_sync) as hub_sync:
            create_user = self.client.post(
                "/platform/users",
                headers=self.admin_headers,
                json={
                    "name": "Usuario Tenant Rotas",
                    "email": f"tenant-{uuid.uuid4().hex[:8]}@example.com",
                    "password": "senha123",
                    "company_id": company_id,
                    "department": "Campo",
                    "role": "coordinator",
                    "create_hub_login": True,
                },
            )
        self.assertEqual(create_user.status_code, 200, create_user.text)
        hub_sync.assert_called_once()
        created_user = create_user.json()
        membership = next(item for item in created_user["companies"] if item["company_id"] == company_id)

        update_link = self.client.patch(
            f"/platform/company-users/{membership['id']}", headers=self.admin_headers,
            json={"department_id": department_id, "role": "user", "status": "active"},
        )
        self.assertEqual(update_link.status_code, 200, update_link.text)
        reset_password = self.client.post(
            f"/platform/users/{created_user['id']}/reset-password", headers=self.admin_headers,
            json={"password": "novaSenha123", "company_id": company_id},
        )
        self.assertEqual(reset_password.status_code, 200, reset_password.text)

        remove_membership = self.client.delete(
            f"/platform/company-users/{membership['id']}", headers=self.admin_headers
        )
        self.assertEqual(remove_membership.status_code, 200, remove_membership.text)

        import_checks = [
            self.client.post(
                "/platform/import/companies/preview", headers=self.admin_headers,
                files={"file": ("companies.csv", b"nome_empresa;cnpj;responsavel;telefone_1;telefone_2;status\n", "text/csv")},
            ),
            self.client.post(
                "/platform/import/companies/confirm", headers=self.admin_headers, json={"rows": []}
            ),
            self.client.post(
                "/platform/import/users/preview", headers=self.admin_headers,
                files={"file": ("users.csv", b"nome_usuario;email;senha_primaria;id_empresa;telefone;setor;nivel_usuario;status\n", "text/csv")},
            ),
            self.client.post(
                "/platform/import/users/confirm", headers=self.admin_headers, json={"rows": []}
            ),
        ]
        for response in import_checks:
            self.assertEqual(response.status_code, 200, response.text)

        delete_company = self.client.delete(f"/platform/companies/{company_id}", headers=self.admin_headers)
        self.assertEqual(delete_company.status_code, 200, delete_company.text)
        self.assertGreaterEqual(delete_company.json()["deleted"]["users"], 1)
        companies = self.client.get("/platform/companies", headers=self.admin_headers).json()
        self.assertFalse(any(item["id"] == company_id for item in companies))

        protected_default = self.client.delete(
            f"/platform/companies/{api.DEFAULT_COMPANY_ID}", headers=self.admin_headers
        )
        self.assertEqual(protected_default.status_code, 400, protected_default.text)


    def test_platform_admin_clears_only_selected_company_history(self):
        suffix = uuid.uuid4().hex[:8]
        target_response = self.client.post(
            "/platform/companies",
            headers=self.admin_headers,
            json={"name": f"Empresa Limpeza {suffix}", "status": "active"},
        )
        other_response = self.client.post(
            "/platform/companies",
            headers=self.admin_headers,
            json={"name": f"Empresa Preservada {suffix}", "status": "active"},
        )
        self.assertEqual(target_response.status_code, 200, target_response.text)
        self.assertEqual(other_response.status_code, 200, other_response.text)
        target_company_id = target_response.json()["id"]
        other_company_id = other_response.json()["id"]

        with api.SessionLocal() as db:
            admin = db.query(api.User).filter(api.User.username == "admin").one()
            department = api.Department(
                id=str(uuid.uuid4()), company_id=target_company_id, name=f"Operacao {suffix}", status="active"
            )
            uploaded_file = api.FileUpload(
                company_id=target_company_id,
                filename="historico.txt",
                file_path=f"test/{suffix}/historico.txt",
                file_size=9,
                content_type="text/plain",
                binary_data=b"historico",
                uploaded_by=admin.id,
            )
            message = api.Message(
                company_id=target_company_id,
                content="Mensagem a apagar",
                sender_id=admin.id,
            )
            ticket = api.Ticket(
                company_id=target_company_id,
                title="Ticket a apagar",
                description="Historico operacional",
                created_by_id=admin.id,
            )
            task = api.TaskItem(
                company_id=target_company_id,
                title="Tarefa a apagar",
                created_by_id=admin.id,
                assigned_to_id=admin.id,
            )
            db.add_all([department, uploaded_file, message, ticket, task])
            db.flush()
            ticket_message = api.TicketMessage(
                company_id=target_company_id,
                ticket_id=ticket.id,
                sender_id=admin.id,
                content="Conversa do ticket",
                file_id=uploaded_file.id,
            )
            db.add(ticket_message)
            db.flush()
            db.add_all([
                api.MessageReaction(message_id=message.id, user_id=admin.id, emoji="ok"),
                api.MessageReadReceipt(message_id=message.id, user_id=admin.id),
                api.TicketMessageReaction(ticket_message_id=ticket_message.id, user_id=admin.id, emoji="ok"),
                api.TicketAssignee(ticket_id=ticket.id, user_id=admin.id),
                api.TicketDepartment(ticket_id=ticket.id, department_id=department.id),
                api.BoltDailyTicketSummary(
                    company_id=target_company_id,
                    user_id=admin.id,
                    summary_date="2026-08-03",
                    open_ticket_count=1,
                    awaiting_reply_count=1,
                    message_id=message.id,
                ),
                api.ChatAttentionLimit(
                    company_id=target_company_id,
                    sender_id=admin.id,
                    receiver_id=admin.id,
                    usage_date="2026-08-03",
                    daily_count=1,
                ),
                api.ChatHistoryBackup(
                    company_id=target_company_id,
                    period_start=datetime(2026, 7, 1),
                    period_end=datetime(2026, 7, 31),
                    message_count=1,
                    original_size=9,
                    compressed_size=9,
                    compressed_data=b"historico",
                ),
                api.TaskItem(
                    company_id=other_company_id,
                    title="Tarefa que deve permanecer",
                    created_by_id=admin.id,
                    assigned_to_id=admin.id,
                ),
            ])
            meeting_id = str(uuid.uuid4())
            db.execute(api.text("""
                INSERT INTO meetings (
                    id, company_id, creator_user_id, title, meeting_type, starts_at, ends_at
                ) VALUES (
                    :id, :company_id, :creator_user_id, :title, 'video', :starts_at, :ends_at
                )
            """), {
                "id": meeting_id,
                "company_id": target_company_id,
                "creator_user_id": admin.id,
                "title": "Reuniao a apagar",
                "starts_at": datetime(2026, 8, 3, 14, 0),
                "ends_at": datetime(2026, 8, 3, 15, 0),
            })
            db.execute(api.text("""
                INSERT INTO meeting_participants (meeting_id, user_id, response_status)
                VALUES (:meeting_id, :user_id, 'accepted')
            """), {"meeting_id": meeting_id, "user_id": admin.id})
            db.commit()

        denied = self.client.delete(
            f"/platform/companies/{target_company_id}/history",
            headers=self.user_headers,
        )
        self.assertEqual(denied.status_code, 403, denied.text)

        cleared = self.client.delete(
            f"/platform/companies/{target_company_id}/history",
            headers=self.admin_headers,
        )
        self.assertEqual(cleared.status_code, 200, cleared.text)
        deleted = cleared.json()["deleted"]
        for key in [
            "messages", "message_reactions", "message_read_receipts", "daily_summaries",
            "tickets", "ticket_messages", "ticket_message_reactions", "ticket_assignees",
            "ticket_departments", "tasks", "meetings", "meeting_participants", "files",
            "backups", "attention_limits",
        ]:
            self.assertEqual(deleted[key], 1, f"Contagem incorreta para {key}: {cleared.text}")

        with api.SessionLocal() as db:
            self.assertIsNotNone(db.query(api.Company).filter(api.Company.id == target_company_id).first())
            self.assertIsNotNone(db.query(api.Department).filter(api.Department.company_id == target_company_id).first())
            self.assertEqual(db.query(api.Message).filter(api.Message.company_id == target_company_id).count(), 0)
            self.assertEqual(db.query(api.Ticket).filter(api.Ticket.company_id == target_company_id).count(), 0)
            self.assertEqual(db.query(api.TaskItem).filter(api.TaskItem.company_id == target_company_id).count(), 0)
            self.assertEqual(db.query(api.TaskItem).filter(api.TaskItem.company_id == other_company_id).count(), 1)
            self.assertEqual(db.execute(api.text(
                "SELECT COUNT(*) FROM meetings WHERE company_id = :company_id"
            ), {"company_id": target_company_id}).scalar(), 0)
            self.assertIsNotNone(db.query(api.AuditLog).filter(
                api.AuditLog.company_id == target_company_id,
                api.AuditLog.action == "historico_empresa_apagado",
            ).first())

        self.client.delete(f"/platform/companies/{target_company_id}", headers=self.admin_headers)
        self.client.delete(f"/platform/companies/{other_company_id}", headers=self.admin_headers)

    def test_company_admin_manages_departments_and_imports_users(self):
        denied = self.client.post(
            "/company-admin/departments",
            headers=self.user_headers,
            json={"company_id": api.DEFAULT_COMPANY_ID, "name": "Setor Bloqueado"},
        )
        self.assertEqual(denied.status_code, 403, denied.text)

        created = self.client.post(
            "/company-admin/departments",
            headers=self.company_admin_headers,
            json={"company_id": api.DEFAULT_COMPANY_ID, "name": "Qualidade", "description": "Auditoria"},
        )
        self.assertEqual(created.status_code, 200, created.text)
        department = created.json()

        updated = self.client.patch(
            f"/company-admin/departments/{department['id']}",
            headers=self.company_admin_headers,
            json={"company_id": api.DEFAULT_COMPANY_ID, "name": "Qualidade e Processos"},
        )
        self.assertEqual(updated.status_code, 200, updated.text)

        with api.SessionLocal() as db:
            target_user = db.query(api.User).filter(api.User.username == "ana").one()
            target_user_id = target_user.id
        allocated = self.client.patch(
            f"/company-admin/users/{target_user_id}/department",
            headers=self.company_admin_headers,
            json={"company_id": api.DEFAULT_COMPANY_ID, "department_id": department["id"]},
        )
        self.assertEqual(allocated.status_code, 200, allocated.text)
        self.assertEqual(allocated.json()["department_name"], "Qualidade e Processos")

        template = self.client.get(
            f"/company-admin/import/users/template?company_id={api.DEFAULT_COMPANY_ID}",
            headers=self.company_admin_headers,
        )
        self.assertEqual(template.status_code, 200, template.text)
        self.assertTrue(template.content.startswith(b"PK"))
        workbook = load_workbook(io.BytesIO(template.content))
        user_sheet = workbook["Usuarios"]
        self.assertEqual(
            [cell.value for cell in user_sheet[1]],
            ["nome_completo", "usuario", "email", "ramal", "setor", "nivel_usuario"],
        )
        validations = list(user_sheet.data_validations.dataValidation)
        self.assertEqual(len(validations), 1)
        self.assertEqual(validations[0].formula1, '"usuario,coordenador,admin"')

        self.assertEqual(api.normalize_platform_role("usuario"), "user")
        self.assertEqual(api.normalize_platform_role("coordenador"), "coordinator")
        self.assertEqual(api.normalize_platform_role("admin"), "company_admin")

        csv_payload = (
            "nome_completo;usuario;email;ramal;setor;nivel_usuario\n"
            "Joana Lote;pessoa.importada;pessoa.importada@example.com;310;"
            "Qualidade e Processos;admin\n"
        ).encode("utf-8")
        preview = self.client.post(
            f"/company-admin/import/users/preview?company_id={api.DEFAULT_COMPANY_ID}",
            headers=self.company_admin_headers,
            files={"file": ("usuarios.csv", csv_payload, "text/csv")},
        )
        self.assertEqual(preview.status_code, 200, preview.text)
        self.assertEqual(preview.json()["error_count"], 0, preview.text)

        confirmed = self.client.post(
            "/company-admin/import/users/confirm",
            headers=self.company_admin_headers,
            json={
                "company_id": api.DEFAULT_COMPANY_ID,
                "rows": [row["data"] for row in preview.json()["rows"]],
            },
        )
        self.assertEqual(confirmed.status_code, 200, confirmed.text)
        self.assertEqual(confirmed.json()["imported"], 1)

        with api.SessionLocal() as db:
            imported_user = db.query(api.User).filter(api.User.email == "pessoa.importada@example.com").one()
            imported_link = db.query(api.CompanyUser).filter(
                api.CompanyUser.company_id == api.DEFAULT_COMPANY_ID,
                api.CompanyUser.user_id == imported_user.id,
            ).one()
            self.assertTrue(api.verify_password("Alterar@123", imported_user.hashed_password))
            self.assertTrue(imported_user.must_change_password)
            self.assertEqual(imported_user.status, api.ACTIVE_STATUS)
            self.assertEqual(imported_link.status, api.ACTIVE_STATUS)
            self.assertEqual(imported_link.role, "company_admin")

        overview = self.client.get(
            f"/company-admin/overview?company_id={api.DEFAULT_COMPANY_ID}",
            headers=self.company_admin_headers,
        )
        self.assertEqual(overview.status_code, 200, overview.text)
        self.assertTrue(any(item["email"] == "pessoa.importada@example.com" for item in overview.json()["users"]))


    def test_dashboard_metrics_are_tenant_and_role_scoped(self):
        company_id = str(uuid.uuid4())
        with api.SessionLocal() as db:
            company = api.Company(
                id=company_id,
                name="Empresa Dashboard Isolada",
                tenant_global_id=str(uuid.uuid4()),
                status=api.ACTIVE_STATUS,
            )
            own_department = api.Department(
                id=str(uuid.uuid4()),
                company_id=company_id,
                name="Operacao Dashboard",
                status=api.ACTIVE_STATUS,
            )
            other_department = api.Department(
                id=str(uuid.uuid4()),
                company_id=company_id,
                name="Outro Dashboard",
                status=api.ACTIVE_STATUS,
            )
            db.add_all([company, own_department, other_department])
            db.flush()

            users = {
                user.username: user
                for user in db.query(api.User).filter(
                    api.User.username.in_(["usuario", "coordenador", "empresa_admin", "ana", "carlos"])
                ).all()
            }
            roles = {
                "usuario": ("user", own_department.id),
                "coordenador": ("coordinator", own_department.id),
                "empresa_admin": ("company_admin", own_department.id),
                "ana": ("user", own_department.id),
                "carlos": ("user", other_department.id),
            }
            for username, (role, department_id) in roles.items():
                db.add(api.CompanyUser(
                    id=str(uuid.uuid4()),
                    company_id=company_id,
                    user_id=users[username].id,
                    department_id=department_id,
                    role=role,
                    status=api.ACTIVE_STATUS,
                ))

            assigned_user_ticket = api.Ticket(
                company_id=company_id,
                title="Somente usuario",
                description="Atribuicao individual",
                department=other_department.name,
                created_by_id=users["empresa_admin"].id,
                assigned_to_id=users["usuario"].id,
            )
            department_ticket = api.Ticket(
                company_id=company_id,
                title="Setor coordenado",
                description="Atribuicao por setor",
                department=other_department.name,
                created_by_id=users["empresa_admin"].id,
                assigned_to_id=users["ana"].id,
            )
            other_ticket = api.Ticket(
                company_id=company_id,
                title="Outro setor",
                description="Nao visivel ao coordenador",
                department=other_department.name,
                created_by_id=users["empresa_admin"].id,
                assigned_to_id=users["carlos"].id,
            )
            coordinator_ticket = api.Ticket(
                company_id=company_id,
                title="Direto ao coordenador",
                description="Ticket grupal fora do setor",
                department=other_department.name,
                created_by_id=users["empresa_admin"].id,
                assigned_to_id=users["carlos"].id,
            )
            db.add_all([assigned_user_ticket, department_ticket, other_ticket, coordinator_ticket])
            db.flush()
            db.add(api.TicketDepartment(ticket_id=department_ticket.id, department_id=own_department.id))
            db.add(api.TicketAssignee(ticket_id=coordinator_ticket.id, user_id=users["coordenador"].id))

            db.add_all([
                api.TaskItem(
                    company_id=company_id, title="Task usuario", category=other_department.name,
                    created_by_id=users["empresa_admin"].id, assigned_to_id=users["usuario"].id,
                ),
                api.TaskItem(
                    company_id=company_id, title="Task setor", category=own_department.name,
                    created_by_id=users["empresa_admin"].id, assigned_to_id=users["ana"].id,
                ),
                api.TaskItem(
                    company_id=company_id, title="Task outro setor", category=other_department.name,
                    created_by_id=users["empresa_admin"].id, assigned_to_id=users["carlos"].id,
                ),
                api.TaskItem(
                    company_id=company_id, title="Task coordenador", category=other_department.name,
                    created_by_id=users["empresa_admin"].id, assigned_to_id=users["coordenador"].id,
                ),
            ])
            db.commit()

        def overview(headers):
            response = self.client.get(
                f"/dashboard/overview?company_id={company_id}",
                headers=headers,
            )
            self.assertEqual(response.status_code, 200, response.text)
            return response.json()

        user_overview = overview(self.user_headers)
        self.assertEqual(user_overview["scope"]["type"], "user")
        self.assertEqual(user_overview["stats"]["tickets"], 1)
        self.assertEqual(user_overview["stats"]["tasks"], 1)
        self.assertEqual(set(user_overview["ticket_dashboards"]), {"my_requests", "my_services"})
        self.assertIn("recent_conversations", user_overview)
        self.assertIn("birthdays_today", user_overview)
        coordinator_overview = overview(self.coordinator_headers)
        self.assertEqual(coordinator_overview["scope"]["type"], "department")
        self.assertEqual(coordinator_overview["stats"]["tickets"], 2)
        self.assertEqual(coordinator_overview["stats"]["tasks"], 1)

        admin_overview = overview(self.company_admin_headers)
        self.assertEqual(admin_overview["scope"]["type"], "company")
        self.assertEqual(admin_overview["stats"]["tickets"], 4)
        self.assertEqual(admin_overview["stats"]["tasks"], 4)

    def test_audit_logs_show_actor_and_delete_records_older_than_seven_days(self):
        suffix = uuid.uuid4().hex
        old_action = f"auditoria_antiga_{suffix}"
        recent_action = f"auditoria_recente_{suffix}"
        with api.SessionLocal() as db:
            admin = db.query(api.User).filter(api.User.username == "admin").one()
            db.add_all([
                api.AuditLog(
                    id=str(uuid.uuid4()),
                    company_id=api.DEFAULT_COMPANY_ID,
                    actor_user_id=admin.id,
                    action=old_action,
                    entity_type="test",
                    entity_id="old",
                    metadata_json={"retention": "expired"},
                    created_at=datetime.utcnow() - timedelta(days=8),
                ),
                api.AuditLog(
                    id=str(uuid.uuid4()),
                    company_id=api.DEFAULT_COMPANY_ID,
                    actor_user_id=admin.id,
                    action=recent_action,
                    entity_type="test",
                    entity_id="recent",
                    metadata_json={"retention": "active"},
                    created_at=datetime.utcnow() - timedelta(days=6),
                ),
            ])
            db.commit()

        deleted = api.purge_expired_audit_logs()
        self.assertGreaterEqual(deleted, 1)

        with api.SessionLocal() as db:
            self.assertIsNone(db.query(api.AuditLog).filter(api.AuditLog.action == old_action).first())
            self.assertIsNotNone(db.query(api.AuditLog).filter(api.AuditLog.action == recent_action).first())

        overview = self.client.get("/platform/overview", headers=self.admin_headers)
        self.assertEqual(overview.status_code, 200, overview.text)
        audit_log = next(
            item for item in overview.json()["audit_logs"]
            if item["action"] == recent_action
        )
        self.assertEqual(audit_log["actor_name"], "Volt Admin")
        self.assertEqual(audit_log["actor_username"], "admin")
        self.assertEqual(audit_log["actor_email"], "admin@voltcorp.com")


    def test_unique_username_uses_email_local_and_first_name_across_companies(self):
        suffix = uuid.uuid4().hex[:8]
        base = f"cadastro6{suffix}"
        created_ids = []
        with api.SessionLocal() as db:
            first = api.User(
                username=base,
                email=f"primeiro-{suffix}@empresa-x.test",
                full_name="Primeiro Usuario",
                hashed_password=api.get_password_hash("Senha123!"),
                status=api.ACTIVE_STATUS,
                is_active=True,
            )
            db.add(first)
            db.flush()
            created_ids.append(first.id)

            generated = api.generate_unique_username(
                db,
                f"{base}@empresa-y.test",
                "Álan Souza",
            )
            self.assertEqual(generated, f"{base}.ala")

            second = api.User(
                username=generated,
                email=f"segundo-{suffix}@empresa-y.test",
                full_name="Alan Souza",
                hashed_password=api.get_password_hash("Senha123!"),
                status=api.ACTIVE_STATUS,
                is_active=True,
            )
            db.add(second)
            db.flush()
            created_ids.append(second.id)

            self.assertEqual(
                api.generate_unique_username(db, f"{base}@empresa-z.test", "Alan Lima"),
                f"{base}.ala2",
            )
            db.query(api.User).filter(api.User.id.in_(created_ids)).delete(synchronize_session=False)
            db.commit()

    def test_database_maintenance_is_scheduled_and_purges_files_in_small_batches(self):
        before_window = datetime(2026, 7, 15, 6, 0, tzinfo=timezone.utc)
        after_window = datetime(2026, 7, 15, 6, 16, tzinfo=timezone.utc)
        self.assertEqual(api.seconds_until_database_maintenance(before_window), 15 * 60)
        self.assertEqual(api.seconds_until_database_maintenance(after_window), (23 * 60 + 59) * 60)

        suffix = uuid.uuid4().hex
        with api.SessionLocal() as db:
            admin_id = db.query(api.User).filter(api.User.username == "admin").one().id
            expired = api.FileUpload(
                company_id=api.DEFAULT_COMPANY_ID,
                filename=f"expirado-{suffix}.bin",
                file_path=f"nao-existe-{suffix}.bin",
                file_size=1024 * 1024,
                content_type="application/octet-stream",
                binary_data=b"x" * (1024 * 1024),
                uploaded_by=admin_id,
                expires_at=datetime(2000, 1, 1),
            )
            active = api.FileUpload(
                company_id=api.DEFAULT_COMPANY_ID,
                filename=f"ativo-{suffix}.bin",
                file_path=f"nao-existe-ativo-{suffix}.bin",
                file_size=1,
                content_type="application/octet-stream",
                binary_data=b"x",
                uploaded_by=admin_id,
                expires_at=datetime.utcnow() + timedelta(days=1),
            )
            db.add_all([expired, active])
            db.commit()
            expired_id, active_id = expired.id, active.id

            self.assertEqual(api.purge_expired_files(db, batch_size=1), 1)
            self.assertIsNone(db.query(api.FileUpload).filter(api.FileUpload.id == expired_id).first())
            self.assertIsNotNone(db.query(api.FileUpload).filter(api.FileUpload.id == active_id).first())
            db.query(api.FileUpload).filter(api.FileUpload.id == active_id).delete(synchronize_session=False)
            db.commit()

    def test_password_reset_uses_single_expiring_token_and_revokes_session(self):
        old_session = self.login("ana", "test123")
        with patch.object(api, "BREVO_API_KEY", "test-key"), patch.object(api, "BREVO_SENDER_EMAIL", "noreply@example.com"), patch.object(api, "send_password_reset_email") as send_email:
            unknown = self.client.post("/auth/forgot-password", json={"email": "desconhecido@example.com"})
            self.assertEqual(unknown.status_code, 200)
            self.assertEqual(send_email.call_count, 0)

            requested = self.client.post("/auth/forgot-password", json={"email": "ana@example.com"})
            self.assertEqual(requested.status_code, 200)
            self.assertEqual(requested.json(), unknown.json())
            send_email.assert_called_once()
            raw_token = send_email.call_args.args[1]

        reset = self.client.post(
            "/auth/reset-password",
            json={"token": raw_token, "new_password": "nova-senha-segura"},
        )
        self.assertEqual(reset.status_code, 200)
        self.assertEqual(self.client.get("/auth/me", headers=old_session).status_code, 401)
        self.assertEqual(self.client.post("/auth/reset-password", json={"token": raw_token, "new_password": "outra-senha"}).status_code, 400)
        self.assertEqual(self.client.post("/auth/login", json={"username": "ana", "password": "test123"}).status_code, 401)
        self.assertEqual(self.client.post("/auth/login", json={"username": "ana", "password": "nova-senha-segura"}).status_code, 200)


    def test_connection_manager_keeps_browser_and_desktop_sessions(self):
        with api.SessionLocal() as db:
            user_id = db.query(api.User).filter(api.User.username == "usuario").one().id

        manager = api.ConnectionManager()
        manager.broadcast_user_status = AsyncMock()
        browser_socket = MagicMock()
        browser_socket.accept = AsyncMock()
        browser_socket.send_text = AsyncMock()
        desktop_socket = MagicMock()
        desktop_socket.accept = AsyncMock()
        desktop_socket.send_text = AsyncMock()

        async def exercise_connections():
            await manager.connect(browser_socket, user_id, api.DEFAULT_COMPANY_ID)
            await manager.connect(desktop_socket, user_id, api.DEFAULT_COMPANY_ID)
            self.assertEqual(len(manager.user_connections[user_id]), 2)
            manager.broadcast_user_status.assert_awaited_once()

            browser_socket.send_text.reset_mock()
            desktop_socket.send_text.reset_mock()
            await manager.send_personal_message("primeira", user_id)
            browser_socket.send_text.assert_awaited_once_with("primeira")
            desktop_socket.send_text.assert_awaited_once_with("primeira")

            still_online = manager.disconnect(user_id, id(browser_socket))
            self.assertTrue(still_online)
            self.assertIn(id(desktop_socket), manager.active_connections)

            await manager.send_personal_message("segunda", user_id)
            browser_socket.send_text.assert_awaited_once()
            self.assertEqual(desktop_socket.send_text.await_count, 2)
            desktop_socket.send_text.assert_awaited_with("segunda")

            still_online = manager.disconnect(user_id, id(desktop_socket))
            self.assertFalse(still_online)
            self.assertNotIn(user_id, manager.user_connections)

        asyncio.run(exercise_connections())

if __name__ == "__main__":
    unittest.main()
