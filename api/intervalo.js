// ============================================================
//  api/intervalo.js — faixa de datas que a base ja tem guardada
// ------------------------------------------------------------
//  Usado pelo front (aba "Comparar periodos" e seletores de data) pra
//  travar o que da pra escolher no que a base ja cobre — evita o
//  usuario montar uma comparacao com data de fora do historico
//  mantido (que dispararia busca ao vivo sem cache no Datacrazy).
// ============================================================

const dados = require('./dados.js');

module.exports = async (req, res) => {
  const faixa = await dados.faixaHistoricoDisponivel();
  res.setHeader('Content-Type', 'application/json');
  return res.status(200).json(faixa);
};
