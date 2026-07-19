# wattmatch-server

Express + Sequelize (MySQL) API for the Wattmatch lead-capture site. Routes: `/api/leads/ci`, `/api/leads/generator`, `/api/contact`, `/api/health`.

## Development

```bash
npm install
cp .env.example .env   # or create .env with the vars below
npm run dev
```

Environment variables (`.env`): `PORT`, `DB_HOST`, `DB_PORT`, `DB_USER`, `DB_PASSWORD`, `DB_NAME`, `CORS_ORIGIN`.

Migrations: `npm run migrate` / `npm run migrate:undo` / `npm run migrate:status`.

## Deployment

Push to `main` deploys automatically (`.github/workflows/deploy-production.yml`): GitHub Actions SSHes into the EC2 host, then `git pull`, `npm ci`, `npm run build`, `npm run migrate`, `pm2 restart wattmatch`.

The app runs under pm2 as `wattmatch`, served through CloudFront at `/api/*`.
