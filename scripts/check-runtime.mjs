#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

function parseVersion(value) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(String(value).trim());
  return match ? match.slice(1).map(Number) : null;
}

function compare(left, right) {
  return left[0] - right[0] || left[1] - right[1] || left[2] - right[2];
}

export function satisfies(version, range) {
  const parsed = parseVersion(version);
  if (!parsed) return false;
  return String(range)
    .split('||')
    .some((alternative) =>
      alternative
        .trim()
        .split(/\s+/)
        .filter(Boolean)
        .every((comparator) => {
          const match = /^(>=|<=|>|<|=)?v?(\d+)(?:\.(\d+))?(?:\.(\d+))?$/.exec(comparator);
          if (!match) throw new Error(`unsupported version range: ${comparator}`);
          const target = [Number(match[2]), Number(match[3] ?? 0), Number(match[4] ?? 0)];
          const result = compare(parsed, target);
          switch (match[1] ?? '=') {
            case '>=':
              return result >= 0;
            case '>':
              return result > 0;
            case '<=':
              return result <= 0;
            case '<':
              return result < 0;
            default:
              return result === 0;
          }
        }),
    );
}

export function runtimeProblems({ pkg, nvmrc, nodeVersion = process.versions.node }) {
  const problems = [];
  const range = pkg.engines?.node;
  if (!range) {
    problems.push('package.json is missing engines.node');
    return problems;
  }
  if (!satisfies(nodeVersion, range)) {
    problems.push(`running Node ${nodeVersion} does not satisfy engines.node ${range}`);
  }
  const pinned = parseVersion(nvmrc);
  if (!pinned) {
    problems.push(`.nvmrc is not an exact version: ${JSON.stringify(nvmrc.trim())}`);
  } else if (!satisfies(nvmrc, range)) {
    problems.push(`.nvmrc ${nvmrc.trim()} does not satisfy engines.node ${range}`);
  }
  return problems;
}

const DEPENDENCY_FIELDS = [
  'dependencies',
  'devDependencies',
  'optionalDependencies',
  'peerDependencies',
];

function compareDependencyMaps(field, declared, locked, problems) {
  const declaredNames = Object.keys(declared).sort();
  const lockedNames = Object.keys(locked).sort();
  for (const name of declaredNames) {
    if (!(name in locked)) problems.push(`${field}.${name} is missing from the lockfile root`);
    else if (locked[name] !== declared[name]) {
      problems.push(
        `${field}.${name} is "${declared[name]}" in package.json but "${locked[name]}" in the lockfile`,
      );
    }
  }
  for (const name of lockedNames) {
    if (!(name in declared))
      problems.push(`${field}.${name} is in the lockfile but not in package.json`);
  }
}

export function lockfileProblems({ pkg, lock }) {
  const problems = [];
  if (lock.lockfileVersion !== 3) {
    problems.push(`lockfileVersion is ${lock.lockfileVersion}, expected 3`);
  }
  if (lock.name !== pkg.name)
    problems.push(`lockfile name ${lock.name} does not match ${pkg.name}`);
  if (lock.version !== pkg.version) {
    problems.push(`lockfile version ${lock.version} does not match ${pkg.version}`);
  }

  const packages = lock.packages ?? {};
  const root = packages[''] ?? {};
  for (const field of DEPENDENCY_FIELDS) {
    compareDependencyMaps(field, pkg[field] ?? {}, root[field] ?? {}, problems);
  }

  let verified = 0;
  for (const [path, entry] of Object.entries(packages)) {
    if (path === '' || entry.link) continue;
    const registry =
      entry.resolved === undefined || entry.resolved.startsWith('https://registry.npmjs.org/');
    if (!registry) continue;
    if (typeof entry.integrity !== 'string' || !entry.integrity.startsWith('sha512-')) {
      problems.push(`${path} is missing a sha512 integrity hash`);
    }
    verified += 1;
  }
  return { problems, verified };
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

export function validate(root) {
  const pkg = readJson(resolve(root, 'package.json'));
  const nvmrc = readFileSync(resolve(root, '.nvmrc'), 'utf8');
  const lock = readJson(resolve(root, 'package-lock.json'));
  const runtime = runtimeProblems({ pkg, nvmrc });
  const { problems: lockProblems, verified } = lockfileProblems({ pkg, lock });
  return {
    problems: [...runtime, ...lockProblems],
    verified,
    nodeVersion: process.versions.node,
    range: pkg.engines?.node,
    nvmrc: nvmrc.trim(),
  };
}

const rootIndex = process.argv.indexOf('--root');
const root =
  rootIndex === -1 ? resolve(import.meta.dirname, '..') : resolve(process.argv[rootIndex + 1]);
const result = validate(root);

if (result.problems.length > 0) {
  console.error('runtime check failed:');
  for (const problem of result.problems) console.error(`- ${problem}`);
  process.exit(1);
}

console.log(
  `runtime: Node ${result.nodeVersion} satisfies ${result.range} (.nvmrc ${result.nvmrc})`,
);
console.log(`lockfile: v3, ${result.verified} registry packages carry sha512 integrity hashes`);
