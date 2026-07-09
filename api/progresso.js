// ============================================================
//  api/progresso.js — status da busca em andamento no api/dados.js
// ------------------------------------------------------------
//  Front-end usa isso pra mostrar a barra de "calculando" em vez
//  de tela vazia ou dado inventado.
//  Aviso: so funciona de verdade rodando com server.js (memoria
//  compartilhada). Como funcao serverless na Vercel cada rota e
//  uma instancia separada, entao pode nao refletir o progresso
//  de uma busca rodando em outra instancia.
// ============================================================

const dados = require('./dados.js');

module.exports = async (req, res) => {
  const p = dados.obterProgresso();
  res.setHeader('Content-Type', 'application/json');
  return res.status(200).json(p ? { ativo: true, ...p } : { ativo: false });
};
