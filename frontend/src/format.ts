export const number = (value: number | null | undefined, digits = 2) =>
  value == null || !Number.isFinite(value) ? 'Not available' : new Intl.NumberFormat('en-US', { maximumFractionDigits: digits }).format(value);
export const percent = (value: number | null | undefined, digits = 1) =>
  value == null || !Number.isFinite(value) ? 'Not available' : new Intl.NumberFormat('en-US', { style: 'percent', minimumFractionDigits: digits, maximumFractionDigits: digits }).format(value);
export const money = (value: number, currency = 'USD', digits = 0) =>
  new Intl.NumberFormat('en-US', { style: 'currency', currency, minimumFractionDigits: digits, maximumFractionDigits: digits }).format(value);
export const date = (value: string) => {
  const parsed = new Date(value.length === 10 ? `${value}T12:00:00` : value);
  return Number.isNaN(parsed.getTime()) ? value : new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric' }).format(parsed);
};
export const timestamp = (value: string) => {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' }).format(parsed);
};
export const signed = (value: number, digits = 2) => `${value > 0 ? '+' : ''}${number(value, digits)}`;
export const metricLabel = (value: string) => value.replaceAll('_', ' ');
