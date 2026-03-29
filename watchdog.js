const cron = require('node-cron');
const { pool } = require('./db');
const { enviarNotificacao } = require('./push');

const LIMITE_MINUTOS = 60;

const RECUPERACAO = {
  'PANE TOTAL': 20,
  'EMERGÊNCIA': 40,
};

// Controle de alertas já enviados — evita spam a cada ciclo
// Formato: { deviceId: timestampUltimoAlerta }
const ultimoAlertaEnviado = {};

function dentroDoHorario() {
  const agora = new Date();
  const horaBR = new Date(agora.toLocaleString('en-US', { timeZone: 'America/Sao_Paulo' }));
  const dia = horaBR.getDay();
  const hora = horaBR.getHours();
  if (dia === 0 || dia === 6) return false;
  if (hora < 7 || hora >= 20) return false;
  return true;
}

async function verificarTodos() {
  if (!dentroDoHorario()) return;

  const agora = new Date();
  const { rows: subs } = await pool.query(
    'SELECT device_id, subscription FROM push_subscriptions'
  );

  console.log(`[Watchdog] Verificando ${subs.length} devices...`);

  for (const sub of subs) {
    const { rows } = await pool.query(
      `SELECT criado_em, estado FROM checkins
       WHERE device_id = $1
       ORDER BY criado_em DESC
       LIMIT 1`,
      [sub.device_id]
    );

    if (rows.length === 0) {
      console.log(`[Watchdog] Device ${sub.device_id.slice(-8)}: sem check-ins, pulando.`);
      continue;
    }

    const ultimo = new Date(rows[0].criado_em);
    const minutosPassados = Math.round((agora - ultimo) / 60000);
    const ultimoEstado = rows[0].estado;

    console.log(`[Watchdog] Device ${sub.device_id.slice(-8)}: ${minutosPassados}min (${ultimoEstado})`);

    if (RECUPERACAO[ultimoEstado]) continue;

    // Verifica modo trabalho — não alerta se estiver fora
    const { rows: modoRows } = await pool.query(
      'SELECT modo FROM modo_trabalho WHERE device_id = $1',
      [sub.device_id]
    );
    const modo = modoRows[0]?.modo || 'trabalho';
    if (modo === 'fora') {
      console.log(`[Watchdog] Device ${sub.device_id.slice(-8)}: fora do trabalho, pulando.`);
      continue;
    }

    if (minutosPassados >= LIMITE_MINUTOS) {
      // Verifica se já enviou alerta desde o último check-in
      const tsUltimoAlerta = ultimoAlertaEnviado[sub.device_id] || 0;
      const tsUltimoCheckin = ultimo.getTime();

      // Só envia se não enviou alerta depois do último check-in
      if (tsUltimoAlerta > tsUltimoCheckin) {
        console.log(`[Watchdog] Device ${sub.device_id.slice(-8)}: alerta já enviado, aguardando novo check-in.`);
        continue;
      }

      console.log(`[Watchdog] Enviando alerta para ${sub.device_id.slice(-8)}...`);
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

      console.log(`[Watchdog] Resultado: ${resultado}`);

      if (resultado === true) {
        // Registra o momento do envio para não repetir
        ultimoAlertaEnviado[sub.device_id] = agora.getTime();
      } else if (resultado === 'expirada') {
        console.log(`[Watchdog] Subscription expirada, removendo ${sub.device_id.slice(-8)}`);
        await pool.query('DELETE FROM push_subscriptions WHERE device_id = $1', [sub.device_id]);
        delete ultimoAlertaEnviado[sub.device_id];
      }
    }
  }
}

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

    if (minutosDesde >= limiteRecuperacao && minutosDesde < limiteRecuperacao + 10) {
      const isPaneTotal = ultimoEstado === 'PANE TOTAL';
      const titulo = isPaneTotal ? '🌱 Como você está agora?' : '💧 Já passou um pouco...';
      const corpo = isPaneTotal
        ? `Já faz ${minutosDesde} minutos. Sem pressa — só quando sentir que dá, conta como está agora.`
        : `${minutosDesde} minutos desde o último check-in. Se já deu uma respirada, como está sendo?`;

      const resultado = await enviarNotificacao(sub.subscription, titulo, corpo, {
        tag: 'recuperacao',
        requireInteraction: false,
        silent: isPaneTotal,
        actions: [
          { action: 'checkin', title: '📋 Fazer check-in' },
          { action: 'estou-bem', title: '✅ Estou melhor' }
        ]
      });

      if (resultado === 'expirada') {
        await pool.query('DELETE FROM push_subscriptions WHERE device_id = $1', [sub.device_id]);
      }
    }
  }
}

