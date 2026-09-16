#!/usr/bin/env python3
"""DACHBYTE Business staging smoke/integration checks.

Runs from the disposable validation container. It never mutates business data
except for optional Chat upload probes (small upload always when Chat auth is
configured; 10 MiB boundary probe only when explicitly enabled).
"""
from __future__ import annotations

import asyncio
import io
import json
import os
import sys
from dataclasses import dataclass
from typing import Any, Callable
from urllib.parse import quote, urlparse

import requests
import websockets


TRUE = {"1", "true", "yes", "on", "y"}


def env_first(*names: str, default: str = "") -> str:
    for name in names:
        value = os.getenv(name)
        if value is not None and str(value).strip() != "":
            return str(value).strip()
    return default


def env_bool_alias(primary: str, legacy: str, default: bool = False) -> bool:
    raw = env_first(primary, legacy, default="true" if default else "false")
    return raw.strip().lower() in TRUE


def clean_base(value: str) -> str:
    value = str(value or "").strip()
    if not value:
        return ""
    return value.rstrip("/")


PUBLIC_BASE = clean_base(env_first("VALIDATION_BASE_URL", "STAGING_BASE_URL", default="https://staging.dachbyte.tech"))
VERIFY_TLS = env_bool_alias("VALIDATION_VERIFY_TLS", "STAGING_VERIFY_TLS", True)
TIMEOUT = float(env_first("VALIDATION_HTTP_TIMEOUT_SECONDS", "STAGING_HTTP_TIMEOUT_SECONDS", default="15"))
RUN_AUTH = env_bool_alias("VALIDATION_RUN_AUTH_TESTS", "STAGING_RUN_AUTH_TESTS", True)
REQUIRE_AUTH = env_bool_alias("VALIDATION_REQUIRE_AUTH_TESTS", "STAGING_REQUIRE_AUTH_TESTS", True)
REQUIRE_PASSWORD_RESET = env_bool_alias("VALIDATION_REQUIRE_PASSWORD_RESET_CONFIG", "STAGING_REQUIRE_PASSWORD_RESET_CONFIG", True)
REQUIRE_DESKTOP_RELEASE = env_bool_alias("VALIDATION_REQUIRE_DESKTOP_RELEASE", "STAGING_REQUIRE_DESKTOP_RELEASE", False)
REQUIRE_HUB_VERIFY = env_bool_alias("VALIDATION_REQUIRE_HUB_VERIFY", "STAGING_REQUIRE_HUB_VERIFY", True)
REQUIRE_ISOLATION = env_bool_alias("VALIDATION_REQUIRE_ISOLATION_TESTS", "STAGING_REQUIRE_ISOLATION_TESTS", True)
TEST_LARGE_UPLOAD = env_bool_alias("VALIDATION_TEST_CHAT_LARGE_UPLOAD", "STAGING_TEST_CHAT_LARGE_UPLOAD", False)
DESKTOP_MANIFEST_URL = env_first("VALIDATION_DESKTOP_MANIFEST_URL", "STAGING_DESKTOP_MANIFEST_URL")
EXPECTED_DESKTOP_CHANNEL = env_first("VALIDATION_EXPECTED_DESKTOP_CHANNEL", "STAGING_EXPECTED_DESKTOP_CHANNEL")
LEGACY_PROBE_HEADERS = {"X-Dachbyte-Validation-Probe": "legacy-smoke"}


@dataclass
class Result:
    status: str
    name: str
    detail: str = ""


results: list[Result] = []


def record(status: str, name: str, detail: str = "") -> None:
    results.append(Result(status, name, detail))
    suffix = f" — {detail}" if detail else ""
    print(f"[{status}] {name}{suffix}", flush=True)


def passed(name: str, detail: str = "") -> None:
    record("PASS", name, detail)


def failed(name: str, detail: str = "") -> None:
    record("FAIL", name, detail)


def skipped(name: str, detail: str = "") -> None:
    record("SKIP", name, detail)


