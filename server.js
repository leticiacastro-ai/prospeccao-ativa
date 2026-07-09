// Servidor local simples — substitui a Vercel pra rodar o projeto na sua máquina.
// Serve o index.html e expõe /api/dados chamando a mesma função da api/dados.js.
require('dotenv').config();
const http = require('http');
const fs = require('fs');
const path = require('path');
const url = require('url');
const dados = require('./api/dados.js');
const sdrs = require('./api/sdrs.js');

const PORT = process.env.PORT || 3000;

function servirArquivo(res, caminho, tipo) {
  fs.readFile(caminho, (err, conteudo) => {
    if (err) { res.writeHead(404); res.end('Não encontrado'); return; }
    res.writeHead(200, { 'Content-Type': tipo });
    res.end(conteudo);
  });
}

function lerCorpoJson(req) {
  return new Promise((resolve) => {
    let dados = '';
    req.on('data', (c) => { dados += c; });
    req.on('end', () => {
      try { resolve(JSON.parse(dados || '{}')); } catch { resolve({}); }
    });
  });
}

const server = http.createServer(async (req, res) => {
  const parsed = url.parse(req.url, true);

  if (parsed.pathname === '/api/dados') {
    const reqFake = { query: parsed.query };
    const resFake = {
      status(codigo) { res.statusCode = codigo; return this; },
      setHeader(k, v) { res.setHeader(k, v); },
      json(obj) { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(obj)); },
    };
    await dados(reqFake, resFake);
    return;
  }

  if (parsed.pathname === '/api/sdrs') {
    const corpo = ['POST','PUT','DELETE'].includes(req.method) ? await lerCorpoJson(req) : {};
    const reqFake = { method: req.method, body: corpo };
    const resFake = {
      status(codigo) { res.statusCode = codigo; return this; },
      setHeader(k, v) { res.setHeader(k, v); },
      json(obj) { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(obj)); },
    };
    await sdrs(reqFake, resFake);
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
    console.log('Aviso: DATACRAZY_API_KEY não definida — vai cair nos dados de exemplo.');
  }
});
