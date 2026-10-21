const el = (id) => document.getElementById(id);
const statusEl = el('status');
const kpisEl = el('kpis');
const insightsEl = el('insights');
const gerarBtn = el('gerar');
const contagemVendasEl = el('contagemVendas');
const contagemProdutosEl = el('contagemProdutos');

const chartInstances = {};
const vendasDetalheState = { pedidos: [], filtro: '', pagina: 1, pageSize: 50 };
const produtosDetalheState = { produtos: [], filtro: '', pagina: 1, pageSize: 50 };

let vendasAtualRaw = [];
let clientesInfoAtual = [];

const MESES_PT = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];

function hoje() {
  return new Date().toISOString().slice(0, 10);
}

function primeiroDiaDoMes() {
  const d = new Date();
  return new Date(d.getFullYear(), d.getMonth(), 1).toISOString().slice(0, 10);
}

el('dataInicial').value = primeiroDiaDoMes();
el('dataFinal').value = hoje();

function formatBRL(valor) {
  const n = Number(valor) || 0;
  return n.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}

function formatData(valor) {
  if (!valor) return '';
  return new Date(valor).toLocaleDateString('pt-BR');
}

function setStatus(msg, isError = false) {
  statusEl.textContent = msg;
  statusEl.classList.toggle('error', isError);
}

async function fetchJSON(url, options) {
  const res = await fetch(url, options);
  const data = await res.json();
  if (res.status === 401) {
    mostrarTelaLogin('Sessão encerrada. Faça login novamente.');
    throw new Error('Sessão encerrada.');
  }
  if (!res.ok) {
    const msg = (data && data.error && (data.error.message || JSON.stringify(data.error))) || 'Falha ao consultar o Vendr';
    throw new Error(msg);
  }
  return data;
}

// ---------- Datas ----------

function parseDate(str) {
  return new Date(`${str}T00:00:00`);
}

function toISO(d) {
  return d.toISOString().slice(0, 10);
}

function addDays(d, n) {
  const r = new Date(d);
  r.setDate(r.getDate() + n);
  return r;
}

function periodoAnterior(inicioStr, fimStr) {
  const inicio = parseDate(inicioStr);
  const fim = parseDate(fimStr);
  const dias = Math.round((fim - inicio) / 86400000) + 1;
  const anteriorFim = addDays(inicio, -1);
  const anteriorInicio = addDays(anteriorFim, -(dias - 1));
  return { inicio: toISO(anteriorInicio), fim: toISO(anteriorFim) };
}

function inicioMesesAtras(fimStr, n) {
  const fim = parseDate(fimStr);
  const d = new Date(fim.getFullYear(), fim.getMonth() - (n - 1), 1);
  return toISO(d);
}

// ---------- Tabelas genéricas ----------

function criarTabela(rows, columns) {
  const table = document.createElement('table');
  const thead = document.createElement('thead');
  const headRow = document.createElement('tr');
  columns.forEach((c) => {
    const th = document.createElement('th');
    th.textContent = c.label;
    headRow.appendChild(th);
  });
  thead.appendChild(headRow);

  const tbody = document.createElement('tbody');
  if (!rows || rows.length === 0) {
    const tr = document.createElement('tr');
    const td = document.createElement('td');
    td.colSpan = columns.length;
    td.textContent = 'Nenhum dado encontrado para o período selecionado.';
    tr.appendChild(td);
    tbody.appendChild(tr);
  } else {
    rows.forEach((row) => {
      const tr = document.createElement('tr');
      columns.forEach((c) => {
        const td = document.createElement('td');
        const raw = row[c.key];
        const texto = c.format ? c.format(raw, row) : (raw ?? '');
        if (c.clickable) {
          const btn = document.createElement('button');
          btn.type = 'button';
          btn.className = 'link-btn';
          btn.textContent = texto;
          btn.addEventListener('click', () => c.onClick(row));
          td.appendChild(btn);
        } else {
          td.textContent = texto;
          if (c.className) td.className = typeof c.className === 'function' ? c.className(row) : c.className;
        }
        tr.appendChild(td);
      });
      tbody.appendChild(tr);
    });
  }
  table.appendChild(thead);
  table.appendChild(tbody);
  return table;
}

function montarTabelaEm(containerId, rows, columns) {
  const wrap = el(containerId);
  wrap.innerHTML = '';
  wrap.appendChild(criarTabela(rows, columns));
}

// ---------- Modal ----------

function abrirModal(titulo) {
  el('modalTitulo').textContent = titulo;
  el('modalExtra').innerHTML = '';
  el('modalCorpo').innerHTML = '';
  el('modalOverlay').hidden = false;
}

function fecharModal() {
  el('modalOverlay').hidden = true;
}

el('modalFechar').addEventListener('click', fecharModal);
el('modalOverlay').addEventListener('click', (e) => {
  if (e.target === el('modalOverlay')) fecharModal();
});

function mostrarNoModal(rows, columns) {
  const corpo = el('modalCorpo');
  corpo.innerHTML = '';
  corpo.appendChild(criarTabela(rows, columns));
}

// ---------- Agregações ----------

function calcularKPIs(vendas) {
  const pedidos = new Set();
  const clientes = new Set();
  let faturamento = 0;
  (vendas || []).forEach((v) => {
    faturamento += Number(v.vlTotal) || 0;
    pedidos.add(v.id_pedido);
    clientes.add((v.cliente || '').trim().toUpperCase());
  });
  const qtdPedidos = pedidos.size;
  return {
    faturamento,
    pedidos: qtdPedidos,
    ticketMedio: qtdPedidos ? faturamento / qtdPedidos : 0,
    clientes: clientes.size,
  };
}

function custoUnitario(v, custoMap) {
  const custoVenda = Number(v.preco_custo) || 0;
  if (custoVenda > 0) return custoVenda;
  return custoMap.get((v.produto || '').trim()) || 0;
}

function calcularMargemTotal(vendas, custoMap) {
  let receita = 0;
  let custo = 0;
  (vendas || []).forEach((v) => {
    const qtd = Number(v.quantidade) || 0;
    receita += Number(v.vlTotal) || 0;
    custo += custoUnitario(v, custoMap) * qtd;
  });
  return {
    receita,
    custo,
    margem: receita - custo,
    margemPct: receita ? ((receita - custo) / receita) * 100 : 0,
  };
}