def request(method: str, path_or_url: str, *, session: requests.Session | None = None,
            expected: set[int] | None = None, allow_redirects: bool = True, **kwargs: Any) -> requests.Response:
    client = session or requests
    url = path_or_url if path_or_url.startswith(("http://", "https://")) else f"{PUBLIC_BASE}{path_or_url}"
    response = client.request(
        method,
        url,
        timeout=TIMEOUT,
        verify=VERIFY_TLS,
        allow_redirects=allow_redirects,
        **kwargs,
    )
    if expected is not None and response.status_code not in expected:
        body = response.text[:240].replace("\n", " ")
        raise AssertionError(f"HTTP {response.status_code}; esperado {sorted(expected)}; resposta={body!r}")
    return response


def safe_json(response: requests.Response) -> dict[str, Any]:
    try:
        payload = response.json()
    except Exception as exc:
        raise AssertionError(f"resposta nao e JSON: {response.text[:200]!r}") from exc
    if not isinstance(payload, dict):
        raise AssertionError(f"JSON inesperado: {type(payload).__name__}")
    return payload


def run_case(name: str, fn: Callable[[], str | None]) -> None:
    try:
        detail = fn() or ""
        passed(name, detail)
    except Exception as exc:
        failed(name, str(exc))


def check_internal_services() -> None:
    endpoints = {
        "portal container": "http://business-portal:3000/business/healthz",
        "core container": "http://business-core:3000/business/core/healthz",
        "core database health": "http://business-core:3000/business/core/api/health",
        "chat web container": "http://business-chat:3000/business/chat/healthz",
        "chat API database health": "http://business-chat-api:8001/health",
        "stock container": "http://business-stock:3000/business/stock/healthz",
        "stock database health": "http://business-stock:3000/business/stock/api/health",
        "price container": "http://business-price:3000/business/price/healthz",
        "price database health": "http://business-price:3000/business/price/health",
    }
    for name, url in endpoints.items():
        def _one(url=url) -> str:
            response = request("GET", url, expected={200})
            return f"HTTP {response.status_code}"
        run_case(f"internal: {name}", _one)


def _assert_legacy_headers(response: requests.Response, canonical_path: str) -> str:
    if response.headers.get("X-Dachbyte-Legacy-Route", "").lower() != "true":
        raise AssertionError("header X-Dachbyte-Legacy-Route ausente")
    if response.headers.get("Deprecation", "").lower() != "true":
        raise AssertionError("header Deprecation ausente")
    advertised = response.headers.get("X-Dachbyte-Canonical-Path", "")
    if advertised != canonical_path:
        raise AssertionError(f"canonical path anunciado={advertised!r}; esperado={canonical_path!r}")
    return canonical_path


def _assert_redirect(response: requests.Response, canonical_path: str) -> str:
    location = response.headers.get("Location", "")
    if not location:
        raise AssertionError("redirect sem Location")
    parsed = urlparse(location)
    actual_path = parsed.path or location.split("?", 1)[0]
    if actual_path.rstrip("/") != canonical_path.rstrip("/"):
        raise AssertionError(f"Location={location!r}; esperado caminho {canonical_path!r}")
    return location


