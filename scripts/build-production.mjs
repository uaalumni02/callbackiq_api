import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { transformFileAsync } from '@babel/core';
import { auditImports } from './import-graph-audit.mjs';
auditImports();
const source = path.resolve('src'); const destination = path.resolve('build');
await fs.rm(destination, { recursive: true, force: true });
let count = 0;
const copy = async (directory) => {
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const input = path.join(directory, entry.name);
    const output = path.join(destination, path.relative(source, input));
    if (entry.isDirectory()) { await copy(input); continue; }
    await fs.mkdir(path.dirname(output), { recursive: true });
    if (entry.name.endsWith('.js')) {
      const result = await transformFileAsync(input, { babelrc: false, configFile: false,
        presets: [['@babel/preset-env', { targets: { node: '24' }, modules: false }]], sourceMaps: false });
      await fs.writeFile(output, result.code + '\n'); count++;
    } else await fs.copyFile(input, output);
  }
};
await copy(source);
let sha;
try {
  sha = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
} catch {
  sha = process.env.RENDER_GIT_COMMIT || process.env.GIT_COMMIT_SHA;
}
await fs.writeFile(path.join(destination, 'config/build-version.js'), 'export default ' + JSON.stringify({
  sha: /^[a-f0-9]{40}$/.test(sha || '') ? sha : null,
  builtAt: new Date().toISOString(),
}) + ';\n');
console.log(`Built ${count} ES modules for Node 24 LTS.`);