function calcularSerieDiaria(vendas) {
  const porDia = new Map();
  (vendas || []).forEach((v) => {
    const dia = (v.data_pedido || '').slice(0, 10);
    porDia.set(dia, (porDia.get(dia) || 0) + (Number(v.vlTotal) || 0));
  });
  const dias = [...porDia.keys()].sort();
  return {
    labels: dias.map((d) => d.split('-').reverse().join('/')),
    valores: dias.map((d) => porDia.get(d)),
  };
}

function calcularVendasMensais(vendas) {
  const porMes = new Map();
  (vendas || []).forEach((v) => {
    const chave = (v.data_pedido || '').slice(0, 7);
    if (!chave) return;
    if (!porMes.has(chave)) porMes.set(chave, { pedidos: new Set(), total: 0 });
    const e = porMes.get(chave);
    e.total += Number(v.vlTotal) || 0;
    e.pedidos.add(v.id_pedido);
  });
  return [...porMes.keys()]
    .sort()
    .map((chave) => {
      const [ano, mes] = chave.split('-');
      return {
        chave,
        label: `${MESES_PT[Number(mes) - 1]}/${ano.slice(2)}`,
        total: porMes.get(chave).total,
        pedidos: porMes.get(chave).pedidos.size,
      };
    });
}

function calcularFormasPagamento(vendas) {
  const mapa = new Map();
  (vendas || []).forEach((v) => {
    const forma = v.forma_pagamento || 'Não informado';
    mapa.set(forma, (mapa.get(forma) || 0) + (Number(v.vlTotal) || 0));
  });
  return [...mapa.entries()]
    .map(([forma, total]) => ({ forma, total }))
    .sort((a, b) => b.total - a.total);
}

function calcularTopProdutos(vendas, custoMap, n = 10) {
  const mapa = new Map();
  (vendas || []).forEach((v) => {
    const nome = v.produto || 'Produto';
    if (!mapa.has(nome)) mapa.set(nome, { produto: nome, qtd: 0, receita: 0, custo: 0 });
    const e = mapa.get(nome);
    const qtd = Number(v.quantidade) || 0;
    e.qtd += qtd;
    e.receita += Number(v.vlTotal) || 0;
    e.custo += custoUnitario(v, custoMap) * qtd;
  });
  return [...mapa.values()]
    .map((p) => ({
      ...p,
      margem: p.receita - p.custo,
      margemPct: p.receita ? ((p.receita - p.custo) / p.receita) * 100 : 0,
    }))
    .sort((a, b) => b.receita - a.receita)
    .slice(0, n);
}

function mapaCidadePorCliente(clientesInfo) {
  const mapa = new Map();
  (clientesInfo || []).forEach((c) => {
    if (c.nome) mapa.set(c.nome.trim().toUpperCase(), c.cidade || 'Não informado');
  });
  return mapa;
}

function agregarPorCliente(vendas, clientesInfo) {
  const cidadePorNome = mapaCidadePorCliente(clientesInfo);
  const porCliente = new Map();

  (vendas || []).forEach((v) => {
    const nome = (v.cliente || 'Não informado').trim();
    if (!porCliente.has(nome)) porCliente.set(nome, { nome, total: 0, pedidos: new Set() });
    const entry = porCliente.get(nome);
    entry.total += Number(v.vlTotal) || 0;
    entry.pedidos.add(v.id_pedido);
  });

  return [...porCliente.values()]
    .map((c) => ({
      nome: c.nome,
      cidade: cidadePorNome.get(c.nome.toUpperCase()) || 'Não informado',
      qtdPedidos: c.pedidos.size,
      totalComprado: c.total,
      ticketMedio: c.pedidos.size ? c.total / c.pedidos.size : 0,
    }))
    .sort((a, b) => b.totalComprado - a.totalComprado);
}

function agregarPorCidade(vendas, clientesInfo) {
  const cidadePorNome = mapaCidadePorCliente(clientesInfo);
  const porCidade = new Map();

  (vendas || []).forEach((v) => {
    const nomeCliente = (v.cliente || '').trim().toUpperCase();
    const cidade = cidadePorNome.get(nomeCliente) || 'Não informado';
    if (!porCidade.has(cidade)) porCidade.set(cidade, { cidade, total: 0, pedidos: new Set(), clientes: new Set() });
    const entry = porCidade.get(cidade);
    entry.total += Number(v.vlTotal) || 0;
    entry.pedidos.add(v.id_pedido);
    entry.clientes.add(nomeCliente);
  });

  return [...porCidade.values()]
    .map((c) => ({
      cidade: c.cidade,
      qtdClientes: c.clientes.size,
      qtdPedidos: c.pedidos.size,
      totalVendido: c.total,
    }))
    .sort((a, b) => b.totalVendido - a.totalVendido);
}

function calcularClientesInativos(clientesInfo, n = 15) {
  const agora = Date.now();
  return (clientesInfo || [])
    .filter((c) => c.dtUltimoPedido)
    .map((c) => ({
      nome: c.nome,
      cidade: c.cidade || 'Não informado',
      ultimaCompra: c.dtUltimoPedido,
      dias: Math.floor((agora - new Date(c.dtUltimoPedido).getTime()) / 86400000),
    }))
    .sort((a, b) => b.dias - a.dias)
    .slice(0, n);
}

function agruparPorPedido(vendas) {
  const porPedido = new Map();
  (vendas || []).forEach((v) => {
    if (!porPedido.has(v.id_pedido)) {
      porPedido.set(v.id_pedido, {
        id_pedido: v.id_pedido,
        pedido: v.id_pedidoStr,
        cliente: v.cliente,
        data: v.data_pedido,
        dataFmt: v.data_pedidoStr,
        formaPagamento: v.forma_pagamento,
        totalItens: 0,
        total: 0,
        itens: [],
      });
    }
    const p = porPedido.get(v.id_pedido);
    p.totalItens += 1;
    p.total += Number(v.vlTotal) || 0;
    p.itens.push(v);
  });
  return [...porPedido.values()].sort((a, b) => (b.data || '').localeCompare(a.data || ''));
}

