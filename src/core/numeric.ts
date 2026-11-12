export function roundTo(value: number, precision: number): number {
  const factor = 10 ** precision;
  return Math.round((value + Number.EPSILON * Math.sign(value)) * factor) / factor;
}

export function normalizeZero(value: number, precision: number): number {
  const rounded = roundTo(value, precision);
  return rounded === 0 ? 0 : rounded;
}

export function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

export function formatNumber(value: number, precision = 4): string {
  const rounded = roundTo(value, precision);
  if (Object.is(rounded, -0)) return '0';
  return String(rounded);
}

export function formatSigned(value: number, precision = 4): string {
  const text = formatNumber(value, precision);
  return value > 0 ? `+${text}` : text;
}
