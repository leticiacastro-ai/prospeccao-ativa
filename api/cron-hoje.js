// ============================================================
//  api/cron-hoje.js — atualiza o cache do dia de hoje
// ------------------------------------------------------------
//  Chamado a cada 5 min (Vercel Cron no plano Pro, ou um cron
//  externo tipo cron-job.org/GitHub Actions no plano Hobby, que
//  so libera cron nativo 1x/dia). Sem isso configurado, o cache
//  de hoje ainda funciona — so fica "preguicoso" (atualiza na
//  hora do primeiro request depois de 5 min, em vez de ja vir
//  pronto). Ver TTL_HOJE em api/dados.js.
//
//  Protegido por CRON_SECRET, igual api/cron-aquecer.js.
// ============================================================

const dados = require('./dados.js');

module.exports = async (req, res) => {
  const segredo = process.env.CRON_SECRET;
  if (segredo && req.headers['authorization'] !== `Bearer ${segredo}`) {
    return res.status(401).json({ error: 'nao autorizado' });
  }
  await dados.atualizarCacheHoje();
  return res.status(200).json({ ok: true });
};