// ---------- KPIs e insights ----------

function deltaPercent(atual, anterior) {
  if (!anterior) return null;
  return ((atual - anterior) / anterior) * 100;
}

function criarTileKPI(label, valor, delta) {
  const tile = document.createElement('div');
  tile.className = 'stat-tile';

  const labelEl = document.createElement('span');
  labelEl.className = 'label';
  labelEl.textContent = label;

  const valueEl = document.createElement('span');
  valueEl.className = 'value';
  valueEl.textContent = valor;

  tile.appendChild(labelEl);
  tile.appendChild(valueEl);

  if (delta !== null && isFinite(delta)) {
    const deltaEl = document.createElement('span');
    const dir = delta > 0.5 ? 'up' : delta < -0.5 ? 'down' : 'flat';
    deltaEl.className = `delta ${dir}`;
    const seta = dir === 'up' ? '▲' : dir === 'down' ? '▼' : '—';
    deltaEl.textContent = `${seta} ${Math.abs(delta).toFixed(1)}% vs período anterior`;
    tile.appendChild(deltaEl);
  }

  return tile;
}

function renderKPIs(atual, anterior, margemAtual, margemAnterior) {
  kpisEl.innerHTML = '';
  kpisEl.appendChild(criarTileKPI('Faturamento', formatBRL(atual.faturamento), deltaPercent(atual.faturamento, anterior.faturamento)));
  kpisEl.appendChild(criarTileKPI('Pedidos', atual.pedidos, deltaPercent(atual.pedidos, anterior.pedidos)));
  kpisEl.appendChild(criarTileKPI('Ticket Médio', formatBRL(atual.ticketMedio), deltaPercent(atual.ticketMedio, anterior.ticketMedio)));
  kpisEl.appendChild(criarTileKPI('Clientes Ativos', atual.clientes, deltaPercent(atual.clientes, anterior.clientes)));
  kpisEl.appendChild(criarTileKPI('Margem Bruta', formatBRL(margemAtual.margem), deltaPercent(margemAtual.margem, margemAnterior.margem)));
  kpisEl.hidden = false;
}

function abrirDetalheFiado(vendas) {
  const fiado = (vendas || []).filter((v) => (v.forma_pagamento || '').toLowerCase() === 'fiado');
  const porCliente = new Map();
  fiado.forEach((v) => {
    const nome = (v.cliente || 'Não informado').trim();
    if (!porCliente.has(nome)) porCliente.set(nome, { cliente: nome, pedidos: new Set(), total: 0 });
    const e = porCliente.get(nome);
    e.pedidos.add(v.id_pedido);
    e.total += Number(v.vlTotal) || 0;
  });
  const linhas = [...porCliente.values()]
    .map((c) => ({ cliente: c.cliente, pedidos: c.pedidos.size, total: c.total }))
    .sort((a, b) => b.total - a.total);
  abrirModal('Fiado — valor a receber por cliente');
  mostrarNoModal(linhas, [
    { key: 'cliente', label: 'Cliente' },
    { key: 'pedidos', label: 'Pedidos' },
    { key: 'total', label: 'Total a Receber', format: formatBRL },
  ]);
}

function abrirDetalheSemCusto(todosProdutos) {
  const linhas = todosProdutos.filter((p) => p.custo === 0).sort((a, b) => b.receita - a.receita);
  abrirModal('Produtos sem custo cadastrado no Vendr');
  mostrarNoModal(linhas, [
    { key: 'produto', label: 'Produto', clickable: true, onClick: (row) => abrirDetalheProduto(row.produto) },
    { key: 'qtd', label: 'Qtd' },
    { key: 'receita', label: 'Receita', format: formatBRL },
  ]);
}

function abrirDetalheInativosCompleto(clientesInfo) {
  const linhas = calcularClientesInativos(clientesInfo, Infinity).filter((c) => c.dias >= 30);
  abrirModal(`Clientes sem comprar há 30+ dias (${linhas.length})`);
  mostrarNoModal(linhas, [
    { key: 'nome', label: 'Cliente' },
    { key: 'cidade', label: 'Cidade' },
    { key: 'ultimaCompra', label: 'Última Compra', format: formatData },
    { key: 'dias', label: 'Dias sem comprar' },
  ]);
}

function renderInsights(vendas, clientesInfo, custoMap) {
  const cards = [];
  let totalFiado = 0;
  let total = 0;

  (vendas || []).forEach((v) => {
    const val = Number(v.vlTotal) || 0;
    total += val;
    if ((v.forma_pagamento || '').toLowerCase() === 'fiado') totalFiado += val;
  });

  if (total > 0 && totalFiado > 0) {
    const pct = (totalFiado / total) * 100;
    cards.push({
      tipo: pct > 30 ? 'critical' : pct > 15 ? 'warning' : 'good',
      titulo: `${pct.toFixed(0)}% das vendas em Fiado`,
      texto: `${formatBRL(totalFiado)} vendidos a prazo no período — valor ainda a receber dos clientes. Clique para ver por cliente.`,
      onClick: () => abrirDetalheFiado(vendas),
    });
  }

  const todosProdutos = calcularTopProdutos(vendas, custoMap, Infinity);
  if (todosProdutos.length) {
    const campeao = todosProdutos[0];
    cards.push({
      tipo: 'good',
      titulo: campeao.produto,
      texto: `Produto campeão de vendas: ${formatBRL(campeao.receita)} em ${campeao.qtd} unidades. Clique para ver quem comprou.`,
      onClick: () => abrirDetalheProduto(campeao.produto),
    });
  }

  const receitaTotal = todosProdutos.reduce((s, p) => s + p.receita, 0);
  const receitaSemCusto = todosProdutos.filter((p) => p.custo === 0).reduce((s, p) => s + p.receita, 0);
  const pctSemCusto = receitaTotal ? (receitaSemCusto / receitaTotal) * 100 : 0;
  if (pctSemCusto > 20) {
    cards.push({
      tipo: 'warning',
      titulo: `${pctSemCusto.toFixed(0)}% da receita sem custo cadastrado`,
      texto: 'A margem calculada pode estar subestimada. Clique para ver quais produtos precisam de custo cadastrado.',
      onClick: () => abrirDetalheSemCusto(todosProdutos),
    });
  }

  const inativos = calcularClientesInativos(clientesInfo, Infinity).filter((c) => c.dias >= 30);
  if (inativos.length) {
    cards.push({
      tipo: inativos.length > 10 ? 'critical' : 'warning',
      titulo: `${inativos.length} clientes sem comprar há 30+ dias`,
      texto: 'Oportunidade de reativação. Clique para ver a lista completa.',
      onClick: () => abrirDetalheInativosCompleto(clientesInfo),
    });
  }

  insightsEl.innerHTML = '';
  cards.forEach((c) => {
    const div = document.createElement('div');
    div.className = `insight-card ${c.tipo}`;
    const strong = document.createElement('strong');
    strong.textContent = c.titulo;
    const span = document.createElement('span');
    span.textContent = c.texto;
    div.appendChild(strong);
    div.appendChild(span);
    if (c.onClick) {
      div.classList.add('clickable');
      div.setAttribute('role', 'button');
      div.setAttribute('tabindex', '0');
      div.addEventListener('click', c.onClick);
      div.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          c.onClick();
        }
      });
    }
    insightsEl.appendChild(div);
  });
  insightsEl.hidden = cards.length === 0;
}

