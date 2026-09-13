"""
Teste do sistema de WebSocket
"""

import asyncio
import websockets
import json
import requests
from datetime import datetime

# Configuração
API_BASE = "http://127.0.0.1:8001"
WS_BASE = "ws://127.0.0.1:8001"


async def test_websocket_chat():
    """Testa o sistema de chat via WebSocket"""

    print("🧪 Testando sistema de WebSocket...")

    # 1. Fazer login para obter token
    login_response = requests.post(f"{API_BASE}/auth/login", json={
        "username": "admin",
        "password": "admin123"
    })

    if login_response.status_code != 200:
        print("❌ Erro no login")
        return

    token = login_response.json()["access_token"]
    user_info = login_response.json()["user"]

    print(f"✅ Login realizado: {user_info['full_name']}")

    # 2. Conectar ao WebSocket
    ws_url = f"{WS_BASE}/messages/ws/{token}"

    try:
        async with websockets.connect(ws_url) as websocket:
            print("✅ Conectado ao WebSocket")

            # 3. Enviar mensagem de teste
            test_message = {
                "type": "chat_message",
                "content": f"Mensagem de teste - {datetime.now().strftime('%H:%M:%S')}",
                "message_type": "text"
            }

            await websocket.send(json.dumps(test_message))
            print("📤 Mensagem enviada")

            # 4. Aguardar resposta
            try:
                response = await asyncio.wait_for(websocket.recv(), timeout=5.0)
                response_data = json.loads(response)
                print(f"📥 Resposta recebida: {response_data}")

                if response_data.get("type") == "new_message":
                    print("✅ Mensagem processada com sucesso!")

            except asyncio.TimeoutError:
                print("⏰ Timeout aguardando resposta")

            # 5. Testar indicador de digitação
            typing_message = {
                "type": "typing",
                "is_typing": True
            }

            await websocket.send(json.dumps(typing_message))
            print("⌨️ Indicador de digitação enviado")

            # Parar de digitar
            typing_message["is_typing"] = False
            await websocket.send(json.dumps(typing_message))

            print("✅ Teste de WebSocket concluído!")

    except Exception as e:
        print(f"❌ Erro no WebSocket: {e}")


def test_api_endpoints():
    """Testa todos os endpoints da API"""

    print("\n🧪 Testando todos os endpoints...")

    # Login
    login_response = requests.post(f"{API_BASE}/auth/login", json={
        "username": "admin",
        "password": "admin123"
    })

    if login_response.status_code != 200:
        print("❌ Erro no login")
        return

    token = login_response.json()["access_token"]
    headers = {"Authorization": f"Bearer {token}"}

    # Testes dos endpoints
    endpoints_to_test = [
        ("GET", "/", "Página inicial"),
        ("GET", "/health", "Health check"),
        ("GET", "/auth/me", "Perfil do usuário"),
        ("GET", "/auth/permissions", "Permissões"),
        ("GET", "/users/", "Lista de usuários"),
        ("GET", "/tickets/", "Lista de tickets"),
        ("GET", "/tasks/", "Lista de tasks"),
        ("GET", "/messages/", "Lista de mensagens"),
        ("GET", "/messages/online-users", "Usuários online"),
        ("GET", "/dashboard/overview", "Dashboard overview"),
        ("GET", "/dashboard/charts/tickets-by-priority", "Gráfico de tickets"),
        ("GET", "/dashboard/performance", "Métricas de performance"),
    ]

    successful_tests = 0
    total_tests = len(endpoints_to_test)

    for method, endpoint, description in endpoints_to_test:
        try:
            if method == "GET":
                response = requests.get(f"{API_BASE}{endpoint}", headers=headers)

            if response.status_code == 200:
                print(f"✅ {description}")
                successful_tests += 1
            else:
                print(f"❌ {description} - Status: {response.status_code}")

        except Exception as e:
            print(f"❌ {description} - Erro: {e}")

    print(f"\n📊 Resultado: {successful_tests}/{total_tests} testes passaram")

    if successful_tests == total_tests:
        print("🎉 Todos os testes passaram!")
    else:
        print("⚠️ Alguns testes falharam")


async def main():
    """Função principal de teste"""

    print("🚀 Volt Corp - Teste Completo do Sistema")
    print("=" * 50)

    # Testar API REST
    test_api_endpoints()

    # Testar WebSocket
    await test_websocket_chat()

    print("\n" + "=" * 50)
    print("🎉 Testes concluídos!")


if __name__ == "__main__":
    asyncio.run(main())