def check_public_routes() -> None:
    canonical_ui = {
        "portal canonical": "/business",
        "core canonical": "/business/core",
        "chat canonical": "/business/chat",
        "stock canonical": "/business/stock",
        "price canonical": "/business/price",
    }
    for name, path in canonical_ui.items():
        def _ui(path=path) -> str:
            response = request("GET", path, expected={200})
            if not response.content:
                raise AssertionError("resposta vazia")
            return f"HTTP {response.status_code}, {len(response.content)} bytes"
        run_case(f"public UI: {name}", _ui)

    legacy_ui = {
        "core legacy": ("/core", "/business/core"),
        "chat legacy": ("/chat", "/business/chat"),
        "stock legacy": ("/voltstock", "/business/stock"),
        "price legacy": ("/volt-price", "/business/price"),
        "voltchat alias": ("/voltchat", "/business/chat"),
        "volt_chat alias": ("/volt_chat", "/business/chat"),
        "stock short alias": ("/stock", "/business/stock"),
    }
    for name, (path, canonical) in legacy_ui.items():
        def _legacy_ui(path=path, canonical=canonical) -> str:
            response = request("GET", path, expected={308}, allow_redirects=False, headers=LEGACY_PROBE_HEADERS)
            return f"HTTP 308 -> {_assert_redirect(response, canonical)}"
        run_case(f"legacy UI redirect: {name}", _legacy_ui)

    def _legacy_nested_redirect() -> str:
        response = request("GET", "/chat/login?legacy_probe=1", expected={308}, allow_redirects=False, headers=LEGACY_PROBE_HEADERS)
        location = _assert_redirect(response, "/business/chat/login")
        if "legacy_probe=1" not in location:
            raise AssertionError(f"query string perdida no redirect: {location!r}")
        return location
    run_case("legacy UI preserves suffix/query", _legacy_nested_redirect)

    canonical_health = {
        "core canonical API": "/business/core/api/health",
        "chat canonical API": "/business/chat/api/health",
        "stock canonical API": "/business/stock/api/health",
        "price canonical service": "/business/price/health",
    }
    for name, path in canonical_health.items():
        def _health(path=path) -> str:
            response = request("GET", path, expected={200})
            payload = safe_json(response)
            return f"HTTP 200, ok={payload.get('ok', payload.get('status', 'n/a'))}"
        run_case(f"public health: {name}", _health)

    legacy_health = {
        "core legacy API": ("/api/core/health", "/business/core/api"),
        "chat legacy API": ("/chat-api/health", "/business/chat/api"),
        "chat transitional legacy API": ("/business/chat-api/health", "/business/chat/api"),
        "stock legacy API": ("/voltstock/api/health", "/business/stock/api"),
        "price legacy service": ("/volt-price/health", "/business/price/health"),
    }
    for name, (path, canonical) in legacy_health.items():
        def _legacy_health(path=path, canonical=canonical) -> str:
            response = request("GET", path, expected={200}, allow_redirects=False, headers=LEGACY_PROBE_HEADERS)
            payload = safe_json(response)
            _assert_legacy_headers(response, canonical)
            return f"HTTP 200 deprecated, ok={payload.get('ok', payload.get('status', 'n/a'))}"
        run_case(f"legacy API compatibility: {name}", _legacy_health)

    canonical_unauthorized = {
        "core canonical auth guard": "/business/core/api/auth/me",
        "chat canonical auth guard": "/business/chat/api/auth/me",
        "stock canonical auth guard": "/business/stock/api/v1/me",
        "price canonical auth guard": "/business/price/api/auth/me",
    }
    for name, path in canonical_unauthorized.items():
        def _guard(path=path) -> str:
            response = request("GET", path, expected={401, 403})
            return f"HTTP {response.status_code}"
        run_case(f"public API: {name}", _guard)

    legacy_unauthorized = {
        "core legacy auth guard": ("/api/core/auth/me", "/business/core/api"),
        "chat legacy auth guard": ("/chat-api/auth/me", "/business/chat/api"),
        "stock legacy auth guard": ("/voltstock/api/v1/me", "/business/stock/api"),
        "price legacy auth guard": ("/volt-price/api/auth/me", "/business/price/api"),
    }
    for name, (path, canonical) in legacy_unauthorized.items():
        def _legacy_guard(path=path, canonical=canonical) -> str:
            response = request("GET", path, expected={401, 403}, allow_redirects=False, headers=LEGACY_PROBE_HEADERS)
            _assert_legacy_headers(response, canonical)
            return f"HTTP {response.status_code} deprecated"
        run_case(f"legacy API guard: {name}", _legacy_guard)

    def _canonical_version() -> str:
        response = request("GET", "/business/chat/version.json", expected={200})
        payload = safe_json(response)
        return str(payload.get("version") or "version.json ok")
    run_case("chat canonical version", _canonical_version)

    def _legacy_chat_version() -> str:
        response = request("GET", "/chat/version.json", expected={308}, allow_redirects=False, headers=LEGACY_PROBE_HEADERS)
        return _assert_redirect(response, "/business/chat/version.json")
    run_case("chat legacy version redirect", _legacy_chat_version)

    def _root_compat_version() -> str:
        response = request("GET", "/version.json", expected={200}, allow_redirects=False, headers=LEGACY_PROBE_HEADERS)
        _assert_legacy_headers(response, "/business/chat/version.json")
        payload = safe_json(response)
        return str(payload.get("version") or "version.json ok")
    run_case("chat root compatibility version", _root_compat_version)


