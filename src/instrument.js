require('dotenv').config();
const Sentry = require('@sentry/node');

const dsn = process.env.SENTRY_DSN || '';
const environment = process.env.APP_ENV || process.env.NODE_ENV || 'development';
const release = process.env.APP_VERSION || '1.0.0';

if (dsn) {
  Sentry.init({
    dsn,
    environment,
    release: `smart-table-os-backend@${release}`,
    tracesSampleRate: 1.0,
    sendDefaultPii: true,
  });
}

module.exports = Sentry;
