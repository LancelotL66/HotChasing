/**
 * 轻量内存版 better-sqlite3 模拟，仅供测试。
 * 支持本仓库用到的 SQL 子集：SELECT/FROM + WHERE 等值/IN、INSERT、UPDATE、DELETE、COUNT。
 * 参数绑定顺序遵循 better-sqlite3：按 SQL 中占位符出现顺序（UPDATE 为 SET 先、WHERE 后）。
 */

type Row = Record<string, unknown>;

function extractTable(sql: string): string {
  const m = /(?:FROM|INTO|UPDATE|DELETE FROM)\s+([\w_]+)/i.exec(sql);
  return m ? m[1] : '';
}

function splitWhere(sql: string): string {
  const idx = /\sWHERE\s/i.exec(sql)?.index;
  return idx === undefined ? '' : sql.slice(idx + 6);
}

function parseConditions(wherePart: string): Array<{ col: string; op: 'eq' | 'in'; n: number; value?: unknown; negate?: boolean }> {
  const conditions: Array<{ col: string; op: 'eq' | 'in'; n: number; value?: unknown; negate?: boolean }> = [];
  const tokens: Array<{ col: string; op: 'eq' | 'in'; raw: string; negate?: boolean }> = [];
  const inRe = /([\w_]+)\s+(NOT\s+)?IN\s*\(([^)]*)\)/gi;
  let m: RegExpExecArray | null;
  while ((m = inRe.exec(wherePart)) !== null) {
    const placeholders = m[3].split(',').map((s) => s.trim()).filter((s) => s === '?');
    tokens.push({ col: m[1], op: 'in', raw: placeholders.join(','), negate: Boolean(m[2]) });
  }
  const eqRe = /([\w_]+)\s*=\s*(\?|'[^']*'|\d+(?:\.\d+)?)/g;
  while ((m = eqRe.exec(wherePart)) !== null) {
    if (!tokens.some((t) => t.col === m[1])) tokens.push({ col: m[1], op: 'eq', raw: m[2] });
  }
  for (const token of tokens) {
    if (token.op === 'in') {
      const n = token.raw.split(',').filter((s) => s === '?').length;
      conditions.push({ col: token.col, op: 'in', n, negate: token.negate });
    } else {
      conditions.push({ col: token.col, op: 'eq', n: token.raw === '?' ? 1 : 0, value: token.raw === '?' ? undefined : token.raw.startsWith("'") ? token.raw.slice(1, -1) : Number(token.raw) });
    }
  }
  return conditions;
}

function whereParamsCount(conditions: Array<{ col: string; op: 'eq' | 'in'; n: number }>): number {
  return conditions.reduce((acc, c) => acc + (c.op === 'in' ? c.n : c.n), 0);
}

function matchesRow(row: Row, conditions: Array<{ col: string; op: 'eq' | 'in'; n: number; value?: unknown; negate?: boolean }>, whereParams: unknown[]): boolean {
  let pi = 0;
  for (const cond of conditions) {
    const actual = row[cond.col];
    if (cond.op === 'in') {
      const values = whereParams.slice(pi, pi + cond.n);
      pi += cond.n;
      const contained = values.includes(actual);
      if (cond.negate ? contained : !contained) return false;
    } else {
      const expected = cond.n === 1 ? whereParams[pi++] : cond.value;
      if (actual !== expected) return false;
    }
  }
  return true;
}

function sortRows(rows: Row[], sql: string): Row[] {
  const orderMatch = /ORDER BY (\w+)( DESC)?/i.exec(sql);
  if (!orderMatch) return rows;
  const col = orderMatch[1];
  const desc = Boolean(orderMatch[2]);
  return [...rows].sort((a, b) => {
    const av = String(a[col] ?? '');
    const bv = String(b[col] ?? '');
    return desc ? bv.localeCompare(av) : av.localeCompare(bv);
  });
}

function tableStore(self: FakeDb, table: string): Map<string, Row> {
  if (!self.tables[table]) self.tables[table] = new Map<string, Row>();
  return self.tables[table];
}

