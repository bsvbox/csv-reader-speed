// solve.js — a fast drop-in for csv-reader 1.0.0.
//
// Answers exactly as csv-reader does for every {text, header} input:
//   {columns, rows, errors}
//
// Semantics, from the competition description:
// - A U+FEFF at the very start of the text is dropped.
// - A record ends at LF or CRLF; a line left with no characters is no record.
// - Outside quotes a CR not followed by LF is dropped (error stray_cr).
// - A field that opens with a quote runs to the next quote that is not doubled;
//   "" inside it is one quote, and each CRLF or lone CR inside it is read as LF;
//   what follows its closing quote, up to the next comma or line break, is appended
//   as it stands (error quote_junk, when the field ends); a quote that never closes
//   is a literal character, and the text after it is read again as unquoted
//   (error unterminated_quote). A quote inside an unquoted field is literal.
// - Fields stay strings, never trimmed or converted.
// - columns is the first record when header is true, else null; rows holds the
//   records after it (every record when header is false), each padded with empty
//   strings (short_row, with fields: its field count) or cut (long_row, with
//   extra: the cut fields) to the first record's width.
// - Each error is {code, line, row}, in the order met, a record's short_row or
//   long_row when it ends: line is the 1-based line its record starts on,
//   counting every LF, CRLF and lone CR inside quotes; row is its record's
//   index in rows, null for the header.
//
// Speed strategy: the text is scanned with indexOf jumps, never char by char
// over plain stretches. A line with no quote and no stray CR is split in one
// native call; other records are parsed field by field, each field found by
// indexOf, and a quoted field's content is taken verbatim unless it holds a
// doubled quote or an embedded line break.

const DQ = 34; // "
const COMMA = 44; // ,
const LF = 10; // \n
const CR = 13; // \r
const BOM = 0xfeff;

