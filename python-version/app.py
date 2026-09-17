import json
import os
from datetime import date, timedelta
from pathlib import Path

import pandas as pd
import plotly.graph_objects as go
import requests
import streamlit as st
from dotenv import load_dotenv

from vendr_client import VendrClient

BASE_DIR = Path(__file__).resolve().parent
ENV_PATH = BASE_DIR / ".env"
DATA_DIR = BASE_DIR / "data"

COR_SERIE_1 = "#2a78d6"
COR_SERIE_2 = "#eb6834"
COR_SERIE_3 = "#1baf7a"
COR_SERIE_4 = "#eda100"
COR_SERIE_5 = "#e87ba4"
COR_MARCA = "#a15a68"

MESES_PT = ["jan", "fev", "mar", "abr", "mai", "jun", "jul", "ago", "set", "out", "nov", "dez"]

st.set_page_config(page_title="Bio Cosméticos | Painel de Vendas", layout="wide")

st.markdown(
    """
    <style>
    @import url('https://fonts.googleapis.com/css2?family=Playfair+Display:wght@700&display=swap');
    .brand-title { font-family: 'Playfair Display', serif; color: #a15a68; font-size: 1.8rem; margin: 0; }
    .brand-sub { color: #888; letter-spacing: 2px; text-transform: uppercase; font-size: 0.72rem; margin: 0 0 8px; }
    </style>
    """,
    unsafe_allow_html=True,
)

load_dotenv(ENV_PATH)


# ---------- Formatação ----------

def format_brl(valor):
    try:
        v = float(valor)
    except (TypeError, ValueError):
        v = 0.0
    texto = f"{v:,.2f}"
    texto = texto.replace(",", "X").replace(".", ",").replace("X", ".")
    return f"R$ {texto}"


def format_delta(pct):
    if pct is None:
        return None
    return f"{pct:+.1f}%"


def iso_inicio(d: date) -> str:
    return f"{d.isoformat()}T00:00:00.000Z"


def iso_fim(d: date) -> str:
    return f"{d.isoformat()}T23:59:59.000Z"


def periodo_anterior(inicio: date, fim: date):
    dias = (fim - inicio).days + 1
    anterior_fim = inicio - timedelta(days=1)
    anterior_inicio = anterior_fim - timedelta(days=dias - 1)
    return anterior_inicio, anterior_fim


def inicio_meses_atras(fim: date, n: int) -> date:
    mes = fim.month - (n - 1)
    ano = fim.year
    while mes <= 0:
        mes += 12
        ano -= 1
    return date(ano, mes, 1)


def delta_pct(atual, anterior):
    if not anterior:
        return None
    return (atual - anterior) / anterior * 100


# ---------- Credenciais salvas (.env local) ----------

def salvar_credenciais_env(email, senha):
    linhas = []
    if ENV_PATH.exists():
        for linha in ENV_PATH.read_text(encoding="utf-8").splitlines():
            if linha.strip() and not linha.startswith("VENDR_EMAIL=") and not linha.startswith("VENDR_PASSWORD="):
                linhas.append(linha)
    linhas.append(f"VENDR_EMAIL={email}")
    linhas.append(f"VENDR_PASSWORD={senha}")
    ENV_PATH.write_text("\n".join(linhas) + "\n", encoding="utf-8")


# ---------- Checklist "Vendas do Dia" (persistido em arquivo) ----------

def ler_reposicao_dia(dia_iso):
    arquivo = DATA_DIR / f"reposicao_{dia_iso}.json"
    if arquivo.exists():
        try:
            return json.loads(arquivo.read_text(encoding="utf-8"))
        except Exception:
            return {}
    return {}


def salvar_reposicao_dia(dia_iso, mapa):
    DATA_DIR.mkdir(exist_ok=True)
    arquivo = DATA_DIR / f"reposicao_{dia_iso}.json"
    arquivo.write_text(json.dumps(mapa, ensure_ascii=False, indent=2), encoding="utf-8")


# ---------- Busca de dados (cacheada) ----------

@st.cache_data(ttl=300, show_spinner="Carregando vendas...")
def fetch_vendas(_client, id_vendedor, inicio_iso, fim_iso):
    data = _client.request(
        "get",
        "/api/v1/relatorio/detalhevenda",
        {"idVendedor": id_vendedor, "dtInicial": inicio_iso, "dtFinal": fim_iso, "timezoneOffset": 180},
    )
    return pd.DataFrame(data)


@st.cache_data(ttl=300, show_spinner="Carregando clientes...")
def fetch_clientes(_client, id_vendedor, inicio_iso, fim_iso):
    data = _client.request(
        "get",
        "/api/v1/relatorio/GetRelatorioCliente",
        {"idVendedor": id_vendedor, "dtInicial": inicio_iso, "dtFinal": fim_iso},
    )
    return pd.DataFrame(data)


@st.cache_data(ttl=300, show_spinner=False)
def fetch_produtos(_client, id_vendedor):
    data = _client.request("get", "/api/v1/relatorio/GetRelatorioProduto", {"idVendedor": id_vendedor})
    return pd.DataFrame(data)


