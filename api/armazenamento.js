// ============================================================
//  api/armazenamento.js — onde o cache de cada dia fica guardado
// ------------------------------------------------------------
//  3 modos, na ordem de preferencia:
//   1) Vercel KV — se KV_REST_API_URL/KV_REST_API_TOKEN estiverem
//      configuradas (Storage > KV/Redis no dashboard da Vercel).
//      Persistencia de verdade, entre qualquer chamada.
//   2) Arquivo local (data/leads-dia/) — quando roda com server.js
//      na sua maquina. Tambem persistencia de verdade.
//   3) Memoria do proprio processo (Map) — fallback quando roda na
//      Vercel SEM KV configurado. Nao e garantido: so funciona
//      enquanto a mesma instancia da funcao continuar "quente"
//      (a Vercel reaproveita por alguns minutos as vezes, mas pode
//      comecar do zero a qualquer chamada, sem aviso). Na pior
//      hipotese se comporta como se nao tivesse cache nenhum (igual
//      era antes); na melhor, economiza buscas de graca, sem
//      precisar configurar nada.
//
//  Tres espacos, mesmo esquema (chave = "AAAA-MM-DD"):
//   - leads-dia: os leads brutos do dia.
//   - sdrs-cadastro-dia: quem estava cadastrado como SDR no momento
//     em que o dia foi fechado/revalidado — usado pra travar a
//     contagem no atendente daquele dia, sem deixar um cadastro
//     novo (de hoje) mudar retroativamente o total de dias fechados.
//   - resumo-dia: totais por etapa (prospectou/respondeu/agendou/
//     compareceu/cliente) ja agregados do dia — calculado uma vez
//     quando o dia fecha/revalida, pra o painel de media (api/resumo.js)
//     so somar numero pronto em vez de reprocessar lead por lead toda
//     vez que alguem troca a janela (10, 30, 60... dias).
// ============================================================

const fs = require('fs');
const path = require('path');

const DIR_BASE = path.join(__dirname, '..', 'data');
const EM_SERVERLESS = !!process.env.VERCEL;
const USANDO_KV = !!(process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN);
let kvClient = null;
function kv() {
  if (!kvClient) kvClient = require('@vercel/kv').kv;
  return kvClient;
}

function criarArmazenamentoPorDia(nomeEspaco) {
  const prefixo = `${nomeEspaco}:`;
  const dir = path.join(DIR_BASE, nomeEspaco);
  // Sobrevive entre chamadas SO enquanto a instancia do processo continuar
  // viva (nao e persistencia real) — ver aviso no topo do arquivo.
  const memoria = new Map();

  function caminhoLocal(chave) { return path.join(dir, `${chave}.json`); }

  async function lerDia(chave) {
    if (USANDO_KV) return (await kv().get(prefixo + chave)) || null;
    if (EM_SERVERLESS) return memoria.get(chave) || null;
    try { return JSON.parse(fs.readFileSync(caminhoLocal(chave), 'utf8')); }
    catch { return null; }
  }

  async function salvarDia(chave, valor) {
    if (USANDO_KV) { await kv().set(prefixo + chave, valor); return; }
    if (EM_SERVERLESS) { memoria.set(chave, valor); return; }
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(caminhoLocal(chave), JSON.stringify(valor));
  }

  async function apagarDia(chave) {
    if (USANDO_KV) { await kv().del(prefixo + chave); return; }
    if (EM_SERVERLESS) { memoria.delete(chave); return; }
    try { fs.unlinkSync(caminhoLocal(chave)); } catch {}
  }

  async function listarChaves() {
    if (USANDO_KV) {
      const chaves = await kv().keys(prefixo + '*');
      return chaves.map((k) => k.slice(prefixo.length));
    }
    if (EM_SERVERLESS) return [...memoria.keys()];
    try { return fs.readdirSync(dir).map((n) => n.replace(/\.json$/, '')); }
    catch { return []; }
  }

  return { lerDia, salvarDia, apagarDia, listarChaves };
}

const leadsDia = criarArmazenamentoPorDia('leads-dia');
const cadastroDia = criarArmazenamentoPorDia('sdrs-cadastro-dia');
const resumoDia = criarArmazenamentoPorDia('resumo-dia');

module.exports = {
  lerDia: leadsDia.lerDia,
  salvarDia: leadsDia.salvarDia,
  apagarDia: leadsDia.apagarDia,
  listarChaves: leadsDia.listarChaves,

  lerCadastroDia: cadastroDia.lerDia,
  salvarCadastroDia: cadastroDia.salvarDia,
  apagarCadastroDia: cadastroDia.apagarDia,

  lerResumoDia: resumoDia.lerDia,
  salvarResumoDia: resumoDia.salvarDia,

  USANDO_KV,
};