// ---------- Gráficos ----------

function destroyChart(id) {
  if (chartInstances[id]) {
    chartInstances[id].destroy();
    delete chartInstances[id];
  }
}

function corVar(nome) {
  return getComputedStyle(document.documentElement).getPropertyValue(nome).trim();
}

function renderTendenciaChart(serie) {
  destroyChart('chartTendencia');
  chartInstances.chartTendencia = new Chart(el('chartTendencia'), {
    type: 'bar',
    data: {
      labels: serie.labels,
      datasets: [{ label: 'Vendas', data: serie.valores, backgroundColor: corVar('--series-1'), borderRadius: 4 }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      scales: { y: { beginAtZero: true, ticks: { callback: (v) => formatBRL(v) } } },
      plugins: {
        legend: { display: false },
        tooltip: { callbacks: { label: (ctx) => formatBRL(ctx.raw) } },
      },
    },
  });
}

function renderMensalChart(serie) {
  destroyChart('chartMensal');
  chartInstances.chartMensal = new Chart(el('chartMensal'), {
    type: 'bar',
    data: {
      labels: serie.map((m) => m.label),
      datasets: [{ label: 'Faturamento', data: serie.map((m) => m.total), backgroundColor: corVar('--series-1'), borderRadius: 4 }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      scales: { y: { beginAtZero: true, ticks: { callback: (v) => formatBRL(v) } } },
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            label: (ctx) => formatBRL(ctx.raw),
            afterLabel: (ctx) => `${serie[ctx.dataIndex].pedidos} pedido(s)`,
          },
        },
      },
    },
  });
}

function renderPagamentoChart(formas) {
  destroyChart('chartPagamento');
  const cores = ['--series-1', '--series-2', '--series-3', '--series-4', '--series-5'].map(corVar);
  chartInstances.chartPagamento = new Chart(el('chartPagamento'), {
    type: 'bar',
    data: {
      labels: formas.map((f) => f.forma),
      datasets: [{ data: formas.map((f) => f.total), backgroundColor: formas.map((_, i) => cores[i % cores.length]), borderRadius: 4 }],
    },
    options: {
      indexAxis: 'y',
      responsive: true,
      maintainAspectRatio: false,
      scales: { x: { beginAtZero: true, ticks: { callback: (v) => formatBRL(v) } } },
      plugins: {
        legend: { display: false },
        tooltip: { callbacks: { label: (ctx) => formatBRL(ctx.raw) } },
      },
    },
  });
}

function renderRankingChart(canvasId, labels, valores, onClickLabel) {
  destroyChart(canvasId);
  chartInstances[canvasId] = new Chart(el(canvasId), {
    type: 'bar',
    data: { labels, datasets: [{ data: valores, backgroundColor: corVar('--series-1'), borderRadius: 4 }] },
    options: {
      indexAxis: 'y',
      responsive: true,
      maintainAspectRatio: false,
      onClick: (evt, elements) => {
        if (!onClickLabel || !elements.length) return;
        onClickLabel(labels[elements[0].index]);
      },
      scales: { x: { beginAtZero: true, ticks: { callback: (v) => formatBRL(v) } } },
      plugins: {
        legend: { display: false },
        tooltip: { callbacks: { label: (ctx) => formatBRL(ctx.raw) } },
      },
    },
  });
  el(canvasId).style.cursor = onClickLabel ? 'pointer' : 'default';
}

// ---------- Drill-downs (modal) ----------

function abrirDetalheProduto(nomeProduto) {
  const linhas = vendasAtualRaw
    .filter((v) => v.produto === nomeProduto)
    .map((v) => ({ cliente: v.cliente, dataFmt: v.data_pedidoStr, data: v.data_pedido, quantidade: v.quantidade, total: v.vlTotal }))
    .sort((a, b) => (b.data || '').localeCompare(a.data || ''));
  abrirModal(`Quem comprou: ${nomeProduto}`);
  mostrarNoModal(linhas, [
    { key: 'cliente', label: 'Cliente' },
    { key: 'dataFmt', label: 'Data' },
    { key: 'quantidade', label: 'Qtd' },
    { key: 'total', label: 'Total', format: formatBRL },
  ]);
}

function abrirDetalheCliente(nomeCliente) {
  const linhas = vendasAtualRaw
    .filter((v) => (v.cliente || '').trim() === nomeCliente)
    .map((v) => ({ produto: v.produto, dataFmt: v.data_pedidoStr, data: v.data_pedido, quantidade: v.quantidade, total: v.vlTotal }))
    .sort((a, b) => (b.data || '').localeCompare(a.data || ''));
  abrirModal(`Produtos comprados por: ${nomeCliente}`);
  mostrarNoModal(linhas, [
    { key: 'produto', label: 'Produto' },
    { key: 'dataFmt', label: 'Data' },
    { key: 'quantidade', label: 'Qtd' },
    { key: 'total', label: 'Total', format: formatBRL },
  ]);
}

