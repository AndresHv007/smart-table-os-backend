const Sentry = require('./instrument');
const { createDatabase } = require('./database');
const { createApp } = require('./app');

const PORT = process.env.PORT || 3001;
const db = createDatabase();
const { server } = createApp({ db, sentry: Sentry, enableTimerLoop: true });

server.listen(PORT, '0.0.0.0', () => {
  console.log(
    `[SmartTable OS Backend] Escuchando en puerto ${PORT} | env=${process.env.APP_ENV || process.env.NODE_ENV || 'development'} | sentry=${Boolean(process.env.SENTRY_DSN)}`
  );
});
