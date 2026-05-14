import { readdirSync, statSync } from 'node:fs';
import { extname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  filterIndexableFiles,
  getIndexIgnoreDiagnostics,
  SOURCE_EXTENSIONS,
  SKIP_DIRS,
  walkDir,
} from './file-walker.js';

interface Report {
  root: string;
  rawSourceFiles: string[];
  indexFiles: string[];
  filteredOut: string[];
  ignoredByGit: string[];
  ignoredByIndexIgnore: string[];
  whitelistedByIndexIgnore: string[];
}

function collectRawSourceFiles(dir: string, collected: string[]): void {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }

  for (const entry of entries) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    let stat;
    try {
      stat = statSync(full);
    } catch {
      continue;
    }

    if (stat.isDirectory()) {
      collectRawSourceFiles(full, collected);
    } else if (stat.isFile() && SOURCE_EXTENSIONS.has(extname(entry))) {
      collected.push(full);
    }
  }
}

function rel(root: string, file: string): string {
  return relative(root, file).replace(/\\/g, '/');
}

export function buildIndexFileReport(rootPath: string): Report {
  const root = resolve(rootPath);
  const rawAbs: string[] = [];
  const walkerAbs: string[] = [];
  collectRawSourceFiles(root, rawAbs);
  walkDir(root, walkerAbs);

  const indexAbs = filterIndexableFiles(root, rawAbs);
  const rawSourceFiles = rawAbs.map((file) => rel(root, file)).sort();
  const indexFiles = indexAbs.map((file) => rel(root, file)).sort();
  const walkerFiles = walkerAbs.map((file) => rel(root, file)).sort();
  const indexSet = new Set(indexFiles);
  const walkerSet = new Set(walkerFiles);
  const filteredOut = rawSourceFiles.filter((file) => !indexSet.has(file));
  const walkerMismatch = indexFiles.filter((file) => !walkerSet.has(file));

  if (walkerMismatch.length > 0 || walkerFiles.some((file) => !indexSet.has(file))) {
    throw new Error('walkDir output does not match filterIndexableFiles(raw source files)');
  }

  const diagnostics = getIndexIgnoreDiagnostics(root, rawAbs);
  return {
    root,
    rawSourceFiles,
    indexFiles,
    filteredOut,
    ignoredByGit: diagnostics.gitIgnored,
    ignoredByIndexIgnore: diagnostics.indexIgnored,
    whitelistedByIndexIgnore: diagnostics.indexWhitelisted,
  };
}

function printSection(title: string, files: string[], max = 200): void {
  console.log(`\n${title} (${files.length})`);
  for (const file of files.slice(0, max)) console.log(`  ${file}`);
  if (files.length > max) console.log(`  ... ${files.length - max} more`);
}

function main(): void {
  const root = process.argv[2] ? resolve(process.argv[2]) : process.cwd();
  const asJson = process.argv.includes('--json');
  const report = buildIndexFileReport(root);

  if (asJson) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  console.log(`Index file report for ${report.root}`);
  console.log(`Raw source files: ${report.rawSourceFiles.length}`);
  console.log(`Index files: ${report.indexFiles.length}`);
  console.log(`Filtered out: ${report.filteredOut.length}`);
  printSection('Filtered out', report.filteredOut);
  printSection('Ignored by .gitignore', report.ignoredByGit);
  printSection('Ignored by index.ignore', report.ignoredByIndexIgnore);
  printSection('Whitelisted by index.ignore', report.whitelistedByIndexIgnore);
}

const thisFile = fileURLToPath(import.meta.url);
if (resolve(process.argv[1] ?? '') === thisFile) {
  main();
}