function abrirDetalheCidade(nomeCidade) {
  const cidadePorNome = mapaCidadePorCliente(clientesInfoAtual);
  const linhas = vendasAtualRaw
    .filter((v) => (cidadePorNome.get((v.cliente || '').trim().toUpperCase()) || 'Não informado') === nomeCidade)
    .map((v) => ({ produto: v.produto, cliente: v.cliente, dataFmt: v.data_pedidoStr, data: v.data_pedido, quantidade: v.quantidade, total: v.vlTotal }))
    .sort((a, b) => (b.data || '').localeCompare(a.data || ''));
  abrirModal(`Vendas em: ${nomeCidade}`);
  mostrarNoModal(linhas, [
    { key: 'produto', label: 'Produto' },
    { key: 'cliente', label: 'Cliente' },
    { key: 'dataFmt', label: 'Data' },
    { key: 'quantidade', label: 'Qtd' },
    { key: 'total', label: 'Total', format: formatBRL },
  ]);
}

function abrirDetalhePedido(pedido) {
  abrirModal(`Pedido ${pedido.pedido} — ${pedido.cliente}`);
  mostrarNoModal(pedido.itens, [
    { key: 'produto', label: 'Produto' },
    { key: 'quantidade', label: 'Qtd' },
    { key: 'preco_unitario', label: 'Preço Unit.', format: formatBRL },
    { key: 'vlTotal', label: 'Total', format: formatBRL },
  ]);
}

function chaveReposicaoDia(data) {
  return `vendasDia:reposicao:${data}`;
}

function lerReposicaoDia(data) {
  try {
    const raw = localStorage.getItem(chaveReposicaoDia(data));
    return raw ? JSON.parse(raw) : {};
  } catch (e) {
    return {};
  }
}

function salvarReposicaoDia(data, mapa) {
  try {
    localStorage.setItem(chaveReposicaoDia(data), JSON.stringify(mapa));
  } catch (e) {
    // localStorage indisponível — o checklist só não persiste, sem quebrar a tela
  }
}

async function carregarVendasDoDia(data) {
  const corpo = el('modalCorpo');
  corpo.innerHTML = '<p class="muted">Carregando...</p>';
  try {
    const [vendasDia, clientesDia] = await Promise.all([
      fetchJSON(`/api/vendas?inicio=${data}&fim=${data}`),
      fetchJSON(`/api/clientes?inicio=${data}&fim=${data}`).catch(() => []),
    ]);
    const cidadePorNome = mapaCidadePorCliente(clientesDia);
    const mapa = new Map();
    vendasDia.forEach((v) => {
      const nome = v.produto || 'Produto';
      if (!mapa.has(nome)) mapa.set(nome, { produto: nome, qtd: 0, pedidos: new Set(), total: 0, itens: [] });
      const e = mapa.get(nome);
      e.qtd += Number(v.quantidade) || 0;
      e.pedidos.add(v.id_pedido);
      e.total += Number(v.vlTotal) || 0;
      e.itens.push({
        hora: (v.data_pedido || '').slice(11, 16),
        cliente: (v.cliente || '').trim(),
        cidade: cidadePorNome.get((v.cliente || '').trim().toUpperCase()) || 'Não informado',
        quantidade: Number(v.quantidade) || 0,
      });
    });
    const linhas = [...mapa.values()]
      .map((p) => ({
        produto: p.produto,
        qtd: p.qtd,
        pedidos: p.pedidos.size,
        total: p.total,
        itens: p.itens.sort((a, b) => b.hora.localeCompare(a.hora)),
      }))
      .sort((a, b) => a.produto.localeCompare(b.produto, 'pt-BR', { sensitivity: 'base' }));

    const reposicao = lerReposicaoDia(data);

    corpo.innerHTML = '';

    const resumo = document.createElement('p');
    resumo.className = 'modal-summary';
    corpo.appendChild(resumo);

    function atualizarResumo() {
      const repostos = linhas.filter((l) => reposicao[l.produto]).length;
      resumo.textContent = `${repostos} de ${linhas.length} produto(s) já repostos — ${vendasDia.length} item(ns) vendidos, ${formatBRL(linhas.reduce((s, p) => s + p.total, 0))} no total.`;
    }

    if (linhas.length) {
      const acoes = document.createElement('div');
      acoes.className = 'modal-actions';

      const btnTodos = document.createElement('button');
      btnTodos.type = 'button';
      btnTodos.className = 'link-btn';
      btnTodos.textContent = 'Marcar todos';
      btnTodos.addEventListener('click', () => {
        linhas.forEach((l) => (reposicao[l.produto] = true));
        salvarReposicaoDia(data, reposicao);
        carregarVendasDoDia(data);
      });

      const btnNenhum = document.createElement('button');
      btnNenhum.type = 'button';
      btnNenhum.className = 'link-btn';
      btnNenhum.textContent = 'Desmarcar todos';
      btnNenhum.addEventListener('click', () => {
        linhas.forEach((l) => (reposicao[l.produto] = false));
        salvarReposicaoDia(data, reposicao);
        carregarVendasDoDia(data);
      });

      acoes.appendChild(btnTodos);
      acoes.appendChild(btnNenhum);
      corpo.appendChild(acoes);
    }

    const table = document.createElement('table');
    const thead = document.createElement('thead');
    const headRow = document.createElement('tr');
    ['Reposto', 'Produto', 'Qtd. Vendida', 'Pedidos', 'Receita'].forEach((label) => {
      const th = document.createElement('th');
      th.textContent = label;
      headRow.appendChild(th);
    });
    thead.appendChild(headRow);

    const tbody = document.createElement('tbody');
    if (!linhas.length) {
      const tr = document.createElement('tr');
      const td = document.createElement('td');
      td.colSpan = 5;
      td.textContent = 'Nenhuma venda registrada nesse dia.';
      tr.appendChild(td);
      tbody.appendChild(tr);
    } else {
      linhas.forEach((linha) => {
        const tr = document.createElement('tr');
        tr.classList.toggle('reposto', !!reposicao[linha.produto]);

        const tdCheck = document.createElement('td');
        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.checked = !!reposicao[linha.produto];
        checkbox.addEventListener('change', () => {
          reposicao[linha.produto] = checkbox.checked;
          salvarReposicaoDia(data, reposicao);
          tr.classList.toggle('reposto', checkbox.checked);
          atualizarResumo();
        });
        tdCheck.appendChild(checkbox);
        tr.appendChild(tdCheck);

        const tdProduto = document.createElement('td');
        const btnProduto = document.createElement('button');
        btnProduto.type = 'button';
        btnProduto.className = 'link-btn';
        btnProduto.textContent = linha.produto;
        btnProduto.addEventListener('click', () => {
          const proxima = tr.nextElementSibling;
          if (proxima && proxima.classList.contains('detalhe-produto')) {
            proxima.remove();
            return;
          }
          const detalhe = document.createElement('tr');
          detalhe.className = 'detalhe-produto';
          const celula = document.createElement('td');
          celula.colSpan = 5;
          celula.appendChild(
            criarTabela(linha.itens, [
              { key: 'hora', label: 'Hora' },
              { key: 'cliente', label: 'Cliente' },
              { key: 'cidade', label: 'Cidade' },
              { key: 'quantidade', label: 'Qtd' },
            ])
          );
          detalhe.appendChild(celula);
          tr.after(detalhe);
        });
        tdProduto.appendChild(btnProduto);
        tr.appendChild(tdProduto);

        const tdQtd = document.createElement('td');
        tdQtd.textContent = linha.qtd;
        tr.appendChild(tdQtd);

        const tdPedidos = document.createElement('td');
        tdPedidos.textContent = linha.pedidos;
        tr.appendChild(tdPedidos);

        const tdTotal = document.createElement('td');
        tdTotal.textContent = formatBRL(linha.total);
        tr.appendChild(tdTotal);

        tbody.appendChild(tr);
      });
    }

    table.appendChild(thead);
    table.appendChild(tbody);
    corpo.appendChild(table);

    atualizarResumo();
  } catch (err) {
    corpo.innerHTML = '';
    const p = document.createElement('p');
    p.className = 'status error';
    p.textContent = err.message || 'Erro ao carregar vendas do dia.';
    corpo.appendChild(p);
  }
}