@st.cache_data(ttl=60, show_spinner="Carregando vendas do dia...")
def fetch_vendas_periodo(_client, id_vendedor, inicio_iso, fim_iso):
    data = _client.request(
        "get",
        "/api/v1/relatorio/detalhevenda",
        {"idVendedor": id_vendedor, "dtInicial": inicio_iso, "dtFinal": fim_iso, "timezoneOffset": 180},
    )
    return pd.DataFrame(data)


# ---------- Agregações ----------

def calcular_kpis(vendas_df):
    if vendas_df.empty:
        return {"faturamento": 0.0, "pedidos": 0, "ticket_medio": 0.0, "clientes": 0}
    faturamento = float(vendas_df["vlTotal"].sum())
    pedidos = int(vendas_df["id_pedido"].nunique())
    clientes = int(vendas_df["cliente"].fillna("").str.strip().str.upper().nunique())
    return {
        "faturamento": faturamento,
        "pedidos": pedidos,
        "ticket_medio": faturamento / pedidos if pedidos else 0.0,
        "clientes": clientes,
    }


def custo_unitario_serie(vendas_df, custo_map):
    custo_venda = pd.to_numeric(vendas_df.get("preco_custo"), errors="coerce").fillna(0)
    produto_key = vendas_df["produto"].fillna("").str.strip()
    custo_catalogo = produto_key.map(custo_map).fillna(0)
    return custo_venda.where(custo_venda > 0, custo_catalogo)


def calcular_margem_total(vendas_df, custo_map):
    if vendas_df.empty:
        return {"receita": 0.0, "custo": 0.0, "margem": 0.0, "margem_pct": 0.0}
    receita = float(vendas_df["vlTotal"].sum())
    custo = float((custo_unitario_serie(vendas_df, custo_map) * vendas_df["quantidade"]).sum())
    margem = receita - custo
    return {"receita": receita, "custo": custo, "margem": margem, "margem_pct": (margem / receita * 100) if receita else 0.0}


def calcular_serie_diaria(vendas_df):
    if vendas_df.empty:
        return pd.DataFrame(columns=["dia", "total"])
    df = vendas_df.copy()
    df["dia"] = df["data_pedido"].fillna("").str.slice(0, 10)
    agg = df.groupby("dia", as_index=False)["vlTotal"].sum().rename(columns={"vlTotal": "total"})
    return agg.sort_values("dia")


def calcular_vendas_mensais(vendas_df):
    if vendas_df.empty:
        return pd.DataFrame(columns=["mes", "label", "total", "pedidos"])
    df = vendas_df.copy()
    df["mes"] = df["data_pedido"].fillna("").str.slice(0, 7)
    df = df[df["mes"] != ""]
    if df.empty:
        return pd.DataFrame(columns=["mes", "label", "total", "pedidos"])
    agg = df.groupby("mes").agg(total=("vlTotal", "sum"), pedidos=("id_pedido", "nunique")).reset_index()
    agg = agg.sort_values("mes")
    agg["label"] = agg["mes"].apply(lambda m: f"{MESES_PT[int(m.split('-')[1]) - 1]}/{m.split('-')[0][2:]}")
    return agg


def calcular_formas_pagamento(vendas_df):
    if vendas_df.empty:
        return pd.DataFrame(columns=["forma", "total"])
    df = vendas_df.copy()
    df["forma_pagamento"] = df["forma_pagamento"].fillna("Não informado")
    agg = df.groupby("forma_pagamento", as_index=False)["vlTotal"].sum().rename(
        columns={"forma_pagamento": "forma", "vlTotal": "total"}
    )
    return agg.sort_values("total", ascending=False)


def calcular_top_produtos(vendas_df, custo_map, n=10):
    colunas = ["produto", "qtd", "receita", "custo", "margem", "margem_pct"]
    if vendas_df.empty:
        return pd.DataFrame(columns=colunas)
    df = vendas_df.copy()
    df["custo_unit"] = custo_unitario_serie(df, custo_map)
    df["custo_total"] = df["custo_unit"] * df["quantidade"]
    agg = df.groupby("produto", as_index=False).agg(
        qtd=("quantidade", "sum"), receita=("vlTotal", "sum"), custo=("custo_total", "sum")
    )
    agg["margem"] = agg["receita"] - agg["custo"]
    agg["margem_pct"] = agg.apply(lambda r: (r["margem"] / r["receita"] * 100) if r["receita"] else 0.0, axis=1)
    agg = agg.sort_values("receita", ascending=False)
    return agg.head(n) if n else agg


def mapa_cidade_por_cliente(clientes_df):
    if clientes_df.empty or "nome" not in clientes_df.columns:
        return {}
    df = clientes_df.copy()
    df["chave"] = df["nome"].fillna("").str.strip().str.upper()
    df["cidade"] = df["cidade"].fillna("Não informado")
    return dict(zip(df["chave"], df["cidade"]))


