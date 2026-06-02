// Post-selection dedupe — final safety pass on the ordered IDs to guarantee
// uniqueness while preserving order.

export function dedupe(postIds: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const id of postIds) {
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}