def check_password_reset_config() -> None:
    if not REQUIRE_PASSWORD_RESET:
        skipped("Chat password reset configuration", "STAGING_REQUIRE_PASSWORD_RESET_CONFIG=false")
        return

    def _probe() -> str:
        # Nonexistent address intentionally exercises Brevo configuration without sending mail.
        response = request(
            "POST",
            "/business/chat/api/auth/forgot-password",
            expected={200},
            json={"email": "staging-probe-nonexistent@invalid.example"},
        )
        payload = safe_json(response)
        if "message" not in payload:
            raise AssertionError("resposta generica de recuperacao ausente")
        return "configuracao de recuperacao carregada; nenhum email enviado"
    run_case("Chat password reset configuration", _probe)


def check_desktop_release() -> None:
    if not REQUIRE_DESKTOP_RELEASE:
        skipped("Chat desktop release manifest", "nao exigido neste ambiente")
        return
    if not DESKTOP_MANIFEST_URL:
        failed(
            "Chat desktop release manifest",
            "VALIDATION_DESKTOP_MANIFEST_URL/STAGING_DESKTOP_MANIFEST_URL obrigatoria quando o gate de desktop esta ativo",
        )
        return

    def _probe() -> str:
        response = request("GET", DESKTOP_MANIFEST_URL, expected={200})
        payload = safe_json(response)
        channel = str(payload.get("channel") or "production").strip().lower()
        if EXPECTED_DESKTOP_CHANNEL and channel != EXPECTED_DESKTOP_CHANNEL.strip().lower():
            raise AssertionError(
                f"canal inesperado: manifesto={channel!r} esperado={EXPECTED_DESKTOP_CHANNEL!r}"
            )
        if not payload.get("version") or not payload.get("sha256") or not payload.get("download_url"):
            raise AssertionError("manifesto R2 incompleto")
        return f"channel={channel} version={payload['version']}"
    run_case("Chat desktop release manifest", _probe)


def credentials(prefix: str) -> tuple[str, str]:
    return (
        env_first(f"VALIDATION_{prefix}_USER", f"STAGING_{prefix}_USER"),
        env_first(f"VALIDATION_{prefix}_PASSWORD", f"STAGING_{prefix}_PASSWORD"),
    )


def required_credentials(prefix: str, label: str) -> tuple[str, str] | None:
    user, password = credentials(prefix)
    if user and password:
        return user, password
    message = f"defina STAGING_{prefix}_USER e STAGING_{prefix}_PASSWORD"
    if REQUIRE_AUTH:
        failed(label, message)
    else:
        skipped(label, message)
    return None


def check_hub_verify() -> None:
    if not RUN_AUTH:
        skipped("Hub internal auth verify", "STAGING_RUN_AUTH_TESTS=false")
        return
    if not REQUIRE_HUB_VERIFY:
        skipped("Hub internal auth verify", "STAGING_REQUIRE_HUB_VERIFY=false")
        return
    user, password = credentials("CORE")
    hub_base = clean_base(os.getenv("HUB_BASE_URL", ""))
    hub_token = os.getenv("HUB_INTERNAL_TOKEN", "").strip()
    if not user or not password:
        if REQUIRE_AUTH:
            failed("Hub internal auth verify", "use uma conta STAGING_CORE_USER/PASSWORD autorizada no Hub")
        else:
            skipped("Hub internal auth verify", "credenciais Core ausentes no public smoke")
        return
    if not hub_base or not hub_token:
        failed("Hub internal auth verify", "HUB_BASE_URL/HUB_INTERNAL_TOKEN ausentes no container de validacao")
        return

    def _probe() -> str:
        response = request(
            "POST",
            f"{hub_base}/v1/internal/auth/verify",
            expected={200},
            headers={"Authorization": f"Bearer {hub_token}", "Content-Type": "application/json"},
            json={"email": user, "password": password, "module": "volt_core"},
        )
        payload = safe_json(response)
        if payload.get("allow") is not True:
            raise AssertionError(f"Hub negou volt_core: reason={payload.get('reason') or payload.get('error')}")
        return f"allow=true tenant_id={payload.get('tenant_id')} user_id={payload.get('user_id')}"
    run_case("Hub internal auth verify", _probe)