def agregar_por_cliente(vendas_df, clientes_df):
    colunas = ["nome", "cidade", "qtd_pedidos", "total_comprado", "ticket_medio"]
    if vendas_df.empty:
        return pd.DataFrame(columns=colunas)
    cidade_map = mapa_cidade_por_cliente(clientes_df)
    df = vendas_df.copy()
    df["nome"] = df["cliente"].fillna("Não informado").str.strip()
    agg = df.groupby("nome").agg(total_comprado=("vlTotal", "sum"), qtd_pedidos=("id_pedido", "nunique")).reset_index()
    agg["cidade"] = agg["nome"].str.upper().map(cidade_map).fillna("Não informado")
    agg["ticket_medio"] = agg.apply(lambda r: r["total_comprado"] / r["qtd_pedidos"] if r["qtd_pedidos"] else 0.0, axis=1)
    return agg.sort_values("total_comprado", ascending=False)


def agregar_por_cidade(vendas_df, clientes_df):
    colunas = ["cidade", "qtd_clientes", "qtd_pedidos", "total_vendido"]
    if vendas_df.empty:
        return pd.DataFrame(columns=colunas)
    cidade_map = mapa_cidade_por_cliente(clientes_df)
    df = vendas_df.copy()
    df["nome_cliente"] = df["cliente"].fillna("").str.strip().str.upper()
    df["cidade"] = df["nome_cliente"].map(cidade_map).fillna("Não informado")
    agg = df.groupby("cidade").agg(
        total_vendido=("vlTotal", "sum"),
        qtd_pedidos=("id_pedido", "nunique"),
        qtd_clientes=("nome_cliente", "nunique"),
    ).reset_index()
    return agg.sort_values("total_vendido", ascending=False)


def calcular_clientes_inativos(clientes_df, min_dias=None, limite=None):
    colunas = ["nome", "cidade", "ultima_compra", "dias"]
    if clientes_df.empty or "dtUltimoPedido" not in clientes_df.columns:
        return pd.DataFrame(columns=colunas)
    df = clientes_df[clientes_df["dtUltimoPedido"].notna()].copy()
    if df.empty:
        return pd.DataFrame(columns=colunas)
    df["ultima_compra"] = pd.to_datetime(df["dtUltimoPedido"])
    agora = pd.Timestamp.now()
    df["dias"] = (agora - df["ultima_compra"]).dt.days
    df["cidade"] = df["cidade"].fillna("Não informado")
    if min_dias is not None:
        df = df[df["dias"] >= min_dias]
    df = df.sort_values("dias", ascending=False)
    resultado = df[colunas]
    return resultado.head(limite) if limite else resultado


def agrupar_por_pedido(vendas_df):
    colunas = ["id_pedido", "pedido", "cliente", "data", "data_fmt", "itens", "total", "pagamento"]
    if vendas_df.empty:
        return pd.DataFrame(columns=colunas)
    agg = vendas_df.groupby("id_pedido").agg(
        pedido=("id_pedidoStr", "first"),
        cliente=("cliente", "first"),
        data=("data_pedido", "first"),
        data_fmt=("data_pedidoStr", "first"),
        pagamento=("forma_pagamento", "first"),
        itens=("produto", "count"),
        total=("vlTotal", "sum"),
    ).reset_index()
    return agg.sort_values("data", ascending=False)


def filtrar_clientes_info(df, cidade_sel, cliente_sel):
    if df.empty or (not cidade_sel and not cliente_sel):
        return df
    mask = pd.Series(True, index=df.index)
    if cidade_sel:
        mask &= df["cidade"].fillna("Não informado") == cidade_sel
    if cliente_sel:
        mask &= df["nome"].fillna("").str.strip().str.upper() == cliente_sel.strip().upper()
    return df[mask]


def aplicar_filtros_vendas(vendas_df, clientes_df_completo, cidade_sel, cliente_sel):
    if vendas_df.empty or (not cidade_sel and not cliente_sel):
        return vendas_df
    cidade_map = mapa_cidade_por_cliente(clientes_df_completo)
    df = vendas_df.copy()
    nome_cliente = df["cliente"].fillna("").str.strip()
    if cliente_sel:
        df = df[nome_cliente.str.upper() == cliente_sel.strip().upper()]
        nome_cliente = df["cliente"].fillna("").str.strip()
    if cidade_sel:
        cidade_da_linha = nome_cliente.str.upper().map(cidade_map).fillna("Não informado")
        df = df[cidade_da_linha == cidade_sel]
    return df


# ---------- Diálogos (drill-down) ----------

