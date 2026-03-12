require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { iniciarDB, pool } = require('./db');
const { configurarWebPush, enviarNotificacao } = require('./push');
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

  app.listen(PORT, () => {
    console.log(`Sentinela backend rodando na porta ${PORT}`);
  });
}

iniciar().catch(err => {
  console.error('Erro fatal na inicialização:', err);
  process.exit(1);
});
