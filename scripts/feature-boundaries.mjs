import path from 'node:path';

// Explicit production boundaries, additional to the audit's original named cycle set.
const boundaries = {
  callbackiq_api: [{
    name: 'Booking policies',
    includes: file => file.startsWith('src/services/booking/') && file.endsWith('.policy.js'),
    forbiddenPaths: ['src/controllers/', 'src/routes/', 'src/db/', 'src/models/', 'src/integrations/', 'src/workers/'],
    forbiddenPackages: ['mongoose', 'twilio', 'stripe', 'openai', 'redis'],
  }],
  callbackiq_frontend: [{
    name: 'Leads feature',
    includes: file => file.startsWith('src/features/leads/'),
    forbiddenPaths: ['src/pages/'],
    forbiddenPackages: ['mongoose', 'twilio', 'stripe'],
  }],
};
const production = file => !/(?:^|\/)(?:__tests__|__mocks__|fixtures)(?:\/|$)|\.(?:test|spec)\./.test(file);
const portable = file => file.split(path.sep).join('/');

export function auditFeatureBoundaries({ root, repository, dependencies }) {
  const failures = [];
  let protectedFiles = 0;
  const relative = file => portable(path.relative(root, file));
  for (const boundary of boundaries[repository] || []) {
    const starts = [...dependencies.keys()].filter(file => production(relative(file)) && boundary.includes(relative(file)));
    protectedFiles += starts.length;
    const visited = new Set();
    const active = new Set();
    const visit = (file, chain) => {
      if (active.has(file)) {
        failures.push(`${boundary.name} dependency cycle: ${[...chain, file].map(relative).join(' -> ')}`);
        return;
      }
      if (visited.has(file)) return;
      visited.add(file);
      active.add(file);
      for (const { specifier, target, line } of dependencies.get(file) || []) {
        const destination = relative(target);
        const forbiddenPath = boundary.forbiddenPaths.some(prefix => destination.startsWith(prefix));
        const forbiddenPackage = boundary.forbiddenPackages.some(name => specifier === name ||
          specifier.startsWith(name + '/') || portable(target).includes('/node_modules/' + name + '/'));
        if (forbiddenPath || forbiddenPackage) {
          failures.push(`${boundary.name} forbidden import at ${relative(file)}:${line}: ${specifier}; dependency chain: ${[...chain, file, target].map(relative).join(' -> ')}`);
        }
        if (dependencies.has(target)) visit(target, [...chain, file]);
      }
      active.delete(file);
    };
    for (const file of starts) visit(file, []);
  }
  return { failures, protectedFiles };
}