function abrirVendasDoDia() {
  abrirModal('Vendas do Dia');
  const extra = el('modalExtra');
  extra.className = 'modal-extra';

  const label = document.createElement('label');
  label.textContent = 'Data';
  const input = document.createElement('input');
  input.type = 'date';
  input.value = hoje();
  label.appendChild(input);

  const btn = document.createElement('button');
  btn.type = 'button';
  btn.textContent = 'Buscar';
  btn.addEventListener('click', () => carregarVendasDoDia(input.value));

  extra.appendChild(label);
  extra.appendChild(btn);

  carregarVendasDoDia(input.value);
}

el('botaoVendasDia').addEventListener('click', abrirVendasDoDia);

// ---------- Detalhe de vendas (agrupado por pedido) ----------

function aplicarFiltroVendas() {
  const termo = vendasDetalheState.filtro.trim().toLowerCase();
  if (!termo) return vendasDetalheState.pedidos;
  return vendasDetalheState.pedidos.filter(
    (p) =>
      (p.cliente || '').toLowerCase().includes(termo) ||
      p.itens.some((item) => (item.produto || '').toLowerCase().includes(termo))
  );
}

function renderVendasDetalhe() {
  const filtradas = aplicarFiltroVendas();
  const totalPaginas = Math.max(1, Math.ceil(filtradas.length / vendasDetalheState.pageSize));
  if (vendasDetalheState.pagina > totalPaginas) vendasDetalheState.pagina = totalPaginas;
  const inicio = (vendasDetalheState.pagina - 1) * vendasDetalheState.pageSize;
  const pagina = filtradas.slice(inicio, inicio + vendasDetalheState.pageSize);

  contagemVendasEl.textContent = `${filtradas.length} pedido(s)`;

  montarTabelaEm('tabelaVendasWrap', pagina, [
    { key: 'pedido', label: 'Pedido', clickable: true, onClick: abrirDetalhePedido },
    { key: 'cliente', label: 'Cliente' },
    { key: 'dataFmt', label: 'Data' },
    { key: 'totalItens', label: 'Itens' },
    { key: 'total', label: 'Total', format: formatBRL },
    { key: 'formaPagamento', label: 'Pagamento' },
  ]);

  const pager = el('pagerVendas');
  pager.innerHTML = '';

  const btnAnterior = document.createElement('button');
  btnAnterior.textContent = 'Anterior';
  btnAnterior.disabled = vendasDetalheState.pagina <= 1;
  btnAnterior.addEventListener('click', () => {
    vendasDetalheState.pagina -= 1;
    renderVendasDetalhe();
  });

  const info = document.createElement('span');
  info.textContent = `Página ${vendasDetalheState.pagina} de ${totalPaginas}`;

  const btnProxima = document.createElement('button');
  btnProxima.textContent = 'Próxima';
  btnProxima.disabled = vendasDetalheState.pagina >= totalPaginas;
  btnProxima.addEventListener('click', () => {
    vendasDetalheState.pagina += 1;
    renderVendasDetalhe();
  });

  pager.appendChild(btnAnterior);
  pager.appendChild(info);
  pager.appendChild(btnProxima);
}

el('buscaVendas').addEventListener('input', (e) => {
  vendasDetalheState.filtro = e.target.value;
  vendasDetalheState.pagina = 1;
  renderVendasDetalhe();
});

// ---------- Todos os produtos vendidos (busca + paginação) ----------

function aplicarFiltroProdutos() {
  const termo = produtosDetalheState.filtro.trim().toLowerCase();
  if (!termo) return produtosDetalheState.produtos;
  return produtosDetalheState.produtos.filter((p) => (p.produto || '').toLowerCase().includes(termo));
}

