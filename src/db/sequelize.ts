import { Sequelize } from 'sequelize';

export const sequelize = new Sequelize(
  process.env.DB_NAME || 'wattmatch',
  process.env.DB_USER || 'root',
  process.env.DB_PASSWORD || '',
  {
    host: process.env.DB_HOST || '127.0.0.1',
    port: Number(process.env.DB_PORT) || 3306,
    dialect: 'mysql',
    logging: false,
    // Sequelize's default pool (max: 5) queues requests once ~5 queries are in flight at once —
    // fine for the lead-gen forms this was built for, not for ~20 concurrent auction rooms each
    // polling/writing independently. Sized for the auction module's target scale (100 concurrent
    // participants across 20 concurrent auctions), not just today's traffic.
    pool: { max: 30, min: 0, acquire: 30000, idle: 10000 },
  }
);