@st.dialog("Detalhe")
def abrir_detalhe_produto(vendas_df, produto):
    st.markdown(f"**Quem comprou: {produto}**")
    detalhe = vendas_df[vendas_df["produto"] == produto][["cliente", "data_pedido", "data_pedidoStr", "quantidade", "vlTotal"]].copy()
    detalhe = detalhe.sort_values("data_pedido", ascending=False)
    detalhe["vlTotal"] = detalhe["vlTotal"].apply(format_brl)
    detalhe = detalhe.rename(columns={"cliente": "Cliente", "data_pedidoStr": "Data", "quantidade": "Qtd", "vlTotal": "Total"})
    st.dataframe(detalhe[["Cliente", "Data", "Qtd", "Total"]], use_container_width=True, hide_index=True)


@st.dialog("Detalhe")
def abrir_detalhe_cliente(vendas_df, cliente):
    st.markdown(f"**Produtos comprados por: {cliente}**")
    detalhe = vendas_df[vendas_df["cliente"].fillna("").str.strip() == cliente][
        ["produto", "data_pedido", "data_pedidoStr", "quantidade", "vlTotal"]
    ].copy()
    detalhe = detalhe.sort_values("data_pedido", ascending=False)
    detalhe["vlTotal"] = detalhe["vlTotal"].apply(format_brl)
    detalhe = detalhe.rename(columns={"produto": "Produto", "data_pedidoStr": "Data", "quantidade": "Qtd", "vlTotal": "Total"})
    st.dataframe(detalhe[["Produto", "Data", "Qtd", "Total"]], use_container_width=True, hide_index=True)


@st.dialog("Detalhe")
def abrir_detalhe_cidade(vendas_df, clientes_df, cidade):
    st.markdown(f"**Vendas em: {cidade}**")
    cidade_map = mapa_cidade_por_cliente(clientes_df)
    df = vendas_df.copy()
    df["cidade_calc"] = df["cliente"].fillna("").str.strip().str.upper().map(cidade_map).fillna("Não informado")
    detalhe = df[df["cidade_calc"] == cidade][["produto", "cliente", "data_pedido", "data_pedidoStr", "quantidade", "vlTotal"]].copy()
    detalhe = detalhe.sort_values("data_pedido", ascending=False)
    detalhe["vlTotal"] = detalhe["vlTotal"].apply(format_brl)
    detalhe = detalhe.rename(
        columns={"produto": "Produto", "cliente": "Cliente", "data_pedidoStr": "Data", "quantidade": "Qtd", "vlTotal": "Total"}
    )
    st.dataframe(detalhe[["Produto", "Cliente", "Data", "Qtd", "Total"]], use_container_width=True, hide_index=True)


@st.dialog("Itens do pedido")
def abrir_detalhe_pedido(vendas_df, id_pedido, pedido_label, cliente_label):
    st.markdown(f"**Pedido {pedido_label} — {cliente_label}**")
    itens = vendas_df[vendas_df["id_pedido"] == id_pedido][["produto", "quantidade", "preco_unitario", "vlTotal"]].copy()
    itens["preco_unitario"] = itens["preco_unitario"].apply(format_brl)
    itens["vlTotal"] = itens["vlTotal"].apply(format_brl)
    itens = itens.rename(columns={"produto": "Produto", "quantidade": "Qtd", "preco_unitario": "Preço Unit.", "vlTotal": "Total"})
    st.dataframe(itens, use_container_width=True, hide_index=True)


@st.dialog("Fiado — valor a receber por cliente")
def abrir_detalhe_fiado(vendas_df):
    fiado = vendas_df[vendas_df["forma_pagamento"].fillna("").str.lower() == "fiado"].copy()
    if fiado.empty:
        st.info("Nenhuma venda em Fiado no período.")
        return
    agg = fiado.groupby(fiado["cliente"].fillna("Não informado").str.strip()).agg(
        pedidos=("id_pedido", "nunique"), total=("vlTotal", "sum")
    ).reset_index().rename(columns={"cliente": "Cliente"})
    agg = agg.sort_values("total", ascending=False)
    agg["total"] = agg["total"].apply(format_brl)
    agg = agg.rename(columns={"pedidos": "Pedidos", "total": "Total a Receber"})
    st.dataframe(agg, use_container_width=True, hide_index=True)


@st.dialog("Produtos sem custo cadastrado")
def abrir_detalhe_sem_custo(todos_produtos):
    sem_custo = todos_produtos[todos_produtos["custo"] == 0].sort_values("receita", ascending=False).copy()
    sem_custo["receita"] = sem_custo["receita"].apply(format_brl)
    sem_custo = sem_custo.rename(columns={"produto": "Produto", "qtd": "Qtd", "receita": "Receita"})
    st.dataframe(sem_custo[["Produto", "Qtd", "Receita"]], use_container_width=True, hide_index=True)


@st.dialog("Clientes sem comprar há 30+ dias")
def abrir_detalhe_inativos(clientes_df):
    inativos = calcular_clientes_inativos(clientes_df, min_dias=30)
    inativos = inativos.copy()
    inativos["ultima_compra"] = inativos["ultima_compra"].dt.strftime("%d/%m/%Y")
    inativos = inativos.rename(columns={"nome": "Cliente", "cidade": "Cidade", "ultima_compra": "Última Compra", "dias": "Dias sem comprar"})
    st.dataframe(inativos, use_container_width=True, hide_index=True)


