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

// Cache do dia de HOJE — antes buscava fresco no Datacrazy toda vez que
// alguem trocava o filtro (7 dias, 30 dias, mes...), mesmo trocando so o
// recorte e nao o dia em si. Agora busca no maximo 1x a cada 5 min e todo
// filtro que incluir hoje reusa esse mesmo resultado.
let cacheHoje = { chave: null, leads: null, ts: 0 };
const TTL_HOJE = 5 * 60 * 1000;

// Rodando na Vercel (plano Hobby) a funcao so tem 10s de execucao no total —
// pausas longas estouram isso sozinhas, sem nem chegar a bater rate limit de
// verdade. Local (server.js) e processo continuo, pode ser bem mais paciente.
const EM_SERVERLESS = !!process.env.VERCEL;
const ORCAMENTO_REQUISICAO_MS = EM_SERVERLESS ? 8000 : null; // 2s de folga dos 10s do Hobby
const PAUSA_ENTRE_PAGINAS = EM_SERVERLESS ? 700 : 9000;
const PAUSA_ENTRE_DIAS = EM_SERVERLESS ? 400 : 3000;

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

const REGEX_DATA = /^\d{4}-\d{2}-\d{2}$/;
const MAX_DIAS_PERIODO = 3650; // 10 anos — evita periodo="999999999" gerar uma faixa absurda

// Converte "YYYY-MM-DD" pra Date local (meia-noite). Retorna null se o
// formato ou o valor forem invalidos, em vez de deixar virar "Invalid Date"
// e propagar silenciosamente pro filtro.
function parseDataQuery(str) {
  if (!str || !REGEX_DATA.test(str)) return null;
  const d = new Date(str + 'T00:00:00');
  return isNaN(d.getTime()) ? null : d;
}

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
    const d = parseDataQuery(query.data) || agora;
    return { inicio: inicioDoDia(d), fim: fimDoDia(d) };
  }
  if (periodo === 'intervalo') {
    const inicio = parseDataQuery(query.inicio);
    const fimBase = parseDataQuery(query.fim);
    return { inicio, fim: fimBase ? fimDoDia(fimBase) : null };
  }
  if (periodo === 'mes') {
    return { inicio: new Date(agora.getFullYear(), agora.getMonth(), 1), fim: null };
  }
  const dias = parseInt(periodo, 10);
  if (!isNaN(dias) && dias > 0) {
    const diasLimitados = Math.min(dias, MAX_DIAS_PERIODO);
    const d = new Date(agora); d.setDate(d.getDate() - (diasLimitados - 1)); // -1: hoje ja conta como 1 dos "dias"
    return { inicio: inicioDoDia(d), fim: null }; // dia cheio, pra bater com o cache diario
  }
  return { inicio: null, fim: null };
}

