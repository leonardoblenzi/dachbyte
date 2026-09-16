from pathlib import Path
import argparse
import hashlib
import json
import mimetypes
import os
from datetime import datetime, timezone
from urllib.parse import quote

import boto3
from botocore.config import Config

from env_loader import load_environment_from_env_file

ROOT = Path(__file__).resolve().parents[2]
FRONTEND_ROOT = ROOT / "sordchat-frontend"
FRONTEND_PACKAGE = FRONTEND_ROOT / "package.json"
HASH_CHUNK_SIZE = 1024 * 1024
KEEP_RELEASES = 2
CHANNELS = {"production", "staging"}


def env_first(*names: str, default: str = "") -> str:
    for name in names:
        value = os.getenv(name, "").strip()
        if value:
            return value
    return default




def load_desktop_environment() -> None:
    desktop_env = FRONTEND_ROOT / ".env.desktop"
    if not desktop_env.exists():
        return
    for raw_line in desktop_env.read_text(encoding="utf-8-sig").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        key = key.strip()
        if not key:
            continue
        os.environ.setdefault(key, value.strip().strip('"').strip("'"))


def get_package_version() -> str:
    if not FRONTEND_PACKAGE.exists():
        return "0.1.0"
    package_data = json.loads(FRONTEND_PACKAGE.read_text(encoding="utf-8"))
    return package_data.get("version") or "0.1.0"


def installer_for_channel(channel: str) -> Path:
    version = get_package_version()
    if channel == "staging":
        return FRONTEND_ROOT / "dist-desktop-staging" / f"VoltChat-Staging-Setup-{version}.exe"
    return FRONTEND_ROOT / "dist-desktop" / f"VoltChat-Setup-{version}.exe"


def release_prefix_for_channel(channel: str) -> str:
    if channel == "staging":
        return env_first("R2_STAGING_RELEASE_PREFIX", default="desktop/staging/releases").strip("/")
    return env_first("R2_RELEASE_PREFIX", default="desktop/releases").strip("/")


def get_r2_config(channel: str) -> dict:
    account_id = env_first("R2_ACCOUNT_ID", "CLOUDFLARE_R2_ACCOUNT_ID")
    access_key_id = env_first("R2_ACCESS_KEY_ID", "CLOUDFLARE_R2_ACCESS_KEY_ID")
    secret_access_key = env_first("R2_SECRET_ACCESS_KEY", "CLOUDFLARE_R2_SECRET_ACCESS_KEY")
    bucket = env_first("R2_BUCKET_NAME", "CLOUDFLARE_R2_BUCKET_NAME")
    prefix = release_prefix_for_channel(channel)
    public_base_url = env_first(
        "R2_PUBLIC_BASE_URL",
        "CLOUDFLARE_R2_PUBLIC_BASE_URL",
    ).rstrip("/")
    endpoint_url = env_first(
        "R2_ENDPOINT_URL",
        "CLOUDFLARE_R2_ENDPOINT_URL",
        default=f"https://{account_id}.r2.cloudflarestorage.com" if account_id else "",
    ).rstrip("/")

    missing = [
        name
        for name, value in (
            ("R2_ACCOUNT_ID", account_id),
            ("R2_ACCESS_KEY_ID", access_key_id),
            ("R2_SECRET_ACCESS_KEY", secret_access_key),
            ("R2_BUCKET_NAME", bucket),
            ("R2_PUBLIC_BASE_URL", public_base_url),
        )
        if not value
    ]
    if missing:
        raise RuntimeError(
            "Configuracao do Cloudflare R2 incompleta. Faltando: " + ", ".join(missing)
        )
    if not public_base_url.startswith("https://"):
        raise RuntimeError("R2_PUBLIC_BASE_URL precisa iniciar com https://")

    return {
        "account_id": account_id,
        "access_key_id": access_key_id,
        "secret_access_key": secret_access_key,
        "bucket": bucket,
        "prefix": prefix,
        "public_base_url": public_base_url,
        "endpoint_url": endpoint_url,
        "channel": channel,
    }


