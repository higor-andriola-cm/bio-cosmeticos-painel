const el = (id) => document.getElementById(id);

function hoje() {
  return new Date().toISOString().slice(0, 10);
}

function formatBRL(valor) {
  const n = Number(valor) || 0;
  return n.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}

function setStatus(msg, isError = false) {
  const statusEl = el('statusReposicao');
  statusEl.textContent = msg;
  statusEl.classList.toggle('error', isError);
}

async function fetchJSON(url) {
  const res = await fetch(url);
  const data = await res.json();
  if (!res.ok) {
    const msg = (data && data.error && (data.error.message || JSON.stringify(data.error))) || 'Falha ao consultar o Vendr';
    throw new Error(msg);
  }
  return data;
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
    td.textContent = 'Nenhuma venda registrada nesse dia.';
    tr.appendChild(td);
    tbody.appendChild(tr);
  } else {
    rows.forEach((row) => {
      const tr = document.createElement('tr');
      columns.forEach((c) => {
        const td = document.createElement('td');
        if (c.render) {
          c.render(td, row, tr);
        } else {
          td.textContent = c.format ? c.format(row[c.key], row) : (row[c.key] ?? '');
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

async function carregarVendasDoDia(data) {
  setStatus('Carregando...');
  el('tabelaReposicaoWrap').innerHTML = '';
  el('acoesReposicao').innerHTML = '';
  el('resumoReposicao').textContent = '';

  try {
    const vendasDia = await fetchJSON(`/api/publico/vendas-do-dia?data=${data}`);
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
        cidade: v.cidade || 'Não informado',
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
      .sort((a, b) => b.qtd - a.qtd);

    const reposicao = lerReposicaoDia(data);

    function atualizarResumo() {
      const repostos = linhas.filter((l) => reposicao[l.produto]).length;
      el('resumoReposicao').textContent =
        `${repostos} de ${linhas.length} produto(s) já repostos — ${vendasDia.length} item(ns) vendidos, ${formatBRL(linhas.reduce((s, p) => s + p.total, 0))} no total.`;
    }

    if (linhas.length) {
      const acoes = el('acoesReposicao');
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
    }

    const table = criarTabela(linhas, [
      {
        label: 'Reposto',
        render: (td, row, tr) => {
          const checkbox = document.createElement('input');
          checkbox.type = 'checkbox';
          checkbox.checked = !!reposicao[row.produto];
          tr.classList.toggle('reposto', checkbox.checked);
          checkbox.addEventListener('change', () => {
            reposicao[row.produto] = checkbox.checked;
            salvarReposicaoDia(data, reposicao);
            tr.classList.toggle('reposto', checkbox.checked);
            atualizarResumo();
          });
          td.appendChild(checkbox);
        },
      },
      {
        label: 'Produto',
        render: (td, row, tr) => {
          const btn = document.createElement('button');
          btn.type = 'button';
          btn.className = 'link-btn';
          btn.textContent = row.produto;
          btn.addEventListener('click', () => {
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
              criarTabela(row.itens, [
                { key: 'hora', label: 'Hora' },
                { key: 'cliente', label: 'Cliente' },
                { key: 'cidade', label: 'Cidade' },
                { key: 'quantidade', label: 'Qtd' },
              ])
            );
            detalhe.appendChild(celula);
            tr.after(detalhe);
          });
          td.appendChild(btn);
        },
      },
      { key: 'qtd', label: 'Qtd. Vendida' },
      { key: 'pedidos', label: 'Pedidos' },
      { key: 'total', label: 'Receita', format: formatBRL },
    ]);

    el('tabelaReposicaoWrap').appendChild(table);
    atualizarResumo();
    setStatus('');
  } catch (err) {
    setStatus(err.message || 'Erro ao carregar vendas do dia.', true);
  }
}

el('dataReposicao').value = hoje();
el('botaoBuscar').addEventListener('click', () => carregarVendasDoDia(el('dataReposicao').value));

carregarVendasDoDia(el('dataReposicao').value);
