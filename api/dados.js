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
const { lerLista: lerSdrsCadastrados } = require('./sdrs.js');
const armazenamento = require('./armazenamento.js');

// Cache por dia — dia fechado (ontem pra tras) nao muda mais, entao busca
// uma vez so e guarda pra sempre. So o dia de hoje e buscado fresco a cada
// chamada. Isso evita reprocessar o historico inteiro toda vez que alguem
// troca o filtro (7 dias, 30 dias, mes, intervalo...). Onde isso e guardado
// (arquivo local ou Vercel KV) fica em api/armazenamento.js.
function chaveDia(d) {
  const ano = d.getFullYear();
  const mes = String(d.getMonth() + 1).padStart(2, '0');
  const dia = String(d.getDate()).padStart(2, '0');
  return `${ano}-${mes}-${dia}`;
}

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

// --- trava simples: so deixa UMA busca no Datacrazy rodar por vez.       ---
// --- se chegar outra requisicao enquanto uma ja esta buscando, ela      ---
// --- espera a fila em vez de disparar outra busca paginada por cima,    ---
// --- o que dobrava/triplicava o consumo da cota quando tinha mais de    ---
// --- uma aba/pedido ao mesmo tempo.                                     ---
let filaDeEspera = Promise.resolve();
function comFila(tarefa) {
  const proxima = filaDeEspera.then(tarefa, tarefa);
  filaDeEspera = proxima.catch(() => {}); // nao deixa um erro travar a fila
  return proxima;
}

// --- cache simples na memória do servidor ---
const CACHE = new Map();            // periodo -> { data, ts }
const TTL = 3 * 60 * 1000;            // 3 min "fresco"
const TTL_RESERVA = 30 * 60 * 1000;  // até 30 min como reserva em caso de erro

function nomesDasTags(tags) {
  if (!tags) return [];
  const lista = Array.isArray(tags) ? tags : [tags];
  return lista
    .map((t) => (typeof t === 'string' ? t : (t && t.name) || (t && t.nome) || ''))
    .filter(Boolean)
    .map((s) => s.trim().toLowerCase());
}

function inicioDoDia(d) { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; }
function fimDoDia(d) { const x = new Date(d); x.setHours(23, 59, 59, 999); return x; }

// Retorna { inicio, fim } (fim pode ser null = sem limite superior, até agora).
function faixaDeData(query) {
  const periodo = (query && query.periodo) || '30';
  const agora = new Date();

  if (periodo === 'hoje') {
    return { inicio: inicioDoDia(agora), fim: null };
  }
  if (periodo === 'ontem') {
    const ontem = new Date(agora); ontem.setDate(ontem.getDate() - 1);
    return { inicio: inicioDoDia(ontem), fim: fimDoDia(ontem) };
  }
  if (periodo === 'data') {
    const d = query.data ? new Date(query.data + 'T00:00:00') : agora;
    return { inicio: inicioDoDia(d), fim: fimDoDia(d) };
  }
  if (periodo === 'intervalo') {
    const inicio = query.inicio ? new Date(query.inicio + 'T00:00:00') : null;
    const fim = query.fim ? fimDoDia(new Date(query.fim + 'T00:00:00')) : null;
    return { inicio, fim };
  }
  if (periodo === 'mes') {
    return { inicio: new Date(agora.getFullYear(), agora.getMonth(), 1), fim: null };
  }
  const dias = parseInt(periodo, 10);
  if (!isNaN(dias)) {
    const d = new Date(agora); d.setDate(d.getDate() - dias);
    return { inicio: inicioDoDia(d), fim: null }; // dia cheio, pra bater com o cache diario
  }
  return { inicio: null, fim: null };
}

// Faz a chamada e, se levar 429, espera o tempo que o Datacrazy pedir (Retry-After)
// e tenta de novo, em vez de desistir rápido — prefere demorar a devolver parcial.
async function buscarComPaciencia(url, opts) {
  const maxTentativas = 8; // paciencia total de uns 2 minutos por pagina
  for (let tentativa = 0; tentativa < maxTentativas; tentativa++) {
    const resp = await fetch(url, opts);
    if (resp.status !== 429) return resp;
    if (tentativa === maxTentativas - 1) return resp; // esgotou as tentativas: devolve o 429
    const ra = parseInt(resp.headers.get('retry-after') || '', 10);
    const espera = !isNaN(ra) ? ra * 1000 : 3000 * (tentativa + 1);
    await sleep(espera);
  }
}