@st.dialog("Vendas do Dia")
def abrir_vendas_do_dia(client):
    dia = st.date_input("Data", value=date.today(), key="dia_vendas_dia")
    try:
        vendas_dia = fetch_vendas_periodo(client, client.id_vendedor, iso_inicio(dia), iso_fim(dia))
    except Exception as e:
        st.error(f"Erro ao carregar vendas do dia: {e}")
        return

    if vendas_dia.empty:
        st.info("Nenhuma venda registrada nesse dia.")
        return

    agrupado = vendas_dia.groupby("produto").agg(
        qtd=("quantidade", "sum"), pedidos=("id_pedido", "nunique"), total=("vlTotal", "sum")
    ).reset_index()
    agrupado = agrupado.sort_values("qtd", ascending=False)

    dia_iso = dia.isoformat()
    reposicao = ler_reposicao_dia(dia_iso)
    agrupado["Reposto"] = agrupado["produto"].map(lambda p: bool(reposicao.get(p, False)))

    repostos = int(agrupado["Reposto"].sum())
    st.caption(
        f"{repostos} de {len(agrupado)} produto(s) já repostos — {len(vendas_dia)} item(ns) vendidos, "
        f"{format_brl(agrupado['total'].sum())} no total."
    )

    tabela = agrupado.rename(columns={"produto": "Produto", "qtd": "Qtd. Vendida", "pedidos": "Pedidos", "total": "Receita"})
    tabela = tabela[["Reposto", "Produto", "Qtd. Vendida", "Pedidos", "Receita"]]

    editado = st.data_editor(
        tabela,
        use_container_width=True,
        hide_index=True,
        disabled=["Produto", "Qtd. Vendida", "Pedidos", "Receita"],
        column_config={"Receita": st.column_config.NumberColumn(format="R$ %.2f")},
        key=f"editor_reposicao_{dia_iso}",
    )
    nova_reposicao = dict(zip(editado["Produto"], editado["Reposto"].astype(bool)))
    if nova_reposicao != reposicao:
        salvar_reposicao_dia(dia_iso, nova_reposicao)
        st.rerun()


# ---------- Tela de login ----------

def tela_login():
    st.markdown('<p class="brand-title">Bio Cosméticos</p><p class="brand-sub">Painel de Vendas</p>', unsafe_allow_html=True)
    st.subheader("Entrar")
    st.caption("Use o mesmo e-mail e senha da sua conta Vendr.")
    with st.form("form_login"):
        email = st.text_input("E-mail")
        senha = st.text_input("Senha", type="password")
        lembrar = st.checkbox("Lembrar meu login neste computador", value=True)
        enviar = st.form_submit_button("Entrar")

    if enviar:
        if not email.strip() or not senha.strip():
            st.error("Informe e-mail e senha.")
            return
        try:
            client = VendrClient(email.strip(), senha.strip())
            client.login()
            st.session_state["client"] = client
            if lembrar:
                try:
                    salvar_credenciais_env(email.strip(), senha.strip())
                except Exception:
                    pass
            st.rerun()
        except requests.HTTPError:
            st.error("E-mail ou senha inválidos.")
        except Exception as e:
            st.error(f"Não foi possível entrar: {e}")


def tentar_login_automatico():
    if "client" in st.session_state or st.session_state.get("auto_login_tentado"):
        return
    st.session_state["auto_login_tentado"] = True
    email = os.getenv("VENDR_EMAIL", "").strip()
    senha = os.getenv("VENDR_PASSWORD", "").strip()
    if not email or not senha:
        return
    try:
        client = VendrClient(email, senha)
        client.login()
        st.session_state["client"] = client
    except Exception:
        pass  # falha silenciosa — mostra a tela de login


# ---------- App principal ----------

tentar_login_automatico()

if "client" not in st.session_state:
    tela_login()
    st.stop()

client = st.session_state["client"]

col_logo, col_title, col_sair = st.columns([1, 7, 1])
with col_logo:
    logo_path = BASE_DIR / "logo.png"
    if logo_path.exists():
        st.image(str(logo_path), width=60)
with col_title:
    st.markdown('<p class="brand-title">Bio Cosméticos</p><p class="brand-sub">Painel de Vendas</p>', unsafe_allow_html=True)
with col_sair:
    if st.button("Sair"):
        st.session_state.pop("client", None)
        st.rerun()

c1, c2 = st.columns(2)
with c1:
    data_inicial = st.date_input("De", value=date.today().replace(day=1))
with c2:
    data_final = st.date_input("Até", value=date.today())

if data_inicial > data_final:
    st.error("A data inicial não pode ser depois da data final.")
    st.stop()

inicio_iso = iso_inicio(data_inicial)
fim_iso = iso_fim(data_final)

try:
    clientes_completo = fetch_clientes(client, client.id_vendedor, inicio_iso, fim_iso)
except Exception as e:
    st.error(f"Erro ao consultar o Vendr: {e}")
    st.stop()

