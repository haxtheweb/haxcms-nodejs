const fs = require('fs-extra');
const path = require('path');
const child_process = require('child_process');
const { discoverConfigPath } = require('./discoverConfigPath.js');

const SSL_DIR = path.join(discoverConfigPath, 'ssl');
const KEY_PATH = path.join(SSL_DIR, 'localhost.key');
const CERT_PATH = path.join(SSL_DIR, 'localhost.crt');

function hasCustomSslCerts() {
  const keyPath = process.env.HAXCMS_SSL_KEY;
  const certPath = process.env.HAXCMS_SSL_CERT;
  return (
    keyPath &&
    certPath &&
    fs.existsSync(keyPath) &&
    fs.existsSync(certPath)
  );
}

function getCustomSslCerts() {
  return {
    key: fs.readFileSync(process.env.HAXCMS_SSL_KEY),
    cert: fs.readFileSync(process.env.HAXCMS_SSL_CERT),
    ca: process.env.HAXCMS_SSL_CA && fs.existsSync(process.env.HAXCMS_SSL_CA)
      ? fs.readFileSync(process.env.HAXCMS_SSL_CA)
      : undefined,
  };
}

function isMkcertAvailable() {
  try {
    child_process.execSync('mkcert --version', { stdio: 'ignore' });
    return true;
  } catch (e) {
    return false;
  }
}

function hasMkcertCerts() {
  return fs.existsSync(KEY_PATH) && fs.existsSync(CERT_PATH);
}

function getMkcertCerts() {
  return {
    key: fs.readFileSync(KEY_PATH),
    cert: fs.readFileSync(CERT_PATH),
  };
}

function generateMkcertCerts() {
  if (!fs.existsSync(SSL_DIR)) {
    fs.mkdirSync(SSL_DIR, { recursive: true });
  }
  try {
    // Ensure the local CA is installed in system/browser trust stores
    child_process.execSync('mkcert -install', { stdio: 'ignore' });
  } catch (e) {
    // -install may already be done or may fail silently; continue to cert generation
  }
  try {
    child_process.execSync(
      `mkcert -key-file "${KEY_PATH}" -cert-file "${CERT_PATH}" localhost 127.0.0.1 ::1`,
      { stdio: 'ignore', cwd: SSL_DIR }
    );
    console.log(`Generated locally-trusted SSL certificates via mkcert in ${SSL_DIR}`);
    console.log('These certificates are trusted by your system/browser because mkcert installed a local CA.');
    return true;
  } catch (e) {
    console.error('mkcert failed to generate certificates. Falling back to openssl.');
    return false;
  }
}

function hasOpensslCerts() {
  return fs.existsSync(KEY_PATH) && fs.existsSync(CERT_PATH);
}

function getOpensslCerts() {
  return {
    key: fs.readFileSync(KEY_PATH),
    cert: fs.readFileSync(CERT_PATH),
  };
}

function generateOpensslCerts() {
  if (!fs.existsSync(SSL_DIR)) {
    fs.mkdirSync(SSL_DIR, { recursive: true });
  }
  const configPath = path.join(SSL_DIR, 'openssl-san.cnf');
  const sanConfig = `
[req]
distinguished_name = req_distinguished_name
x509_extensions = v3_req
prompt = no
[req_distinguished_name]
CN = localhost
[v3_req]
keyUsage = keyEncipherment, dataEncipherment
extendedKeyUsage = serverAuth
subjectAltName = @alt_names
[alt_names]
DNS.1 = localhost
IP.1 = 127.0.0.1
IP.2 = ::1
`;
  fs.writeFileSync(configPath, sanConfig.trim());
  try {
    child_process.execSync(
      `openssl req -x509 -nodes -days 365 -newkey rsa:2048 -keyout "${KEY_PATH}" -out "${CERT_PATH}" -config "${configPath}"`,
      { stdio: 'ignore' }
    );
    console.log(`Generated self-signed SSL certificates in ${SSL_DIR}`);
    console.log('WARNING: Browsers will show a security warning for this certificate.');
    console.log('Install mkcert (https://github.com/FiloSottile/mkcert) for trusted local certificates.');
    return true;
  } catch (e) {
    console.error('Failed to generate local SSL certificates. Ensure openssl is installed.');
    return false;
  }
}

function hasLocalCerts() {
  return fs.existsSync(KEY_PATH) && fs.existsSync(CERT_PATH);
}

function getLocalCerts() {
  return {
    key: fs.readFileSync(KEY_PATH),
    cert: fs.readFileSync(CERT_PATH),
  };
}

function ensureLocalCerts() {
  if (hasLocalCerts()) {
    return true;
  }
  if (isMkcertAvailable()) {
    return generateMkcertCerts();
  }
  return generateOpensslCerts();
}

function createServer(app) {
  if (hasCustomSslCerts()) {
    return require('https').createServer(getCustomSslCerts(), app);
  }
  if (process.env.HAXCMS_ENABLE_SSL) {
    if (ensureLocalCerts()) {
      return require('https').createServer(getLocalCerts(), app);
    }
    console.error('HAXCMS_ENABLE_SSL is set but could not generate local certificates. Falling back to HTTP.');
  }
  return require('http').createServer(app);
}

function getServerProtocol() {
  if (hasCustomSslCerts()) {
    return 'https';
  }
  if (process.env.HAXCMS_ENABLE_SSL) {
    if (ensureLocalCerts()) {
      return 'https';
    }
  }
  return 'http';
}

module.exports = {
  hasCustomSslCerts,
  getCustomSslCerts,
  isMkcertAvailable,
  hasMkcertCerts,
  getMkcertCerts,
  generateMkcertCerts,
  hasOpensslCerts,
  getOpensslCerts,
  generateOpensslCerts,
  hasLocalCerts,
  getLocalCerts,
  ensureLocalCerts,
  createServer,
  getServerProtocol,
};
