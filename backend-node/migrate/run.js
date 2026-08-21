require("dotenv").config({ path: require("path").join(__dirname, "..", ".env") });
const path = require("path");
const fs = require("fs");
const mysql = require("mysql2/promise");
const { readCsv, parseFlexibleDate, num, intOrNull, str, batchInsert } = require("./utils");

const CSV_DIR = process.env.CSV_DIR;

async function main() {
  const pool = await mysql.createPool({
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    port: process.env.DB_PORT || 3306,
    waitForConnections: true,
    connectionLimit: 5,
  });

  console.log("Aplicando esquema...");
  const schemaRaw = fs.readFileSync(path.join(__dirname, "schema.sql"), "utf8");
  const schemaSinComentarios = schemaRaw
    .split("\n")
    .filter((line) => !line.trim().startsWith("--"))
    .join("\n");
  const statements = schemaSinComentarios.split(";").map((s) => s.trim()).filter(Boolean);
  for (const stmt of statements) {
    await pool.query(stmt);
  }
  console.log("Esquema aplicado.\n");

  // ---------- PLANTA CLIENTES ----------
  {
    const rows = readCsv(path.join(CSV_DIR, "PLANTA CLIENTES.csv"), ";");
    const data = rows.map((r) => [
      str(r.COD_CLIENTE), str(r.FINANCIAL_ACCOUNT), str(r.NUM_ANEXO), str(r.telefono_hash),
      parseFlexibleDate(r.fecha_activacion_original), intOrNull(r.ciclo), str(r.lob_type), str(r.negocio),
    ]);
    await batchInsert(pool, "planta_clientes",
      ["cod_cliente", "financial_account", "num_anexo", "telefono_hash", "fecha_activacion", "ciclo", "lob_type", "negocio"],
      data);
  }

  // ---------- CATALOGO OFERTAS ----------
  {
    const rows = readCsv(path.join(CSV_DIR, "CATALOGO-OFERTAS.csv"), ";");
    const data = rows.map((r) => [str(r["CHARGE CODE"]), num(r.rate_final, null), str(r["TIPO DE RENTA"])]);
    await batchInsert(pool, "catalogo_ofertas", ["charge_code", "rate_final", "tipo_renta"], data);
  }

  // ---------- FACTURACION (la grande, 297k filas) ----------
  {
    const rows = readCsv(path.join(CSV_DIR, "FACTURACION-CLIENTES_.csv"), ";");
    const data = rows.map((r) => [
      str(r.FINANCIAL_ACCOUNT_KEY), str(r.CUSTOMER_KEY), str(r.BILLING_ARRANGEMENT_KEY),
      str(r.LEGAL_INVOICE_NUMBER), str(r.BILLING_CYCLE_KEY), num(r.CHARGE_NET_AMOUNT), num(r.CHARGE_TOTAL_AMOUNT),
      str(r.CHARGE_CODE_ID), str(r.CHARGE_CODE_DESC), str(r.CHARGE_CODE_CLASSIFICATION), str(r.SUBSCRIBER_KEY),
      parseFlexibleDate(r.PERIOD_START_DATE), parseFlexibleDate(r.PERIOD_END_DATE), intOrNull(r.ciclo),
      str(r.GRUPO), str(r.SUB_GRUPO), parseFlexibleDate(r["FECHA-VENCIMIENTO"]), str(r.DEUDA),
    ]);
    await batchInsert(pool, "facturacion",
      ["financial_account_key", "customer_key", "billing_arrangement_key", "legal_invoice_number",
        "billing_cycle_key", "charge_net_amount", "charge_total_amount", "charge_code_id", "charge_code_desc",
        "charge_code_classification", "subscriber_key", "period_start_date", "period_end_date", "ciclo",
        "grupo", "sub_grupo", "fecha_vencimiento", "deuda"],
      data);
  }

  // ---------- ORDENES ----------
  {
    const rows = readCsv(path.join(CSV_DIR, "Ordenes.csv"), ",");
    const data = rows.map((r) => [
      parseFlexibleDate(r.ORDER_ACTION_COMPLETION_DATE), parseFlexibleDate(r.ORDER_ACTION_START_DATE),
      str(r.CUSTOMER_KEY), str(r.SUBSCRIBER_KEY), str(r.ORDER_ACTION_REASON_DESC), str(r.ORDER_ACTION_REASON_ID),
      str(r.ORDER_ITEM_TYPE_DESC), str(r.ORDER_ACTION_STATUS_DESC), str(r.ORDER_ACTION_LAST_UPDATOR), str(r.ORDER_ACTION_CREATOR),
    ]);
    await batchInsert(pool, "ordenes",
      ["completion_date", "start_date", "customer_key", "subscriber_key", "reason_desc", "reason_id",
        "item_type_desc", "status_desc", "last_updator", "creator"],
      data);
  }

  // ---------- NOTAS CREDITO ----------
  {
    const rows = readCsv(path.join(CSV_DIR, "NOTAS_CREDITO.csv"), ",");
    const data = rows.map((r) => [
      str(r.RECEIVER_CUSTOMER), str(r.BA_NO), str(r.SERVICE_RECEIVER_ID), str(r.CHARGE_CODE),
      str(r.CANCEL_CHARGE_TYPE), parseFlexibleDate(r.EFFECTIVE_DATE), num(r.AMOUNT),
      parseFlexibleDate(r.PERIOD_START_DATE), parseFlexibleDate(r.PERIOD_END_DATE), str(r.CICLO),
    ]);
    await batchInsert(pool, "notas_credito",
      ["receiver_customer", "ba_no", "service_receiver_id", "charge_code", "cancel_charge_type",
        "effective_date", "amount", "period_start_date", "period_end_date", "ciclo"],
      data);
  }

  // ---------- BRAINY PRORRATEO ----------
  {
    const rows = readCsv(path.join(CSV_DIR, "BRAINY_PRORRATEO_ALTASV3.csv"), ";");
    const data = rows.map((r) => [
      str(r.BA), str(r.CuentaFinanciera), str(r.Numero), str(r.NumeroRecibo),
      parseFlexibleDate(r.Ciclica), parseFlexibleDate(r.fecha_inicio_minima), parseFlexibleDate(r.fecha_fin_maxima),
      num(r.suma_prorrateo), intOrNull(r.Q_cargos), str(r.tiponumero),
    ]);
    await batchInsert(pool, "brainy_prorrateo",
      ["ba", "cuenta_financiera", "numero", "numero_recibo", "ciclica", "fecha_inicio_minima",
        "fecha_fin_maxima", "suma_prorrateo", "q_cargos", "tiponumero"],
      data);
  }

  // ---------- BRAINY RECONEXIONES ----------
  {
    const rows = readCsv(path.join(CSV_DIR, "BRAINY_RECONEXIONESV3.csv"), ";");
    const data = rows.map((r) => [
      str(r.BA), str(r.CuentaFinanciera), str(r.Numero), str(r.Codigo), str(r.NumeroRecibo),
      str(r.Descripcion), parseFlexibleDate(r.FechaReconexion), num(r.Monto),
      parseFlexibleDate(r.Ciclica), parseFlexibleDate(r.FechaCorte),
    ]);
    await batchInsert(pool, "brainy_reconexiones",
      ["ba", "cuenta_financiera", "numero", "codigo", "numero_recibo", "descripcion",
        "fecha_reconexion", "monto", "ciclica", "fecha_corte"],
      data);
  }

  // ---------- BRAINY DESCUENTOS CUOTAS ----------
  {
    const rows = readCsv(path.join(CSV_DIR, "BRAINY_DESCUENTOS_CUOTAS.csv"), ",");
    const data = rows.map((r) => [
      str(r.TipoProceso), str(r.FlagFactura), str(r.TipoRenta), str(r.BillingArrangement),
      parseFlexibleDate(r.Ciclo), str(r.Telefono), parseFlexibleDate(r.FechaInicio),
      intOrNull(r.PromotionDuration), num(r.PorcentajePromo, null), str(r.chargecode),
      parseFlexibleDate(r.FechaFin), intOrNull(r.DiasVencidos), intOrNull(r.DiasAdelantados),
      intOrNull(r.flag_inicio_ciclica), intOrNull(r.CuotaActual), str(r.Traduccion), str(r.Descripcion),
      intOrNull(r.flag_descuento_completo), str(r.tipo_descuento), str(r.cuentafinanciera),
      num(r.Monto_Descuento), str(r.tiponumero), str(r.tipodoc), str(r.numerodocumento),
    ]);
    await batchInsert(pool, "brainy_descuentos_cuotas",
      ["tipo_proceso", "flag_factura", "tipo_renta", "billing_arrangement", "ciclo", "telefono",
        "fecha_inicio", "promotion_duration", "porcentaje_promo", "chargecode", "fecha_fin",
        "dias_vencidos", "dias_adelantados", "flag_inicio_ciclica", "cuota_actual", "traduccion",
        "descripcion", "flag_descuento_completo", "tipo_descuento", "cuentafinanciera",
        "monto_descuento", "tiponumero", "tipodoc", "numerodocumento"],
      data);
  }

  console.log("\n✅ Migración completa.");
  await pool.end();
}

main().catch((e) => {
  console.error("ERROR EN MIGRACION:", e);
  process.exit(1);
});
