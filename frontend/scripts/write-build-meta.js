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

  const now = new Date();
  const buildDateUtc = now.toISOString();

  // Precompute a human-friendly Eastern time representation at build time so that
  // static prerendered HTML and the client bundle embed the exact same string.
  let buildDateEt = buildDateUtc;
  try {
    buildDateEt =
      new Intl.DateTimeFormat('en-US', {
        timeZone: 'America/New_York',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: 'numeric',
        minute: '2-digit',
        second: '2-digit',
        hour12: true,
        timeZoneName: 'short',
      }).format(now) || buildDateUtc;
  } catch {
    // ignore
  }

  const meta = {
    version,
    build_date: buildDateUtc,
    build_date_et: buildDateEt,
  };

  fs.writeFileSync(outPath, JSON.stringify(meta, null, 2) + '\n', 'utf8');
}

main();