function renderProdutosDetalhe() {
  const filtradas = aplicarFiltroProdutos();
  const totalPaginas = Math.max(1, Math.ceil(filtradas.length / produtosDetalheState.pageSize));
  if (produtosDetalheState.pagina > totalPaginas) produtosDetalheState.pagina = totalPaginas;
  const inicio = (produtosDetalheState.pagina - 1) * produtosDetalheState.pageSize;
  const pagina = filtradas.slice(inicio, inicio + produtosDetalheState.pageSize);

  contagemProdutosEl.textContent = `${filtradas.length} produto(s) diferentes`;

  montarTabelaEm('tabelaTodosProdutosWrap', pagina, [
    { key: 'produto', label: 'Produto', clickable: true, onClick: (row) => abrirDetalheProduto(row.produto) },
    { key: 'qtd', label: 'Qtd' },
    { key: 'receita', label: 'Receita', format: formatBRL },
    {
      key: 'margem',
      label: 'Margem',
      format: formatBRL,
      className: (row) => (row.margem >= 0 ? 'margem-positiva' : 'margem-negativa'),
    },
    { key: 'margemPct', label: 'Margem %', format: (v) => `${v.toFixed(0)}%` },
  ]);

  const pager = el('pagerProdutos');
  pager.innerHTML = '';

  const btnAnterior = document.createElement('button');
  btnAnterior.textContent = 'Anterior';
  btnAnterior.disabled = produtosDetalheState.pagina <= 1;
  btnAnterior.addEventListener('click', () => {
    produtosDetalheState.pagina -= 1;
    renderProdutosDetalhe();
  });

  const info = document.createElement('span');
  info.textContent = `Página ${produtosDetalheState.pagina} de ${totalPaginas}`;

  const btnProxima = document.createElement('button');
  btnProxima.textContent = 'Próxima';
  btnProxima.disabled = produtosDetalheState.pagina >= totalPaginas;
  btnProxima.addEventListener('click', () => {
    produtosDetalheState.pagina += 1;
    renderProdutosDetalhe();
  });

  pager.appendChild(btnAnterior);
  pager.appendChild(info);
  pager.appendChild(btnProxima);
}

el('buscaProdutos').addEventListener('input', (e) => {
  produtosDetalheState.filtro = e.target.value;
  produtosDetalheState.pagina = 1;
  renderProdutosDetalhe();
});

// ---------- Filtros de cidade e cliente ----------

function popularFiltros(clientesInfo) {
  const selectCidade = el('filtroCidade');
  const valorAtualCidade = selectCidade.value;
  const cidades = [...new Set((clientesInfo || []).map((c) => c.cidade || 'Não informado'))].sort();

  selectCidade.innerHTML = '';
  const optTodas = document.createElement('option');
  optTodas.value = '';
  optTodas.textContent = 'Todas as cidades';
  selectCidade.appendChild(optTodas);
  cidades.forEach((cidade) => {
    const opt = document.createElement('option');
    opt.value = cidade;
    opt.textContent = cidade;
    selectCidade.appendChild(opt);
  });
  if (cidades.includes(valorAtualCidade)) selectCidade.value = valorAtualCidade;

  const datalist = el('listaClientes');
  datalist.innerHTML = '';
  const nomes = [...new Set((clientesInfo || []).map((c) => c.nome).filter(Boolean))].sort();
  nomes.forEach((nome) => {
    const opt = document.createElement('option');
    opt.value = nome;
    datalist.appendChild(opt);
  });
}

function aplicarFiltrosGlobais(vendas, clientesInfoCompleto) {
  const cidadeSel = el('filtroCidade').value;
  const clienteSel = el('filtroCliente').value.trim();
  if (!cidadeSel && !clienteSel) return vendas || [];

  const cidadePorNome = mapaCidadePorCliente(clientesInfoCompleto);
  return (vendas || []).filter((v) => {
    const nomeCliente = (v.cliente || '').trim();
    if (clienteSel && nomeCliente.toUpperCase() !== clienteSel.toUpperCase()) return false;
    if (cidadeSel) {
      const cidade = cidadePorNome.get(nomeCliente.toUpperCase()) || 'Não informado';
      if (cidade !== cidadeSel) return false;
    }
    return true;
  });
}

function filtrarClientesInfo(clientesInfo) {
  const cidadeSel = el('filtroCidade').value;
  const clienteSel = el('filtroCliente').value.trim();
  if (!cidadeSel && !clienteSel) return clientesInfo || [];

  return (clientesInfo || []).filter((c) => {
    if (cidadeSel && (c.cidade || 'Não informado') !== cidadeSel) return false;
    if (clienteSel && (c.nome || '').trim().toUpperCase() !== clienteSel.toUpperCase()) return false;
    return true;
  });
}

el('filtroCidade').addEventListener('change', gerarRelatorio);
el('filtroCliente').addEventListener('change', gerarRelatorio);
el('limparFiltros').addEventListener('click', () => {
  el('filtroCidade').value = '';
  el('filtroCliente').value = '';
  gerarRelatorio();
});

// ---------- Orquestração ----------