// Monta os parametros de filtro por data que a propria API do Datacrazy aceita,
// pra ela devolver so o pedaco do periodo pedido (em vez de buscar a base toda
// e descartar o resto aqui). Reduz bastante o numero de paginas/requisicoes.
function paramsDeFiltro(faixa) {
  const params = new URLSearchParams();
  if (faixa && faixa.inicio) params.set('filter[createdAtGreaterOrEqual]', faixa.inicio.toISOString());
  if (faixa && faixa.fim) params.set('filter[createdAtLessOrEqual]', faixa.fim.toISOString());
  return params.toString();
}

async function buscarLeadsPaginado(faixa, rotulo) {
  const take = 200; // paginas maiores = menos requisicoes pra mesma quantidade de leads
  let skip = 0;
  const todos = [];
  const opts = { headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' } };
  const filtroQuery = paramsDeFiltro(faixa);

  for (let pagina = 0; pagina < 100; pagina++) {
    const url = `${BASE}/leads?skip=${skip}&take=${take}` + (filtroQuery ? `&${filtroQuery}` : '');
    const resp = await buscarComPaciencia(url, opts);

    if (resp.status === 429) {
      const corpoErro = await resp.text().catch(() => '');
      console.error('--- ERRO BRUTO DO DATACRAZY ---');
      console.error('URL:', url);
      console.error('Status:', resp.status, resp.statusText);
      console.error('Retry-After:', resp.headers.get('retry-after'));
      console.error('Corpo:', corpoErro);
      console.error('-------------------------------');

      // se ja tiver conseguido pelo menos uma pagina, devolve o que tem ate
      // agora (parcial) em vez de jogar tudo fora — melhor mostrar dado
      // incompleto avisado do que travar tudo por causa do limite externo.
      if (todos.length > 0) {
        console.error(`[api/dados] rate limit no meio da busca (${rotulo}) — devolvendo parcial (${todos.length} leads de ${pagina} pagina(s))`);
        return { leads: todos, parcial: true };
      }
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
    console.log(`[api/dados] ${rotulo} pagina ${pagina + 1}: ${pagina_leads.length} leads (skip=${skip}, total ate agora=${todos.length})`);
    if (pagina_leads.length < take) break;
    skip += take;
    await sleep(5000); // pausa maior entre paginas, poupa cota da conta
  }
  return { leads: todos, parcial: false };
}

function listarDiasDaFaixa(faixa) {
  const hoje = inicioDoDia(new Date());
  const inicio = inicioDoDia(faixa.inicio);
  const fim = faixa.fim ? inicioDoDia(faixa.fim) : hoje;
  const dias = [];
  const cursor = new Date(Math.min(inicio, fim));
  const limite = new Date(Math.min(fim, hoje)); // nunca busca dia futuro
  while (cursor <= limite) {
    dias.push(new Date(cursor));
    cursor.setDate(cursor.getDate() + 1);
  }
  return dias;
}

// Progresso da busca em andamento (uma so por vez, por causa da fila) —
// front-end consulta isso pra mostrar barra de "calculando" em vez de
// travar numa tela vazia ou mostrar dado inventado.
let progressoAtual = null;
function obterProgresso() { return progressoAtual; }

// Busca dia por dia em vez do periodo inteiro de uma vez. Dia fechado
// (ontem pra tras) usa cache em arquivo e nao bate no Datacrazy de novo;
// so o dia de hoje e sempre buscado fresco. Isso faz trocar de filtro
// (7 dias, 30 dias, mes...) ser rapido depois da primeira vez.
async function buscarPorDiasComCache(faixa) {
  if (!faixa || !faixa.inicio) return buscarLeadsPaginado(faixa, 'sem-filtro');

  const hoje = inicioDoDia(new Date());
  const chaveHoje = chaveDia(hoje);
  const dias = listarDiasDaFaixa(faixa);
  const todos = [];
  let parcial = false;
  progressoAtual = { feito: 0, total: dias.length };

  try {
    for (const dia of dias) {
      const chave = chaveDia(dia);
      const ehHoje = chave === chaveHoje;

      if (!ehHoje) {
        const emCache = await armazenamento.lerDia(chave);
        if (emCache) { todos.push(...emCache); progressoAtual.feito++; continue; }
      }

      try {
        const r = await buscarLeadsPaginado({ inicio: inicioDoDia(dia), fim: fimDoDia(dia) }, chave);
        todos.push(...r.leads);
        if (r.parcial) parcial = true;
        else if (!ehHoje) await armazenamento.salvarDia(chave, r.leads); // so grava cache de dia fechado e busca completa
        progressoAtual.feito++;
        if (dias.length > 1) await sleep(1500); // pausa curta entre dias
      } catch (e) {
        if (todos.length > 0) { parcial = true; break; }
        throw e;
      }
    }
  } finally {
    progressoAtual = null;
  }
  console.log(`[api/dados] busca concluida: ${todos.length} leads no total (${dias.length} dia(s), ${parcial ? 'parcial' : 'completa'})`);
  return { leads: todos, parcial };
}

const DIAS_RETENCAO = 60; // guarda historico dos ultimos 60 dias, o resto e limpo

// Roda de madrugada (ou quando o servidor sobe): busca e salva o cache de
// todo dia fechado que ainda estiver faltando (nao so ontem — cobre o caso
// do servidor ter ficado desligado alguns dias). Assim quem abrir o
// dashboard de manha ja acha os numeros prontos, sem esperar calcular.
async function aquecerDiasFechados(diasParaTras = DIAS_RETENCAO) {
  if (!TOKEN) return;
  const hoje = inicioDoDia(new Date());
  for (let i = diasParaTras; i >= 1; i--) {
    const dia = new Date(hoje); dia.setDate(dia.getDate() - i);
    const chave = chaveDia(dia);
    if (await armazenamento.lerDia(chave)) continue; // ja tem, nada a fazer

    try {
      const r = await comFila(() => buscarLeadsPaginado({ inicio: inicioDoDia(dia), fim: fimDoDia(dia) }, chave));
      if (!r.parcial) {
        await armazenamento.salvarDia(chave, r.leads);
        console.log(`[api/dados] cache do dia ${chave} aquecido: ${r.leads.length} leads`);
      }
    } catch (e) {
      console.error(`[api/dados] falha ao aquecer cache do dia ${chave}:`, (e && e.message) || e);
    }
    await sleep(1500); // pausa curta entre dias
  }
}

// Apaga cache de dia mais velho que DIAS_RETENCAO — mantem so o historico
// recente, sem deixar o armazenamento crescer pra sempre.
async function limparDiasAntigos() {
  const limite = inicioDoDia(new Date());
  limite.setDate(limite.getDate() - DIAS_RETENCAO);
  const chaves = await armazenamento.listarChaves();
  for (const chave of chaves) {
    const data = new Date(chave + 'T00:00:00');
    if (isNaN(data)) continue;
    if (data < limite) {
      await armazenamento.apagarDia(chave);
      console.log(`[api/dados] cache do dia ${chave} removido (mais velho que ${DIAS_RETENCAO} dias)`);
    }
  }
}

// Calcula quanto tempo falta ate o proximo horario HH:MM (hora local).
function msAteProximoHorario(hora, minuto) {
  const agora = new Date();
  const proximo = new Date(agora);
  proximo.setHours(hora, minuto, 0, 0);
  if (proximo <= agora) proximo.setDate(proximo.getDate() + 1);
  return proximo - agora;
}

// Uma rodada de manutencao: limpa o que passou dos 60 dias e busca o que
// tiver faltando. Usado tanto pelo agendamento local (server.js) quanto
// pelo Vercel Cron em producao (api/cron-aquecer.js).
async function rodarManutencaoDoCache() {
  await limparDiasAntigos().catch(() => {});
  await aquecerDiasFechados().catch(() => {});
}

// Agenda o aquecimento pra rodar todo dia de madrugada (antes da operacao
// comecar), alem de uma vez no boot pra cobrir o servidor tendo acabado
// de subir. So funciona rodando com server.js (processo continuo) — na
// Vercel isso e feito pelo Cron configurado em vercel.json.
function agendarAquecimentoDiario(hora = 5, minuto = 0) {
  const rodar = rodarManutencaoDoCache;
  rodar(); // cobre o boot
  setTimeout(function agendarProxima() {
    rodar();
    setInterval(rodar, 24 * 60 * 60 * 1000);
  }, msAteProximoHorario(hora, minuto));
}

function agregar(leads, faixa) {
  // so conta quem estiver cadastrado como SDR (aba de Cadastro de SDR).
  // se ninguem foi cadastrado ainda, nao conta ninguem — evita misturar
  // gente de outro cargo que por acaso ficou como atendente de um lead.
  const cadastrados = new Set(lerSdrsCadastrados().map((n) => n.toLowerCase()));

  const porSdr = new Map();
  for (const lead of leads) {
    const sdr = lead.attendant || lead.atendente;
    const nomeSdr = sdr && (sdr.name || sdr.nome);
    if (!nomeSdr) continue;
    if (!cadastrados.has(nomeSdr.toLowerCase())) continue;

    const tags = nomesDasTags(lead.tags);
    if (!tags.includes('ig-outbound')) continue;

    if (faixa && (faixa.inicio || faixa.fim)) {
      const criado = lead.createdAt || lead.created_at || lead.dataCriacao;
      const dataCriado = criado ? new Date(criado) : null;
      if (faixa.inicio && (!dataCriado || dataCriado < faixa.inicio)) continue;
      if (faixa.fim && (!dataCriado || dataCriado > faixa.fim)) continue;
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
  const resultado = [...porSdr.values()]
    .sort((a, b) => b.cliente - a.cliente)
    .map((r, i) => ({ ...r, cor: CORES[i % CORES.length] }));
  console.log(`[api/dados] agregacao: ${leads.length} leads recebidos, ${resultado.length} SDRs no resultado`);
  return resultado;
}

module.exports = async (req, res) => {
  try {
    if (!TOKEN) {
      return res.status(500).json({ error: 'Falta configurar a variavel DATACRAZY_API_KEY na Vercel.' });
    }

    const query = req.query || {};
    const chaveCache = JSON.stringify({ p: query.periodo || '30', d: query.data, i: query.inicio, f: query.fim });
    const agora = Date.now();
    const emCache = CACHE.get(chaveCache);

    // cache fresco: devolve na hora, sem chamar o Datacrazy
    if (emCache && (agora - emCache.ts) < TTL) {
      res.setHeader('Cache-Control', 'no-store');
      if (emCache.parcial) res.setHeader('X-Dados-Parcial', 'true');
      return res.status(200).json(emCache.data);
    }

    try {
      // reconfere o cache: pode ter sido preenchido enquanto esperava a fila
      const recheck = CACHE.get(chaveCache);
      if (recheck && (Date.now() - recheck.ts) < TTL) {
        res.setHeader('Cache-Control', 'no-store');
        if (recheck.parcial) res.setHeader('X-Dados-Parcial', 'true');
        return res.status(200).json(recheck.data);
      }

      const faixa = faixaDeData(query);
      const busca = await comFila(() => buscarPorDiasComCache(faixa));
      const resultado = agregar(busca.leads, faixa);
      CACHE.set(chaveCache, { data: resultado, ts: Date.now(), parcial: busca.parcial });
      res.setHeader('Cache-Control', 'no-store');
      if (busca.parcial) res.setHeader('X-Dados-Parcial', 'true');
      return res.status(200).json(resultado);
    } catch (e) {
      console.error('[api/dados] erro ao buscar leads:', (e && e.message) || e);
      // deu erro (ex.: 429): se tiver um resultado de reserva, usa ele
      if (emCache && (agora - emCache.ts) < TTL_RESERVA) {
        res.setHeader('Cache-Control', 'no-store');
        res.setHeader('X-Dados-Parcial', 'true');
        return res.status(200).json(emCache.data);
      }
      const status = e.code === 429 ? 429 : 500;
      return res.status(status).json({ error: String((e && e.message) || e) });
    }
  } catch (e) {
    return res.status(500).json({ error: String((e && e.message) || e) });
  }
};

module.exports.agendarAquecimentoDiario = agendarAquecimentoDiario;
module.exports.rodarManutencaoDoCache = rodarManutencaoDoCache;

// Chamado pelo api/sdrs.js quando o cadastro de SDR muda — descarta so a
// resposta ja pronta (o historico bruto por dia continua intacto), pra
// proxima consulta recalcular com a lista nova em vez de esperar o TTL.
module.exports.limparCacheResposta = () => CACHE.clear();
module.exports.obterProgresso = obterProgresso;
