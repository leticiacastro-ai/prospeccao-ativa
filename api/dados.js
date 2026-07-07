// ============================================================
//  api/dados.js  —  a ÚNICA peça de servidor do app
// ------------------------------------------------------------
//  O que ela faz:
//   1. Busca todos os leads no Datacrazy (respeitando o limite
//      de 120 requisições por minuto).
//   2. Mantém só os leads de prospecção ativa (tag "ig-outbound")
//      que têm um SDR atribuído.
//   3. Descobre a etapa mais avançada de cada lead pelas tags.
//   4. Soma tudo por SDR e devolve pronto pro app desenhar.
//
//  O token fica guardado com segurança na variável de ambiente
//  DATACRAZY_API_KEY (configurada na Vercel), nunca no navegador.
// ============================================================

const BASE = (process.env.DATACRAZY_API_URL || 'https://api.g1.datacrazy.io') + '/api/v1';
const TOKEN = process.env.DATACRAZY_API_KEY;

// Ordem do funil (rank). A etapa do lead é o MAIOR rank entre as tags dele.
const RANK = {
  'ig-outbound': 1,
  'respondeu outbound': 2,
  'status-agendado': 3,
  'status-no-show': 3,
  'status-cancelado': 3,
  'status-reagendado': 3,
  'status-excluida': 3,
  'status-compareceu': 4,
  'cliente ativo': 5,
};

const CORES = ['#4A79B0','#2A9E8C','#E4A028','#B4749B','#C7623E','#5B8C5A','#7E6BB0','#3E8FA3'];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Transforma o campo tags (que às vezes vem como objeto único, às vezes
// como lista) numa lista simples de nomes em minúsculo.
function nomesDasTags(tags) {
  if (!tags) return [];
  const lista = Array.isArray(tags) ? tags : [tags];
  return lista
    .map((t) => (typeof t === 'string' ? t : (t && t.name) || (t && t.nome) || ''))
    .filter(Boolean)
    .map((s) => s.trim().toLowerCase());
}

// Descobre a partir de quando contar, com base no período escolhido.
function dataDeCorte(periodo) {
  const agora = new Date();
  if (periodo === 'mes') return new Date(agora.getFullYear(), agora.getMonth(), 1);
  const dias = parseInt(periodo, 10);
  if (!isNaN(dias)) {
    const d = new Date(agora);
    d.setDate(d.getDate() - dias);
    return d;
  }
  return null; // sem filtro
}

async function buscarTodosOsLeads() {
  const take = 100;
  let skip = 0;
  const todos = [];

  // trava de segurança: no máximo 100 páginas (10 mil leads)
  for (let pagina = 0; pagina < 100; pagina++) {
    const url = `${BASE}/leads?skip=${skip}&take=${take}`;
    const resp = await fetch(url, {
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        'Content-Type': 'application/json',
      },
    });

    if (!resp.ok) {
      const texto = await resp.text().catch(() => '');
      throw new Error(`Datacrazy respondeu ${resp.status}. ${texto.slice(0, 200)}`);
    }

    const corpo = await resp.json();
    // a resposta pode vir como { data: [...] } ou como [...] direto
    const pagina_leads = Array.isArray(corpo) ? corpo : (corpo.data || corpo.leads || []);
    todos.push(...pagina_leads);

    if (pagina_leads.length < take) break; // acabou
    skip += take;
    await sleep(600); // respeita o limite de 120 req/min
  }

  return todos;
}

module.exports = async (req, res) => {
  try {
    if (!TOKEN) {
      return res.status(500).json({
        error: 'Falta configurar a variável DATACRAZY_API_KEY na Vercel.',
      });
    }

    const periodo = (req.query && req.query.periodo) || '30';
    const corte = dataDeCorte(periodo);

    const leads = await buscarTodosOsLeads();

    // agrega por SDR
    const porSdr = new Map();

    for (const lead of leads) {
      // precisa ter SDR atribuído
      const sdr = lead.attendant || lead.atendente;
      const nomeSdr = sdr && (sdr.name || sdr.nome);
      if (!nomeSdr) continue;

      // precisa ser prospecção ativa (ig-outbound)
      const tags = nomesDasTags(lead.tags);
      if (!tags.includes('ig-outbound')) continue;

      // filtro de período pela data em que o lead foi prospectado
      if (corte) {
        const criado = lead.createdAt || lead.created_at || lead.dataCriacao;
        if (criado && new Date(criado) < corte) continue;
      }

      // etapa = maior rank entre as tags do lead
      let etapa = 1;
      for (const t of tags) if (RANK[t] && RANK[t] > etapa) etapa = RANK[t];

      if (!porSdr.has(nomeSdr)) {
        porSdr.set(nomeSdr, {
          sdr: nomeSdr,
          prospectou: 0, respondeu: 0, agendou: 0, compareceu: 0, cliente: 0,
        });
      }
      const r = porSdr.get(nomeSdr);
      r.prospectou += 1;                 // etapa >= 1
      if (etapa >= 2) r.respondeu += 1;
      if (etapa >= 3) r.agendou += 1;
      if (etapa >= 4) r.compareceu += 1;
      if (etapa >= 5) r.cliente += 1;
    }

    // ordena por clientes e adiciona uma cor pra cada SDR
    const resultado = [...porSdr.values()]
      .sort((a, b) => b.cliente - a.cliente)
      .map((r, i) => ({ ...r, cor: CORES[i % CORES.length] }));

    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json(resultado);
  } catch (e) {
    return res.status(500).json({ error: String((e && e.message) || e) });
  }
};
