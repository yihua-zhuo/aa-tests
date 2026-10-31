/** 95% Wilson score interval for a binomial proportion. */
export function wilsonInterval(hit: number, total: number): [number, number] {
  if (total <= 0) return [0, 0];
  const z = 1.959963984540054;
  const p = hit / total;
  const denominator = 1 + (z * z) / total;
  const center = (p + (z * z) / (2 * total)) / denominator;
  const margin =
    (z * Math.sqrt((p * (1 - p)) / total + (z * z) / (4 * total * total))) / denominator;
  return [Math.max(0, center - margin), Math.min(1, center + margin)];
}

export function rateOf(hit: number, total: number): number | null {
  return total > 0 ? hit / total : null;
}

/**
 * Smallest sample size whose 95% Wilson bound still clears `threshold` when the
 * observed rate holds. Null when no sample size can: a point estimate that sits
 * on the wrong side of the threshold, or exactly at it, never produces a bound
 * that clears. Used to size gate runs instead of letting a small corpus pass by
 * luck.
 */
export function requiredSamples(
  observed: number,
  threshold: number,
  comparison: 'min' | 'max' = 'min',
  maxSamples = 100_000,
): number | null {
  if (!Number.isFinite(observed) || observed < 0 || observed > 1) return null;
  if (!Number.isFinite(threshold)) return null;
  const clears = (total: number): boolean => {
    const [lower, upper] = wilsonInterval(Math.round(observed * total), total);
    return comparison === 'min' ? lower >= threshold : upper <= threshold;
  };
  if (clears(1)) return 1;
  let bound = 2;
  while (bound <= maxSamples && !clears(bound)) bound *= 2;
  if (bound > maxSamples) return null;
  let low = Math.floor(bound / 2) + 1;
  let high = bound;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (clears(middle)) high = middle;
    else low = middle + 1;
  }
  // hit = round(observed × n) makes the bound jitter slightly non-monotonic.
  while (low > 1 && clears(low - 1)) low -= 1;
  return low;
}
