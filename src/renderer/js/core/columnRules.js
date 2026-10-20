/**
 * 表格列规则（Beyond Compare 的 Column Rules / 表格比较规则）。
 *
 * BC 里每列可以单独设置：是否参与比较、忽略大小写、忽略空白、按数字比较等。
 * 这里把规则表达成"按列名或列序号匹配"的一小组开关，在单元格比较层生效，
 * 不改动行对齐与渲染，因此实现小、失败面也小。
 *
 * 规则文本格式（每行一条）：
 *   <列>[:选项][:<选项>]...
 *   - <列> 可以是表头名称（不区分大小写），或 `#1` 这样的 1 基序号；
 *   - 选项：
 *       ignore       该列不参与比较
 *       case         比较时忽略大小写
 *       trim         比较时忽略首尾空白
 *       numeric      按数字比较（"1.0" 与 "1" 相等，非数字退化为文本比较）
 *       regex:<r>    该列只比较正则 <r> 匹配到的部分（如取日期）
 *   - `*` 作为列名表示"所有列的默认选项"。
 */

const DEFAULTS = { ignore: false, caseInsensitive: false, trim: false, numeric: false, regex: null };

/**
 * 编译列规则文本。
 *
 * @returns {{ok:boolean, rules:Array<{sel:any, opts:object}>, reason?:string, source?:string}}
 */
export function compileColumnRules(text) {
  const src = String(text ?? '');
  const parts = src.split(/\r?\n|;/).map((s) => s.trim()).filter(Boolean);
  const rules = [];
  for (const p of parts) {
    const segs = splitTopLevel(p);
    const sel = parseSelector(segs[0] ?? '');
    if (sel === null) return { ok: false, reason: 'invalid', source: p, rules };
    const opts = { ...DEFAULTS };
    for (const raw of segs.slice(1)) {
      const key = raw.trim();
      if (!key) continue;
      const lower = key.toLowerCase();
      if (lower === 'ignore') opts.ignore = true;
      else if (lower === 'case') opts.caseInsensitive = true;
      else if (lower === 'trim') opts.trim = true;
      else if (lower === 'numeric') opts.numeric = true;
      else if (lower.startsWith('regex:')) {
        const body = key.slice(6);
        try {
          opts.regex = new RegExp(body, 'g');
        } catch (err) {
          return { ok: false, reason: 'invalid', source: p, rules };
        }
      } else {
        return { ok: false, reason: 'invalid', source: p, rules };
      }
    }
    rules.push({ sel, opts });
  }
  return { ok: true, rules };
}

/** 按冒号切分，但 `regex:` 之后的内容整体保留（正则里可能含冒号）。 */
function splitTopLevel(p) {
  const parts = p.split(':');
  const out = [];
  for (let k = 0; k < parts.length; k++) {
    const cur = parts[k];
    // `regex` 之后的全部内容（可能还含冒号）都原样保留。
    if (cur.trim().toLowerCase() === 'regex') {
      out.push(`regex:${parts.slice(k + 1).join(':')}`);
      break;
    }
    out.push(cur);
  }
  return out;
}

function parseSelector(s) {
  const name = s.trim();
  if (!name) return null;
  if (name === '*') return { kind: 'all' };
  const m = /^#(\d+)$/.exec(name);
  if (m) {
    const n = Number(m[1]);
    return n > 0 ? { kind: 'index', n } : null;
  }
  return { kind: 'name', name: name.toLowerCase() };
}

/**
 * 取出某一列最终生效的选项：先应用 `*` 默认项，再叠加该列自己的规则。
 *
 * @param {{label?:string, leftIndex?:number, rightIndex?:number}} column
 */
export function columnOptions(column, rules, ordinal) {
  let out = { ...DEFAULTS };
  if (!rules || !rules.length) return out;
  // label / leftName 可能带「仅左/仅右」后缀，不能直接拿来匹配；优先用未装饰的 rawName。
  const names = [column?.rawName, column?.leftName, column?.rightName, column?.label]
    .map((s) => String(s ?? '').trim().toLowerCase())
    .filter(Boolean);
  for (const r of rules) {
    const sel = r.sel;
    const hit =
      sel.kind === 'all'
      || (sel.kind === 'index' && sel.n === ordinal)
      || (sel.kind === 'name' && names.includes(sel.name));
    if (hit) out = { ...out, ...r.opts };
  }
  return out;
}

/** 按选项规范化单元格值；ignore 的列返回固定串，使任意两值都相等。 */
export function normalizeCell(value, opts) {
  if (opts?.ignore) return '\u0000ignored';
  let s = String(value ?? '');
  if (opts?.regex) {
    // 只保留正则匹配到的片段；没有命中则视为空串。
    const all = s.match(opts.regex) || [];
    s = all.join('');
  }
  if (opts?.trim) s = s.trim();
  if (opts?.numeric) {
    const n = Number(s.trim());
    if (s.trim() !== '' && Number.isFinite(n)) return String(n);
  }
  if (opts?.caseInsensitive) s = s.toLowerCase();
  return s;
}

/** 按选项比较两个单元格。 */
export function cellsEqual(a, b, opts) {
  return normalizeCell(a, opts) === normalizeCell(b, opts);
}
