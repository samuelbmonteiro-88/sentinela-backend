const cron = require('node-cron');
const { pool } = require('./db');
const { enviarNotificacao } = require('./push');

const LIMITE_MINUTOS = 60;

// Minutos para disparar o cão de recuperação por estado crítico
const RECUPERACAO = {
  'PANE TOTAL': 20,
  'EMERGÊNCIA': 40,
};

function dentroDoHorario() {
  const agora = new Date();
  const horaBR = new Date(agora.toLocaleString('en-US', { timeZone: 'America/Sao_Paulo' }));
  const dia = horaBR.getDay();
  const hora = horaBR.getHours();
  if (dia === 0 || dia === 6) return false;
  if (hora < 7 || hora >= 20) return false;
  return true;
}

// ── CÃO DE GUARDA NORMAL (80min de inatividade) ───────────────────────────────
async function verificarTodos() {
  if (!dentroDoHorario()) return;

  const agora = new Date();
  const { rows: subs } = await pool.query(
    'SELECT device_id, subscription FROM push_subscriptions'
  );

  for (const sub of subs) {
    const { rows } = await pool.query(
      `SELECT criado_em, estado FROM checkins
       WHERE device_id = $1
       ORDER BY criado_em DESC
       LIMIT 1`,
      [sub.device_id]
    );

    if (rows.length === 0) continue;

    const ultimo = new Date(rows[0].criado_em);
    const minutosPassados = Math.round((agora - ultimo) / 60000);
    const ultimoEstado = rows[0].estado;

    // Se último estado foi crítico, cão de recuperação cuida — normal não interfere
    if (RECUPERACAO[ultimoEstado]) continue;

    if (minutosPassados >= LIMITE_MINUTOS) {
      const resultado = await enviarNotificacao(
        sub.subscription,
        '🚨 ALERTA DE TÚNEL',
        `${minutosPassados} min sem check-in. Para tudo 2 min: água, mandíbula, respira.`,
        {
          tag: 'watchdog',
          requireInteraction: true,
          actions: [
            { action: 'checkin', title: '✅ Check-in agora' },
            { action: 'soneca', title: '⏰ +20 min' }
          ]
        }
      );

      if (resultado === 'expirada') {
        await pool.query('DELETE FROM push_subscriptions WHERE device_id = $1', [sub.device_id]);
      }
    }
  }
}

// ── CÃO DE RECUPERAÇÃO (após estado crítico) ──────────────────────────────────
async function verificarRecuperacao() {
  if (!dentroDoHorario()) return;

  const agora = new Date();
  const { rows: subs } = await pool.query(
    'SELECT device_id, subscription FROM push_subscriptions'
  );

  for (const sub of subs) {
    const { rows } = await pool.query(
      `SELECT criado_em, estado FROM checkins
       WHERE device_id = $1
       ORDER BY criado_em DESC
       LIMIT 1`,
      [sub.device_id]
    );

    if (rows.length === 0) continue;

    const ultimoEstado = rows[0].estado;
    const ultimoTs = new Date(rows[0].criado_em);
    const minutosDesde = Math.round((agora - ultimoTs) / 60000);

    const limiteRecuperacao = RECUPERACAO[ultimoEstado];
    if (!limiteRecuperacao) continue;

    // Janela: entre limite e limite+10min para não repetir
    if (minutosDesde >= limiteRecuperacao && minutosDesde < limiteRecuperacao + 10) {
      const isPaneTotal = ultimoEstado === 'PANE TOTAL';

      const titulo = isPaneTotal ? '🌱 Como você está agora?' : '💧 Já passou um pouco...';
      const corpo = isPaneTotal
        ? `Já faz ${minutosDesde} minutos. Sem pressa — só quando sentir que dá, conta como está agora.`
        : `${minutosDesde} minutos desde o último check-in. Se já deu uma respirada, como está sendo?`;

      const resultado = await enviarNotificacao(
        sub.subscription,
        titulo,
        corpo,
        {
          tag: 'recuperacao',
          requireInteraction: false,
          silent: isPaneTotal, // Pane Total: sem som/vibração — estímulo pode ser invasivo
          actions: [
            { action: 'checkin', title: '📋 Fazer check-in' },
            { action: 'estou-bem', title: '✅ Estou melhor' }
          ]
        }
      );

      if (resultado === 'expirada') {
        await pool.query('DELETE FROM push_subscriptions WHERE device_id = $1', [sub.device_id]);
      }
    }
  }
}

// ── CÃO DE GUARDA DE HÁBITOS ─────────────────────────────────────────────────
const HABITOS_LIMITE = {
  normal:   { agua: 60,  alongar: 90  }, // minutos — estado bom
  critico:  { agua: 120, alongar: 120 }, // minutos — estado crítico
};

