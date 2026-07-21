// ============================================================
//  api/cron-aquecer.js — chamado pelo Vercel Cron todo dia as 3h
// ------------------------------------------------------------
//  Faz o que o agendamento local (server.js) faz sozinho: busca o(s)
//  dia(s) fechado(s) que ainda faltar e revalida os mais recentes.
//  Nao apaga nada — o historico so cresce a partir do deploy.
//  So funciona de verdade se o Vercel KV estiver configurado
//  (ver api/armazenamento.js) — sem KV, roda mas nao persiste
//  nada entre as chamadas.
//
//  Protegido por CRON_SECRET: configura essa env var na Vercel e
//  o proprio Cron da Vercel ja manda o header certo sozinho
//  (https://vercel.com/docs/cron-jobs/manage-cron-jobs#securing-cron-jobs).
// ============================================================

const dados = require('./dados.js');

module.exports = async (req, res) => {
  const segredo = process.env.CRON_SECRET;
  if (segredo && req.headers['authorization'] !== `Bearer ${segredo}`) {
    return res.status(401).json({ error: 'nao autorizado' });
  }
  await dados.rodarManutencaoDoCache();
  return res.status(200).json({ ok: true });
};