def require_publish_confirmation(channel: str) -> None:
    if channel != "production":
        return
    confirmation = env_first("CONFIRM_DESKTOP_PRODUCTION_PUBLISH").upper()
    if confirmation != "YES":
        raise RuntimeError(
            "Publicacao oficial bloqueada. Defina CONFIRM_DESKTOP_PRODUCTION_PUBLISH=YES "
            "somente depois de validar o instalador interno de staging e congelar a URL de producao."
        )


def create_r2_client(config: dict):
    return boto3.client(
        service_name="s3",
        endpoint_url=config["endpoint_url"],
        aws_access_key_id=config["access_key_id"],
        aws_secret_access_key=config["secret_access_key"],
        region_name="auto",
        config=Config(signature_version="s3v4", retries={"max_attempts": 5, "mode": "standard"}),
    )


def hash_release_file(installer_path: Path) -> str:
    digest = hashlib.sha256()
    with installer_path.open("rb") as file:
        for chunk in iter(lambda: file.read(HASH_CHUNK_SIZE), b""):
            digest.update(chunk)
    return digest.hexdigest()


def build_storage_key(config: dict, platform: str, version: str, filename: str, digest: str) -> str:
    parts = [
        part
        for part in (
            config["prefix"],
            platform,
            version,
            f"{digest[:16]}-{filename}",
        )
        if part
    ]
    return "/".join(part.strip("/") for part in parts)


def build_manifest_key(config: dict, platform: str) -> str:
    return "/".join(
        part.strip("/")
        for part in (config["prefix"], platform, "latest.json")
        if part
    )


def public_object_url(config: dict, storage_key: str) -> str:
    return f"{config['public_base_url']}/{quote(storage_key, safe='/')}"


def upload_release(
    r2,
    config: dict,
    installer_path: Path,
    storage_key: str,
    content_type: str,
    version: str,
    digest: str,
) -> None:
    print(f"Enviando instalador [{config['channel']}] para Cloudflare R2: r2://{config['bucket']}/{storage_key}")
    r2.upload_file(
        str(installer_path),
        config["bucket"],
        storage_key,
        ExtraArgs={
            "ContentType": content_type,
            "ContentDisposition": f'attachment; filename="{installer_path.name}"',
            "CacheControl": "public, max-age=31536000, immutable",
            "Metadata": {
                "voltchat-version": version,
                "voltchat-channel": config["channel"],
                "sha256": digest,
            },
        },
    )
    head = r2.head_object(Bucket=config["bucket"], Key=storage_key)
    remote_size = int(head.get("ContentLength") or 0)
    if remote_size != installer_path.stat().st_size:
        raise RuntimeError(
            f"Upload incompleto no R2: esperado={installer_path.stat().st_size} recebido={remote_size}"
        )


def upload_manifest(r2, config: dict, platform: str, manifest: dict) -> str:
    manifest_key = build_manifest_key(config, platform)
    payload = json.dumps(manifest, ensure_ascii=False, indent=2).encode("utf-8")
    r2.put_object(
        Bucket=config["bucket"],
        Key=manifest_key,
        Body=payload,
        ContentType="application/json; charset=utf-8",
        CacheControl="no-store, no-cache, max-age=0, must-revalidate",
        Metadata={
            "voltchat-version": manifest["version"],
            "voltchat-channel": config["channel"],
            "sha256": manifest["sha256"],
        },
    )
    print(f"Manifesto [{config['channel']}] atualizado no R2: r2://{config['bucket']}/{manifest_key}")
    return manifest_key


def list_release_executables(r2, config: dict, platform: str) -> list[dict]:
    prefix = "/".join(part.strip("/") for part in (config["prefix"], platform) if part) + "/"
    paginator = r2.get_paginator("list_objects_v2")
    objects: list[dict] = []
    for page in paginator.paginate(Bucket=config["bucket"], Prefix=prefix):
        for item in page.get("Contents", []):
            key = str(item.get("Key") or "")
            if key.lower().endswith(".exe"):
                objects.append(item)
    return objects


