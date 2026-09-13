from pathlib import Path
import os


def _env_candidates() -> list[Path]:
    return [
        Path(__file__).resolve().parents[2] / ".env",
        Path(__file__).resolve().parents[1] / ".env",
    ]


def load_environment_from_env_file() -> None:
    """Carrega variaveis simples KEY=VALUE dos .env do projeto sem sobrescrever o ambiente atual."""
    for env_path in _env_candidates():
        if not env_path.exists():
            continue
        content = env_path.read_text(encoding="utf-8-sig").strip()
        if not content:
            continue
        for raw_line in content.splitlines():
            line = raw_line.strip()
            if not line or line.startswith("#"):
                continue
            if line.startswith(("postgres://", "postgresql://")):
                os.environ.setdefault("DATABASE_URL", line)
                continue
            if "=" not in line:
                continue
            key, value = line.split("=", 1)
            key = key.strip()
            if not key:
                continue
            value = value.strip().strip('"').strip("'")
            os.environ.setdefault(key, value)

    if os.getenv("VOLT_CHAT_DATABASE_URL") and not os.getenv("DATABASE_URL"):
        os.environ["DATABASE_URL"] = os.environ["VOLT_CHAT_DATABASE_URL"]


def load_database_url_from_env_file() -> None:
    load_environment_from_env_file()
