/**
 * RFC 4180 风格的 CSV 解析器。
 *
 * 支持：引号包裹的字段、字段内逗号与换行、重复引号（"" 表示一个 "）。
 * 单独成文件是为了能在 Node 里做单元测试，不依赖 DOM。
 */
export function parseCsv(text) {
  const rows = [];
  let cur = [];
  let field = '';
  let inQuotes = false;
  const src = String(text ?? '');

  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else if (ch === '\r' && src[i + 1] === '\n') {
        // 引号内的 CRLF 统一成 LF，避免同一份数据因换行风格不同而产生差异。
        field += '\n';
        i++;
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      cur.push(field);
      field = '';
    } else if (ch === '\n') {
      cur.push(field);
      rows.push(cur);
      cur = [];
      field = '';
    } else if (ch !== '\r') {
      field += ch;
    }
  }
  // 末尾若有未闭合的内容，也算一行
  if (field !== '' || cur.length) { cur.push(field); rows.push(cur); }
  return trimTrailingBlankRows(rows);
}

/**
 * 去掉文件末尾的空白行。
 *
 * RFC 4180 允许在最后一个记录后再跟一个换行，很多表格软件导出时还会多留
 * 一个空行。按字面解析它们会变成一条 `['']` 的"数据行"，表格比较于是把
 * "文件末尾多一个空行"报告成仅右侧 / 仅左侧的差异——这是书写习惯，不是
 * 数据差异。
 *
 * 只有在「确实解析出了数据行」时才裁剪：一个只有换行符的文件仍应显示为
 * 一行空行，而不是被解析成空表。中间的空行一律保留。
 */
function trimTrailingBlankRows(rows) {
  if (rows.length <= 1) return rows;
  let end = rows.length;
  while (end > 1 && rows[end - 1].every((f) => f === '')) end--;
  return end === rows.length ? rows : rows.slice(0, end);
}
