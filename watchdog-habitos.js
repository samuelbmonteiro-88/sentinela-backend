const cron = require('node-cron');
const { pool } = require('./db');
const { enviarNotificacao } = require('./push');

const CRITICOS = ['EMERGÊNCIA', 'PANE TOTAL'];

function dentroDoHorario() {
  const agora = new Date();
  const horaBR = new Date(agora.toLocaleString('en-US', { timeZone: 'America/Sao_Paulo' }));
  const hora = horaBR.getHours();
  return hora >= 7 && hora < 22;
}

async function verificarHabitos() {
  if (!dentroDoHorario()) return;

  const agora = new Date();
  const { rows: subs } = await pool.query(
    'SELECT device_id, subscription FROM push_subscriptions'
  );

  for (const sub of subs) {
    const { rows: checkinRows } = await pool.query(
      `SELECT estado FROM checkins WHERE device_id = $1 ORDER BY criado_em DESC LIMIT 1`,
      [sub.device_id]
    );
    const estadoAtual = checkinRows[0]?.estado || 'PILOTO AUTO';
    const estadoCritico = CRITICOS.includes(estadoAtual);

    // INVERTIDO: estado crítico = intervalos MENORES (interocepção falha)
    const limiteAgua    = estadoCritico ? 30 : 60;
    const limiteAlongar = estadoCritico ? 45 : 90;

    const { rows: aguaRows } = await pool.query(`
      SELECT MAX(ts) as ultimo FROM (
        SELECT criado_em as ts FROM habitos
          WHERE device_id = $1 AND tipo = 'agua'
        UNION ALL
        SELECT criado_em as ts FROM checkins
          WHERE device_id = $1 AND bebi_agua = true
      ) x
    `, [sub.device_id]);

    const { rows: alongarRows } = await pool.query(`
      SELECT MAX(ts) as ultimo FROM (
        SELECT criado_em as ts FROM habitos
          WHERE device_id = $1 AND tipo = 'alongar'
        UNION ALL
        SELECT criado_em as ts FROM checkins
          WHERE device_id = $1 AND alonguei = true
      ) x
    `, [sub.device_id]);

    const ultimaAgua    = aguaRows[0]?.ultimo    ? new Date(aguaRows[0].ultimo)    : null;
    const ultimoAlongar = alongarRows[0]?.ultimo ? new Date(alongarRows[0].ultimo) : null;

    const minSemAgua    = ultimaAgua    ? Math.round((agora - ultimaAgua)    / 60000) : 999;
    const minSemAlongar = ultimoAlongar ? Math.round((agora - ultimoAlongar) / 60000) : 999;

    // ── ÁGUA ──────────────────────────────────────────────────────────────────
    if (minSemAgua >= limiteAgua && minSemAgua < limiteAgua + 10) {
      // Em estado crítico: silencioso (sem vibração, sem interação forçada)
      const titulo = estadoCritico ? '💧 Um cuidado pequeno' : '💧 Lembrete de água';
      const corpo  = estadoCritico
        ? 'Se ajudar, um gole de água agora. Sem pressão.'
        : 'Já faz um tempo desde o último gole. Um copo agora pode ajudar.';

      const resultado = await enviarNotificacao(sub.subscription, titulo, corpo, {
        tag: 'habito-agua',
        requireInteraction: false,
        silent: estadoCritico, // silencioso em estado crítico
        actions: [{ action: 'agua', title: '💧 Bebi agora' }]
      });
      if (resultado === 'expirada') {
        await pool.query('DELETE FROM push_subscriptions WHERE device_id = $1', [sub.device_id]);
        continue;
      }
    }

    // ── ALONGAR ───────────────────────────────────────────────────────────────
    if (minSemAlongar >= limiteAlongar && minSemAlongar < limiteAlongar + 10) {
      const titulo = estadoCritico ? '🧘 Um micro-respiro' : '🧘 Pausa rápida para alongar';
      const corpo  = estadoCritico
        ? 'Se der, levantar um momento pode aliviar a tensão.'
        : 'Que tal 2-3 min para mexer pescoço e ombros?';

      const resultado = await enviarNotificacao(sub.subscription, titulo, corpo, {
        tag: 'habito-alongar',
        requireInteraction: false,
        silent: estadoCritico,
        actions: [{ action: 'alongar', title: '🧘 Fiz agora' }]
      });
      if (resultado === 'expirada') {
        await pool.query('DELETE FROM push_subscriptions WHERE device_id = $1', [sub.device_id]);
      }
    }
  }
}

function iniciarWatchdogHabitos() {
  cron.schedule('*/10 * * * *', () => {
    verificarHabitos().catch(err => console.error('Watchdog hábitos erro:', err.message));
  });
  console.log('Watchdog hábitos: ativo (crítico: água 30min / alongar 45min | normal: 60min / 90min)');
}

module.exports = { iniciarWatchdogHabitos };