export class FakeDb {
  tables: Record<string, Map<string, Row>> = {};

  seed(table: string, rows: Row[]): void {
    const store = tableStore(this, table);
    for (const row of rows) {
      const key = String(row.id ?? `${Math.random()}`);
      store.set(key, { ...row });
    }
  }

  prepare(sql: string) {
    const table = extractTable(sql);
    const wherePart = splitWhere(sql);
    const conditions = parseConditions(wherePart);
    const whereCount = whereParamsCount(conditions);

    return {
      get: (...params: unknown[]) => {
        const store = tableStore(this, table);
        if (sql.includes('COUNT(*)')) {
          const rows = [...store.values()].filter((row) => matchesRow(row, conditions, params.slice(0, whereCount)));
          return { c: rows.length };
        }
        if (sql.includes('SELECT')) {
          let rows = [...store.values()].filter((row) => matchesRow(row, conditions, params.slice(0, whereCount)));
          rows = sortRows(rows, sql);
          if (sql.includes('LIMIT 1')) return rows[0] ?? undefined;
          return rows[0] ?? undefined;
        }
        return undefined;
      },
      all: (...params: unknown[]) => {
        const store = tableStore(this, table);
        let rows = [...store.values()].filter((row) => matchesRow(row, conditions, params.slice(0, whereCount)));
        rows = sortRows(rows, sql);
        return rows;
      },
      run: (...params: unknown[]) => {
        const store = tableStore(this, table);
        if (sql.startsWith('INSERT INTO')) {
          const colsMatch = /INSERT INTO \w+\s*\(([^)]+)\)/.exec(sql);
          const valuesMatch = /VALUES\s*\(([^)]+)\)/i.exec(sql);
          if (colsMatch && valuesMatch) {
            const cols = colsMatch[1].split(',').map((s) => s.trim());
            const valueTokens = valuesMatch[1].split(',').map((s) => s.trim());
            const row: Row = {};
            let pi = 0;
            valueTokens.forEach((token, i) => {
              const col = cols[i];
              if (token === '?') row[col] = params[pi++];
              else if (token.startsWith("'")) row[col] = token.slice(1, -1);
              else row[col] = Number(token);
            });
            const key = String(row.id ?? `${Math.random()}`);
            store.set(key, row);
          }
          return;
        }
        if (sql.startsWith('UPDATE')) {
          const setIdx = /SET\s/i.exec(sql)?.index;
          const whereStart = /\sWHERE\s/i.exec(sql)?.index;
          if (setIdx === undefined) return;
          const setPart = whereStart !== undefined ? sql.slice(setIdx + 4, whereStart) : sql.slice(setIdx + 4);
          const setItems = setPart.split(',').map((s) => s.trim());
          const setQCount = (setPart.match(/\?/g) ?? []).length;
          const whereParams = params.slice(setQCount, setQCount + whereCount);
          const setParams = params.slice(0, setQCount);
          // 先收集 SET 操作（解析占位符），再一次性确定匹配行，最后统一应用。
          const ops: Array<{ col: string; value: unknown }> = [];
          let si = 0;
          for (const item of setItems) {
            const pm = /^([\w_]+)\s*=\s*(\?|'[^']*'|\d+(?:\.\d+)?|NULL)$/i.exec(item);
            if (!pm) continue;
            const col = pm[1];
            const raw = pm[2];
            const value = raw === '?' ? setParams[si++] : raw === 'NULL' ? null : raw.startsWith("'") ? raw.slice(1, -1) : Number(raw);
            ops.push({ col, value });
          }
          const matching = [...store.values()].filter((row) => matchesRow(row, conditions, whereParams));
          for (const op of ops) {
            for (const row of matching) row[op.col] = op.value;
          }
          return;
        }
        if (sql.startsWith('DELETE FROM')) {
          const whereParams = params.slice(0, whereCount);
          for (const [key, row] of store) {
            if (matchesRow(row, conditions, whereParams)) store.delete(key);
          }
          return;
        }
      },
    };
  }

  transaction(fn: () => void) {
    return () => fn();
  }
}
