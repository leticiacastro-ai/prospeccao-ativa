// ============================================================
//  api/armazenamento.js — onde o cache de cada dia fica guardado
// ------------------------------------------------------------
//  Rodando local (server.js): guarda em arquivo, em data/leads-dia/.
//  Rodando na Vercel: nao tem disco persistente entre chamadas, entao
//  usa o Vercel KV (banco chave-valor) se as variaveis de ambiente
//  KV_REST_API_URL/KV_REST_API_TOKEN estiverem configuradas (provisiona
//  isso no dashboard da Vercel, aba Storage > KV, e faz `vercel env pull`).
//  Sem KV configurado na Vercel, o cache simplesmente nao persiste entre
//  chamadas — cada requisicao recalcula do zero (comportamento antigo).
// ============================================================

const fs = require('fs');
const path = require('path');

const DIR_CACHE_DIAS = path.join(__dirname, '..', 'data', 'leads-dia');
const PREFIXO = 'leads-dia:';

const USANDO_KV = !!(process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN);
let kvClient = null;
function kv() {
  if (!kvClient) kvClient = require('@vercel/kv').kv;
  return kvClient;
}

function caminhoLocal(chave) { return path.join(DIR_CACHE_DIAS, `${chave}.json`); }

async function lerDia(chave) {
  if (USANDO_KV) return (await kv().get(PREFIXO + chave)) || null;
  try { return JSON.parse(fs.readFileSync(caminhoLocal(chave), 'utf8')); }
  catch { return null; }
}

async function salvarDia(chave, leads) {
  if (USANDO_KV) { await kv().set(PREFIXO + chave, leads); return; }
  fs.mkdirSync(DIR_CACHE_DIAS, { recursive: true });
  fs.writeFileSync(caminhoLocal(chave), JSON.stringify(leads));
}

async function apagarDia(chave) {
  if (USANDO_KV) { await kv().del(PREFIXO + chave); return; }
  try { fs.unlinkSync(caminhoLocal(chave)); } catch {}
}

async function listarChaves() {
  if (USANDO_KV) {
    const chaves = await kv().keys(PREFIXO + '*');
    return chaves.map((k) => k.slice(PREFIXO.length));
  }
  try { return fs.readdirSync(DIR_CACHE_DIAS).map((n) => n.replace(/\.json$/, '')); }
  catch { return []; }
}

module.exports = { lerDia, salvarDia, apagarDia, listarChaves, USANDO_KV };