async function gerarRelatorio() {
  const inicio = el('dataInicial').value;
  const fim = el('dataFinal').value;

  if (!inicio || !fim) {
    setStatus('Selecione o período.', true);
    return;
  }

  gerarBtn.disabled = true;
  setStatus('Carregando dados do Vendr...');

  try {
    const anterior = periodoAnterior(inicio, fim);
    const inicioMensal = inicioMesesAtras(fim, 6);

    const [vendasBrutas, vendasAnteriorBrutas, clientesInfoCompleto, produtosCatalog, vendasMensalBrutas] = await Promise.all([
      fetchJSON(`/api/vendas?inicio=${inicio}&fim=${fim}`),
      fetchJSON(`/api/vendas?inicio=${anterior.inicio}&fim=${anterior.fim}`),
      fetchJSON(`/api/clientes?inicio=${inicio}&fim=${fim}`),
      fetchJSON('/api/produtos'),
      fetchJSON(`/api/vendas?inicio=${inicioMensal}&fim=${fim}`),
    ]);

    popularFiltros(clientesInfoCompleto);

    const vendas = aplicarFiltrosGlobais(vendasBrutas, clientesInfoCompleto);
    const vendasAnterior = aplicarFiltrosGlobais(vendasAnteriorBrutas, clientesInfoCompleto);
    const vendasMensalBruto = aplicarFiltrosGlobais(vendasMensalBrutas, clientesInfoCompleto);
    const clientesInfo = filtrarClientesInfo(clientesInfoCompleto);

    vendasAtualRaw = vendas;
    clientesInfoAtual = clientesInfoCompleto;

    const custoMap = new Map();
    (produtosCatalog || []).forEach((p) => {
      if (p.descricao) custoMap.set(p.descricao.trim(), Number(p.preco_custo) || 0);
    });

    const margemAtual = calcularMargemTotal(vendas, custoMap);
    const margemAnterior = calcularMargemTotal(vendasAnterior, custoMap);

    renderKPIs(calcularKPIs(vendas), calcularKPIs(vendasAnterior), margemAtual, margemAnterior);
    renderInsights(vendas, clientesInfo, custoMap);

    renderTendenciaChart(calcularSerieDiaria(vendas));
    renderPagamentoChart(calcularFormasPagamento(vendas));
    renderMensalChart(calcularVendasMensais(vendasMensalBruto));

    const topProdutos = calcularTopProdutos(vendas, custoMap, 10);
    renderRankingChart('chartProdutos', topProdutos.map((p) => p.produto), topProdutos.map((p) => p.receita), abrirDetalheProduto);
    montarTabelaEm('tabelaProdutosWrap', topProdutos, [
      { key: 'produto', label: 'Produto', clickable: true, onClick: (row) => abrirDetalheProduto(row.produto) },
      { key: 'qtd', label: 'Qtd' },
      { key: 'receita', label: 'Receita', format: formatBRL },
      {
        key: 'margem',
        label: 'Margem',
        format: formatBRL,
        className: (row) => (row.margem >= 0 ? 'margem-positiva' : 'margem-negativa'),
      },
      { key: 'margemPct', label: 'Margem %', format: (v) => `${v.toFixed(0)}%` },
    ]);

    produtosDetalheState.produtos = calcularTopProdutos(vendas, custoMap, Infinity);
    produtosDetalheState.pagina = 1;
    renderProdutosDetalhe();

    const topClientes = agregarPorCliente(vendas, clientesInfo).slice(0, 10);
    renderRankingChart('chartClientes', topClientes.map((c) => c.nome), topClientes.map((c) => c.totalComprado), abrirDetalheCliente);
    montarTabelaEm('tabelaClientesWrap', topClientes, [
      { key: 'nome', label: 'Cliente', clickable: true, onClick: (row) => abrirDetalheCliente(row.nome) },
      { key: 'cidade', label: 'Cidade' },
      { key: 'qtdPedidos', label: 'Pedidos' },
      { key: 'totalComprado', label: 'Total', format: formatBRL },
      { key: 'ticketMedio', label: 'Ticket Médio', format: formatBRL },
    ]);

    const topCidades = agregarPorCidade(vendas, clientesInfo).slice(0, 10);
    renderRankingChart('chartCidades', topCidades.map((c) => c.cidade), topCidades.map((c) => c.totalVendido), abrirDetalheCidade);
    montarTabelaEm('tabelaCidadesWrap', topCidades, [
      { key: 'cidade', label: 'Cidade', clickable: true, onClick: (row) => abrirDetalheCidade(row.cidade) },
      { key: 'qtdClientes', label: 'Clientes' },
      { key: 'qtdPedidos', label: 'Pedidos' },
      { key: 'totalVendido', label: 'Total', format: formatBRL },
    ]);

    vendasDetalheState.pedidos = agruparPorPedido(vendas);
    vendasDetalheState.pagina = 1;
    renderVendasDetalhe();

    const inativos = calcularClientesInativos(clientesInfo, 15);
    montarTabelaEm('tabelaInativosWrap', inativos, [
      { key: 'nome', label: 'Cliente' },
      { key: 'cidade', label: 'Cidade' },
      { key: 'ultimaCompra', label: 'Última Compra', format: formatData },
      { key: 'dias', label: 'Dias sem comprar' },
    ]);

    setStatus('');
  } catch (err) {
    console.error(err);
    setStatus(err.message || 'Erro ao carregar o painel.', true);
  } finally {
    gerarBtn.disabled = false;
  }
}

// ---------- Autenticação ----------

function mostrarTelaLogin(mensagemErro) {
  el('telaLogin').hidden = false;
  el('barraFiltros').hidden = true;
  el('conteudoPainel').hidden = true;
  const erroEl = el('loginErro');
  if (mensagemErro) {
    erroEl.textContent = mensagemErro;
    erroEl.hidden = false;
  } else {
    erroEl.hidden = true;
  }
}

function mostrarPainel() {
  el('telaLogin').hidden = true;
  el('barraFiltros').hidden = false;
  el('conteudoPainel').hidden = false;
}

el('formLogin').addEventListener('submit', async (e) => {
  e.preventDefault();
  const email = el('loginEmail').value.trim();
  const senha = el('loginSenha').value;
  const lembrar = el('loginLembrar').checked;
  const botao = el('botaoEntrar');
  const erroEl = el('loginErro');
  erroEl.hidden = true;
  botao.disabled = true;
  botao.textContent = 'Entrando...';

  try {
    const res = await fetch('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password: senha, lembrar }),
    });
    const data = await res.json();
    if (!res.ok) {
      throw new Error(data.error || 'Não foi possível entrar.');
    }
    el('loginSenha').value = '';
    mostrarPainel();
    gerarRelatorio();
  } catch (err) {
    erroEl.textContent = err.message || 'Não foi possível entrar.';
    erroEl.hidden = false;
  } finally {
    botao.disabled = false;
    botao.textContent = 'Entrar';
  }
});

el('botaoSair').addEventListener('click', async () => {
  try {
    await fetch('/api/logout', { method: 'POST' });
  } catch (e) {
    // ignora falha de rede ao sair
  }
  el('loginEmail').value = '';
  el('loginSenha').value = '';
  mostrarTelaLogin();
});

async function iniciar() {
  try {
    const res = await fetch('/api/session');
    const data = await res.json();
    if (data.autenticado) {
      mostrarPainel();
      gerarRelatorio();
    } else {
      mostrarTelaLogin();
    }
  } catch (err) {
    mostrarTelaLogin('Não foi possível conectar ao servidor.');
  }
}

gerarBtn.addEventListener('click', gerarRelatorio);
iniciar();
