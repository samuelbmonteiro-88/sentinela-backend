const cron = require('node-cron');
const { pool } = require('./db');
const { enviarNotificacao } = require('./push');

const LIMITE_MINUTOS = 80;

function dentroDoHorario() {
  const agora = new Date();
  const horaBR = new Date(agora.toLocaleString('en-US', { timeZone: 'America/Sao_Paulo' }));
  const dia = horaBR.getDay();   // 0=dom, 6=sab
  const hora = horaBR.getHours();
  if (dia === 0 || dia === 6) return false;
  if (hora < 7 || hora >= 20) return false;
  return true;
}

async function verificarTodos() {
  if (!dentroDoHorario()) return;

  const agora = new Date();

  // Pega todos os devices com subscription ativa
  const { rows: subs } = await pool.query(
    'SELECT device_id, subscription FROM push_subscriptions'
  );

  for (const sub of subs) {
    // Busca o último check-in deste device
    const { rows } = await pool.query(
      `SELECT criado_em FROM checkins
       WHERE device_id = $1
       ORDER BY criado_em DESC
       LIMIT 1`,
      [sub.device_id]
    );

    let minutosPassados;
    if (rows.length === 0) {
      // Nunca fez check-in — usa a hora atual como base, não alerta ainda
      continue;
    } else {
      const ultimo = new Date(rows[0].criado_em);
      minutosPassados = Math.round((agora - ultimo) / 60000);
    }

    if (minutosPassados >= LIMITE_MINUTOS) {
      const resultado = await enviarNotificacao(
        sub.subscription,
        '🚨 ALERTA DE TÚNEL',
        `${minutosPassados} min sem check-in. Para tudo por 2 min: beba água, solte a mandíbula, respire.`,
        {
          tag: 'watchdog',
          requireInteraction: true,
          url: '/',
          actions: [
            { action: 'checkin', title: '✅ Check-in agora' },
            { action: 'soneca', title: '⏰ +20 min' }
          ]
        }
      );

      // Remove subscription expirada
      if (resultado === 'expirada') {
        await pool.query(
          'DELETE FROM push_subscriptions WHERE device_id = $1',
          [sub.device_id]
        );
      }
    }
  }
}

function iniciarWatchdog() {
  // Roda a cada 10 minutos — precisão suficiente para janela de 80min
  cron.schedule('*/10 * * * *', () => {
    verificarTodos().catch(err => console.error('Watchdog erro:', err.message));
  });
  console.log('Watchdog: ativo (verifica a cada 10min, alertas seg-sex 07h-20h)');
}

module.exports = { iniciarWatchdog };
