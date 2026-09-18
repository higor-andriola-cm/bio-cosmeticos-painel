const path = require('path');
const fs = require('fs');
const { exec, execSync } = require('child_process');

// Quando empacotado com pkg, o executavel fica sozinho numa pasta junto com
// public/ e .env; fora do pkg (rodando via "node server.js", inclusive no
// Render), essas pastas ficam um nivel acima de backend/.
const baseDir = process.pkg ? path.dirname(process.execPath) : path.join(__dirname, '..');

// Modo desktop = executavel local (.exe). So nesse modo faz sentido logar
// automatico via .env e salvar login no disco: e uma unica pessoa usando o
// proprio computador. No Render (ou qualquer "node server.js" fora do pkg)
// cada pessoa loga pela tela, e "lembrar" usa cookie em vez de arquivo.
const MODO_DESKTOP = !!process.pkg;

// O executavel roda sem janela de console (veja Abrir Painel.vbs), entao um
// erro fatal precisa aparecer de outro jeito: gravamos num log e mostramos
// um popup do Windows via PowerShell. Em servidor (Render) isso vira so log.
function mostrarErroCritico(mensagem) {
  console.error(mensagem);
  try {
    fs.appendFileSync(path.join(baseDir, 'erro.log'), `[${new Date().toISOString()}] ${mensagem}\n`);
  } catch (e) {
    // ignora falha ao gravar o log
  }
  if (MODO_DESKTOP) {
    try {
      const escapada = mensagem.replace(/'/g, "''");
      const comandoPs = `Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.MessageBox]::Show('${escapada}', 'Bio Cosmeticos - Painel de Vendas')`;
      execSync(`powershell -NoProfile -Command "${comandoPs}"`, { stdio: 'ignore' });
    } catch (e) {
      // ignora falha ao exibir o popup (ex: rodando fora do Windows)
    }
  }
}

function encerrarComErro(mensagem) {
  mostrarErroCritico(mensagem);
  process.exit(1);
}

require('dotenv').config({ path: path.join(baseDir, '.env') });
const express = require('express');
const session = require('express-session');
const VendrClient = require('./vendrClient');

const PORT = process.env.PORT || 3000;
const EM_PRODUCAO = process.env.NODE_ENV === 'production';
const app = express();

if (EM_PRODUCAO) {
  // Necessario para o cookie "secure" funcionar atras do proxy HTTPS do Render.
  app.set('trust proxy', 1);
}

app.use(express.json());
app.use(
  session({
    secret: process.env.SESSION_SECRET || 'chave-local-de-desenvolvimento',
    resave: false,
    saveUninitialized: true,
    cookie: {
      httpOnly: true,
      sameSite: 'lax',
      secure: EM_PRODUCAO,
    },
  })
);
app.use(express.static(path.join(baseDir, 'public')));

// Cada sessao (um navegador) tem seu proprio VendrClient — assim duas pessoas
// acessando ao mesmo tempo nao compartilham nem derrubam o login uma da outra.
const clientesPorSessao = new Map(); // sessionID -> { client, ultimoUso }
const SETE_DIAS_MS = 7 * 24 * 60 * 60 * 1000;

function getClient(req) {
  const entrada = clientesPorSessao.get(req.sessionID);
  if (!entrada) return null;
  entrada.ultimoUso = Date.now();
  return entrada.client;
}

function definirClient(req, client) {
  clientesPorSessao.set(req.sessionID, { client, ultimoUso: Date.now() });
}

function removerClient(req) {
  clientesPorSessao.delete(req.sessionID);
}

// No modo desktop, o login automatico via .env (definido mais abaixo, quando
// resolve) vale para a primeira sessao que acessar o painel. Precisa estar
// registrado antes das rotas para realmente valer a pena.
let clientAutomaticoDesktop = null;
app.use((req, res, next) => {
  if (clientAutomaticoDesktop && !clientesPorSessao.has(req.sessionID)) {
    definirClient(req, clientAutomaticoDesktop);
  }
  next();
});

setInterval(() => {
  const agora = Date.now();
  for (const [sid, entrada] of clientesPorSessao.entries()) {
    if (agora - entrada.ultimoUso > SETE_DIAS_MS) clientesPorSessao.delete(sid);
  }
}, 60 * 60 * 1000).unref();

function isoInicio(dateStr) {
  return `${dateStr}T00:00:00.000Z`;
}

function isoFim(dateStr) {
  return `${dateStr}T23:59:59.000Z`;
}

function handleErro(res, err) {
  const status = err.response ? err.response.status : 500;
  const message = err.response ? err.response.data : err.message;
  console.error('Erro ao consultar Vendr:', status, message);
  res.status(status).json({ error: message || 'Erro ao consultar a API do Vendr' });
}

function exigirLogin(req, res, next) {
  const client = getClient(req);
  if (!client) {
    return res.status(401).json({ error: 'Sessao nao autenticada. Faca login.' });
  }
  req.vendrClient = client;
  next();
}

function salvarCredenciaisEnv(email, password) {
  const envPath = path.join(baseDir, '.env');
  let conteudo = '';
  try {
    conteudo = fs.readFileSync(envPath, 'utf8');
  } catch (e) {
    conteudo = '';
  }
  const linhas = conteudo
    .split(/\r?\n/)
    .filter((l) => l.trim() && !l.startsWith('VENDR_EMAIL=') && !l.startsWith('VENDR_PASSWORD='));
  linhas.push(`VENDR_EMAIL=${email}`);
  linhas.push(`VENDR_PASSWORD=${password}`);
  fs.writeFileSync(envPath, `${linhas.join('\n')}\n`, 'utf8');
}

app.get('/api/session', (req, res) => {
  const client = getClient(req);
  res.json({ autenticado: !!client, idVendedor: client ? client.idVendedor : null });
});

app.post('/api/login', async (req, res) => {
  const email = (req.body.email || '').trim();
  const password = (req.body.password || '').trim();
  const lembrar = !!req.body.lembrar;
  if (!email || !password) {
    return res.status(400).json({ error: 'Informe e-mail e senha.' });
  }
  try {
    const novoClient = new VendrClient({ email, password });
    await novoClient.login();
    definirClient(req, novoClient);

    if (MODO_DESKTOP) {
      if (lembrar) {
        try {
          salvarCredenciaisEnv(email, password);
        } catch (e) {
          console.error('Nao foi possivel salvar o login no .env:', e.message);
        }
      }
    } else {
      // Sem .env compartilhado no servidor: "lembrar" so estende a validade do cookie.
      req.session.cookie.maxAge = lembrar ? 30 * 24 * 60 * 60 * 1000 : undefined;
    }

    console.log(`Login no Vendr OK (vendedor ${novoClient.idVendedor}).`);
    res.json({ ok: true, idVendedor: novoClient.idVendedor });
  } catch (err) {
    const status = err.response ? err.response.status : 500;
    console.error('Falha no login:', status, err.response ? err.response.data : err.message);
    res.status(401).json({ error: 'E-mail ou senha invalidos.' });
  }
});

app.post('/api/logout', (req, res) => {
  removerClient(req);
  res.json({ ok: true });
});

app.get('/api/vendas', exigirLogin, async (req, res) => {
  const { inicio, fim } = req.query;
  try {
    const data = await req.vendrClient.request('get', '/api/v1/relatorio/detalhevenda', {
      idVendedor: req.vendrClient.idVendedor,
      dtInicial: isoInicio(inicio),
      dtFinal: isoFim(fim),
      timezoneOffset: 180,
    });
    res.json(data);
  } catch (err) {
    handleErro(res, err);
  }
});

app.get('/api/produtos', exigirLogin, async (req, res) => {
  try {
    const data = await req.vendrClient.request('get', '/api/v1/relatorio/GetRelatorioProduto', {
      idVendedor: req.vendrClient.idVendedor,
    });
    res.json(data);
  } catch (err) {
    handleErro(res, err);
  }
});

app.get('/api/clientes', exigirLogin, async (req, res) => {
  const { inicio, fim } = req.query;
  try {
    const data = await req.vendrClient.request('get', '/api/v1/relatorio/GetRelatorioCliente', {
      idVendedor: req.vendrClient.idVendedor,
      dtInicial: isoInicio(inicio),
      dtFinal: isoFim(fim),
    });
    res.json(data);
  } catch (err) {
    handleErro(res, err);
  }
});

app.get('/api/estoque', exigirLogin, async (req, res) => {
  const { inicio, fim } = req.query;
  try {
    const data = await req.vendrClient.request('get', '/api/v1/relatorio/GetRelatorioEstoque', {
      idVendedor: req.vendrClient.idVendedor,
      dtInicial: isoInicio(inicio),
      dtFinal: isoFim(fim),
    });
    res.json(data);
  } catch (err) {
    handleErro(res, err);
  }
});

app.get('/api/receita-despesa', exigirLogin, async (req, res) => {
  const { inicio, fim } = req.query;
  try {
    const data = await req.vendrClient.request('get', '/vendr/v1/graficos/receitadespesa/paged', {
      DataGTE: inicio,
      DataLTE: fim,
      page: 1,
    });
    res.json(data);
  } catch (err) {
    handleErro(res, err);
  }
});

app.get('/reposicao', (req, res) => {
  res.sendFile(path.join(baseDir, 'public', 'reposicao.html'));
});

async function tentarLoginAutomatico() {
  if (!MODO_DESKTOP) return;
  const email = (process.env.VENDR_EMAIL || '').trim();
  const password = (process.env.VENDR_PASSWORD || '').trim();
  if (!email || !password) return null;
  try {
    const c = new VendrClient({ email, password });
    await c.login();
    console.log(`Login automatico via .env OK (vendedor ${c.idVendedor}).`);
    return c;
  } catch (err) {
    console.log('Login automatico via .env falhou; use a tela de login do painel.');
    return null;
  }
}

tentarLoginAutomatico().then((c) => {
  clientAutomaticoDesktop = c;

  const server = app.listen(PORT, () => {
    const url = `http://localhost:${PORT}`;
    console.log(`Painel Vendr rodando em ${url}`);
    if (MODO_DESKTOP) {
      exec(`start "" "${url}"`, (err) => {
        if (err) console.error('Nao foi possivel abrir o navegador automaticamente:', err.message);
      });
    }
  });

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      encerrarComErro(
        `A porta ${PORT} ja esta em uso (o painel provavelmente ja esta aberto). Abra http://localhost:${PORT} no navegador.`
      );
    } else {
      encerrarComErro(`Erro ao iniciar o servidor: ${err.message}`);
    }
  });
});
