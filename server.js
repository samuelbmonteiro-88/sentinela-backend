require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { iniciarDB, pool } = require('./db');
const { configurarWebPush } = require('./push');
const { iniciarWatchdog } = require('./watchdog');

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

// ── VAPID PUBLIC KEY ──────────────────────────────────────────────────────────
app.get('/vapid-public-key', (req, res) => {
  res.json({ key: process.env.VAPID_PUBLIC_KEY });
});

// ── REGISTRAR DEVICE ──────────────────────────────────────────────────────────
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
  const naoCriticos = ['VOO LIVRE', 'PILOTO AUTO', 'FOCO FRÁGIL', 'CURTO-CIRCUITO', 'ESTOU BEM'];
  if (naoCriticos.includes(estado)) {
    const { rows } = await pool.query(
      `SELECT estado, criado_em FROM checkins
       WHERE device_id = $1 ORDER BY criado_em DESC LIMIT 2`,
      [deviceId]
    );
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

// ── ESTATÍSTICAS DE RECUPERAÇÃO ───────────────────────────────────────────────
app.get('/recuperacao/:deviceId', async (req, res) => {
  const { deviceId } = req.params;
  const { rows } = await pool.query(`
    SELECT estado_critico,
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

// ── HÁBITOS ───────────────────────────────────────────────────────────────────
app.post('/habito', async (req, res) => {
  const { deviceId, tipo, estadoAtual } = req.body;
  if (!deviceId || !tipo) return res.status(400).json({ erro: 'dados incompletos' });

  const tiposValidos = ['agua', 'alongar', 'pausa'];
  if (!tiposValidos.includes(tipo)) return res.status(400).json({ erro: 'tipo inválido' });

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
    SELECT tipo,
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

// ── MODO TRABALHO ────────────────────────────────────────────────────────────
app.post('/modo', async (req, res) => {
  const { deviceId, modo } = req.body;
  if (!deviceId || !modo) return res.status(400).json({ erro: 'dados incompletos' });
  await pool.query(`
    INSERT INTO modos (device_id, modo, atualizado_em)
    VALUES ($1, $2, NOW())
    ON CONFLICT (device_id) DO UPDATE SET modo = $2, atualizado_em = NOW()
  `, [deviceId, modo]);
  res.json({ ok: true });
});

app.get('/modo/:deviceId', async (req, res) => {
  const { rows } = await pool.query(
    'SELECT modo FROM modos WHERE device_id = $1', [req.params.deviceId]
  );
  res.json({ modo: rows[0]?.modo || 'trabalho' });
});

// ── SONECA (+20min na notificação) ────────────────────────────────────────────
app.post('/soneca', async (req, res) => {
  const { deviceId } = req.body;
  if (!deviceId) return res.status(400).json({ erro: 'deviceId obrigatório' });
  await pool.query(
    `INSERT INTO checkins (device_id, estado, criado_em) VALUES ($1, 'SONECA', NOW())`,
    [deviceId]
  );
  res.json({ ok: true });
});

// ── INICIALIZAÇÃO ─────────────────────────────────────────────────────────────
async function iniciar() {
  await iniciarDB();
  configurarWebPush();
  iniciarWatchdog(); // inclui watchdog normal, recuperação e hábitos

  app.listen(PORT, () => {
    console.log(`Sentinela backend rodando na porta ${PORT}`);
  });
}

iniciar().catch(err => {
  console.error('Erro fatal na inicialização:', err);
  process.exit(1);
});