export function run(input) {
  const text = input.text;
  const header = input.header;
  const n = text.length;
  let i = 0;
  if (n > 0 && text.charCodeAt(0) === BOM) i = 1;
  let line = 1;
  const errors = [];
  const rows = [];
  let columns = header ? [] : null;
  let width = 0;
  let first = true;

  // Position and line for the slow record parser (it consumes whole records,
  // which may span lines through quoted fields).
  let P = 0;
  let LN = 1;

  // Commit one record's fields: set the width on the first record, else pad
  // or cut to it, recording short_row / long_row when the record ends.
  function commit(fields, recLine, rowIdx) {
    if (first) {
      width = fields.length;
      if (header) columns = fields;
      else rows.push(fields);
      first = false;
      return;
    }
    if (fields.length < width) {
      errors.push({ code: 'short_row', fields: fields.length, line: recLine, row: rowIdx });
      while (fields.length < width) fields.push('');
      rows.push(fields);
    } else if (fields.length > width) {
      const extra = fields.slice(width);
      errors.push({ code: 'long_row', extra, line: recLine, row: rowIdx });
      fields.length = width;
      rows.push(fields);
    } else {
      rows.push(fields);
    }
  }

  // Parse an unquoted field starting at P. Stops at ',', LF, CRLF or EOF.
  // A lone CR inside it is dropped and reported; the field runs on past it.
  // Returns the field value; leaves P at the delimiter (or EOF).
  function unquoted(recLine, rowIdx) {
    let val = '';
    for (;;) {
      const cComma = text.indexOf(',', P);
      const cLF = text.indexOf('\n', P);
      let end = n;
      if (cComma !== -1) end = cComma;
      if (cLF !== -1 && cLF < end) end = cLF;
      const span = text.slice(P, end);
      const cr = span.indexOf('\r');
      if (cr === -1) {
        val += span;
        P = end;
        return val;
      }
      // The span holds at least one CR. A CR that ends the span while the next
      // character is LF is the CRLF line break, not a stray CR; every other CR
      // in the span is a lone one: dropped, and reported.
      const trailingCRLF = span.charCodeAt(span.length - 1) === CR && end < n && text.charCodeAt(end) === LF;
      const parts = span.split('\r');
      let lone = parts.length - 1;
      let clean;
      if (trailingCRLF) {
        lone -= 1;
        clean = span.slice(0, -1);
        if (lone > 0) clean = clean.split('\r').join('');
      } else {
        clean = parts.join('');
      }
      for (let t = 0; t < lone; t++) errors.push({ code: 'stray_cr', line: recLine, row: rowIdx });
      val += clean;
      P = end;
      return val;
    }
  }

  // Parse one record starting at P (a record start). Handles quoted fields,
  // junk after closing quotes, unterminated quotes and stray CRs. Returns the
  // record's fields; leaves P at the next record start and LN on its line.
  function slowRecord(recLine, rowIdx) {
    const fields = [];
    let done = false;
    while (!done) {
      let val;
      if (P < n && text.charCodeAt(P) === DQ) {
        // Quoted field: find the closing quote, the next quote not doubled.
        let j = P + 1;
        let close = -1;
        let doubled = false;
        for (;;) {
          const q = text.indexOf('"', j);
          if (q === -1) break;
          if (text.charCodeAt(q + 1) === DQ) {
            doubled = true;
            j = q + 2;
            continue;
          }
          close = q;
          break;
        }
        if (close === -1) {
          // No closing quote anywhere: the opening quote is literal, and the
          // text after it is read again as unquoted.
          errors.push({ code: 'unterminated_quote', line: recLine, row: rowIdx });
          P = P + 1;
          val = '"' + unquoted(recLine, rowIdx);
        } else {
          const content = text.slice(P + 1, close);
          let v;
          if (!doubled && content.indexOf('\r') === -1 && content.indexOf('\n') === -1) {
            v = content;
          } else {
            let breaks = 0;
            v = content;
            if (v.indexOf('\r') !== -1 || v.indexOf('\n') !== -1) {
              v = v.replace(/\r\n?|\n/g, () => {
                breaks++;
                return '\n';
              });
            }
            if (doubled) v = v.replace(/""/g, '"');
            LN += breaks;
          }
          // Junk after the closing quote, up to the next comma or line break,
          // appended as it stands. A lone CR inside the junk is dropped and
          // reported, and the junk runs on past it. A CR right after the quote
          // starts the junk scan too: only a CR followed by LF ends the record.
          let end = close + 1;
          if (end < n) {
            const c = text.charCodeAt(end);
            if (c !== COMMA && c !== LF) {
              let acc = '';
              let pos = end;
              for (;;) {
                const cComma = text.indexOf(',', pos);
                const cLF = text.indexOf('\n', pos);
                const cCR = text.indexOf('\r', pos);
                let e = n;
                let kind = 0;
                if (cComma !== -1 && cComma < e) {
                  e = cComma;
                  kind = 1;
                }
                if (cLF !== -1 && cLF < e) {
                  e = cLF;
                  kind = 2;
                }
                if (cCR !== -1 && cCR < e) {
                  e = cCR;
                  kind = 3;
                }
                if (kind === 3 && e + 1 < n && text.charCodeAt(e + 1) === LF) {
                  acc += text.slice(pos, e);
                  pos = e;
                  break;
                }
                if (kind === 3) {
                  acc += text.slice(pos, e);
                  errors.push({ code: 'stray_cr', line: recLine, row: rowIdx });
                  pos = e + 1;
                  continue;
                }
                acc += text.slice(pos, e);
                pos = e;
                break;
              }
              if (acc.length > 0) {
                errors.push({ code: 'quote_junk', line: recLine, row: rowIdx });
                v += acc;
              }
              end = pos;
            }
          }
          val = v;
          P = end;
        }
      } else {
        val = unquoted(recLine, rowIdx);
      }
      fields.push(val);
      // Record terminator: comma (next field), LF or CRLF (record ends),
      // EOF (record ends). A lone CR here is dropped and reported, and the
      // terminator is read again.
      for (;;) {
        if (P >= n) {
          done = true;
          break;
        }
        const c = text.charCodeAt(P);
        if (c === COMMA) {
          P++;
          break;
        }
        if (c === LF) {
          LN++;
          P++;
          done = true;
          break;
        }
        if (c === CR) {
          if (text.charCodeAt(P + 1) === LF) {
            LN++;
            P += 2;
            done = true;
            break;
          }
          errors.push({ code: 'stray_cr', line: recLine, row: rowIdx });
          P++;
          continue;
        }
        done = true;
        break;
      }
    }
    return fields;
  }

  while (i < n) {
    const recLine = line;
    const rowIdx = first ? (header ? null : 0) : rows.length;
    const nl = text.indexOf('\n', i);
    const segEnd = nl === -1 ? n : nl;
    if (text.charCodeAt(i) === CR) {
      // A line holding only CRs is an empty line (no record); each CR not
      // followed by LF is a stray CR. (A lone CR is not a line break for the
      // line count, so line advances by one here whatever the CRs.)
      let k = i;
      while (k < segEnd && text.charCodeAt(k) === CR) k++;
      if (k === segEnd) {
        const lone = (segEnd - i) - (nl === -1 ? 0 : 1);
        for (let t = 0; t < lone; t++) errors.push({ code: 'stray_cr', line: recLine, row: rowIdx });
        line++;
        i = nl === -1 ? n : nl + 1;
        continue;
      }
    }
    const q = text.indexOf('"', i);
    if (q !== -1 && q < segEnd) {
      // This line holds a quote: parse the whole record the slow way (it may
      // span lines through a quoted field).
      P = i;
      LN = line;
      const fields = slowRecord(recLine, rowIdx);
      i = P;
      line = LN;
      commit(fields, recLine, rowIdx);
      continue;
    }
    const cr = text.indexOf('\r', i);
    if (cr !== -1 && cr < segEnd && cr !== segEnd - 1) {
      // A stray CR sits inside this line: parse the record the slow way.
      P = i;
      LN = line;
      const fields = slowRecord(recLine, rowIdx);
      i = P;
      line = LN;
      commit(fields, recLine, rowIdx);
      continue;
    }
    // Fast path: no quote and no stray CR on this line. A trailing CR is the
    // CRLF line break when a LF follows; at end of input it is a lone CR.
    let seg = text.slice(i, segEnd);
    if (seg.length > 0 && seg.charCodeAt(seg.length - 1) === CR) {
      if (nl === -1) errors.push({ code: 'stray_cr', line: recLine, row: rowIdx });
      seg = seg.slice(0, -1);
    }
    if (seg.length === 0) {
      // An empty line is no record.
      line++;
      i = nl === -1 ? n : nl + 1;
      continue;
    }
    const fields = seg.split(',');
    commit(fields, recLine, rowIdx);
    line++;
    i = nl === -1 ? n : nl + 1;
  }

  return { columns, rows, errors };
}
