from pathlib import Path
import os
import sys

import psycopg

from env_loader import load_database_url_from_env_file

ROOT = Path(__file__).resolve().parents[1]
MIGRATIONS_DIR = ROOT / "db" / "migrations"


def get_database_url() -> str:
    database_url = os.getenv("DATABASE_URL")
    if not database_url:
        raise RuntimeError("DATABASE_URL nao configurada. Use a connection string do Neon.")
    return database_url


def ensure_migrations_table(conn):
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS schema_migrations (
          version TEXT PRIMARY KEY,
          applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
        """
    )


def applied_versions(conn) -> set[str]:
    rows = conn.execute("SELECT version FROM schema_migrations").fetchall()
    return {row[0] for row in rows}


def main():
    load_database_url_from_env_file()
    migrations = sorted(MIGRATIONS_DIR.glob("*.sql"))
    if not migrations:
        print("Nenhuma migration encontrada.")
        return 0

    with psycopg.connect(get_database_url()) as conn:
        ensure_migrations_table(conn)
        applied = applied_versions(conn)

        for migration in migrations:
            version = migration.stem
            if version in applied:
                print(f"skip {version}")
                continue

            print(f"apply {version}")
            sql = migration.read_text(encoding="utf-8")
            with conn.transaction():
                conn.execute(sql)
                conn.execute("INSERT INTO schema_migrations (version) VALUES (%s)", (version,))

    print("Migrations aplicadas com sucesso.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
