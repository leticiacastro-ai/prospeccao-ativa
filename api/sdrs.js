// ============================================================
//  api/sdrs.js  —  cadastro de quem conta como SDR no dashboard
// ------------------------------------------------------------
//  Lista simples guardada em data/sdrs.json. So quem estiver
//  cadastrado aqui entra na contagem do funil (api/dados.js le
//  essa lista pra filtrar).
//
//  Aviso: isso guarda num arquivo local. Funciona rodando com
//  server.js na sua maquina. Se publicar na Vercel como funcao
//  serverless, o disco e temporario e a lista pode nao persistir
//  entre deploys — nesse caso precisa trocar por um banco/KV.
// ============================================================

const fs = require('fs');
const path = require('path');

const ARQUIVO = path.join(__dirname, '..', 'data', 'sdrs.json');

function lerLista() {
  try {
    const conteudo = fs.readFileSync(ARQUIVO, 'utf8');
    const lista = JSON.parse(conteudo);
    return Array.isArray(lista) ? lista : [];
  } catch (e) {
    return [];
  }
}

function salvarLista(lista) {
  fs.mkdirSync(path.dirname(ARQUIVO), { recursive: true });
  fs.writeFileSync(ARQUIVO, JSON.stringify(lista, null, 2));
  // avisa o api/dados.js pra descartar a resposta ja pronta (nao o historico
  // bruto) e recalcular com a lista de SDR atualizada na proxima consulta.
  try { require('./dados.js').limparCacheResposta(); } catch {}
}

module.exports = async (req, res) => {
  try {
    if (req.method === 'GET') {
      return res.status(200).json(lerLista());
    }

    if (req.method === 'POST') {
      const nome = (req.body && req.body.nome || '').trim();
      if (!nome) return res.status(400).json({ error: 'Informe um nome.' });
      const lista = lerLista();
      if (!lista.some((n) => n.toLowerCase() === nome.toLowerCase())) {
        lista.push(nome);
        salvarLista(lista);
      }
      return res.status(200).json(lista);
    }

    if (req.method === 'PUT') {
      const nomeAntigo = (req.body && req.body.nomeAntigo || '').trim();
      const nomeNovo = (req.body && req.body.nomeNovo || '').trim();
      if (!nomeAntigo || !nomeNovo) return res.status(400).json({ error: 'Informe o nome atual e o novo nome.' });
      const lista = lerLista();
      const idx = lista.findIndex((n) => n.toLowerCase() === nomeAntigo.toLowerCase());
      if (idx === -1) return res.status(404).json({ error: 'SDR nao encontrado.' });
      lista[idx] = nomeNovo;
      salvarLista(lista);
      return res.status(200).json(lista);
    }

    if (req.method === 'DELETE') {
      const nome = (req.body && req.body.nome || '').trim();
      if (!nome) return res.status(400).json({ error: 'Informe um nome.' });
      const lista = lerLista().filter((n) => n.toLowerCase() !== nome.toLowerCase());
      salvarLista(lista);
      return res.status(200).json(lista);
    }

    return res.status(405).json({ error: 'Metodo nao suportado.' });
  } catch (e) {
    return res.status(500).json({ error: String((e && e.message) || e) });
  }
};

module.exports.lerLista = lerLista;
