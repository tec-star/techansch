// create out directory for static Chrome Extension

const fs = require('fs');
const glob = require('glob');

const files = glob.sync('out/**/*.html');
files.forEach((file) => {
  const content = fs.readFileSync(file, 'utf-8');
  const modifiedContent = content.replace(/\/_next/g, './next');
  fs.writeFileSync(file, modifiedContent, 'utf-8');
});

const sourcePath = 'out/_next';
const destinationPath = 'out/next';

fs.rename(sourcePath, destinationPath, (err) => {
  if (err) {
    console.error('Failed to rename "_next" directory to "next".', err);
  } else {
    console.log('Renamed "_next" directory to "next" successfully.');
  }
});

// the index page loads its candles from here (in dev it uses the /api/candles route instead)
fs.mkdirSync('out/data', { recursive: true });
fs.copyFileSync('data/XMR_USDT-Min5.json', 'out/data/XMR_USDT-Min5.json');
console.log('Copied data/XMR_USDT-Min5.json to out/data.');
