/**
 * Build an FTS5 query for the trigram tokenizer. Trigram indexes need at
 * least three characters per term; shorter input falls back to LIKE.
 */
export function ftsMatch(query: string): string | null {
  const terms = searchTerms(query);
  if (terms.length === 0) return null;
  if (terms.some((term) => term.length < 3)) return null;
  return terms.map((term) => `"${term.replace(/"/g, '""')}"`).join(' AND ');
}

/** Whitespace-separated terms shared by the FTS and LIKE fallback paths. */
export function searchTerms(query: string): string[] {
  return query.trim().split(/\s+/).filter(Boolean);
}
