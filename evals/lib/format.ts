/** Minimal fixed-width table + verdict formatting for eval output. */

export function pad(value: string | number, width: number): string {
  const s = String(value);
  return s.length >= width ? s : s + " ".repeat(width - s.length);
}

export function row(cells: Array<string | number>, widths: number[]): string {
  return cells.map((c, i) => pad(c, widths[i] ?? 8)).join("  ");
}

export function rule(char = "-", len = 88): string {
  return char.repeat(len);
}

export function verdict(pass: boolean | null): string {
  if (pass === null) return "n/a";
  return pass ? "PASS" : "FAIL";
}

export function heading(title: string): void {
  console.log("");
  console.log(rule("="));
  console.log(title);
  console.log(rule("="));
}

export function pct(n: number, digits = 1): string {
  return `${n.toFixed(digits)}%`;
}
