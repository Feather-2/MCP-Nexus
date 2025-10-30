/* Start gateway, register a container stdio echo service, create instance, print responses, stop. */
const { pathToFileURL } = require('url');
const http = require('http');
const path = require('path');

async function main() {
  const modUrl = pathToFileURL(path.join(process.cwd(), 'dist', 'PbMcpGateway.js')).href;
  const mod = await import(modUrl);
  const { createGateway } = mod;
  const gw = createGateway({ port: 19233, host: '127.0.0.1', authMode: 'local-trusted', logLevel: 'info' });
  await gw.start();

  const doPost = (p, payload) => new Promise((resolve) => {
    const data = JSON.stringify(payload || {});
    const req = http.request({ host: '127.0.0.1', port: 19233, path: p, method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } }, (res) => {
      let body = '';
      res.on('data', (d) => (body += d));
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', (e) => resolve({ err: e.message }));
    req.write(data);
    req.end();
  });

  // A simple echo server in node prints a single JSON-RPC line to stdout then exits.
  const tpl = {
    name: 'echo-in-container',
    version: '2024-11-26',
    transport: 'stdio',
    command: 'node',
    args: ['-e', "console.log(JSON.stringify({jsonrpc:'2.0',id:'protocol-test',result:{ok:true}}))"],
    env: { SANDBOX: 'container' },
    container: { image: 'node:20-alpine', readonlyRootfs: true }
  };

  const r1 = await doPost('/api/templates', tpl);
  console.log('register template:', r1.status, r1.body);

  const r2 = await doPost('/api/services', { templateName: 'echo-in-container' });
  console.log('create service:', r2.status, r2.body);

  await gw.stop();
}

main().catch((e) => { console.error(e); process.exit(1); });