// Faz a chamada e, se levar 429, espera o tempo que o Datacrazy pedir (Retry-After)
// e tenta de novo, em vez de desistir rápido — prefere demorar a devolver parcial.
// prazoAte (opcional): timestamp limite — se a proxima espera for estourar isso,
// desiste na hora em vez de dormir e ser cortado no meio pela Vercel.
async function buscarComPaciencia(url, opts, prazoAte) {
  const maxTentativas = 8; // paciencia total de uns 2 minutos por pagina (local); na Vercel o orcamento corta antes
  for (let tentativa = 0; tentativa < maxTentativas; tentativa++) {
    const resp = await fetch(url, opts);
    if (resp.status !== 429) return resp;
    if (tentativa === maxTentativas - 1) return resp; // esgotou as tentativas: devolve o 429
    const ra = parseInt(resp.headers.get('retry-after') || '', 10);
    const espera = !isNaN(ra) ? ra * 1000 + 2000 : 5000 * (tentativa + 1); // sempre um pouco mais que o pedido, com margem
    if (prazoAte && Date.now() + espera > prazoAte) return resp; // sem tempo pra mais uma espera
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

async function buscarLeadsPaginado(faixa, rotulo, prazoAte) {
  const take = 200; // paginas maiores = menos requisicoes pra mesma quantidade de leads
  let skip = 0;
  const todos = [];
  const opts = { headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' } };
  const filtroQuery = paramsDeFiltro(faixa);

  for (let pagina = 0; pagina < 100; pagina++) {
    if (prazoAte && Date.now() > prazoAte) {
      if (todos.length > 0) {
        console.error(`[api/dados] orcamento de tempo acabou (${rotulo}) — devolvendo parcial (${todos.length} leads)`);
        return { leads: todos, parcial: true };
      }
      const err = new Error('Nao deu tempo de buscar (limite de execucao da funcao). Tente atualizar de novo.');
      err.code = 429;
      throw err;
    }
    const url = `${BASE}/leads?skip=${skip}&take=${take}` + (filtroQuery ? `&${filtroQuery}` : '');
    const resp = await buscarComPaciencia(url, opts, prazoAte);

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
    if (prazoAte && Date.now() + PAUSA_ENTRE_PAGINAS > prazoAte) {
      console.error(`[api/dados] sem tempo pra mais uma pagina (${rotulo}) — devolvendo parcial (${todos.length} leads)`);
      return { leads: todos, parcial: true };
    }
    await sleep(PAUSA_ENTRE_PAGINAS);
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

// Busca hoje sozinho e atualiza cacheHoje, sem depender de nenhum filtro/
// request ter chegado. Usado pelo agendamento de 5 em 5 min (server.js) pra
// manter cacheHoje sempre fresco em background, em vez de so recalcular na
// hora que alguem pede.
// Soma o resultado de agregar() (por SDR) num total unico do dia — e esse
// total pronto que fica salvo em resumo-dia, pro painel de media so somar
// numero pronto em vez de reprocessar lead por lead toda vez.
function somarLinhasDoDia(linhas) {
  const totais = { prospectou: 0, respondeu: 0, agendou: 0, compareceu: 0, cliente: 0 };
  for (const l of linhas) {
    totais.prospectou += l.prospectou; totais.respondeu += l.respondeu; totais.agendou += l.agendou;
    totais.compareceu += l.compareceu; totais.cliente += l.cliente;
  }
  return totais;
}

// Fecha o cache de um dia: salva os leads brutos, uma foto de quem estava
// cadastrado como SDR nesse exato momento (trava a contagem no atendente
// daquele dia — ver agregar()) e o resumo do dia ja agregado (pro painel de
// media nao precisar reprocessar lead por lead toda vez que alguem troca a
// janela de dias).
async function fecharCacheDoDia(chave, leads) {
  const cadastroAtual = await lerSdrsCadastrados();
  await armazenamento.salvarDia(chave, leads);
  await armazenamento.salvarCadastroDia(chave, cadastroAtual);
  const linhas = await agregar(leads, null, new Map([[chave, cadastroAtual]]));
  await armazenamento.salvarResumoDia(chave, somarLinhasDoDia(linhas));
  return cadastroAtual;
}

async function atualizarCacheHoje() {
  if (!TOKEN) return;
  const hoje = inicioDoDia(new Date());
  const chave = chaveDia(hoje);
  const prazoAte = ORCAMENTO_REQUISICAO_MS ? Date.now() + ORCAMENTO_REQUISICAO_MS : null;
  try {
    const r = await comFila(() => buscarLeadsPaginado({ inicio: hoje, fim: fimDoDia(hoje) }, chave, prazoAte));
    if (!r.parcial) {
      cacheHoje = { chave, leads: r.leads, ts: Date.now() };
      module.exports.limparCacheResposta(); // descarta respostas ja montadas com o hoje velho
      console.log(`[api/dados] cacheHoje atualizado: ${r.leads.length} leads`);
    }
  } catch (e) {
    console.error('[api/dados] falha ao atualizar cacheHoje:', (e && e.message) || e);
  }
}

// So faz sentido rodando em processo continuo (server.js) — na Vercel cada
// chamada e uma instancia nova/efemera, setInterval nao sobrevive entre
// requests, entao la o refresh continua sendo o lazy (TTL_HOJE na hora do
// request, ver buscarPorDiasComCache).
function agendarAtualizacaoHoje() {
  atualizarCacheHoje();
  setInterval(atualizarCacheHoje, TTL_HOJE);
}

// Progresso da busca em andamento (uma so por vez, por causa da fila) —
// front-end consulta isso pra mostrar barra de "calculando" em vez de
// travar numa tela vazia ou mostrar dado inventado.
let progressoAtual = null;
function obterProgresso() { return progressoAtual; }

// Busca dia por dia em vez do periodo inteiro de uma vez. Dia fechado
// (ontem pra tras) usa cache em arquivo e nao bate no Datacrazy de novo;
// hoje usa cacheHoje (5 min) — busca fresco no maximo 1x a cada 5 min,
// e qualquer filtro que inclua hoje reusa esse mesmo resultado. Isso faz
// trocar de filtro (7 dias, 30 dias, mes...) ser rapido depois da primeira vez.
async function buscarPorDiasComCache(faixa) {
  const prazoAte = ORCAMENTO_REQUISICAO_MS ? Date.now() + ORCAMENTO_REQUISICAO_MS : null;
  if (!faixa || !faixa.inicio) {
    const r = await buscarLeadsPaginado(faixa, 'sem-filtro', prazoAte);
    return { ...r, snapshotsPorDia: new Map() }; // sem dia definido, agregar() cai no cadastro ao vivo
  }

  const hoje = inicioDoDia(new Date());
  const chaveHoje = chaveDia(hoje);
  const dias = listarDiasDaFaixa(faixa);
  const todos = [];
  const snapshotsPorDia = new Map(); // chave do dia -> cadastro de SDR travado naquele dia (null = dia fechado sem foto salva ainda)
  let parcial = false;
  progressoAtual = { feito: 0, total: dias.length };

  try {
    for (const dia of dias) {
      if (prazoAte && Date.now() > prazoAte) { parcial = true; break; } // sem tempo pra mais dias
      const chave = chaveDia(dia);
      const ehHoje = chave === chaveHoje;

      if (!ehHoje) {
        const emCache = await armazenamento.lerDia(chave);
        if (emCache) {
          todos.push(...emCache);
          snapshotsPorDia.set(chave, await armazenamento.lerCadastroDia(chave));
          progressoAtual.feito++; continue;
        }
      } else if (cacheHoje.chave === chave && (Date.now() - cacheHoje.ts) < TTL_HOJE) {
        todos.push(...cacheHoje.leads); progressoAtual.feito++; continue; // hoje nao fecha, nao trava cadastro
      }

      try {
        const r = await buscarLeadsPaginado({ inicio: inicioDoDia(dia), fim: fimDoDia(dia) }, chave, prazoAte);
        todos.push(...r.leads);
        if (r.parcial) parcial = true;
        else if (!ehHoje) snapshotsPorDia.set(chave, await fecharCacheDoDia(chave, r.leads)); // so grava/trava cache de dia fechado e busca completa
        else cacheHoje = { chave, leads: r.leads, ts: Date.now() }; // guarda hoje por TTL_HOJE, reusado por qualquer filtro
        progressoAtual.feito++;
        if (dias.length > 1) {
          if (prazoAte && Date.now() + PAUSA_ENTRE_DIAS > prazoAte) { parcial = true; break; }
          await sleep(PAUSA_ENTRE_DIAS);
        }
      } catch (e) {
        if (todos.length > 0) { parcial = true; break; }
        throw e;
      }
    }
  } finally {
    progressoAtual = null;
  }
  console.log(`[api/dados] busca concluida: ${todos.length} leads no total (${dias.length} dia(s), ${parcial ? 'parcial' : 'completa'})`);
  return { leads: todos, parcial, snapshotsPorDia };
}

// Minimo de historico que a base deve ter, contado a partir de agora pra
// tras. Nao e um teto: nada e apagado — a partir do deploy, cada dia
// fechado novo so vai se somando aos que ja existem (101, 102, 103...).
// So serve como profundidade do backfill inicial (aquecerDiasFechados) e
// como janela fixa do painel de media (calcularResumoHistorico).
const DIAS_HISTORICO_MINIMO = 100;

// Roda de madrugada (ou quando o servidor sobe): busca e salva o cache de
// todo dia fechado que ainda estiver faltando (nao so ontem — cobre o caso
// do servidor ter ficado desligado alguns dias). Assim quem abrir o
// dashboard de manha ja acha os numeros prontos, sem esperar calcular.
async function aquecerDiasFechados(diasParaTras = DIAS_HISTORICO_MINIMO) {
  if (!TOKEN) return;
  // na Vercel (Cron tem o mesmo limite de execucao da funcao), so da tempo
  // de fechar 1-2 dias por chamada — no regime normal (so falta ontem) isso
  // sobra. Backfill grande (muitos dias faltando) vai completando aos poucos,
  // 1+ dia por vez que o Cron rodar, em vez de tentar tudo de uma vez e ser cortado.
  const prazoAte = ORCAMENTO_REQUISICAO_MS ? Date.now() + ORCAMENTO_REQUISICAO_MS : null;
  const hoje = inicioDoDia(new Date());
  for (let i = diasParaTras; i >= 1; i--) {
    if (prazoAte && Date.now() > prazoAte) {
      console.log('[api/dados] aquecimento parou por tempo — continua na proxima chamada');
      break;
    }
    const dia = new Date(hoje); dia.setDate(dia.getDate() - i);
    const chave = chaveDia(dia);
    if (await armazenamento.lerDia(chave)) continue; // ja tem, nada a fazer

    try {
      const r = await comFila(() => buscarLeadsPaginado({ inicio: inicioDoDia(dia), fim: fimDoDia(dia) }, chave, prazoAte));
      if (!r.parcial) {
        await fecharCacheDoDia(chave, r.leads);
        console.log(`[api/dados] cache do dia ${chave} aquecido: ${r.leads.length} leads`);
      }
    } catch (e) {
      console.error(`[api/dados] falha ao aquecer cache do dia ${chave}:`, (e && e.message) || e);
    }
    if (prazoAte && Date.now() + PAUSA_ENTRE_DIAS > prazoAte) break;
    await sleep(PAUSA_ENTRE_DIAS);
  }
}

const DIAS_GRACA_REVALIDACAO = 14; // reprocessa esses dias de novo toda madrugada

// Um dia fechado normalmente nunca e buscado de novo — mas um lead pode
// continuar avancando no funil depois do dia em que foi prospectado (ex.:
// prospectou e agendou hoje, mas a reuniao e so amanha — o "compareceu" so
// vira verdade um dia depois). Se travar o cache logo no dia seguinte, esse
// avanco posterior nunca aparece no fechamento da semana/mes.
// Por isso os ultimos DIAS_GRACA_REVALIDACAO dias sao buscados de novo (nao
// so os que faltam) toda madrugada, ate esse status "assentar". So depois
// desse prazo o dia fica travado de vez.
async function revalidarDiasRecentes(diasGraca = DIAS_GRACA_REVALIDACAO) {
  if (!TOKEN) return;
  const prazoAte = ORCAMENTO_REQUISICAO_MS ? Date.now() + ORCAMENTO_REQUISICAO_MS : null;
  const hoje = inicioDoDia(new Date());
  for (let i = diasGraca; i >= 1; i--) {
    if (prazoAte && Date.now() > prazoAte) {
      console.log('[api/dados] revalidacao parou por tempo — continua na proxima chamada');
      break;
    }
    const dia = new Date(hoje); dia.setDate(dia.getDate() - i);
    const chave = chaveDia(dia);
    try {
      const r = await comFila(() => buscarLeadsPaginado({ inicio: inicioDoDia(dia), fim: fimDoDia(dia) }, chave, prazoAte));
      if (!r.parcial) {
        await fecharCacheDoDia(chave, r.leads); // sobrescreve com o status mais atual (leads e cadastro travado)
        console.log(`[api/dados] dia ${chave} revalidado: ${r.leads.length} leads`);
      }
    } catch (e) {
      console.error(`[api/dados] falha ao revalidar dia ${chave}:`, (e && e.message) || e);
    }
    if (prazoAte && Date.now() + PAUSA_ENTRE_DIAS > prazoAte) break;
    await sleep(PAUSA_ENTRE_DIAS);
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

// Uma rodada de manutencao: busca o que tiver faltando (backfill de pelo
// menos DIAS_HISTORICO_MINIMO dias) e reprocessa os ultimos dias (pra pegar
// avanco no funil que so aconteceu depois do dia em que o lead foi
// prospectado). Nada e apagado — o historico so cresce a partir do deploy.
// Usado tanto pelo agendamento local (server.js) quanto pelo Vercel Cron em
// producao (api/cron-aquecer.js).
async function rodarManutencaoDoCache() {
  await aquecerDiasFechados().catch(() => {}); // preenche o que ainda nao tem cache nenhum
  await revalidarDiasRecentes().catch(() => {}); // reprocessa os ultimos dias, pega status que so se resolveu depois
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

// so conta quem estiver cadastrado como SDR (aba de Cadastro de SDR) —
// evita misturar gente de outro cargo que por acaso ficou como atendente
// de um lead. Pra dia fechado, usa o cadastro travado NAQUELE dia
// (snapshotsPorDia), nao o cadastro atual — senao cadastrar um SDR novo
// hoje mudaria retroativamente o total de qualquer dia ja fechado.
// Dia sem foto salva (cache antigo, de antes dessa trava existir) e o dia
// de hoje (ainda nao fechou) caem no cadastro ao vivo, igual antes.
async function agregar(leads, faixa, snapshotsPorDia) {
  const cadastroAoVivo = new Set((await lerSdrsCadastrados()).map((n) => n.toLowerCase()));
  const cadastroPorDiaEmCache = new Map(); // chave -> Set(nomes), memoiza a conversao pra Set

  function cadastroElegivel(dataCriado) {
    if (!dataCriado || !snapshotsPorDia) return cadastroAoVivo;
    const chave = chaveDia(dataCriado);
    if (!snapshotsPorDia.has(chave)) return cadastroAoVivo;
    const bruta = snapshotsPorDia.get(chave);
    if (!bruta) return cadastroAoVivo; // dia fechado sem foto salva ainda
    if (!cadastroPorDiaEmCache.has(chave)) {
      cadastroPorDiaEmCache.set(chave, new Set(bruta.map((n) => n.toLowerCase())));
    }
    return cadastroPorDiaEmCache.get(chave);
  }

  const porSdr = new Map();
  for (const lead of leads) {
    const sdr = lead.attendant || lead.atendente;
    const nomeSdr = sdr && (sdr.name || sdr.nome);
    if (!nomeSdr) continue;

    const criado = lead.createdAt || lead.created_at || lead.dataCriacao;
    const dataCriado = criado ? new Date(criado) : null;

    const cadastrados = cadastroElegivel(dataCriado);
    if (!cadastrados.has(nomeSdr.toLowerCase())) continue;

    const tags = nomesDasTags(lead.tags);
    if (!tags.includes('ig-outbound')) continue;

    if (faixa && (faixa.inicio || faixa.fim)) {
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

const DIAS_MEDIA_MAX = 3650; // trava janela absurda tipo dias=999999

// Le o resumo pronto de um dia (resumo-dia). Se nao tiver ainda — dia
// fechado antes dessa cache existir — calcula na hora a partir do cache de
// leads e guarda pra da proxima vez ja vir pronto (self-heal, sem precisar
// de migracao manual).
async function resumoDoDia(chave) {
  const pronto = await armazenamento.lerResumoDia(chave);
  if (pronto) return pronto;

  const leads = await armazenamento.lerDia(chave);
  if (!leads) return null;
  const cadastroSnapshot = await armazenamento.lerCadastroDia(chave);
  const linhas = await agregar(leads, null, new Map([[chave, cadastroSnapshot]]));
  const totais = somarLinhasDoDia(linhas);
  await armazenamento.salvarResumoDia(chave, totais);
  return totais;
}

// Resumo dos ultimos N dias fechados. So le o resumo ja pronto de cada dia
// (resumo-dia, calculado uma vez quando o dia fecha/revalida em
// fecharCacheDoDia) — nao reprocessa lead por lead a cada chamada, nem bate
// no Datacrazy. Usado pro painel de media, nao pro filtro escolhido pelo
// usuario no dashboard.
async function calcularResumoHistorico(dias = DIAS_HISTORICO_MINIMO) {
  const janela = Math.min(Math.max(parseInt(dias, 10) || DIAS_HISTORICO_MINIMO, 1), DIAS_MEDIA_MAX);
  const hoje = inicioDoDia(new Date());
  let totalAgendou = 0;
  let totalProspectou = 0;
  let diasComDado = 0;
  let diasComAgendamento = 0;
  let diasComProspeccao = 0;

  for (let i = 1; i <= janela; i++) {
    const dia = new Date(hoje); dia.setDate(dia.getDate() - i);
    const chave = chaveDia(dia);
    const totais = await resumoDoDia(chave);
    if (!totais) continue;
    diasComDado++;
    totalAgendou += totais.agendou;
    totalProspectou += totais.prospectou;
    if (totais.agendou > 0) diasComAgendamento++;
    if (totais.prospectou > 0) diasComProspeccao++;
  }

  return {
    janela,
    diasComDado,
    diasComAgendamento,
    diasComProspeccao,
    totalAgendamentos: totalAgendou,
    mediaAgendamentosPorDia: diasComAgendamento > 0 ? totalAgendou / diasComAgendamento : 0,
    totalProspectados: totalProspectou,
    mediaProspectadosPorDia: diasComProspeccao > 0 ? totalProspectou / diasComProspeccao : 0,
  };
}

// Faixa de datas que a base realmente tem guardada — do dia fechado mais
// antigo no cache ate hoje. Usado pra travar "Comparar periodos" (e outros
// seletores de data) num intervalo que a base ja cobre, em vez de deixar
// escolher qualquer data e disparar busca ao vivo sem cache no Datacrazy.
async function faixaHistoricoDisponivel() {
  const hoje = chaveDia(inicioDoDia(new Date()));
  const chaves = await armazenamento.listarChaves();
  if (!chaves.length) return { inicio: hoje, fim: hoje };
  const inicio = chaves.reduce((menor, atual) => (atual < menor ? atual : menor));
  return { inicio, fim: hoje };
}

// Busca + agrega pro periodo pedido, com o mesmo cache de resposta usado
// pela rota HTTP. Extraido do handler pra poder ser chamado tambem pelo
// export CSV (api/export.js) sem duplicar a logica de cache/fila/reserva.
async function obterResultado(query) {
  if (!TOKEN) {
    const err = new Error('Falta configurar a variavel DATACRAZY_API_KEY na Vercel.');
    err.code = 500;
    throw err;
  }

  const chaveCache = JSON.stringify({ p: query.periodo || '30', d: query.data, i: query.inicio, f: query.fim });
  const agora = Date.now();
  const emCache = CACHE.get(chaveCache);

  if (emCache && (agora - emCache.ts) < TTL) {
    return { resultado: emCache.data, parcial: emCache.parcial };
  }

  try {
    const recheck = CACHE.get(chaveCache);
    if (recheck && (Date.now() - recheck.ts) < TTL) {
      return { resultado: recheck.data, parcial: recheck.parcial };
    }

    const faixa = faixaDeData(query);
    const busca = await comFila(() => buscarPorDiasComCache(faixa));
    const resultado = await agregar(busca.leads, faixa, busca.snapshotsPorDia);
    CACHE.set(chaveCache, { data: resultado, ts: Date.now(), parcial: busca.parcial });
    return { resultado, parcial: busca.parcial };
  } catch (e) {
    console.error('[api/dados] erro ao buscar leads:', (e && e.message) || e);
    if (emCache && (agora - emCache.ts) < TTL_RESERVA) {
      return { resultado: emCache.data, parcial: true };
    }
    e.code = e.code === 429 ? 429 : 500;
    throw e;
  }
}

module.exports = async (req, res) => {
  try {
    const { resultado, parcial } = await obterResultado(req.query || {});
    res.setHeader('Cache-Control', 'no-store');
    if (parcial) res.setHeader('X-Dados-Parcial', 'true');
    return res.status(200).json(resultado);
  } catch (e) {
    return res.status(e.code === 429 || e.code === 500 ? e.code : 500).json({ error: String((e && e.message) || e) });
  }
};

module.exports.agendarAquecimentoDiario = agendarAquecimentoDiario;
module.exports.agendarAtualizacaoHoje = agendarAtualizacaoHoje;
module.exports.atualizarCacheHoje = atualizarCacheHoje;
module.exports.rodarManutencaoDoCache = rodarManutencaoDoCache;

// Chamado pelo api/sdrs.js quando o cadastro de SDR muda — descarta so a
// resposta ja pronta (o historico bruto por dia continua intacto), pra
// proxima consulta recalcular com a lista nova em vez de esperar o TTL.
module.exports.limparCacheResposta = () => CACHE.clear();
module.exports.obterProgresso = obterProgresso;
module.exports.calcularResumoHistorico = calcularResumoHistorico;
module.exports.obterResultado = obterResultado;
module.exports.faixaHistoricoDisponivel = faixaHistoricoDisponivel;
