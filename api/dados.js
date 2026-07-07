// ============================================================
//  api/dados.js  —  a ÚNICA peça de servidor do app
// ------------------------------------------------------------
//  Busca os leads no Datacrazy, conta por etapa e por SDR.
//  Agora com duas proteções contra o limite de 120 req/min:
//   • se levar "429 (rápido demais)", ele espera e tenta de novo;
//   • guarda o resultado por ~1,5 min (cache), pra atualizar a
//     tela não sair pedindo tudo de novo ao Datacrazy toda hora.
//
//  O token fica guardado com segurança na variável de ambiente
//  DATACRAZY_API_KEY (configurada na Vercel), nunca no navegador.
// ============================================================

const BASE = (process.env.DATACRAZY_API_URL || 'https://api.g1.datacrazy.io') + '/api/v1';
const TOKEN = process.env.DATACRAZY_API_KEY;

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

// --- cache simples na memória do servidor ---
const CACHE = new Map();            // periodo -> { data, ts }
const TTL = 90 * 1000;              // 1,5 min "fresco"
const TTL_RESERVA = 15 * 60 * 1000; // até 15 min como reserva em caso de erro

function nomesDasTags(tags) {
  if (!tags) return [];
  const lista = Array.isArray(tags) ? tags : [tags];
  return lista
    .map((t) => (typeof t === 'string' ? t : (t && t.name) || (t && t.nome) || ''))
    .filter(Boolean)
    .map((s) => s.trim().toLowerCase());
}

function dataDeCorte(periodo) {
  const agora = new Date();
  if (periodo === 'mes') return new Date(agora.getFullYear(), agora.getMonth(), 1);
  const dias = parseInt(periodo, 10);
  if (!isNaN(dias)) { const d = new Date(agora); d.setDate(d.getDate() - dias); return d; }
  return null;
}

// Faz a chamada e, se levar 429, espera um pouco e tenta de novo.
async function buscarComPaciencia(url, opts) {
  const esperas = [1500, 3000]; // tenta 3 vezes no total
  for (let i = 0; i <= esperas.length; i++) {
    const resp = await fetch(url, opts);
    if (resp.status !== 429) return resp;
    if (i === esperas.length) return resp; // esgotou as tentativas: devolve o 429
    let espera = esperas[i];
    const ra = parseInt(resp.headers.get('retry-after') || '', 10);
    if (!isNaN(ra)) espera = Math.min(ra * 1000, 4000); // respeita, mas no máx 4s
    await sleep(espera);
  }
}

async function buscarTodosOsLeads() {
  const take = 100;
  let skip = 0;
  const todos = [];
  const opts = { headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' } };

  for (let pagina = 0; pagina < 100; pagina++) {
    const resp = await buscarComPaciencia(`${BASE}/leads?skip=${skip}&take=${take}`, opts);

    if (resp.status === 429) {
      const err = new Error('O Datacrazy esta limitando as requisicoes (limite de 120/min). Tente atualizar em 1 minuto. Se o sistema antigo ainda estiver publicado, pause o cron dele.');
      err.code = 429;
      throw err;
    }
    if (!resp.ok) {
      const texto = await resp.text().catch(() => '');
      throw new Error(`Datacrazy respondeu ${resp.status}. ${texto.slice(0, 160)}`);
    }

    const corpo = await resp.json();
    const pagina_leads = Array.isArray(corpo) ? corpo : (corpo.data || corpo.leads || []);
    todos.push(...pagina_leads);
    if (pagina_leads.length < take) break;
    skip += take;
    await sleep(700); // margem confortavel dentro do limite
  }
  return todos;
}

function agregar(leads, corte) {
  const porSdr = new Map();
  for (const lead of leads) {
    const sdr = lead.attendant || lead.atendente;
    const nomeSdr = sdr && (sdr.name || sdr.nome);
    if (!nomeSdr) continue;

    const tags = nomesDasTags(lead.tags);
    if (!tags.includes('ig-outbound')) continue;

    if (corte) {
      const criado = lead.createdAt || lead.created_at || lead.dataCriacao;
      if (criado && new Date(criado) < corte) continue;
    }

    let etapa = 1;
    for (const t of tags) if (RANK[t] && RANK[t] > etapa) etapa = RANK[t];

    if (!porSdr.has(nomeSdr)) {
      porSdr.set(nomeSdr, { sdr: nomeSdr, prospectou: 0, respondeu: 0, agendou: 0, compareceu: 0, cliente: 0 });
    }
    const r = porSdr.get(nomeSdr);
    r.prospectou += 1;
    if (etapa >= 2) r.respondeu += 1;
    if (etapa >= 3) r.agendou += 1;
    if (etapa >= 4) r.compareceu += 1;
    if (etapa >= 5) r.cliente += 1;
  }
  return [...porSdr.values()]
    .sort((a, b) => b.cliente - a.cliente)
    .map((r, i) => ({ ...r, cor: CORES[i % CORES.length] }));
}

module.exports = async (req, res) => {
  try {
    if (!TOKEN) {
      return res.status(500).json({ error: 'Falta configurar a variavel DATACRAZY_API_KEY na Vercel.' });
    }

    const periodo = (req.query && req.query.periodo) || '30';
    const agora = Date.now();
    const emCache = CACHE.get(periodo);

    // cache fresco: devolve na hora, sem chamar o Datacrazy
    if (emCache && (agora - emCache.ts) < TTL) {
      res.setHeader('Cache-Control', 'no-store');
      return res.status(200).json(emCache.data);
    }

    try {
      const leads = await buscarTodosOsLeads();
      const resultado = agregar(leads, dataDeCorte(periodo));
      CACHE.set(periodo, { data: resultado, ts: agora });
      res.setHeader('Cache-Control', 'no-store');
      return res.status(200).json(resultado);
    } catch (e) {
      // deu erro (ex.: 429): se tiver um resultado de reserva, usa ele
      if (emCache && (agora - emCache.ts) < TTL_RESERVA) {
        res.setHeader('Cache-Control', 'no-store');
        return res.status(200).json(emCache.data);
      }
      const status = e.code === 429 ? 429 : 500;
      return res.status(status).json({ error: String((e && e.message) || e) });
    }
  } catch (e) {
    return res.status(500).json({ error: String((e && e.message) || e) });
  }
};
