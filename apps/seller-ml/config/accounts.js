// config/accounts.js
// Mapeia as contas e resolve as credenciais a partir do .env

const ACCOUNTS = {
  drossi: {
    key: 'drossi',
    label: 'DRossi Interiores',
    prefix: 'ML_DROSSI', // usa ML_DROSSI_* no .env
  },
  diplany: {
    key: 'diplany',
    label: 'Diplany',
    prefix: 'ML_DIPLANY',
  },
  rossidecor: {
    key: 'rossidecor',
    label: 'Rossi Decor',
    prefix: 'ML_ROSSIDECOR',
  },
};

function resolveCreds(accountKey) {
  const acc = ACCOUNTS[accountKey];
  if (!acc) return null;
  const p = acc.prefix;

  // Lê do .env seguindo o padrão ML_PREFIX_*
  const APP_ID         = process.env[`${p}_APP_ID`];
  const CLIENT_SECRET  = process.env[`${p}_CLIENT_SECRET`];
  const CODE           = process.env[`${p}_CODE`];           // opcional
  const REDIRECT_URI   = process.env[`${p}_REDIRECT_URI`];
  const REFRESH_TOKEN  = process.env[`${p}_REFRESH_TOKEN`];
  const ACCESS_TOKEN   = process.env[`${p}_ACCESS_TOKEN`];

  return {
    key: acc.key,
    label: acc.label,
    envPrefix: p,
    APP_ID, CLIENT_SECRET, CODE, REDIRECT_URI, REFRESH_TOKEN, ACCESS_TOKEN,
    // Helper para ver se está “completo” o bastante
    hasMinimum: !!(APP_ID && CLIENT_SECRET && (REFRESH_TOKEN || ACCESS_TOKEN)),
  };
}

function listAccounts() {
  return Object.values(ACCOUNTS).map(a => {
    const c = resolveCreds(a.key);
    return {
      key: a.key,
      label: a.label,
      hasMinimum: !!(c && c.hasMinimum),
    };
  });
}

module.exports = {
  ACCOUNTS,
  resolveCreds,
  listAccounts,
};