async def chat_websocket_probe(token: str) -> str:
    parsed = urlparse(PUBLIC_BASE)
    scheme = "wss" if parsed.scheme == "https" else "ws"
    ws_url = f"{scheme}://{parsed.netloc}/business/chat/api/messages/ws/{quote(token, safe='')}?client_id=staging-smoke"
    ssl_context = None
    if scheme == "wss" and not VERIFY_TLS:
        import ssl
        ssl_context = ssl._create_unverified_context()
    async with websockets.connect(ws_url, open_timeout=TIMEOUT, close_timeout=5, ssl=ssl_context) as websocket:
        frame = await asyncio.wait_for(websocket.recv(), timeout=TIMEOUT)
        parsed_frame = json.loads(frame)
        if not isinstance(parsed_frame, dict) or not parsed_frame.get("type"):
            raise AssertionError(f"frame inicial inesperado: {frame[:180]!r}")
        return str(parsed_frame.get("type"))


def chat_login(user: str, password: str) -> tuple[str, dict[str, Any]]:
    response = request(
        "POST",
        "/business/chat/api/auth/login",
        expected={200},
        json={"username": user, "password": password, "remember_me": False},
    )
    payload = safe_json(response)
    token = str(payload.get("access_token") or "")
    if not token:
        raise AssertionError("access_token ausente")
    return token, payload


def check_chat_auth() -> None:
    if not RUN_AUTH:
        skipped("Chat authenticated flow", "STAGING_RUN_AUTH_TESTS=false")
        return
    creds = required_credentials("CHAT", "Chat authenticated flow")
    if not creds:
        return
    user, password = creds
    state: dict[str, Any] = {}

    def _login() -> str:
        token, payload = chat_login(user, password)
        state["token"] = token
        state["login"] = payload
        info = payload.get("user") or {}
        if info.get("must_change_password"):
            raise AssertionError("usuario de staging exige troca de senha; use uma conta de teste pronta")
        return f"user_id={info.get('id')} company_id={info.get('company_id')}"
    run_case("Chat login canonical", _login)
    token = state.get("token")
    if not token:
        return
    headers = {"Authorization": f"Bearer {token}"}

    def _me() -> str:
        response = request("GET", "/business/chat/api/auth/me", expected={200}, headers=headers)
        payload = safe_json(response)
        state["me"] = payload
        return f"user_id={payload.get('id')} companies={len(payload.get('companies') or [])}"
    run_case("Chat authenticated /auth/me", _me)

    def _ws() -> str:
        frame_type = asyncio.run(chat_websocket_probe(token))
        return f"handshake + frame type={frame_type}"
    run_case("Chat WebSocket canonical", _ws)

    marker = b"dachbyte-staging-download-probe\n"

    def _upload_download() -> str:
        upload = request(
            "POST",
            "/business/chat/api/files/upload",
            expected={200},
            headers=headers,
            files={"file": ("staging-smoke.txt", io.BytesIO(marker), "text/plain")},
        )
        payload = safe_json(upload)
        file_id = payload.get("id")
        if not file_id:
            raise AssertionError("upload nao retornou id")
        download = request(
            "GET",
            f"/business/chat/api/files/download/{file_id}",
            expected={200},
            headers=headers,
        )
        if download.content != marker:
            raise AssertionError(f"download divergiu do upload ({len(download.content)} bytes)")
        return f"upload/download autenticado ok, file_id={file_id}"
    run_case("Chat small upload + authenticated download", _upload_download)

    user_b, pass_b = credentials("CHAT_B")
    if user_b and pass_b:
        def _chat_isolation() -> str:
            token_b, payload_b = chat_login(user_b, pass_b)
            del token_b
            companies_a = (state.get("me") or {}).get("companies") or []
            companies_b = (payload_b.get("user") or {}).get("companies") or []
            ids_a = {str(item.get("company_id")) for item in companies_a if item.get("company_id")}
            foreign = next((item for item in companies_b if str(item.get("company_id")) not in ids_a), None)
            if not foreign:
                raise AssertionError("as duas contas nao fornecem empresas distintas para o teste de isolamento")
            foreign_id = quote(str(foreign["company_id"]), safe="")
            response = request(
                "GET",
                f"/business/chat/api/files/?company_id={foreign_id}",
                expected={403, 404},
                headers=headers,
            )
            return f"empresa estrangeira bloqueada com HTTP {response.status_code}"
        run_case("Chat cross-company isolation", _chat_isolation)
    else:
        message = "defina STAGING_CHAT_B_USER/PASSWORD com outra empresa"
        if REQUIRE_ISOLATION:
            failed("Chat cross-company isolation", message)
        else:
            skipped("Chat cross-company isolation", message)

    if TEST_LARGE_UPLOAD:
        def _large_upload() -> str:
            ten_mib = 10 * 1024 * 1024
            allowed = request(
                "POST",
                "/business/chat/api/files/upload",
                expected={200},
                headers=headers,
                files={"file": ("staging-10m.txt", io.BytesIO(b"a" * ten_mib), "text/plain")},
            )
            allowed_payload = safe_json(allowed)
            rejected = request(
                "POST",
                "/business/chat/api/files/upload",
                expected={400},
                headers=headers,
                files={"file": ("staging-over-10m.txt", io.BytesIO(b"b" * (ten_mib + 1)), "text/plain")},
            )
            return f"10 MiB aceito (file_id={allowed_payload.get('id')}); 10 MiB + 1 byte rejeitado"
        run_case("Chat 10 MiB upload boundary", _large_upload)
    else:
        skipped("Chat 10 MiB upload boundary", "ative STAGING_TEST_CHAT_LARGE_UPLOAD=true uma vez antes do go-live")


