import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';

const legacyDataDir = '/var/lib/ai-presenter/data';
const textExtensions = new Set([
  '.css', '.csv', '.html', '.js', '.json', '.jsonl', '.md', '.mjs', '.py', '.sh', '.srt', '.ts', '.tsx', '.txt', '.vtt',
]);

const walkTextFiles = (root: string): string[] => {
  if (!existsSync(root)) return [];
  const files: string[] = [];
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, {withFileTypes: true})) {
      const filename = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (entry.name !== 'node_modules') visit(filename);
        continue;
      }
      if (!entry.isFile() || !textExtensions.has(path.extname(entry.name).toLowerCase())) continue;
      if (statSync(filename).size <= 32 * 1024 * 1024) files.push(filename);
    }
  };
  visit(root);
  return files;
};

export const migrateLegacyArtifactPaths = (
  dataDir: string,
): {migratedFiles: number; backupDir: string | null; markerPath: string} => {
  const resolvedDataDir = path.resolve(dataDir);
  const markerPath = path.join(resolvedDataDir, '.artifact-path-migration-v1.json');
  if (existsSync(markerPath)) return {migratedFiles: 0, backupDir: null, markerPath};
  const jobsDir = path.join(resolvedDataDir, 'jobs');
  const replacements = walkTextFiles(jobsDir)
    .map((filename) => ({filename, content: readFileSync(filename, 'utf8')}))
    .filter(({content}) => content.includes(legacyDataDir));
  const timestamp = new Date().toISOString().replaceAll(/[:.]/g, '-');
  const backupDir = replacements.length
    ? path.join(resolvedDataDir, 'backups', `artifact-path-migration-${timestamp}`)
    : null;
  for (const {filename, content} of replacements) {
    const relative = path.relative(resolvedDataDir, filename);
    const backup = path.join(backupDir!, relative);
    mkdirSync(path.dirname(backup), {recursive: true});
    copyFileSync(filename, backup);
    const temporary = `${filename}.${process.pid}.path-migration.tmp`;
    writeFileSync(temporary, content.replaceAll(legacyDataDir, resolvedDataDir), 'utf8');
    renameSync(temporary, filename);
  }
  const marker = {
    version: 1,
    legacyDataDir,
    dataDir: resolvedDataDir,
    migratedFiles: replacements.length,
    backupDir,
    completedAt: new Date().toISOString(),
  };
  writeFileSync(markerPath, `${JSON.stringify(marker, null, 2)}\n`, {encoding: 'utf8', mode: 0o600});
  return {migratedFiles: replacements.length, backupDir, markerPath};
};
