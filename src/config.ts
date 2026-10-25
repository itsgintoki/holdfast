import 'dotenv/config';

export const config = {
  databaseUrl:
    process.env.DATABASE_URL ?? 'postgres://holdfast:holdfast@localhost:5432/holdfast',
  poolMax: Number(process.env.DB_POOL_MAX ?? 20),
  port: Number(process.env.PORT ?? 3000),
};