def core_login(user: str, password: str) -> tuple[requests.Session, dict[str, Any]]:
    session = requests.Session()
    response = request(
        "POST", "/business/core/api/auth/login", session=session, expected={200},
        json={"email": user, "password": password},
    )
    return session, safe_json(response)


def check_core_auth() -> None:
    if not RUN_AUTH:
        skipped("Core authenticated flow", "STAGING_RUN_AUTH_TESTS=false")
        return
    creds = required_credentials("CORE", "Core authenticated flow")
    if not creds:
        return
    state: dict[str, Any] = {}

    def _login() -> str:
        session, payload = core_login(*creds)
        state["session"] = session
        state["payload"] = payload
        user = payload.get("user") or {}
        companies = payload.get("companies") or []
        return f"role={user.get('role')} companies={len(companies)}"
    run_case("Core login canonical", _login)
    session = state.get("session")
    if not session:
        return

    def _me() -> str:
        response = request("GET", "/business/core/api/auth/me", session=session, expected={200})
        payload = safe_json(response)
        return f"selectedCompanyId={payload.get('selectedCompanyId')}"
    run_case("Core authenticated /auth/me", _me)

    user_b, pass_b = credentials("CORE_B")
    if user_b and pass_b:
        def _isolation() -> str:
            session_b, payload_b = core_login(user_b, pass_b)
            del session_b
            companies_a = state["payload"].get("companies") or []
            companies_b = payload_b.get("companies") or []
            ids_a = {str(item.get("id")) for item in companies_a if item.get("id")}
            foreign = next((item for item in companies_b if str(item.get("id")) not in ids_a), None)
            if not foreign:
                raise AssertionError("as duas contas nao fornecem empresas distintas para o teste de isolamento")
            foreign_id = quote(str(foreign["id"]), safe="")
            response = request(
                "GET",
                f"/business/core/api/runtime/companies/{foreign_id}/workspace",
                session=session,
                expected={403, 404},
            )
            return f"empresa estrangeira bloqueada com HTTP {response.status_code}"
        run_case("Core cross-company isolation", _isolation)
    else:
        message = "defina STAGING_CORE_B_USER/PASSWORD com outra empresa"
        if REQUIRE_ISOLATION:
            failed("Core cross-company isolation", message)
        else:
            skipped("Core cross-company isolation", message)


