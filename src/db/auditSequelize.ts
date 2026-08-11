import { Sequelize } from 'sequelize';

// Separate connection, deliberately using restricted DB credentials (SELECT+INSERT only on
// wattmatch_auction_bids, no UPDATE/DELETE, no other tables) — see .env.example. This is the only
// connection the audit-bid write path should ever use; the main `sequelize` connection (full
// access, used for everything else) should never write to this table.
export const auditSequelize = new Sequelize(
  process.env.DB_NAME || 'wattmatch',
  process.env.AUDIT_DB_USER || 'wattmatch_audit',
  process.env.AUDIT_DB_PASSWORD || '',
  {
    host: process.env.DB_HOST || '127.0.0.1',
    port: Number(process.env.DB_PORT) || 3306,
    dialect: 'mysql',
    logging: false,
    // Sized for bursts of bid writes across ~20 concurrent auctions — see sequelize.ts for why
    // the default pool (max: 5) isn't enough at this target scale.
    pool: { max: 20, min: 0, acquire: 30000, idle: 10000 },
  }
);
