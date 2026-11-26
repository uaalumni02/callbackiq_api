const fs = require('node:fs');
const path = require('node:path');
const validLocation = value => value && [value.start, value.end].every(point =>
  point && Number.isInteger(point.line) && point.line > 0 &&
  Number.isInteger(point.column) && point.column >= 0);

/** Collapses identical single-location V8 branch records, adding hits; distinct branches, statements and functions remain intact. Invalid counters throw. */
function deduplicateV8Branches(input) {
  const coverage = { ...input, branchMap: { ...input.branchMap }, b: {} };
  for (const [id, hits] of Object.entries(input.b)) {
    if (!Array.isArray(hits) || hits.some(hit => !Number.isSafeInteger(hit) || hit < 0)) {
      throw new TypeError('Coverage contains invalid branch counters. Rerun coverage.');
    }
    coverage.b[id] = [...hits];
  }
  if (input.bT) return { coverage, duplicates: 0 };
  const seen = new Map();
  let duplicates = 0;
  for (const [id, metadata] of Object.entries(input.branchMap)) {
    const hits = coverage.b[id];
    if (!hits || hits.some(hit => !Number.isSafeInteger(hit) || hit < 0)) {
      throw new TypeError('Coverage contains invalid branch counters. Rerun coverage.');
    }
    if (metadata.type !== 'branch' || metadata.locations?.length !== 1 ||
        hits.length !== 1 || !validLocation(metadata.loc) ||
        !validLocation(metadata.locations[0])) continue;
    const key = JSON.stringify([metadata.type, metadata.line, metadata.loc, metadata.locations]);
    if (!seen.has(key)) {
      seen.set(key, id);
      continue;
    }
    const retained = seen.get(key);
    const total = coverage.b[retained][0] + hits[0];
    if (!Number.isSafeInteger(total)) throw new TypeError('Coverage counter overflow.');
    coverage.b[retained][0] = total;
    delete coverage.branchMap[id];
    delete coverage.b[id];
    duplicates++;
  }
  return { coverage, duplicates };
}

/** Returns an LCOV view with exact duplicate V8 records combined; missing or inconsistent counters throw. Raw reports are not modified. */
function distinctBranchLcov(lcov, rawCoverage, root) {
  let duplicates = 0;
  const records = lcov.split('end_of_record').filter(record => record.trim()).map(record => {
    const lines = record.trim().split(/\r?\n/);
    const source = lines.find(line => line.startsWith('SF:'))?.slice(3);
    if (!source) throw new Error('LCOV record is missing its source path.');
    const filename = path.resolve(root, source);
    const input = rawCoverage[filename];
    if (!input) return lines.join('\n');
    const result = deduplicateV8Branches(input);
    if (!result.duplicates) return lines.join('\n');
    duplicates += result.duplicates;
    let total = 0, covered = 0;
    const seenRecords = new Set();
    const output = [];
    for (const line of lines) {
      if (!line.startsWith('BRDA:')) { output.push(line); continue; }
      const [number, id, offset, rawHits] = line.slice(5).split(',');
      const original = input.b[id]?.[Number(offset)];
      const recordKey = `${id}:${offset}`;
      if (seenRecords.has(recordKey)) throw new Error('Duplicate LCOV counter identifier. Rerun coverage.');
      seenRecords.add(recordKey);
      if (rawHits === '-' || original !== Number(rawHits)) {
        throw new Error('LCOV and JSON coverage differ. Rerun coverage before evaluating the gate.');
      }
      const hits = result.coverage.b[id]?.[Number(offset)];
      if (hits === undefined) continue;
      total++; covered += Number(hits > 0);
      output.push(`BRDA:${number},${id},${offset},${hits}`);
    }
    const expectedRecords = Object.values(input.b).reduce((count, hits) => count + hits.length, 0);
    if (seenRecords.size !== expectedRecords) throw new Error('LCOV is missing JSON branch counters. Rerun coverage.');
    return output.map(line => line.startsWith('BRF:') ? `BRF:${total}` : line.startsWith('BRH:') ? `BRH:${covered}` : line).join('\n');
  });
  return { lcov: records.map(record => record + '\nend_of_record\n').join(''), duplicates };
}

/** Returns the gate's distinct-branch LCOV view; absent JSON keeps raw evidence, while malformed/inconsistent evidence throws. */
function readDistinctBranchLcov(root = process.cwd()) {
  const directory = path.join(root, 'coverage');
  const lcov = fs.readFileSync(path.join(directory, 'lcov.info'), 'utf8');
  const jsonPath = path.join(directory, 'coverage-final.json');
  if (!fs.existsSync(jsonPath)) return lcov;
  const result = distinctBranchLcov(
    lcov,
    JSON.parse(fs.readFileSync(jsonPath, 'utf8')),
    root,
  );
  if (result.duplicates) console.log(`Coverage: combined ${result.duplicates} identical V8 records; all distinct branches and thresholds preserved.`);
  return result.lcov;
}

module.exports = { deduplicateV8Branches, distinctBranchLcov, readDistinctBranchLcov };
