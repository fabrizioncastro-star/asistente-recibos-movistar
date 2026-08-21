const fs = require("fs");
const { parse } = require("csv-parse/sync");

function readCsv(filePath, delimiter) {
  const raw = fs.readFileSync(filePath, "utf8");
  return parse(raw, {
    delimiter,
    columns: (header) => header.map((h) => h.trim()),
    skip_empty_lines: true,
    relax_column_count: true,
    trim: true,
  });
}

// Convierte varios formatos de fecha vistos en los CSVs a 'YYYY-MM-DD HH:mm:ss'
// para MySQL. Devuelve null si no matchea ningun formato conocido (ej. el
// valor basura "00:00.0" que aparece en algunas columnas de periodo).
function parseFlexibleDate(raw) {
  if (raw === null || raw === undefined) return null;
  const s = String(raw).trim();
  if (!s || s.toLowerCase() === "nan") return null;

  let m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?/);
  if (m) {
    const [, d, mo, y, h = "00", mi = "00", se = "00"] = m;
    return `${y}-${mo.padStart(2, "0")}-${d.padStart(2, "0")} ${h.padStart(2, "0")}:${mi}:${se}`;
  }

  m = s.match(/^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2}):(\d{2}))?/);
  if (m) {
    const [, y, mo, d, h = "00", mi = "00", se = "00"] = m;
    return `${y}-${mo}-${d} ${h}:${mi}:${se}`;
  }
  return null;
}

function num(raw, fallback = 0) {
  if (raw === null || raw === undefined || raw === "") return fallback;
  const n = parseFloat(String(raw).replace(/,/g, ""));
  return Number.isFinite(n) ? n : fallback;
}

function intOrNull(raw) {
  if (raw === null || raw === undefined || raw === "") return null;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) ? n : null;
}

function str(raw) {
  if (raw === null || raw === undefined) return null;
  const s = String(raw).trim();
  return s === "" ? null : s;
}

async function batchInsert(pool, table, columns, rows, batchSize = 800) {
  if (!rows.length) return 0;
  const placeholders = "(" + columns.map(() => "?").join(",") + ")";
  let inserted = 0;
  for (let i = 0; i < rows.length; i += batchSize) {
    const chunk = rows.slice(i, i + batchSize);
    const sql = `INSERT INTO ${table} (${columns.join(",")}) VALUES ${chunk.map(() => placeholders).join(",")}`;
    const values = chunk.flat();
    await pool.query(sql, values);
    inserted += chunk.length;
    process.stdout.write(`\r  ${table}: ${inserted}/${rows.length}`);
  }
  process.stdout.write("\n");
  return inserted;
}

module.exports = { readCsv, parseFlexibleDate, num, intOrNull, str, batchInsert };