cidades_opcoes = ["(Todas as cidades)"]
clientes_opcoes = ["(Todos os clientes)"]
if not clientes_completo.empty:
    if "cidade" in clientes_completo.columns:
        cidades_opcoes += sorted(clientes_completo["cidade"].fillna("Não informado").unique().tolist())
    if "nome" in clientes_completo.columns:
        clientes_opcoes += sorted(clientes_completo["nome"].dropna().unique().tolist())

c3, c4, c5, c6 = st.columns([1.3, 1.6, 0.7, 0.9])
with c3:
    cidade_sel_opt = st.selectbox("Cidade", cidades_opcoes)
with c4:
    cliente_sel_opt = st.selectbox("Cliente", clientes_opcoes)
with c5:
    if st.button("🔄 Atualizar"):
        st.cache_data.clear()
        st.rerun()
with c6:
    if st.button("📋 Vendas do Dia"):
        abrir_vendas_do_dia(client)

cidade_sel = "" if cidade_sel_opt.startswith("(Todas") else cidade_sel_opt
cliente_sel = "" if cliente_sel_opt.startswith("(Todos") else cliente_sel_opt

anterior_inicio, anterior_fim = periodo_anterior(data_inicial, data_final)
mensal_inicio = inicio_meses_atras(data_final, 6)

try:
    vendas_brutas = fetch_vendas(client, client.id_vendedor, inicio_iso, fim_iso)
    vendas_anterior_brutas = fetch_vendas(client, client.id_vendedor, iso_inicio(anterior_inicio), iso_fim(anterior_fim))
    produtos_catalogo = fetch_produtos(client, client.id_vendedor)
    vendas_mensal_brutas = fetch_vendas(client, client.id_vendedor, iso_inicio(mensal_inicio), fim_iso)
except Exception as e:
    st.error(f"Erro ao consultar o Vendr: {e}")
    st.stop()

vendas = aplicar_filtros_vendas(vendas_brutas, clientes_completo, cidade_sel, cliente_sel)
vendas_anterior = aplicar_filtros_vendas(vendas_anterior_brutas, clientes_completo, cidade_sel, cliente_sel)
vendas_mensal = aplicar_filtros_vendas(vendas_mensal_brutas, clientes_completo, cidade_sel, cliente_sel)
clientes_info = filtrar_clientes_info(clientes_completo, cidade_sel, cliente_sel)

custo_map = {}
if not produtos_catalogo.empty and "descricao" in produtos_catalogo.columns:
    for _, row in produtos_catalogo.iterrows():
        desc = row.get("descricao")
        if desc:
            custo_map[str(desc).strip()] = float(row.get("preco_custo") or 0)

# ---------- KPIs ----------

kpis_atual = calcular_kpis(vendas)
kpis_anterior = calcular_kpis(vendas_anterior)
margem_atual = calcular_margem_total(vendas, custo_map)
margem_anterior = calcular_margem_total(vendas_anterior, custo_map)

st.markdown("---")
kc1, kc2, kc3, kc4, kc5 = st.columns(5)
kc1.metric("Faturamento", format_brl(kpis_atual["faturamento"]), format_delta(delta_pct(kpis_atual["faturamento"], kpis_anterior["faturamento"])))
kc2.metric("Pedidos", kpis_atual["pedidos"], format_delta(delta_pct(kpis_atual["pedidos"], kpis_anterior["pedidos"])))
kc3.metric("Ticket Médio", format_brl(kpis_atual["ticket_medio"]), format_delta(delta_pct(kpis_atual["ticket_medio"], kpis_anterior["ticket_medio"])))
kc4.metric("Clientes Ativos", kpis_atual["clientes"], format_delta(delta_pct(kpis_atual["clientes"], kpis_anterior["clientes"])))
kc5.metric("Margem Bruta", format_brl(margem_atual["margem"]), format_delta(delta_pct(margem_atual["margem"], margem_anterior["margem"])))

# ---------- Insights ----------

todos_produtos = calcular_top_produtos(vendas, custo_map, None)

st.markdown("#### Insights")
ic1, ic2 = st.columns(2)

total_vendido = float(vendas["vlTotal"].sum()) if not vendas.empty else 0.0
total_fiado = float(vendas[vendas["forma_pagamento"].fillna("").str.lower() == "fiado"]["vlTotal"].sum()) if not vendas.empty else 0.0

with ic1:
    if total_vendido > 0 and total_fiado > 0:
        pct_fiado = total_fiado / total_vendido * 100
        caixa = st.error if pct_fiado > 30 else st.warning if pct_fiado > 15 else st.success
        caixa(f"**{pct_fiado:.0f}% das vendas em Fiado** — {format_brl(total_fiado)} ainda a receber.")
        if st.button("Ver por cliente", key="btn_fiado"):
            abrir_detalhe_fiado(vendas)

    if not todos_produtos.empty:
        campeao = todos_produtos.iloc[0]
        st.success(f"**Produto campeão: {campeao['produto']}** — {format_brl(campeao['receita'])} em {int(campeao['qtd'])} unidades.")
        if st.button("Ver quem comprou", key="btn_campeao"):
            abrir_detalhe_produto(vendas, campeao["produto"])

