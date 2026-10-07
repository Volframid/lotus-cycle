'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const root = path.resolve(__dirname, '..');
const files = {};
function add(relative) {
  const data = fs.readFileSync(path.join(root, relative));
  const hash = crypto.createHash('sha256').update(data).digest('hex').toUpperCase();
  const preserve = relative === 'config.json' || relative === 'card-effects.json' ||
    relative === 'lotus.json' || relative.startsWith('config/');
  files[relative] = preserve ? { hash, overwrite: false } : hash;
}
function walk(relative) {
  for (const name of fs.readdirSync(path.join(root, relative)).sort()) {
    const entry = relative + '/' + name;
    const stat = fs.lstatSync(path.join(root, entry));
    if (stat.isDirectory()) walk(entry);
    else if (stat.isFile() && /\.(js|json)$/.test(name)) add(entry);
  }
}
for (const file of ['.gitignore', 'README.md', 'card-effects.json', 'config.json', 'index.js', 'lotus.json', 'module.json']) {
  if (fs.existsSync(path.join(root, file))) add(file);
}
for (const directory of ['config', 'lib']) {
  if (fs.existsSync(path.join(root, directory))) walk(directory);
}
fs.writeFileSync(path.join(root, 'manifest.json'), JSON.stringify({ files }, null, 2) + '\n');
console.log('Update manifest generated for ' + Object.keys(files).length + ' files.');
