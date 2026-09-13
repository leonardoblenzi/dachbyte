const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');

function findSignTool() {
  if (process.env.SIGNTOOL_PATH && fs.existsSync(process.env.SIGNTOOL_PATH)) {
    return process.env.SIGNTOOL_PATH;
  }

  const roots = [
    'C:\\Program Files (x86)\\Windows Kits\\10\\bin',
    'C:\\Program Files\\Windows Kits\\10\\bin',
    'C:\\Program Files (x86)\\Windows Kits\\10\\App Certification Kit',
  ];

  const candidates = [];
  for (const root of roots) {
    collectSignTools(root, candidates);
  }

  candidates.sort().reverse();
  const selected = candidates.find((candidate) => candidate.toLowerCase().includes(`${path.sep}x64${path.sep}`)) || candidates[0];

  if (!selected) {
    throw new Error('signtool.exe nao encontrado. Instale o Windows SDK ou defina SIGNTOOL_PATH.');
  }

  return selected;
}

function collectSignTools(directory, candidates) {
  if (!fs.existsSync(directory)) {
    return;
  }

  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      collectSignTools(entryPath, candidates);
    } else if (entry.isFile() && entry.name.toLowerCase() === 'signtool.exe') {
      candidates.push(entryPath);
    }
  }
}

function run(command, args) {
  return new Promise((resolve, reject) => {
    execFile(command, args, { windowsHide: true }, (error, stdout, stderr) => {
      if (stdout) {
        process.stdout.write(stdout);
      }
      if (stderr) {
        process.stderr.write(stderr);
      }
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    });
  });
}

module.exports = async function signWindows(configuration) {
  const signTool = findSignTool();
  const hash = configuration.hash || 'sha256';
  const certificateSha1 = process.env.VOLTCORP_SIGN_CERT_SHA1;
  const certificateSubject = process.env.VOLTCORP_SIGN_CERT_SUBJECT || 'Volt Corp Internal Code Signing';
  const timestampServer =
    configuration.options?.signtoolOptions?.rfc3161TimeStampServer ||
    configuration.options?.rfc3161TimeStampServer ||
    'http://timestamp.digicert.com';

  const args = ['sign'];

  if (certificateSha1) {
    args.push('/sha1', certificateSha1);
  } else {
    args.push('/n', certificateSubject);
  }

  args.push('/fd', hash);

  if (process.env.ELECTRON_BUILDER_OFFLINE !== 'true') {
    args.push('/tr', timestampServer, '/td', 'sha256');
  }

  if (configuration.name) {
    args.push('/d', configuration.name);
  }

  if (configuration.site) {
    args.push('/du', configuration.site);
  }

  args.push('/debug', configuration.path);

  console.log(`Assinando ${configuration.path} com certificado interno Volt Corp`);
  await run(signTool, args);
};

module.exports.default = module.exports;