// Controle de alertas de hábitos — mesmo mecanismo anti-spam
const ultimoAlertaHabito = {}; // { 'deviceId:tipo': timestamp }

const HABITOS_LIMITE = {
  normal:  { agua: 60,  alongar: 90 },
  critico: { agua: 30,  alongar: 45 },
};

const ESTADOS_CRITICOS_HAB = ['EMERGÊNCIA', 'PANE TOTAL'];

async function verificarHabitos() {
  const agora = new Date();
  const horaBR = new Date(agora.toLocaleString('en-US', { timeZone: 'America/Sao_Paulo' }));
  const hora = horaBR.getHours();
  if (hora < 7 || hora >= 22) return;

  const { rows: subs } = await pool.query(
    'SELECT device_id, subscription FROM push_subscriptions'
  );

  for (const sub of subs) {
    const { rows: estadoRows } = await pool.query(
      `SELECT estado FROM checkins WHERE device_id = $1 ORDER BY criado_em DESC LIMIT 1`,
      [sub.device_id]
    );
    const estadoAtual = estadoRows[0]?.estado || 'PILOTO AUTO';
    const isCritico = ESTADOS_CRITICOS_HAB.includes(estadoAtual);
    const limites = isCritico ? HABITOS_LIMITE.critico : HABITOS_LIMITE.normal;

    for (const tipo of ['agua', 'alongar']) {
      let ultimoHabito = null;

      const { rows: habRows } = await pool.query(
        `SELECT criado_em FROM habitos WHERE device_id = $1 AND tipo = $2 ORDER BY criado_em DESC LIMIT 1`,
        [sub.device_id, tipo]
      );
      if (habRows.length > 0) ultimoHabito = new Date(habRows[0].criado_em);

      const campoCheckin = tipo === 'agua' ? 'bebi_agua' : 'alonguei';
      const { rows: chkRows } = await pool.query(
        `SELECT criado_em FROM checkins WHERE device_id = $1 AND ${campoCheckin} = true ORDER BY criado_em DESC LIMIT 1`,
        [sub.device_id]
      );
      if (chkRows.length > 0) {
        const tsCheckin = new Date(chkRows[0].criado_em);
        if (!ultimoHabito || tsCheckin > ultimoHabito) ultimoHabito = tsCheckin;
      }

      if (!ultimoHabito) ultimoHabito = new Date(agora - 2 * 60 * 60 * 1000);

      const minutosDesde = Math.round((agora - ultimoHabito) / 60000);
      const chaveAlerta = `${sub.device_id}:${tipo}`;
      const tsUltimoAlerta = ultimoAlertaHabito[chaveAlerta] || 0;

      // Só dispara se passou o limite E não enviou alerta depois do último registro
      if (minutosDesde >= limites[tipo] && tsUltimoAlerta <= ultimoHabito.getTime()) {
        const titulo = isCritico
          ? (tipo === 'agua' ? '💧 Um cuidado pequeno' : '🧘 Um micro-respiro')
          : (tipo === 'agua' ? '💧 Lembrete de água' : '🧘 Pausa rápida para alongar');
        const corpo = isCritico
          ? (tipo === 'agua' ? 'Se ajudar, um gole de água agora. Sem pressão.' : 'Se der, levantar um momento pode aliviar a tensão.')
          : (tipo === 'agua' ? 'Já faz um tempo desde o último gole. Um copo agora pode ajudar.' : 'Que tal 2-3 min para mexer pescoço e ombros?');

        const resultado = await enviarNotificacao(sub.subscription, titulo, corpo, {
          tag: `habito-${tipo}`,
          requireInteraction: false,
          silent: isCritico,
          actions: [{ action: tipo, title: tipo === 'agua' ? '💧 Bebi agora' : '🧘 Fiz agora' }]
        });

        if (resultado === true) {
          ultimoAlertaHabito[chaveAlerta] = agora.getTime();
        } else if (resultado === 'expirada') {
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

  cron.schedule('*/10 * * * *', () => {
    verificarHabitos().catch(err => console.error('Watchdog hábitos erro:', err.message));
  });

  console.log('Watchdog normal: ativo (10min, alerta 60min — 1 alerta por ciclo)');
  console.log('Watchdog recuperação: ativo (5min, 20min pós-Pane / 40min pós-Emergência)');
  console.log('Watchdog hábitos: ativo (crítico: água 30min / alongar 45min | normal: 60min / 90min)');
}

module.exports = { iniciarWatchdog };