with ic2:
    if not todos_produtos.empty:
        receita_total = todos_produtos["receita"].sum()
        receita_sem_custo = todos_produtos[todos_produtos["custo"] == 0]["receita"].sum()
        pct_sem_custo = (receita_sem_custo / receita_total * 100) if receita_total else 0
        if pct_sem_custo > 20:
            st.warning(f"**{pct_sem_custo:.0f}% da receita sem custo cadastrado** — a margem pode estar subestimada.")
            if st.button("Ver produtos sem custo", key="btn_sem_custo"):
                abrir_detalhe_sem_custo(todos_produtos)

    inativos_30 = calcular_clientes_inativos(clientes_info, min_dias=30)
    if not inativos_30.empty:
        caixa = st.error if len(inativos_30) > 10 else st.warning
        caixa(f"**{len(inativos_30)} clientes sem comprar há 30+ dias** — oportunidade de reativação.")
        if st.button("Ver lista completa", key="btn_inativos"):
            abrir_detalhe_inativos(clientes_info)

# ---------- Vendas no período e formas de pagamento ----------

st.markdown("#### Vendas no período e formas de pagamento")
g1, g2 = st.columns(2)
with g1:
    serie = calcular_serie_diaria(vendas)
    fig = go.Figure()
    fig.add_bar(x=serie["dia"], y=serie["total"], marker_color=COR_SERIE_1)
    fig.update_layout(margin=dict(t=10, l=10, r=10, b=10), height=300, yaxis_tickprefix="R$ ")
    st.plotly_chart(fig, use_container_width=True)
with g2:
    formas = calcular_formas_pagamento(vendas)
    cores_pg = [COR_SERIE_1, COR_SERIE_2, COR_SERIE_3, COR_SERIE_4, COR_SERIE_5]
    fig2 = go.Figure()
    fig2.add_bar(
        x=formas["total"], y=formas["forma"], orientation="h",
        marker_color=[cores_pg[i % len(cores_pg)] for i in range(len(formas))],
    )
    fig2.update_layout(margin=dict(t=10, l=10, r=10, b=10), height=300, xaxis_tickprefix="R$ ")
    st.plotly_chart(fig2, use_container_width=True)

# ---------- Comparação mensal ----------

st.markdown("#### Comparação mensal")
mensal = calcular_vendas_mensais(vendas_mensal)
fig3 = go.Figure()
fig3.add_bar(x=mensal["label"], y=mensal["total"], marker_color=COR_SERIE_1)
fig3.update_layout(margin=dict(t=10, l=10, r=10, b=10), height=280, yaxis_tickprefix="R$ ")
st.plotly_chart(fig3, use_container_width=True)

# ---------- Produtos mais vendidos / Clientes que mais compraram ----------

st.markdown("#### Produtos mais vendidos e clientes que mais compraram")
p1, p2 = st.columns(2)
with p1:
    st.markdown("**Produtos mais vendidos**")
    top_produtos = calcular_top_produtos(vendas, custo_map, 10)
    fig4 = go.Figure()
    fig4.add_bar(x=top_produtos["receita"], y=top_produtos["produto"], orientation="h", marker_color=COR_SERIE_1)
    fig4.update_layout(margin=dict(t=10, l=10, r=10, b=10), height=320, xaxis_tickprefix="R$ ", yaxis=dict(autorange="reversed"))
    st.plotly_chart(fig4, use_container_width=True)
    tabela_produtos = top_produtos.rename(
        columns={"produto": "Produto", "qtd": "Qtd", "receita": "Receita", "margem": "Margem", "margem_pct": "Margem %"}
    )[["Produto", "Qtd", "Receita", "Margem", "Margem %"]]
    st.dataframe(tabela_produtos, use_container_width=True, hide_index=True)
    if not top_produtos.empty:
        prod_sel = st.selectbox("Ver quem comprou:", top_produtos["produto"].tolist(), key="sel_produto")
        if st.button("Ver detalhes", key="btn_ver_produto"):
            abrir_detalhe_produto(vendas, prod_sel)

with p2:
    st.markdown("**Clientes que mais compraram**")
    top_clientes = agregar_por_cliente(vendas, clientes_completo).head(10)
    fig5 = go.Figure()
    fig5.add_bar(x=top_clientes["total_comprado"], y=top_clientes["nome"], orientation="h", marker_color=COR_SERIE_1)
    fig5.update_layout(margin=dict(t=10, l=10, r=10, b=10), height=320, xaxis_tickprefix="R$ ", yaxis=dict(autorange="reversed"))
    st.plotly_chart(fig5, use_container_width=True)
    tabela_clientes = top_clientes.rename(
        columns={"nome": "Cliente", "cidade": "Cidade", "qtd_pedidos": "Pedidos", "total_comprado": "Total", "ticket_medio": "Ticket Médio"}
    )[["Cliente", "Cidade", "Pedidos", "Total", "Ticket Médio"]]
    st.dataframe(tabela_clientes, use_container_width=True, hide_index=True)
    if not top_clientes.empty:
        cliente_sel_detalhe = st.selectbox("Ver produtos comprados:", top_clientes["nome"].tolist(), key="sel_cliente")
        if st.button("Ver detalhes", key="btn_ver_cliente"):
            abrir_detalhe_cliente(vendas, cliente_sel_detalhe)