def prune_old_r2_releases(r2, config: dict, platform: str, keep: int = KEEP_RELEASES) -> list[str]:
    releases = sorted(
        list_release_executables(r2, config, platform),
        key=lambda item: item.get("LastModified") or datetime.min.replace(tzinfo=timezone.utc),
        reverse=True,
    )
    removed: list[str] = []
    for item in releases[keep:]:
        key = str(item.get("Key") or "")
        if not key:
            continue
        r2.delete_object(Bucket=config["bucket"], Key=key)
        removed.append(key)
    return removed


def main() -> int:
    parser = argparse.ArgumentParser(
        description=(
            "Publica o instalador do VoltChat no Cloudflare R2 em canais isolados. "
            "Staging nunca altera o latest.json oficial de producao."
        )
    )
    parser.add_argument("installer", nargs="?", default=None, help="Caminho do instalador .exe.")
    parser.add_argument(
        "--channel",
        choices=sorted(CHANNELS),
        default=env_first("VOLTCHAT_RELEASE_CHANNEL", default="production"),
        help="Canal de release isolado no R2.",
    )
    parser.add_argument("--version", default=get_package_version(), help="Versao publicada.")
    parser.add_argument("--platform", default="windows", help="Plataforma da release.")
    parser.add_argument(
        "--no-prune",
        action="store_true",
        help="Nao remove releases anteriores do mesmo canal no Cloudflare R2.",
    )
    args = parser.parse_args()

    load_desktop_environment()
    load_environment_from_env_file()
    require_publish_confirmation(args.channel)
    installer_path = Path(args.installer).resolve() if args.installer else installer_for_channel(args.channel).resolve()
    if not installer_path.exists():
        raise FileNotFoundError(f"Instalador nao encontrado: {installer_path}")

    expected_prefix = "VoltChat-Staging-Setup-" if args.channel == "staging" else "VoltChat-Setup-"
    if not installer_path.name.startswith(expected_prefix):
        raise RuntimeError(
            f"Instalador {installer_path.name!r} nao pertence ao canal {args.channel!r}. "
            f"Esperado prefixo {expected_prefix!r}."
        )

    digest = hash_release_file(installer_path)
    content_type = mimetypes.guess_type(installer_path.name)[0] or "application/vnd.microsoft.portable-executable"
    r2_config = get_r2_config(args.channel)
    r2 = create_r2_client(r2_config)
    storage_key = build_storage_key(
        r2_config, args.platform, args.version, installer_path.name, digest
    )

    upload_release(
        r2,
        r2_config,
        installer_path,
        storage_key,
        content_type,
        args.version,
        digest,
    )

    published_at = datetime.now(timezone.utc).isoformat()
    manifest = {
        "schema_version": 1,
        "app": "VoltChat",
        "channel": args.channel,
        "version": args.version,
        "platform": args.platform,
        "filename": installer_path.name,
        "content_type": content_type,
        "file_size": installer_path.stat().st_size,
        "sha256": digest,
        "storage_key": storage_key,
        "download_url": public_object_url(r2_config, storage_key),
        "published_at": published_at,
    }
    manifest_key = upload_manifest(r2, r2_config, args.platform, manifest)
    removed_objects = [] if args.no_prune else prune_old_r2_releases(
        r2, r2_config, args.platform, keep=KEEP_RELEASES
    )

    print(
        "Release publicada exclusivamente no Cloudflare R2: "
        f"channel={args.channel} version={args.version} file={installer_path.name} "
        f"size={installer_path.stat().st_size} sha256={digest}"
    )
    print(f"Manifest URL: {public_object_url(r2_config, manifest_key)}")
    print("Banco de dados: nenhuma leitura ou gravacao de release realizada.")
    if removed_objects:
        print(f"Objetos antigos removidos do mesmo canal: {len(removed_objects)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
