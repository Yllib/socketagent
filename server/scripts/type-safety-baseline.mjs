import { createHash } from 'node:crypto';
import { z } from 'zod';

export const baselineSchema = z.object({
  version: z.literal(1),
  entries: z.record(z.string(), z.number().int().positive()),
});

/** Match the actual offending source, not line numbers or a per-file allowance.
 * @param {string} file @param {string} rule @param {string} sourceLine @param {string} sourceRange
 */
export function violationKey(file, rule, sourceLine, sourceRange) {
  /** @param {string} text */
  const normalize = (text) => text.replace(/\s+/g, ' ').trim();
  const anchor = createHash('sha256')
    .update(normalize(sourceLine)).update('\0').update(normalize(sourceRange))
    .digest('hex');
  return `${file}|${rule}|${anchor}`;
}

/** @param {Record<string, number>} baseline @param {Record<string, number>} current */
export function compareBaseline(baseline, current) {
  const added = Object.entries(current).filter(([key, count]) => count > (baseline[key] ?? 0));
  const removed = Object.entries(baseline).filter(([key, count]) => count > (current[key] ?? 0));
  return { added, removed };
}
