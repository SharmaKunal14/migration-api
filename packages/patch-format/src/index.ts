export function parsePatchPaths(patch: string): string[] {
  if (patch.length === 0) return [];
  const paths: string[] = [];
  for (const line of patch.split('\n')) {
    const match = /^diff --git a\/([A-Za-z0-9._/-]+) b\/([A-Za-z0-9._/-]+)$/u.exec(
      line,
    );
    if (!match) continue;
    const oldPath = match[1];
    const newPath = match[2];
    if (!oldPath || !newPath || oldPath !== newPath || paths.includes(oldPath)) {
      return [];
    }
    paths.push(oldPath);
  }
  return paths;
}
