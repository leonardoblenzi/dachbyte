"use strict";

const db = require("../db/db");
const {
  canEncryptTokens,
  decryptToken,
  encryptToken,
  isEncryptedToken,
} = require("../services/tokenCrypto");

async function main() {
  if (!canEncryptTokens()) {
    throw new Error(
      "Defina ML_TOKEN_ENCRYPTION_KEY ou TOKEN_ENCRYPTION_KEY antes de migrar tokens existentes.",
    );
  }

  const { rows } = await db.query(
    `select meli_conta_id, access_token, refresh_token
       from meli_tokens
      order by meli_conta_id asc`,
  );

  let migrated = 0;
  for (const row of rows || []) {
    const needsAccess = row.access_token && !isEncryptedToken(row.access_token);
    const needsRefresh =
      row.refresh_token && !isEncryptedToken(row.refresh_token);

    if (!needsAccess && !needsRefresh) continue;

    await db.query(
      `update meli_tokens
          set access_token = $2,
              refresh_token = $3
        where meli_conta_id = $1`,
      [
        row.meli_conta_id,
        row.access_token ? encryptToken(decryptToken(row.access_token)) : null,
        row.refresh_token
          ? encryptToken(decryptToken(row.refresh_token))
          : null,
      ],
    );
    migrated += 1;
  }

  console.log(`Tokens migrados: ${migrated}`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("[encrypt-existing-tokens] erro:", err?.message || err);
    process.exit(1);
  });
