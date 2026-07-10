// ============================================================
//  api/resumo.js — media dos ultimos 60 dias de historico
// ------------------------------------------------------------
//  So le o que ja esta em cache (nao bate no Datacrazy), entao e
//  sempre rapido — usado pro painel de media, separado do filtro
//  que o usuario escolhe na tela.
// ============================================================

const dados = require('./dados.js');

module.exports = async (req, res) => {
  const resumo = await dados.calcularResumoHistorico();
  res.setHeader('Content-Type', 'application/json');
  return res.status(200).json(resumo);
};
