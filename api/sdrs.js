// ============================================================
//  api/sdrs.js  —  cadastro de quem conta como SDR no dashboard
// ------------------------------------------------------------
//  Lista simples guardada com o mesmo esquema de persistencia do
//  api/armazenamento.js (KV -> memoria serverless -> arquivo local).
//  So quem estiver cadastrado aqui entra na contagem do funil
//  (api/dados.js le essa lista pra filtrar).
// ============================================================

const fs = require('fs');
const path = require('path');

const NOME_MAX = 80;
const REGEX_NOME = /^[\p{L}\p{M} .'-]+$/u; // letras (com acento), espaco, ponto, apostrofo, hifen

function validarNome(nome) {
  if (!nome || nome.length < 2) return 'Nome deve ter pelo menos 2 caracteres.';
  if (nome.length > NOME_MAX) return `Nome deve ter no maximo ${NOME_MAX} caracteres.`;
  if (!REGEX_NOME.test(nome)) return 'Nome deve conter apenas letras, espacos, ponto, apostrofo ou hifen.';
  return null;
}

const ARQUIVO = path.join(__dirname, '..', 'data', 'sdrs.json');
const CHAVE_KV = 'sdrs:lista';

const EM_SERVERLESS = !!process.env.VERCEL;
const USANDO_KV = !!(process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN);
let kvClient = null;
function kv() {
  if (!kvClient) kvClient = require('@vercel/kv').kv;
  return kvClient;
}

// Sobrevive entre chamadas so enquanto a instancia do processo continuar
// viva (nao e persistencia real) — mesmo aviso do api/armazenamento.js.
let memoria = null;

async function lerLista() {
  if (USANDO_KV) return (await kv().get(CHAVE_KV)) || [];
  if (EM_SERVERLESS) return memoria || [];
  try {
    const conteudo = fs.readFileSync(ARQUIVO, 'utf8');
    const lista = JSON.parse(conteudo);
    return Array.isArray(lista) ? lista : [];
  } catch (e) {
    return [];
  }
}

async function salvarLista(lista) {
  if (USANDO_KV) {
    await kv().set(CHAVE_KV, lista);
  } else if (EM_SERVERLESS) {
    memoria = lista;
  } else {
    fs.mkdirSync(path.dirname(ARQUIVO), { recursive: true });
    fs.writeFileSync(ARQUIVO, JSON.stringify(lista, null, 2));
  }
  // avisa o api/dados.js pra descartar a resposta ja pronta (nao o historico
  // bruto) e recalcular com a lista de SDR atualizada na proxima consulta.
  try { require('./dados.js').limparCacheResposta(); } catch {}
}

module.exports = async (req, res) => {
  try {
    if (req.method === 'GET') {
      return res.status(200).json(await lerLista());
    }

    if (req.method === 'POST') {
      const nome = (req.body && req.body.nome || '').trim();
      const erro = validarNome(nome);
      if (erro) return res.status(400).json({ error: erro });
      const lista = await lerLista();
      if (lista.length >= 500) return res.status(400).json({ error: 'Limite de SDRs cadastrados atingido.' });
      if (!lista.some((n) => n.toLowerCase() === nome.toLowerCase())) {
        lista.push(nome);
        await salvarLista(lista);
      }
      return res.status(200).json(lista);
    }

    if (req.method === 'PUT') {
      const nomeAntigo = (req.body && req.body.nomeAntigo || '').trim();
      const nomeNovo = (req.body && req.body.nomeNovo || '').trim();
      if (!nomeAntigo) return res.status(400).json({ error: 'Informe o nome atual.' });
      const erro = validarNome(nomeNovo);
      if (erro) return res.status(400).json({ error: erro });
      const lista = await lerLista();
      const idx = lista.findIndex((n) => n.toLowerCase() === nomeAntigo.toLowerCase());
      if (idx === -1) return res.status(404).json({ error: 'SDR nao encontrado.' });
      lista[idx] = nomeNovo;
      await salvarLista(lista);
      return res.status(200).json(lista);
    }

    if (req.method === 'DELETE') {
      const nome = (req.body && req.body.nome || '').trim();
      if (!nome) return res.status(400).json({ error: 'Informe um nome.' });
      const lista = (await lerLista()).filter((n) => n.toLowerCase() !== nome.toLowerCase());
      await salvarLista(lista);
      return res.status(200).json(lista);
    }

    return res.status(405).json({ error: 'Metodo nao suportado.' });
  } catch (e) {
    return res.status(500).json({ error: String((e && e.message) || e) });
  }
};

module.exports.lerLista = lerLista;
