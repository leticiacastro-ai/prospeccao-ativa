// ============================================================
//  api/resumo.js — media do historico, janela escolhida pelo usuario
// ------------------------------------------------------------
//  ?dias=N escolhe a janela (10, 30, 60, 90, 100...). Default 100 se
//  nao vier nada. So soma o resumo ja pronto de cada dia (resumo-dia,
//  calculado uma vez quando o dia fecha — ver fecharCacheDoDia em
//  dados.js), nao reprocessa lead por lead nem bate no Datacrazy —
//  por isso e sempre rapido, mesmo trocando a janela toda hora.
// ============================================================

const dados = require('./dados.js');

module.exports = async (req, res) => {
  const dias = (req.query && req.query.dias) || 100;
  const resumo = await dados.calcularResumoHistorico(dias);
  res.setHeader('Content-Type', 'application/json');
  return res.status(200).json(resumo);
};
