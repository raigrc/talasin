/**
 * Tiny CLI flag parser for the eval scripts. No dependency needed for
 * `--flag`, `--key value` and `--key=value` forms.
 */

export function hasFlag(name: string): boolean {
  return process.argv.slice(2).some((a) => a === `--${name}`);
}

export function stringFlag(name: string): string | undefined {
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    if (args[i] === `--${name}` && args[i + 1] && !args[i + 1].startsWith("--")) {
      return args[i + 1];
    }
    if (args[i].startsWith(`--${name}=`)) {
      return args[i].slice(`--${name}=`.length);
    }
  }
  return undefined;
}

export function numberFlag(name: string, fallback: number): number {
  const raw = stringFlag(name);
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    console.error(`--${name} must be a positive number (got "${raw}")`);
    process.exit(2);
  }
  return n;
}
