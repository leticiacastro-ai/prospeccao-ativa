// Servidor local simples — substitui a Vercel pra rodar o projeto na sua máquina.
// Serve o index.html e expõe /api/dados chamando a mesma função da api/dados.js.
require('dotenv').config();
const http = require('http');
const fs = require('fs');
const path = require('path');
const url = require('url');
const dados = require('./api/dados.js');
const sdrs = require('./api/sdrs.js');
const progresso = require('./api/progresso.js');
const cronAquecer = require('./api/cron-aquecer.js');
const cronHoje = require('./api/cron-hoje.js');
const resumo = require('./api/resumo.js');
const exportCsv = require('./api/export.js');

const LIMITE_BODY_BYTES = 1 * 1024 * 1024; // 1MB — cadastro de SDR nao precisa de mais que isso

const PORT = process.env.PORT || 3000;

function servirArquivo(res, caminho, tipo) {
  fs.readFile(caminho, (err, conteudo) => {
    if (err) { res.writeHead(404); res.end('Não encontrado'); return; }
    res.writeHead(200, { 'Content-Type': tipo });
    res.end(conteudo);
  });
}

function lerCorpoJson(req, res) {
  return new Promise((resolve, reject) => {
    let dados = '';
    let tamanho = 0;
    req.on('data', (c) => {
      tamanho += c.length;
      if (tamanho > LIMITE_BODY_BYTES) {
        req.destroy();
        reject(Object.assign(new Error('Corpo da requisicao excede o limite permitido.'), { code: 413 }));
        return;
      }
      dados += c;
    });
    req.on('end', () => {
      try { resolve(JSON.parse(dados || '{}')); } catch { resolve({}); }
    });
    req.on('error', () => resolve({}));
  });
}

// resFake comum a todas as rotas de api/*.js — imita a assinatura (req,res)
// que a Vercel passa pras serverless functions, pra poder rodar o mesmo
// codigo local (server.js) e la (Vercel), sem duplicar por rota.
function criarResFake(res) {
  return {
    status(codigo) { res.statusCode = codigo; return this; },
    setHeader(k, v) { res.setHeader(k, v); },
    json(obj) { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(obj)); },
    end(corpo) { res.end(corpo); },
  };
}

const server = http.createServer(async (req, res) => {
  const parsed = url.parse(req.url, true);
  const resFake = criarResFake(res);

  if (parsed.pathname === '/api/dados') { await dados({ query: parsed.query }, resFake); return; }
  if (parsed.pathname === '/api/export') { await exportCsv({ query: parsed.query }, resFake); return; }
  if (parsed.pathname === '/api/progresso') { await progresso({}, resFake); return; }
  if (parsed.pathname === '/api/cron-aquecer') { await cronAquecer({ headers: req.headers }, resFake); return; }
  if (parsed.pathname === '/api/cron-hoje') { await cronHoje({ headers: req.headers }, resFake); return; }
  if (parsed.pathname === '/api/resumo') { await resumo({}, resFake); return; }

  if (parsed.pathname === '/api/sdrs') {
    let corpo = {};
    if (['POST', 'PUT', 'DELETE'].includes(req.method)) {
      try { corpo = await lerCorpoJson(req); }
      catch (e) { res.statusCode = e.code || 400; res.end(JSON.stringify({ error: e.message })); return; }
    }
    await sdrs({ method: req.method, body: corpo }, resFake);
    return;
  }

  if (parsed.pathname === '/' || parsed.pathname === '/index.html') {
    servirArquivo(res, path.join(__dirname, 'index.html'), 'text/html; charset=utf-8');
    return;
  }

  res.writeHead(404);
  res.end('Não encontrado');
});

server.listen(PORT, () => {
  console.log(`Rodando em http://localhost:${PORT}`);
  if (!process.env.DATACRAZY_API_KEY) {
    console.log('Aviso: DATACRAZY_API_KEY não definida — /api/dados vai responder com erro.');
  }
  dados.agendarAquecimentoDiario(3, 0); // roda no boot e todo dia as 3h, antes da operacao comecar
  dados.agendarAtualizacaoHoje(); // roda no boot e depois a cada 5 min, atualiza cacheHoje em background
});
