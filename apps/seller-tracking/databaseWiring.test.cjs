const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const test = require("node:test");
const assert = require("node:assert/strict");

const readAvantrackingFile = (...segments) =>
  fs.readFileSync(path.join(__dirname, ...segments), "utf8");

test("runtime database clients resolve the isolated Avantracking target", () => {
  const entrypointSource = readAvantrackingFile("index.cjs");
  const dbSource = readAvantrackingFile("server", "src", "lib", "db.ts");
  const compiledDbSource = readAvantrackingFile("server", "dist", "lib", "db.js");

  assert.match(entrypointSource, /require\(["']\.\/databaseTarget\.cjs["']\)/);
  assert.match(entrypointSource, /resolveAvantrackingDatabaseUrl\(process\.env\)/);
  assert.match(dbSource, /require\(["']\.\.\/\.\.\/\.\.\/databaseTarget\.cjs["']\)/);
  assert.match(dbSource, /connectionString:\s*resolveAvantrackingDatabaseUrl\(process\.env\)/);
  assert.doesNotMatch(dbSource, /process\.env\.DATABASE_URL/);
  assert.match(compiledDbSource, /resolveAvantrackingDatabaseUrl\(process\.env\)/);
  assert.doesNotMatch(compiledDbSource, /process\.env\.DATABASE_URL/);
});

test("migration runner has no generic database fallback", () => {
  const source = readAvantrackingFile("server", "scripts", "db-migrate.js");
  const preflightSource = readAvantrackingFile(
    "server",
    "scripts",
    "loadAvantrackingMigrationTarget.cjs",
  );

  assert.match(source, /loadAvantrackingMigrationTarget\(process\.env\)/);
  assert.match(preflightSource, /resolveAvantrackingDatabaseUrl\(env\)/);
  assert.match(source, /databaseEnvKeys:\s*\["AVANTRACKING_DATABASE_URL"\]/);
  assert.doesNotMatch(source, /databaseEnvKeys:\s*\[[^\]]*"DATABASE_URL"/);
});

test("migration preflight loads AVANTRACKING_DATABASE_URL from an owned env file", () => {
  const {
    loadAvantrackingMigrationTarget,
  } = require("./server/scripts/loadAvantrackingMigrationTarget.cjs");
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "avantracking-migration-env-"));
  const envFilePath = path.join(tempDir, ".env");
  const env = {
    DATABASE_URL: "postgresql://shopee.test/shopee",
  };

  try {
    fs.writeFileSync(
      envFilePath,
      "AVANTRACKING_DATABASE_URL=postgresql://avantracking.test/avantracking\n",
      "utf8",
    );

    assert.equal(
      loadAvantrackingMigrationTarget(env, [envFilePath]),
      "postgresql://avantracking.test/avantracking",
    );
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("server build compiles without invoking migrations", () => {
  const packageJson = JSON.parse(readAvantrackingFile("server", "package.json"));

  assert.doesNotMatch(packageJson.scripts.build, /db:migrate:deploy/);
});

test("Render declares the isolated Avantracking database secret", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "render.yaml"), "utf8");

  assert.match(
    source,
    /- key: AVANTRACKING_DATABASE_URL\s+sync: false/,
  );
});

test("local environment example uses only the isolated database key", () => {
  const source = readAvantrackingFile("server", ".env.example.txt");

  assert.match(source, /^AVANTRACKING_DATABASE_URL=/m);
  assert.doesNotMatch(source, /^DATABASE_URL=/m);
});
