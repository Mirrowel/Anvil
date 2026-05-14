import { relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  getIndexFileDiagnostics,
  walkDir,
} from './file-walker.js';

interface Report {
  root: string;
  rawSourceFiles: string[];
  indexFiles: string[];
  filteredOut: string[];
  skippedByDirectory: string[];
  skippedByBlacklist: string[];
  skippedBySize: string[];
  skippedAsBinary: string[];
  ignoredByGit: string[];
  ignoredByIndexIgnore: string[];
  whitelistedByIndexIgnore: string[];
  excludedByOrderedIgnore: string[];
}

function rel(root: string, file: string): string {
  return relative(root, file).replace(/\\/g, '/');
}

export function buildIndexFileReport(rootPath: string): Report {
  const root = resolve(rootPath);
  const walkerAbs: string[] = [];
  walkDir(root, walkerAbs);

  const diagnostics = getIndexFileDiagnostics(root);
  const rawSourceFiles = [
    ...diagnostics.indexable,
    ...diagnostics.skippedByBlacklist,
    ...diagnostics.skippedBySize,
    ...diagnostics.skippedAsBinary,
    ...diagnostics.skippedByGitignore,
    ...diagnostics.skippedByIndexIgnore,
    ...diagnostics.indexExcludedByOrder,
  ].sort();
  const indexFiles = diagnostics.indexable;
  const walkerFiles = walkerAbs.map((file) => rel(root, file)).sort();
  const indexSet = new Set(indexFiles);
  const walkerSet = new Set(walkerFiles);
  const filteredOut = rawSourceFiles.filter((file) => !indexSet.has(file));
  const walkerMismatch = indexFiles.filter((file) => !walkerSet.has(file));

  if (walkerMismatch.length > 0 || walkerFiles.some((file) => !indexSet.has(file))) {
    throw new Error('walkDir output does not match filterIndexableFiles(raw source files)');
  }

  return {
    root,
    rawSourceFiles,
    indexFiles,
    filteredOut,
    skippedByDirectory: diagnostics.skippedByDirectory,
    skippedByBlacklist: diagnostics.skippedByBlacklist,
    skippedBySize: diagnostics.skippedBySize,
    skippedAsBinary: diagnostics.skippedAsBinary,
    ignoredByGit: diagnostics.skippedByGitignore,
    ignoredByIndexIgnore: diagnostics.skippedByIndexIgnore,
    whitelistedByIndexIgnore: diagnostics.indexWhitelisted,
    excludedByOrderedIgnore: diagnostics.indexExcludedByOrder,
  };
}

import { writeFileSync } from 'node:fs';

function printSection(lines: string[], title: string, files: string[], truncate = true): void {
  const max = truncate ? 200 : files.length;
  lines.push(`\n${title} (${files.length})`);
  for (const file of files.slice(0, max)) lines.push(`  ${file}`);
  if (truncate && files.length > max) lines.push(`  ... ${files.length - max} more`);
}

function main(): void {
  const args = process.argv.slice(2);
  const asJson = args.includes('--json');
  const outputIdx = args.indexOf('--output');
  const outputPath = outputIdx !== -1 && args[outputIdx + 1] ? resolve(args[outputIdx + 1]) : null;
  const rootArg = args.find((a) => !a.startsWith('--') && a !== (outputIdx !== -1 ? args[outputIdx + 1] : ''));
  const root = rootArg ? resolve(rootArg) : process.cwd();
  const report = buildIndexFileReport(root);

  if (asJson) {
    const json = JSON.stringify(report, null, 2);
    if (outputPath) {
      writeFileSync(outputPath, json, 'utf-8');
      console.log(`JSON report written to ${outputPath}`);
    } else {
      console.log(json);
    }
    return;
  }

  const truncate = !outputPath;
  const lines: string[] = [];

  lines.push(`Index file report for ${report.root}`);
  lines.push(`Raw source files: ${report.rawSourceFiles.length}`);
  lines.push(`Index files: ${report.indexFiles.length}`);
  lines.push(`Filtered out: ${report.filteredOut.length}`);

  printSection(lines, 'Files to be embedded', report.indexFiles, truncate);

  printSection(lines, 'Filtered out', report.filteredOut, truncate);
  printSection(lines, 'Skipped directories', report.skippedByDirectory, truncate);
  printSection(lines, 'Skipped by default blacklist', report.skippedByBlacklist, truncate);
  printSection(lines, 'Skipped by size', report.skippedBySize, truncate);
  printSection(lines, 'Skipped as binary', report.skippedAsBinary, truncate);
  printSection(lines, 'Ignored by .gitignore', report.ignoredByGit, truncate);
  printSection(lines, 'Ignored by index.ignore', report.ignoredByIndexIgnore, truncate);
  printSection(lines, 'Re-included by index.ignore (!)', report.whitelistedByIndexIgnore, truncate);
  printSection(lines, 'Excluded by ordered index.ignore (whitelisted then excluded)', report.excludedByOrderedIgnore, truncate);

  const text = lines.join('\n');

  if (outputPath) {
    writeFileSync(outputPath, text, 'utf-8');
    console.log(`Report written to ${outputPath}`);
  } else {
    console.log(text);
  }
}

const thisFile = fileURLToPath(import.meta.url);
if (resolve(process.argv[1] ?? '') === thisFile) {
  main();
}
