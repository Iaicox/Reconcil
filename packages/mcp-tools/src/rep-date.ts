/**
 * Representative valuation date for a grouped row (contracts §6.1): a `day` bucket
 * values on that day, a `month` bucket on the month's last day (for a partial final
 * month this can sit just past `period.to`, by design), otherwise on `period.to`.
 * Shared by every aggregate tool that values grouped rows (flows, gas, stablecoins).
 */
export function repDate(group: Record<string, string>, periodTo: string): string {
  if (group.day !== undefined) return group.day;
  if (group.month !== undefined) return lastDayOfMonth(group.month);
  return periodTo;
}

export function lastDayOfMonth(ym: string): string {
  const [y, m] = ym.split('-').map(Number);
  const day = new Date(Date.UTC(y!, m!, 0)).getUTCDate(); // day 0 of next month = last day of this
  return `${ym}-${String(day).padStart(2, '0')}`;
}
