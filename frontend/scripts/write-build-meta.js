const fs = require('fs');
const path = require('path');

function main() {
  const frontendRoot = path.join(__dirname, '..');
  const outPath = path.join(frontendRoot, '.build-meta.json');
  const pkgPath = path.join(frontendRoot, 'package.json');

  let version = '0.0.0';
  try {
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    if (pkg && typeof pkg.version === 'string') version = pkg.version;
  } catch {
    // ignore
  }

  const meta = {
    version,
    build_date: new Date().toISOString(),
  };

  fs.writeFileSync(outPath, JSON.stringify(meta, null, 2) + '\n', 'utf8');
}

main();

