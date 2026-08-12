/**
 * jarvis/importers/parsers/csv_parser.js
 * CSV / TSV テキストをオブジェクト配列に変換するパーサー
 *
 * - ヘッダー行をキーとして使用
 * - クォートフィールド対応（ダブルクォート内のカンマ・改行を許容）
 * - 空行はスキップ
 */

/**
 * CSV/TSV テキストをオブジェクト配列に変換する。
 *
 * @param {string} text - CSV または TSV テキスト
 * @param {object} [options]
 * @param {string} [options.delimiter=','] - 区切り文字（TSVの場合は '\t'）
 * @returns {object[]} ヘッダーキーのオブジェクト配列
 */
export function parseCsv(text, options = {}) {
  const delimiter = options.delimiter ?? ',';
  const lines = splitLines(text);

  if (lines.length === 0) return [];

  // ヘッダー行
  const headers = parseRow(lines[0], delimiter);
  if (headers.length === 0) return [];

  const results = [];

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue; // 空行スキップ

    const values = parseRow(lines[i], delimiter);
    const obj = {};
    for (let j = 0; j < headers.length; j++) {
      obj[headers[j]] = values[j] ?? '';
    }
    results.push(obj);
  }

  return results;
}

/**
 * テキストを行に分割する（\r\n / \n 両対応）。
 * @param {string} text
 * @returns {string[]}
 */
function splitLines(text) {
  return text.replace(/\r\n/g, '\n').split('\n');
}

/**
 * 1行をフィールド配列に分割する。クォートフィールド対応。
 * @param {string} line
 * @param {string} delimiter
 * @returns {string[]}
 */
function parseRow(line, delimiter) {
  const fields = [];
  let i = 0;
  let field = '';

  while (i < line.length) {
    if (line[i] === '"') {
      // クォートフィールド
      i++; // 開始クォートをスキップ
      while (i < line.length) {
        if (line[i] === '"') {
          if (line[i + 1] === '"') {
            // エスケープされたクォート
            field += '"';
            i += 2;
          } else {
            // クォート終了
            i++;
            break;
          }
        } else {
          field += line[i];
          i++;
        }
      }
      // 区切り文字またはEOLまでスキップ
      while (i < line.length && line[i] !== delimiter) i++;
      if (line[i] === delimiter) i++;
      fields.push(field.trim());
      field = '';
    } else {
      // 非クォートフィールド
      const end = line.indexOf(delimiter, i);
      if (end === -1) {
        field += line.slice(i);
        i = line.length;
        fields.push(field.trim());
        field = '';
      } else {
        field += line.slice(i, end);
        fields.push(field.trim());
        field = '';
        i = end + 1;
      }
    }
  }

  // 末尾が区切り文字で終わる場合、空フィールドを追加
  if (line.endsWith(delimiter)) {
    fields.push('');
  }

  return fields;
}