def stock_login(user: str, password: str) -> dict[str, Any]:
    response = request(
        "POST",
        "/business/stock/api/v1/auth/login",
        expected={200},
        json={"email": user, "password": password},
    )
    return safe_json(response)


def check_stock_auth() -> None:
    if not RUN_AUTH:
        skipped("Stock authenticated flow", "STAGING_RUN_AUTH_TESTS=false")
        return
    creds = required_credentials("STOCK", "Stock authenticated flow")
    if not creds:
        return
    state: dict[str, Any] = {}

    def _login() -> str:
        payload = stock_login(*creds)
        token = str(payload.get("accessToken") or "")
        if not token:
            raise AssertionError("accessToken ausente")
        state["payload"] = payload
        state["token"] = token
        user = payload.get("user") or {}
        return f"tenantId={user.get('tenantId')} companyId={user.get('companyId')}"
    run_case("Stock login canonical", _login)
    token = state.get("token")
    if not token:
        return

    def _me() -> str:
        response = request(
            "GET",
            "/business/stock/api/v1/me",
            expected={200},
            headers={"Authorization": f"Bearer {token}"},
        )
        payload = safe_json(response)
        return f"tenantId={(payload.get('user') or {}).get('tenantId')}"
    run_case("Stock authenticated /v1/me", _me)


def price_login(user: str, password: str, path: str = "/business/price") -> tuple[requests.Session, dict[str, Any]]:
    session = requests.Session()
    headers = LEGACY_PROBE_HEADERS if path.startswith("/volt-price") else None
    response = request(
        "POST",
        f"{path}/api/auth/login",
        session=session,
        expected={200},
        headers=headers,
        json={"email": user, "password": password},
    )
    return session, safe_json(response)


def check_price_auth() -> None:
    if not RUN_AUTH:
        skipped("Price authenticated flow", "STAGING_RUN_AUTH_TESTS=false")
        return
    creds = required_credentials("PRICE", "Price authenticated flow")
    if not creds:
        return
    state: dict[str, Any] = {}

    def _canonical() -> str:
        session, payload = price_login(*creds)
        state["session"] = session
        user = payload.get("user") or {}
        response = request("GET", "/business/price/api/auth/me", session=session, expected={200})
        me = safe_json(response).get("user") or {}
        return f"tenantId={me.get('tenantId')} platformAdmin={bool(user.get('isPlatformAdmin'))}"
    run_case("Price canonical login + cookie scope", _canonical)

    def _legacy() -> str:
        session, _payload = price_login(*creds, path="/volt-price")
        response = request("GET", "/volt-price/api/auth/me", session=session, expected={200}, headers=LEGACY_PROBE_HEADERS)
        return f"legacy cookie scope HTTP {response.status_code}"
    run_case("Price legacy login compatibility", _legacy)


def main() -> int:
    print("DACHBYTE Business — staging validation", flush=True)
    print(f"Public base: {PUBLIC_BASE}", flush=True)
    print(f"TLS verification: {VERIFY_TLS}", flush=True)
    print("", flush=True)

    if not PUBLIC_BASE.startswith(("http://", "https://")):
        failed("configuration", "STAGING_BASE_URL precisa iniciar com http:// ou https://")
    else:
        check_internal_services()
        check_public_routes()
        check_password_reset_config()
        check_desktop_release()
        check_hub_verify()
        check_chat_auth()
        check_core_auth()
        check_stock_auth()
        check_price_auth()

    failures = [item for item in results if item.status == "FAIL"]
    skips = [item for item in results if item.status == "SKIP"]
    passes = [item for item in results if item.status == "PASS"]
    print("\n--- summary ---", flush=True)
    print(f"PASS={len(passes)} FAIL={len(failures)} SKIP={len(skips)}", flush=True)
    if failures:
        print("Staging gate: FAILED", flush=True)
        return 1
    print("Staging gate: PASSED", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
