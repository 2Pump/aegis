/**
 * RPC failures come in two kinds that need opposite handling:
 *  - SIZE:  "block range too large", "query returned more than 10000 results", "response size exceeded", out of gas
 *           → make the request smaller
 *  - SLOW:  429 / rate limit / 5xx / timeout / connection reset / generic "request failed"
 *           → keep the request the same size and WAIT (shrinking would send more requests and make it worse)
 */
export type RpcErrorKind = 'size' | 'slow' | 'other';

export function describeRpcError(e: unknown): string {
  const parts: string[] = [];
  const seen = new Set<unknown>();
  let cur: unknown = e;
  for (let depth = 0; cur && depth < 5 && !seen.has(cur); depth++) {
    seen.add(cur);
    const x = cur as { shortMessage?: string; details?: string; message?: string; status?: number; code?: number | string; cause?: unknown };
    if (x.status) parts.push(`HTTP ${x.status}`);
    if (x.code !== undefined && typeof x.code !== 'object') parts.push(`code ${x.code}`);
    if (x.shortMessage) parts.push(x.shortMessage);
    if (x.details && x.details !== x.shortMessage) parts.push(x.details);
    if (!x.shortMessage && x.message) parts.push(x.message.split('\n')[0]!);
    cur = x.cause;
  }
  const uniq = [...new Set(parts.map((p) => p.trim()).filter(Boolean))];
  return (uniq.join(' · ') || String(e)).slice(0, 300);
}

export function classifyRpcError(e: unknown): RpcErrorKind {
  const t = describeRpcError(e).toLowerCase();
  // 1) unmistakable rate limiting ("rate limit exceeded" must not be read as a size error)
  if (/\b429\b|rate.?limit|too many requests|throttl|quota|capacity|compute units|cu limit|request limit/.test(t)) return 'slow';
  // 2) the request was too big for this node
  if (/block range|range (is )?too (large|big|wide)|range.*(limit|max|exceed)|exceed|more than \d+|too many (results|logs|blocks)|limit.*(result|block|log)|response size|log response|out of gas|gas (limit|required)|max.*blocks|payload too large|\b413\b/.test(t))
    return 'size';
  // 3) generic transient failures
  if (/timeout|timed out|econnreset|socket hang up|fetch failed|http 5\d\d|\b50[234]\b|busy|request failed|network/.test(t)) return 'slow';
  return 'other';
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 1s, 2s, 4s, 8s, 16s, 30s, 30s, … */
export const backoffMs = (attempt: number, baseMs = 1000) => Math.min(30 * baseMs, baseMs * 2 ** Math.max(0, attempt - 1));
