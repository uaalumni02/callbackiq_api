export function emailConfiguration(env = process.env) {
  const smtp = Boolean(env.SMTP_HOST);
  const user = smtp ? env.SMTP_USER : env.GMAIL_ADDRESS;
  const pass = smtp ? env.SMTP_PASSWORD : env.GMAIL_PASSWORD;
  const from = env.EMAIL_FROM || user;
  const port = Number(env.SMTP_PORT || 587);
  return {
    configured: Boolean(user && pass && from && (!smtp || Number.isInteger(port) && port > 0 && port <= 65535)),
    from,
    transport: {
      ...(smtp ? { host: env.SMTP_HOST, port, secure: env.SMTP_SECURE === 'true' || port === 465, requireTLS: port !== 465 }
        : { service: 'gmail' }),
      connectionTimeout: 10000, greetingTimeout: 10000, socketTimeout: 20000,
      disableFileAccess: true, disableUrlAccess: true,
      auth: { user, pass },
    },
  };
}
