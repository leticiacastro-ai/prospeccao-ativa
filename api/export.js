// ============================================================
//  api/export.js — exporta a tabela por SDR (mesmo filtro do
//  dashboard) em CSV, pra abrir em Excel/Planilhas.
// ------------------------------------------------------------
//  Reusa api/dados.js#obterResultado, entao respeita o mesmo
//  cache/fila/reserva ja usado pela tela — nao bate no Datacrazy
//  de novo por conta do export.
// ============================================================

const dados = require('./dados.js');

const COLUNAS = [
  ['sdr', 'SDR'],
  ['prospectou', 'Prospectou'],
  ['respondeu', 'Respondeu'],
  ['agendou', 'Agendou'],
  ['compareceu', 'Compareceu'],
  ['cliente', 'Cliente'],
];

function celulaCsv(valor) {
  const texto = String(valor);
  if (/[",\n;]/.test(texto)) return `"${texto.replace(/"/g, '""')}"`;
  return texto;
}

function paraCsv(linhas) {
  const cabecalho = COLUNAS.map(([, rotulo]) => rotulo).join(';');
  const corpo = linhas.map((linha) => COLUNAS.map(([chave]) => celulaCsv(linha[chave])).join(';'));
  return [cabecalho, ...corpo].join('\r\n');
}

module.exports = async (req, res) => {
  try {
    const { resultado, parcial } = await dados.obterResultado((req.query) || {});
    const csv = '﻿' + paraCsv(resultado); // BOM pra acentuacao abrir certo no Excel
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="prospeccao-ativa.csv"');
    if (parcial) res.setHeader('X-Dados-Parcial', 'true');
    res.status(200);
    return res.end(csv);
  } catch (e) {
    res.setHeader('Content-Type', 'application/json');
    const status = e.code === 429 ? 429 : 500;
    return res.status(status).json({ error: String((e && e.message) || e) });
  }
};
