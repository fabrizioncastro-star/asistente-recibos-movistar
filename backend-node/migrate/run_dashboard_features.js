// Corre SOLO la migracion aditiva de dashboard (add_dashboard_features.sql).
// A diferencia de run.js (que aplica schema.sql completo con DROP TABLE y
// vuelve a cargar los CSV), este script no borra ni reinserta nada -- es
// seguro correrlo contra la base de datos real en cualquier momento.
require("dotenv").config({ path: require("path").join(__dirname, "..", ".env") });
const path = require("path");
const fs = require("fs");
const mysql = require("mysql2/promise");

async function main() {
  const pool = await mysql.createPool({
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    port: process.env.DB_PORT || 3306,
    waitForConnections: true,
    connectionLimit: 3,
  });

  const raw = fs.readFileSync(path.join(__dirname, "add_dashboard_features.sql"), "utf8");
  const sinComentarios = raw.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n");
  const statements = sinComentarios.split(";").map((s) => s.trim()).filter(Boolean);

  for (const stmt of statements) {
    console.log("Ejecutando:", stmt.slice(0, 80).replace(/\s+/g, " ") + "...");
    await pool.query(stmt);
  }

  console.log("\n✅ Migración de dashboard aplicada (aditiva, nada se borró).");
  await pool.end();
}

main().catch((e) => {
  console.error("ERROR EN MIGRACION DE DASHBOARD:", e);
  process.exit(1);
});
