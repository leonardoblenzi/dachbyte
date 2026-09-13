const fs = require('fs');
const path = require('path');
const childProcess = require('child_process');
const packageJson = require('../package.json');

const rootDir = path.resolve(__dirname, '..');
const publicDir = path.join(rootDir, 'public');
const versionPath = path.join(publicDir, 'version.json');

const getCommit = () => {
  if (process.env.RENDER_GIT_COMMIT) return process.env.RENDER_GIT_COMMIT;
  if (process.env.REACT_APP_VERSION) return process.env.REACT_APP_VERSION;

  try {
    return childProcess.execSync('git rev-parse --short HEAD', {
      cwd: rootDir,
      stdio: ['ignore', 'pipe', 'ignore'],
      encoding: 'utf8',
    }).trim();
  } catch (error) {
    return 'local';
  }
};

const version = {
  service: 'web',
  app: 'Volt Corp',
  version: packageJson.version,
  commit: getCommit(),
  build_time: new Date().toISOString(),
};

fs.mkdirSync(publicDir, { recursive: true });
fs.writeFileSync(versionPath, `${JSON.stringify(version, null, 2)}\n`);
console.log(`Generated ${path.relative(rootDir, versionPath)} (${version.commit})`);