# ---------- Todos os produtos vendidos ----------

st.markdown("#### Todos os produtos vendidos")
busca_prod = st.text_input("Buscar produto", key="busca_produtos")
todos_produtos_filtrado = todos_produtos
if busca_prod.strip():
    todos_produtos_filtrado = todos_produtos[todos_produtos["produto"].str.lower().str.contains(busca_prod.strip().lower())]
st.caption(f"{len(todos_produtos_filtrado)} produto(s) diferentes")
tabela_todos_produtos = todos_produtos_filtrado.rename(
    columns={"produto": "Produto", "qtd": "Qtd", "receita": "Receita", "margem": "Margem", "margem_pct": "Margem %"}
)[["Produto", "Qtd", "Receita", "Margem", "Margem %"]]
st.dataframe(tabela_todos_produtos, use_container_width=True, hide_index=True, height=350)

# ---------- Vendas por cidade ----------

st.markdown("#### Vendas por cidade")
top_cidades = agregar_por_cidade(vendas, clientes_completo).head(10)
fig6 = go.Figure()
fig6.add_bar(x=top_cidades["total_vendido"], y=top_cidades["cidade"], orientation="h", marker_color=COR_SERIE_1)
fig6.update_layout(margin=dict(t=10, l=10, r=10, b=10), height=320, xaxis_tickprefix="R$ ", yaxis=dict(autorange="reversed"))
st.plotly_chart(fig6, use_container_width=True)
tabela_cidades = top_cidades.rename(
    columns={"cidade": "Cidade", "qtd_clientes": "Clientes", "qtd_pedidos": "Pedidos", "total_vendido": "Total"}
)[["Cidade", "Clientes", "Pedidos", "Total"]]
st.dataframe(tabela_cidades, use_container_width=True, hide_index=True)
if not top_cidades.empty:
    cidade_sel_detalhe = st.selectbox("Ver vendas da cidade:", top_cidades["cidade"].tolist(), key="sel_cidade")
    if st.button("Ver detalhes", key="btn_ver_cidade"):
        abrir_detalhe_cidade(vendas, clientes_completo, cidade_sel_detalhe)

# ---------- Detalhe de vendas ----------

st.markdown("#### Detalhe de vendas")
pedidos_df = agrupar_por_pedido(vendas)
busca_vendas = st.text_input("Buscar por cliente ou produto", key="busca_vendas")
if busca_vendas.strip() and not pedidos_df.empty and not vendas.empty:
    termo = busca_vendas.strip().lower()
    produtos_por_pedido = vendas.groupby("id_pedido")["produto"].apply(lambda s: " ".join(s.fillna("").str.lower()))
    match_cliente = pedidos_df["cliente"].fillna("").str.lower().str.contains(termo)
    match_produto = pedidos_df["id_pedido"].map(produtos_por_pedido).fillna("").str.contains(termo)
    pedidos_df = pedidos_df[match_cliente | match_produto]
st.caption(f"{len(pedidos_df)} pedido(s)")
tabela_pedidos = pedidos_df.rename(
    columns={"pedido": "Pedido", "cliente": "Cliente", "data_fmt": "Data", "itens": "Itens", "total": "Total", "pagamento": "Pagamento"}
)[["Pedido", "Cliente", "Data", "Itens", "Total", "Pagamento"]]
st.dataframe(tabela_pedidos, use_container_width=True, hide_index=True, height=350)
if not pedidos_df.empty:
    pedido_sel = st.selectbox("Ver itens do pedido:", pedidos_df["pedido"].tolist(), key="sel_pedido")
    if st.button("Ver itens", key="btn_ver_pedido"):
        linha = pedidos_df[pedidos_df["pedido"] == pedido_sel].iloc[0]
        abrir_detalhe_pedido(vendas, linha["id_pedido"], linha["pedido"], linha["cliente"])

# ---------- Clientes sem comprar há mais tempo ----------

st.markdown("#### Clientes sem comprar há mais tempo")
inativos = calcular_clientes_inativos(clientes_info, limite=15).copy()
if not inativos.empty:
    inativos["ultima_compra"] = inativos["ultima_compra"].dt.strftime("%d/%m/%Y")
tabela_inativos = inativos.rename(
    columns={"nome": "Cliente", "cidade": "Cidade", "ultima_compra": "Última Compra", "dias": "Dias sem comprar"}
)
st.dataframe(tabela_inativos, use_container_width=True, hide_index=True)
