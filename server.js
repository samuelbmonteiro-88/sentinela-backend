require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { iniciarDB, pool } = require('./db');
const { configurarWebPush, enviarNotificacao } = require('./push');
const { iniciarWatchdog } = require('./watchdog');
const { iniciarWatchdogHabitos } = require('./watchdog-habitos');

const app = express();
const PORT = process.env.PORT || 3000;

// ── CORS ──────────────────────────────────────────────────────────────────────
const origensPermitidas = [
  'https://sentinelv11.netlify.app',
  'http://localhost:3000',
  'http://localhost:5500'
];

app.use(cors({
  origin: (origin, cb) => {
    if (!origin || origensPermitidas.includes(origin)) return cb(null, true);
    cb(new Error('CORS bloqueado: ' + origin));
  }
}));

app.use(express.json());

// ── HEALTH CHECK ──────────────────────────────────────────────────────────────
app.get('/', (req, res) => {
  res.json({ status: 'ok', app: 'Sentinela Backend', ts: new Date().toISOString() });
});

// ── VAPID PUBLIC KEY (o front-end precisa para registrar push) ────────────────
app.get('/vapid-public-key', (req, res) => {
  res.json({ key: process.env.VAPID_PUBLIC_KEY });
});

// ── REGISTRAR DEVICE ──────────────────────────────────────────────────────────
// Chamado na primeira vez que o app abre
app.post('/device', async (req, res) => {
  const { deviceId } = req.body;
  if (!deviceId) return res.status(400).json({ erro: 'deviceId obrigatório' });

  await pool.query(
    'INSERT INTO usuarios (device_id) VALUES ($1) ON CONFLICT (device_id) DO NOTHING',
    [deviceId]
  );
  res.json({ ok: true });
});

// ── SALVAR SUBSCRIPTION PUSH ──────────────────────────────────────────────────
app.post('/push/subscribe', async (req, res) => {
  const { deviceId, subscription } = req.body;
  if (!deviceId || !subscription) return res.status(400).json({ erro: 'dados incompletos' });

  await pool.query(`
    INSERT INTO push_subscriptions (device_id, subscription, atualizado_em)
    VALUES ($1, $2, NOW())
    ON CONFLICT (device_id) DO UPDATE
      SET subscription = $2, atualizado_em = NOW()
  `, [deviceId, JSON.stringify(subscription)]);

  res.json({ ok: true });
});

// ── CHECK-IN ──────────────────────────────────────────────────────────────────
app.post('/checkin', async (req, res) => {
  const { deviceId, estado, score, sono, carga, decisao, pavio, fisica, emocional } = req.body;
  if (!deviceId || !estado) return res.status(400).json({ erro: 'dados incompletos' });

  // Garante que o device existe
  await pool.query(
    'INSERT INTO usuarios (device_id) VALUES ($1) ON CONFLICT (device_id) DO NOTHING',
    [deviceId]
  );

  await pool.query(`
    INSERT INTO checkins (device_id, estado, score, sono, carga, decisao, pavio, fisica, emocional)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
  `, [deviceId, estado, score, sono, carga, decisao, pavio, fisica, emocional]);

  // Calcula tempo de recuperação se veio de estado crítico
  const criticos = ['PANE TOTAL', 'EMERGÊNCIA'];
  const naosCriticos = ['VOO LIVRE', 'PILOTO AUTO', 'FOCO FRÁGIL', 'CURTO-CIRCUITO', 'ESTOU BEM'];
  if (naosCriticos.includes(estado)) {
    const { rows } = await pool.query(
      `SELECT estado, criado_em FROM checkins
       WHERE device_id = $1
       ORDER BY criado_em DESC
       LIMIT 2`,
      [deviceId]
    );
    // rows[0] é o que acabamos de inserir, rows[1] é o anterior
    if (rows.length >= 2 && criticos.includes(rows[1].estado)) {
      const minutos = Math.round((new Date() - new Date(rows[1].criado_em)) / 60000);
      await pool.query(`
        INSERT INTO recuperacoes (device_id, estado_critico, estado_recuperacao, minutos)
        VALUES ($1, $2, $3, $4)
      `, [deviceId, rows[1].estado, estado, minutos]);
    }
  }

  res.json({ ok: true });
});

// ── HISTÓRICO ─────────────────────────────────────────────────────────────────
app.get('/historico/:deviceId', async (req, res) => {
  const { deviceId } = req.params;
  const limite = parseInt(req.query.limite) || 50;

  const { rows } = await pool.query(`
    SELECT estado, score, sono, carga, decisao, pavio, fisica, emocional, criado_em
    FROM checkins
    WHERE device_id = $1
    ORDER BY criado_em DESC
    LIMIT $2
  `, [deviceId, limite]);

  res.json(rows);
});

// ── ESTATÍSTICAS DE RECUPERAÇÃO ──────────────────────────────────────────────
app.get('/recuperacao/:deviceId', async (req, res) => {
  const { deviceId } = req.params;
  const { rows } = await pool.query(`
    SELECT
      estado_critico,
      ROUND(AVG(minutos)) as media_minutos,
      MIN(minutos) as minimo_minutos,
      COUNT(*) as amostras
    FROM recuperacoes
    WHERE device_id = $1
    GROUP BY estado_critico
    ORDER BY estado_critico
  `, [deviceId]);
  res.json(rows);
});

