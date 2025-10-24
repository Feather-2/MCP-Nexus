#!/usr/bin/env node
/*
  Create a portable bundle for the current platform.
  Layout:
  release/<platform>-<arch>/
    - dist/
    - scripts/start.sh | scripts/start.bat
    - config/ (with templates)
    - mcp-sandbox/ (if exists locally)
*/
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');

async function exists(p) { try { await fsp.access(p); return true; } catch { return false; } }
async function copy(src, dst) {
  const st = await fsp.stat(src);
  if (st.isDirectory()) {
    await fsp.mkdir(dst, { recursive: true });
    const items = await fsp.readdir(src);
    for (const it of items) {
      await copy(path.join(src, it), path.join(dst, it));
    }
  } else if (st.isFile()) {
    await fsp.mkdir(path.dirname(dst), { recursive: true });
    await fsp.copyFile(src, dst);
  }
}

async function main() {
  const root = process.cwd();
  const platform = process.platform; // win32, linux, darwin
  const arch = process.arch; // x64, arm64, etc.
  const outDir = path.join(root, 'release', `${platform}-${arch}`);

  // Ensure build exists
  const distDir = path.join(root, 'dist');
  if (!(await exists(distDir))) {
    console.log('[pack] dist not found, building...');
    require('child_process').execSync('npm run build', { stdio: 'inherit' });
  }

  // Prepare output
  await fsp.rm(outDir, { recursive: true, force: true }).catch(() => {});
  await fsp.mkdir(outDir, { recursive: true });

  // Copy dist
  await copy(distDir, path.join(outDir, 'dist'));

  // Copy start script
  if (platform === 'win32') {
    await copy(path.join(root, 'scripts', 'start.bat'), path.join(outDir, 'start.bat'));
  } else {
    await copy(path.join(root, 'scripts', 'start.sh'), path.join(outDir, 'start.sh'));
    // chmod +x
    await fsp.chmod(path.join(outDir, 'start.sh'), 0o755);
  }

  // Copy config & templates (create if missing)
  const cfgDir = path.join(root, 'config');
  await fsp.mkdir(path.join(outDir, 'config', 'templates'), { recursive: true });
  if (await exists(cfgDir)) {
    await copy(cfgDir, path.join(outDir, 'config'));
  }

  // Copy mcp-sandbox runtimes if present
  const sbxDir = path.join(root, 'mcp-sandbox');
  if (await exists(sbxDir)) {
    await copy(sbxDir, path.join(outDir, 'mcp-sandbox'));
  }

  // Write readme
  const readme = `PB-MCPGateway Portable\n\nUsage:\n${platform === 'win32' ? '  double click start.bat' : '  ./start.sh'}\n\nConfig:\n  Edit ./config/gateway.json and put templates to ./config/templates/*.json\n`;
  await fsp.writeFile(path.join(outDir, 'README_PORTABLE.txt'), readme, 'utf-8');

  console.log(`[pack] Portable bundle ready: ${outDir}`);
}

main().catch(err => {
  console.error('[pack] failed:', err);
  process.exit(1);
});

