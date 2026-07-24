import { readFile, readdir } from 'node:fs/promises';
import { extname, join } from 'node:path';

const ignoredDirectories = new Set([
  '.git',
  '.terraform',
  'coverage',
  'dist',
  'node_modules',
]);
const scannableExtensions = new Set([
  '',
  '.css',
  '.env',
  '.hcl',
  '.html',
  '.js',
  '.json',
  '.jsonc',
  '.md',
  '.mjs',
  '.sh',
  '.sql',
  '.tf',
  '.ts',
  '.tsx',
  '.txt',
  '.yaml',
  '.yml',
]);
const secretPatterns = [
  {
    name: 'AWS access key ID',
    expression: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/u,
  },
  {
    name: 'private key',
    expression: /-----BEGIN (?:EC |OPENSSH |RSA )?PRIVATE KEY-----/u,
  },
  {
    name: 'assigned OpenAI API key',
    expression: /\bOPENAI_API_KEY\s*=\s*(?!replace-|<|\$\{)[^\s#]+/u,
  },
  {
    name: 'assigned AWS secret access key',
    expression: /\baws_secret_access_key\s*=\s*(?!replace-|<|\$\{)[^\s#]+/iu,
  },
  {
    name: 'Supabase service-role token',
    expression: /\bservice_role\b[^\n]{0,40}\beyJ[a-zA-Z0-9_-]+\./u,
  },
];

const findings = [];
await scanDirectory('.');
if (findings.length > 0) {
  for (const finding of findings) {
    process.stderr.write(`${finding.file}:${finding.line}: ${finding.pattern}\n`);
  }
  throw new Error(`Potential secrets found: ${findings.length}`);
}
process.stdout.write('Repository secret-pattern scan passed.\n');

async function scanDirectory(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (!ignoredDirectories.has(entry.name)) await scanDirectory(path);
      continue;
    }
    if (!entry.isFile() || !scannableExtensions.has(extname(entry.name))) continue;
    const content = await readFile(path, 'utf8');
    const lines = content.split('\n');
    for (const [index, line] of lines.entries()) {
      for (const pattern of secretPatterns) {
        if (pattern.expression.test(line)) {
          findings.push({ file: path, line: index + 1, pattern: pattern.name });
        }
      }
    }
  }
}
