const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

async function iniciarDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS usuarios (
      id SERIAL PRIMARY KEY,
      device_id TEXT UNIQUE NOT NULL,
      criado_em TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS push_subscriptions (
      id SERIAL PRIMARY KEY,
      device_id TEXT UNIQUE NOT NULL,
      subscription JSONB NOT NULL,
      atualizado_em TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS checkins (
      id SERIAL PRIMARY KEY,
      device_id TEXT NOT NULL,
      estado TEXT NOT NULL,
      score REAL,
      sono INTEGER,
      carga INTEGER,
      decisao INTEGER,
      pavio INTEGER,
      fisica INTEGER,
      emocional INTEGER,
      criado_em TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_checkins_device_criado
      ON checkins(device_id, criado_em DESC);

    CREATE TABLE IF NOT EXISTS recuperacoes (
      id SERIAL PRIMARY KEY,
      device_id TEXT NOT NULL,
      estado_critico TEXT NOT NULL,
      estado_recuperacao TEXT NOT NULL,
      minutos INTEGER NOT NULL,
      criado_em TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS habitos (
      id SERIAL PRIMARY KEY,
      device_id TEXT NOT NULL,
      tipo TEXT NOT NULL CHECK (tipo IN ('agua', 'alongar', 'pausa')),
      estado_no_momento TEXT,
      criado_em TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_habitos_device_criado
      ON habitos(device_id, criado_em DESC);
  `);

  // Colunas de hábitos no checkin (ALTER separado para não falhar se já existirem)
  await pool.query('ALTER TABLE checkins ADD COLUMN IF NOT EXISTS bebi_agua BOOLEAN DEFAULT NULL');
  await pool.query('ALTER TABLE checkins ADD COLUMN IF NOT EXISTS alonguei BOOLEAN DEFAULT NULL');
  await pool.query('ALTER TABLE checkins ADD COLUMN IF NOT EXISTS fez_pausa BOOLEAN DEFAULT NULL');
  console.log('DB: tabelas prontas');
}

module.exports = { pool, iniciarDB };
