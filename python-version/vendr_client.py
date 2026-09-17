import base64
import json

import requests

HOST = "https://main-api.vendr.com.br"
# Chave publica embutida no bundle JS do proprio app.vendr.com.br (nao e um segredo do usuario).
API_KEY = "74wS8OgnxV4NmqR2w2QHN3GOzH3px9eB8seNM0Kx"


def _decode_jwt(token):
    payload = token.split(".")[1]
    padding = "=" * (-len(payload) % 4)
    data = base64.urlsafe_b64decode(payload + padding)
    return json.loads(data)


class VendrClient:
    def __init__(self, email, password):
        if not email or not password:
            raise ValueError("VENDR_EMAIL e VENDR_PASSWORD precisam estar definidos no .env")
        self.email = email
        self.password = password
        self.access_token = None
        self.refresh_token = None
        self.idp_access_token = None
        self.id_vendedor = None

    def _apply_tokens(self, data):
        self.access_token = data["access_token"]
        self.refresh_token = data.get("refresh_token", self.refresh_token)
        self.idp_access_token = data.get("idp_access_token", self.idp_access_token)
        claims = _decode_jwt(self.access_token)
        self.id_vendedor = claims.get("IdVendedor")

    def login(self):
        resp = requests.post(
            f"{HOST}/api/v1/oauth/signin",
            json={
                "userName": self.email,
                "senha": self.password,
                "tipoUsuario": "VENDEDOR",
                "isValidarSenhaSegura": True,
            },
            headers={"x-api-key": API_KEY},
            timeout=30,
        )
        resp.raise_for_status()
        self._apply_tokens(resp.json())

    def refresh(self):
        if not self.refresh_token:
            raise RuntimeError("Sem refresh token disponivel")
        resp = requests.post(
            f"{HOST}/api/v1/oauth/refreshtoken",
            json={"refreshtoken": self.refresh_token},
            headers={"x-api-key": API_KEY},
            timeout=30,
        )
        resp.raise_for_status()
        self._apply_tokens(resp.json())

    def ensure_auth(self):
        if self.access_token:
            return
        if self.refresh_token:
            try:
                self.refresh()
                return
            except requests.RequestException:
                pass
        self.login()

    def request(self, method, path, params=None):
        self.ensure_auth()
        resp = self._do_request(method, path, params)
        if resp.status_code == 401:
            self.access_token = None
            self.ensure_auth()
            resp = self._do_request(method, path, params)
        resp.raise_for_status()
        return resp.json()

    def _do_request(self, method, path, params):
        return requests.request(
            method,
            f"{HOST}{path}",
            params=params,
            headers={
                "x-api-key": API_KEY,
                "Authorization": f"Bearer {self.access_token}",
                "x-access-token": self.idp_access_token or "",
            },
            timeout=30,
        )