// ── HÁBITOS ──────────────────────────────────────────────────────────────────
app.post('/habito', async (req, res) => {
  const { deviceId, tipo, estadoAtual } = req.body;
  if (!deviceId || !tipo) return res.status(400).json({ erro: 'dados incompletos' });

  const tiposValidos = ['agua', 'alongar', 'pausa'];
  if (!tiposValidos.includes(tipo)) return res.status(400).json({ erro: 'tipo inválido' });

  await pool.query(
    'INSERT INTO habitos (device_id, tipo, estado_no_momento) VALUES ($1, $2, $3)',
    [deviceId, tipo, estadoAtual || null]
  );

  res.json({ ok: true });
});

// Retorna agregados de hábitos da semana
app.get('/habitos/semana/:deviceId', async (req, res) => {
  const { deviceId } = req.params;

  // Hábitos dos últimos 7 dias agrupados por dia e tipo
  const { rows: porDia } = await pool.query(`
    SELECT
      DATE(criado_em AT TIME ZONE 'America/Sao_Paulo') as dia,
      tipo,
      COUNT(*) as total
    FROM habitos
    WHERE device_id = $1
      AND criado_em >= NOW() - INTERVAL '7 days'
    GROUP BY dia, tipo
    ORDER BY dia DESC, tipo
  `, [deviceId]);

  // Correlação: dias com água vs % críticos
  const { rows: correlacao } = await pool.query(`
    SELECT
      DATE(h.criado_em AT TIME ZONE 'America/Sao_Paulo') as dia,
      COUNT(CASE WHEN h.tipo = 'agua' THEN 1 END) as agua_count,
      COUNT(CASE WHEN h.tipo = 'alongar' THEN 1 END) as alongar_count,
      COUNT(CASE WHEN c.estado IN ('EMERGÊNCIA','PANE TOTAL') THEN 1 END) as criticos,
      COUNT(c.id) as total_checkins
    FROM habitos h
    FULL OUTER JOIN checkins c
      ON c.device_id = h.device_id
      AND DATE(c.criado_em AT TIME ZONE 'America/Sao_Paulo') =
          DATE(h.criado_em AT TIME ZONE 'America/Sao_Paulo')
    WHERE COALESCE(h.device_id, c.device_id) = $1
      AND COALESCE(h.criado_em, c.criado_em) >= NOW() - INTERVAL '7 days'
    GROUP BY dia
    ORDER BY dia DESC
  `, [deviceId]);

  res.json({ porDia, correlacao });
});

// ── REGISTRAR HÁBITO ─────────────────────────────────────────────────────────
app.post('/habito', async (req, res) => {
  const { deviceId, tipo, estadoAtual } = req.body;
  if (!deviceId || !tipo) return res.status(400).json({ erro: 'dados incompletos' });

  await pool.query(
    'INSERT INTO usuarios (device_id) VALUES ($1) ON CONFLICT (device_id) DO NOTHING',
    [deviceId]
  );

  await pool.query(
    'INSERT INTO habitos (device_id, tipo, estado_no_momento) VALUES ($1, $2, $3)',
    [deviceId, tipo, estadoAtual || null]
  );

  res.json({ ok: true });
});

// ── RELATÓRIO SEMANAL DE HÁBITOS ──────────────────────────────────────────────
app.get('/habitos/semana/:deviceId', async (req, res) => {
  const { deviceId } = req.params;
  const inicio = new Date();
  inicio.setDate(inicio.getDate() - 6);
  inicio.setHours(0, 0, 0, 0);

  const { rows } = await pool.query(`
    SELECT
      tipo,
      DATE(criado_em AT TIME ZONE 'America/Sao_Paulo') as dia,
      COUNT(*) as total,
      array_agg(estado_no_momento ORDER BY criado_em) as estados
    FROM habitos
    WHERE device_id = $1 AND criado_em >= $2
    GROUP BY tipo, dia
    ORDER BY dia, tipo
  `, [deviceId, inicio]);

  res.json(rows);
});

// ── SONECA (botão +20min na notificação) ─────────────────────────────────────
app.post('/soneca', async (req, res) => {
  const { deviceId } = req.body;
  if (!deviceId) return res.status(400).json({ erro: 'deviceId obrigatório' });

  // Insere um check-in fantasma com estado SONECA para resetar o timer do watchdog
  await pool.query(`
    INSERT INTO checkins (device_id, estado, criado_em)
    VALUES ($1, 'SONECA', NOW())
  `, [deviceId]);

  res.json({ ok: true });
});

// ── INICIALIZAÇÃO ─────────────────────────────────────────────────────────────
async function iniciar() {
  await iniciarDB();
  configurarWebPush();
  iniciarWatchdog();
  iniciarWatchdogHabitos();

  app.listen(PORT, () => {
    console.log(`Sentinela backend rodando na porta ${PORT}`);
  });
}

iniciar().catch(err => {
  console.error('Erro fatal na inicialização:', err);
  process.exit(1);
});