const ESTADOS_CRITICOS_HAB = ['EMERGÊNCIA', 'PANE TOTAL'];

const TEXTOS_HABITO = {
  agua: {
    normal:  { titulo: '💧 Lembrete de água',         corpo: 'Já faz um tempo desde o último gole. Um copo agora pode ajudar o resto do dia.' },
    critico: { titulo: '💧 Um cuidado pequeno',        corpo: 'Se ajudar, um gole de água agora. Sem pressão, só uma opção a seu favor.' },
  },
  alongar: {
    normal:  { titulo: '🧘 Pausa rápida para alongar', corpo: 'Que tal 2–3 min para mexer pescoço e ombros? Pequenas pausas ajudam a manter o foco.' },
    critico: { titulo: '🧘 Um micro-respiro para o corpo', corpo: 'Se der, levantar e alongar um pouco pode aliviar a tensão. Só se fizer sentido agora.' },
  },
};

async function verificarHabitos() {
  // Janela ampliada para hábitos: 07h-22h todos os dias
  const agora = new Date();
  const horaBR = new Date(agora.toLocaleString('en-US', { timeZone: 'America/Sao_Paulo' }));
  const hora = horaBR.getHours();
  if (hora < 7 || hora >= 22) return;

  const { rows: subs } = await pool.query(
    'SELECT device_id, subscription FROM push_subscriptions'
  );

  for (const sub of subs) {
    // Estado atual mais recente
    const { rows: estadoRows } = await pool.query(
      `SELECT estado FROM checkins WHERE device_id = $1 ORDER BY criado_em DESC LIMIT 1`,
      [sub.device_id]
    );
    const estadoAtual = estadoRows[0]?.estado || 'PILOTO AUTO';
    const isCritico = ESTADOS_CRITICOS_HAB.includes(estadoAtual);
    const limites = isCritico ? HABITOS_LIMITE.critico : HABITOS_LIMITE.normal;
    const tonTxt = isCritico ? 'critico' : 'normal';

    for (const tipo of ['agua', 'alongar']) {
      // Busca último registro do hábito (botão rápido OU campo do check-in)
      let ultimoHabito = null;

      // Via tabela habitos
      const { rows: habRows } = await pool.query(
        `SELECT criado_em FROM habitos
         WHERE device_id = $1 AND tipo = $2
         ORDER BY criado_em DESC LIMIT 1`,
        [sub.device_id, tipo]
      );
      if (habRows.length > 0) ultimoHabito = new Date(habRows[0].criado_em);

      // Via campo do checkin (bebi_agua ou alonguei)
      const campoCheckin = tipo === 'agua' ? 'bebi_agua' : 'alonguei';
      const { rows: chkRows } = await pool.query(
        `SELECT criado_em FROM checkins
         WHERE device_id = $1 AND ${campoCheckin} = true
         ORDER BY criado_em DESC LIMIT 1`,
        [sub.device_id]
      );
      if (chkRows.length > 0) {
        const tsCheckin = new Date(chkRows[0].criado_em);
        if (!ultimoHabito || tsCheckin > ultimoHabito) ultimoHabito = tsCheckin;
      }

      // Se nunca registrou, usa 2h atrás como base conservadora
      if (!ultimoHabito) ultimoHabito = new Date(agora - 2 * 60 * 60 * 1000);

      const minutosDesde = Math.round((agora - ultimoHabito) / 60000);

      if (minutosDesde >= limites[tipo]) {
        const txt = TEXTOS_HABITO[tipo][tonTxt];
        const resultado = await enviarNotificacao(
          sub.subscription,
          txt.titulo,
          txt.corpo,
          { tag: `habito-${tipo}`, requireInteraction: false }
        );
        if (resultado === 'expirada') {
          await pool.query('DELETE FROM push_subscriptions WHERE device_id = $1', [sub.device_id]);
        }
      }
    }
  }
}

function iniciarWatchdog() {
  cron.schedule('*/10 * * * *', () => {
    verificarTodos().catch(err => console.error('Watchdog erro:', err.message));
  });

  cron.schedule('*/5 * * * *', () => {
    verificarRecuperacao().catch(err => console.error('Watchdog recuperação erro:', err.message));
  });

  // Cão de hábitos: verifica a cada 10 minutos, janela 07h-22h todos os dias
  cron.schedule('*/10 * * * *', () => {
    verificarHabitos().catch(err => console.error('Watchdog hábitos erro:', err.message));
  });

  console.log('Watchdog normal: ativo (10min, alerta 80min inatividade)');
  console.log('Watchdog recuperação: ativo (5min, 20min pós-Pane / 40min pós-Emergência)');
  console.log('Watchdog hábitos: ativo (10min, água 60min / alongar 90min / modulado por estado)');
}

module.exports = { iniciarWatchdog };
