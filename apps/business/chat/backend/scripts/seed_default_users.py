from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "scripts"))

from env_loader import load_database_url_from_env_file  # noqa: E402

load_database_url_from_env_file()
from sordchat_fixed import create_default_users  # noqa: E402


if __name__ == "__main__":
    create_default_users()
    print("Usuarios padrao verificados.")
