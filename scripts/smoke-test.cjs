/*
 * Simple smoke test: start gateway, hit key endpoints, stop.
 */
const { pathToFileURL } = require('url');
const http = require('http');
const path = require('path');

async function main() {
  const modUrl = pathToFileURL(path.join(process.cwd(), 'dist', 'PbMcpGateway.js')).href;
  const mod = await import(modUrl);
  const { createGateway } = mod;
  const gw = createGateway({ port: 19233, host: '127.0.0.1', authMode: 'local-trusted', logLevel: 'warn' });

  await gw.start();

  const doGet = (p) => new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port: 19233, path: p }, (res) => {
      let body = '';
      res.on('data', (d) => (body += d));
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', (e) => resolve({ err: e.message }));
  });

  const doPost = (p, payload) => new Promise((resolve) => {
    const data = JSON.stringify(payload || {});
    const req = http.request(
      { host: '127.0.0.1', port: 19233, path: p, method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } },
      (res) => {
        let body = '';
        res.on('data', (d) => (body += d));
        res.on('end', () => resolve({ status: res.statusCode, body }));
      }
    );
    req.on('error', (e) => resolve({ err: e.message }));
    req.write(data);
    req.end();
  });

  const results = {};
  results.health = await doGet('/health');
  results.market = await doGet('/api/generator/marketplace');
  results.aiConfig = await doGet('/api/ai/config');
  results.aiChat = await doPost('/api/ai/chat', { messages: [{ role: 'user', content: 'ping' }] });
  results.gen = await doPost('/api/generator/generate', {
    source: { type: 'markdown', content: '# Service Plan\nBase URL: https://api.example.com\n\nEndpoint: GET /v1/echo\nAuth: none\nParameters:\n- q: string (optional)' },
    options: { autoRegister: false, testMode: true }
  });
  // GUI static routes
  results.guiIndex = await doGet('/');
  results.guiAssetIndex = await doGet('/static/index.html');

  console.log(JSON.stringify(results, null, 2));

  await gw.stop();
}

main().catch((e) => {
  console.error('SMOKE ERR', e);
  process.exit(1);
});
