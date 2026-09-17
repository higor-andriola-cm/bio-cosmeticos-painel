const axios = require('axios');

const HOST = 'https://main-api.vendr.com.br';
// Chave publica embutida no bundle JS do proprio app.vendr.com.br (nao e um segredo do usuario).
const API_KEY = '74wS8OgnxV4NmqR2w2QHN3GOzH3px9eB8seNM0Kx';

function decodeJwt(token) {
  const payload = token.split('.')[1];
  const json = Buffer.from(payload, 'base64').toString('utf8');
  return JSON.parse(json);
}

class VendrClient {
  constructor({ email, password }) {
    if (!email || !password) {
      throw new Error('VENDR_EMAIL e VENDR_PASSWORD precisam estar definidos no .env');
    }
    this.email = email;
    this.password = password;
    this.accessToken = null;
    this.refreshToken = null;
    this.idpAccessToken = null;
    this.idVendedor = null;
  }

  async login() {
    const { data } = await axios.post(
      `${HOST}/api/v1/oauth/signin`,
      {
        userName: this.email,
        senha: this.password,
        tipoUsuario: 'VENDEDOR',
        isValidarSenhaSegura: true,
      },
      { headers: { 'x-api-key': API_KEY } }
    );
    this._applyTokens(data);
  }

  async refresh() {
    if (!this.refreshToken) throw new Error('Sem refresh token disponivel');
    const { data } = await axios.post(
      `${HOST}/api/v1/oauth/refreshtoken`,
      { refreshtoken: this.refreshToken },
      { headers: { 'x-api-key': API_KEY } }
    );
    this._applyTokens(data);
  }

  _applyTokens(data) {
    this.accessToken = data.access_token;
    this.refreshToken = data.refresh_token || this.refreshToken;
    this.idpAccessToken = data.idp_access_token || this.idpAccessToken;
    const claims = decodeJwt(this.accessToken);
    this.idVendedor = claims.IdVendedor;
  }

  async ensureAuth() {
    if (this.accessToken) return;
    if (this.refreshToken) {
      try {
        await this.refresh();
        return;
      } catch (err) {
        // refresh token expirado/invalido: cai para login completo
      }
    }
    await this.login();
  }

  // path deve comecar com "/" e incluir o prefixo completo, ex: "/api/v1/relatorio/x" ou "/vendr/v1/graficos/y"
  async request(method, path, params) {
    await this.ensureAuth();
    try {
      return await this._doRequest(method, path, params);
    } catch (err) {
      if (err.response && err.response.status === 401) {
        this.accessToken = null;
        await this.ensureAuth();
        return this._doRequest(method, path, params);
      }
      throw err;
    }
  }

  async _doRequest(method, path, params) {
    const { data } = await axios.request({
      method,
      url: `${HOST}${path}`,
      params,
      headers: {
        'x-api-key': API_KEY,
        Authorization: `Bearer ${this.accessToken}`,
        'x-access-token': this.idpAccessToken || '',
      },
    });
    return data;
  }
}

module.exports = VendrClient;
