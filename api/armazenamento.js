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
// ============================================================

const fs = require('fs');
const path = require('path');

const DIR_CACHE_DIAS = path.join(__dirname, '..', 'data', 'leads-dia');
const PREFIXO = 'leads-dia:';

const EM_SERVERLESS = !!process.env.VERCEL;
const USANDO_KV = !!(process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN);
let kvClient = null;
function kv() {
  if (!kvClient) kvClient = require('@vercel/kv').kv;
  return kvClient;
}

// Sobrevive entre chamadas SO enquanto a instancia do processo continuar
// viva (nao e persistencia real) — ver aviso no topo do arquivo.
const memoria = new Map();

function caminhoLocal(chave) { return path.join(DIR_CACHE_DIAS, `${chave}.json`); }

async function lerDia(chave) {
  if (USANDO_KV) return (await kv().get(PREFIXO + chave)) || null;
  if (EM_SERVERLESS) return memoria.get(chave) || null;
  try { return JSON.parse(fs.readFileSync(caminhoLocal(chave), 'utf8')); }
  catch { return null; }
}

async function salvarDia(chave, leads) {
  if (USANDO_KV) { await kv().set(PREFIXO + chave, leads); return; }
  if (EM_SERVERLESS) { memoria.set(chave, leads); return; }
  fs.mkdirSync(DIR_CACHE_DIAS, { recursive: true });
  fs.writeFileSync(caminhoLocal(chave), JSON.stringify(leads));
}

async function apagarDia(chave) {
  if (USANDO_KV) { await kv().del(PREFIXO + chave); return; }
  if (EM_SERVERLESS) { memoria.delete(chave); return; }
  try { fs.unlinkSync(caminhoLocal(chave)); } catch {}
}

async function listarChaves() {
  if (USANDO_KV) {
    const chaves = await kv().keys(PREFIXO + '*');
    return chaves.map((k) => k.slice(PREFIXO.length));
  }
  if (EM_SERVERLESS) return [...memoria.keys()];
  try { return fs.readdirSync(DIR_CACHE_DIAS).map((n) => n.replace(/\.json$/, '')); }
  catch { return []; }
}

module.exports = { lerDia, salvarDia, apagarDia, listarChaves, USANDO_KV };
