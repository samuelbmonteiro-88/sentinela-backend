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
  `);
  console.log('DB: tabelas prontas');
}

module.exports = { pool, iniciarDB };
