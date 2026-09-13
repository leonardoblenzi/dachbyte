const fs = require("fs");
const path = require("path");
const { z } = require("zod");
const dotenv = require("dotenv");

const dotenvCandidates = [
  path.resolve(__dirname, "..", ".env"),
  path.resolve(__dirname, "..", "..", ".env"),
];

for (const dotenvPath of dotenvCandidates) {
  if (!fs.existsSync(dotenvPath)) continue;
  dotenv.config({ path: dotenvPath });
}

const optionalPositiveInt = z.preprocess(
  (value) => (value == null || value === "" ? undefined : value),
  z.coerce.number().int().positive().optional(),
);

const optionalNonEmptyString = z.preprocess(
  (value) => (value == null || value === "" ? undefined : value),
  z.string().min(1).optional(),
);

const EnvSchema = z.object({
  PORT: z.coerce.number().int().positive().default(3000),
  API_BASE_URL: z.string().url(),
  SHOPEE_API_BASE: z.string().url(),

  SHOPEE_PARTNER_ID: z.coerce.number().int().positive(),
  SHOPEE_PARTNER_KEY: z.string().min(10),
  SHOPEE_REDIRECT_URL: z.string().url(),
  SHOPEE_ADS_PARTNER_ID: optionalPositiveInt,
  SHOPEE_ADS_PARTNER_KEY: optionalNonEmptyString,

  SHOPEE_DATABASE_URL: z.string().optional(),
  DATABASE_URL: z.string().optional(),
  REDIS_URL: z.string().optional(),
});

const parsed = EnvSchema.safeParse(process.env);

if (!parsed.success) {
  const issues = parsed.error.issues
    .map((i) => `${i.path.join(".")}: ${i.message}`)
    .join("; ");
  throw new Error(`Variáveis de ambiente inválidas: ${issues}`);
}

module.exports = parsed.data;
