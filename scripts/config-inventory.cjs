const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const entries = new Map();
function scan(directory) {
  for (const item of fs.readdirSync(directory, { withFileTypes: true })) {
    const file = path.join(directory, item.name);
    if (item.isDirectory()) { if (!['__tests__', 'node_modules'].includes(item.name)) scan(file); continue; }
    if (!/\.(?:js|jsx|mjs|cjs)$/.test(file) || /\.test\./.test(file)) continue;
    const text = fs.readFileSync(file, 'utf8');
    for (const match of text.matchAll(/process\.env(?:\.([A-Z][A-Z0-9_]*)|\[['"]([A-Z][A-Z0-9_]*)['"]\])/g)) {
      const name = match[1] || match[2];
      const uses = entries.get(name) || [];
      uses.push(`${path.relative(root, file)}:${text.slice(0, match.index).split('\n').length}`);
      entries.set(name, uses);
    }
  }
}
scan(path.join(root, 'src'));
for(const relative of ['config/worker-settings.json','config/numeric-settings.json']){
 const file=path.join(root,relative),typed=fs.existsSync(file)?JSON.parse(fs.readFileSync(file)):{};
 for(const name of Object.keys(typed))if(!entries.has(name))entries.set(name,[relative]);
}
const inventory = Object.fromEntries([...entries].sort(([a], [b]) => a.localeCompare(b)));
const serialized = JSON.stringify(inventory, null, 2) + '\n';
const output = path.join(root, 'config/environment-inventory.json');
if (process.argv.includes('--write')) {
  fs.mkdirSync(path.dirname(output), { recursive: true }); fs.writeFileSync(output, serialized);
} else if (!fs.existsSync(output) || fs.readFileSync(output, 'utf8') !== serialized) {
  throw new Error('Environment inventory changed; regenerate and review names/consumers with config:inventory -- --write.');
}
console.log(`Environment inventory covers ${entries.size} static names.`);
