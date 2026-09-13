import os
import shutil
import tempfile
import unittest
import uuid
from types import SimpleNamespace
from pathlib import Path

TEST_DATABASE_PATH = Path(tempfile.gettempdir()) / f"voltchat-efficiency-{uuid.uuid4().hex}.db"
os.environ["DATABASE_URL"] = f"sqlite:///{TEST_DATABASE_PATH.as_posix()}"
os.environ["AUTO_SEED_USERS"] = "true"
os.environ["SECRET_KEY"] = "efficiency-test-secret"

import sordchat_fixed as api


class DatabaseEfficiencyTest(unittest.TestCase):
    @classmethod
    def tearDownClass(cls):
        api.engine.dispose()
        TEST_DATABASE_PATH.unlink(missing_ok=True)

    def test_batch_message_serializer_preserves_message_contract(self):
        with api.SessionLocal() as db:
            sender = api.User(
                username="efficiency_sender",
                email="efficiency_sender@example.com",
                full_name="Efficiency Sender",
                hashed_password="hash",
                status=api.ACTIVE_STATUS,
                is_active=True,
            )
            receiver = api.User(
                username="efficiency_receiver",
                email="efficiency_receiver@example.com",
                full_name="Efficiency Receiver",
                hashed_password="hash",
                status=api.ACTIVE_STATUS,
                is_active=True,
            )
            db.add_all([sender, receiver])
            db.flush()
            message = api.Message(
                company_id=api.DEFAULT_COMPANY_ID,
                content="Mensagem de teste",
                sender_id=sender.id,
                receiver_id=receiver.id,
            )
            db.add(message)
            db.commit()
            db.refresh(message)

            payload = api.serialize_messages([message], db)

        self.assertEqual(len(payload), 1)
        self.assertEqual(payload[0]["id"], message.id)
        self.assertEqual(payload[0]["sender_name"], "Efficiency Sender")
        self.assertEqual(payload[0]["receiver_name"], "Efficiency Receiver")
        self.assertEqual(payload[0]["content"], "Mensagem de teste")

    def test_message_history_cursor_returns_stable_pages(self):
        with api.SessionLocal() as db:
            sender = api.User(username="cursor_sender", email="cursor_sender@example.com", full_name="Cursor Sender", hashed_password="hash", status=api.ACTIVE_STATUS, is_active=True)
            receiver = api.User(username="cursor_receiver", email="cursor_receiver@example.com", full_name="Cursor Receiver", hashed_password="hash", status=api.ACTIVE_STATUS, is_active=True)
            db.add_all([sender, receiver])
            db.flush()
            messages = [api.Message(company_id=api.DEFAULT_COMPANY_ID, content=f"cursor-{index}", sender_id=sender.id, receiver_id=receiver.id) for index in range(3)]
            db.add_all(messages)
            db.commit()

            first_page = api.paginate_message_history(db.query(api.Message).filter(api.Message.sender_id == sender.id), db, limit=2)
            second_page = api.paginate_message_history(db.query(api.Message).filter(api.Message.sender_id == sender.id), db, before_message_id=first_page["next_cursor"], limit=2)

        self.assertEqual([item["content"] for item in first_page["messages"]], ["cursor-1", "cursor-2"])
        self.assertEqual([item["content"] for item in second_page["messages"]], ["cursor-0"])
        self.assertIsNone(second_page["next_cursor"])
    def test_batch_group_serializer_preserves_members(self):
        with api.SessionLocal() as db:
            creator = api.User(
                username="efficiency_group_creator",
                email="efficiency_group_creator@example.com",
                full_name="Efficiency Group Creator",
                hashed_password="hash",
                status=api.ACTIVE_STATUS,
                is_active=True,
            )
            member = api.User(
                username="efficiency_group_member",
                email="efficiency_group_member@example.com",
                full_name="Efficiency Group Member",
                hashed_password="hash",
                status=api.ACTIVE_STATUS,
                is_active=True,
            )
            db.add_all([creator, member])
            db.flush()
            group = api.ChatGroup(
                company_id=api.DEFAULT_COMPANY_ID,
                name="Efficiency Group",
                created_by_id=creator.id,
                is_active=True,
            )
            db.add(group)
            db.flush()
            db.add(api.ChatGroupMember(group_id=group.id, user_id=creator.id))
            db.add(api.ChatGroupMember(group_id=group.id, user_id=member.id))
            db.commit()
            db.refresh(group)

            payload = api.serialize_groups([group], db)

        self.assertEqual(payload[0]["name"], "Efficiency Group")
        self.assertEqual(payload[0]["created_by_name"], "Efficiency Group Creator")
        self.assertEqual({item["id"] for item in payload[0]["members"]}, {creator.id, member.id})
    def test_current_user_uses_request_scoped_identity(self):
        cached = api.User(
            id=991,
            username="request_cached_user",
            email="request_cached_user@example.com",
            full_name="Request Cached User",
            hashed_password="hash",
            status=api.ACTIVE_STATUS,
            is_active=True,
        )
        request = SimpleNamespace(state=SimpleNamespace(voltchat_current_user=cached))
        credentials = SimpleNamespace(credentials=api.create_access_token({"sub": "991"}))

        resolved = api.get_current_user(request=request, credentials=credentials)

        self.assertIs(resolved, cached)
    def test_file_metadata_query_defers_binary_content(self):
        with api.SessionLocal() as db:
            user = api.User(
                username="efficiency_file_user",
                email="efficiency_file_user@example.com",
                full_name="Efficiency File User",
                hashed_password="hash",
                status=api.ACTIVE_STATUS,
                is_active=True,
            )
            db.add(user)
            db.flush()
            file_record = api.FileUpload(
                company_id=api.DEFAULT_COMPANY_ID,
                filename="evidence.txt",
                file_path="uploads/evidence.txt",
                file_size=7,
                content_type="text/plain",
                binary_data=b"payload",
                uploaded_by=user.id,
            )
            db.add(file_record)
            db.commit()
            db.expunge_all()

            metadata = api.list_file_metadata_query(db, api.DEFAULT_COMPANY_ID).one()

            self.assertNotIn("binary_data", metadata.__dict__)
            self.assertEqual(metadata.filename, "evidence.txt")


class DatabasePoolModeTest(unittest.TestCase):
    def test_database_pool_mode_accepts_nopooling_alias(self):
        self.assertEqual(api.normalize_db_pool_mode("nopooling"), "null")
        self.assertEqual(api.normalize_db_pool_mode("no-pooling"), "null")
        self.assertEqual(api.normalize_db_pool_mode("small"), "small")

class R2ChatFileStorageTest(unittest.TestCase):
    def test_r2_chat_file_keys_are_scoped_to_the_company(self):
        key = api.r2_chat_file_storage_key("company-abc", "evidence.PDF")
        self.assertTrue(key.startswith("chat/files/company-abc/"))
        self.assertTrue(key.endswith(".pdf"))
        self.assertTrue(api.is_r2_chat_file_path("r2://chat/files/company-abc/item.pdf"))
        self.assertFalse(api.is_r2_chat_file_path("uploads/item.pdf"))

class DatabaseMetricsTest(unittest.TestCase):
    def test_database_metrics_do_not_include_sql_or_user_content(self):
        metrics = api.database_query_metrics()
        self.assertIn("enabled", metrics)
        self.assertIn("total_queries", metrics)
        self.assertNotIn("statement", metrics)
        self.assertNotIn("sql", metrics)

if __name__ == "__main__":
    unittest.main()
