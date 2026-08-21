require("dotenv").config({ path: require("path").join(__dirname, "..", ".env") });
const path = require("path");
const express = require("express");
const cors = require("cors");
const rateLimit = require("express-rate-limit");

const engine = require("./engine");
const assistant = require("./assistant");
const nlg = require("./nlg");
const whatsapp = require("./whatsapp");

const app = express();

// Guardamos el body crudo (rawBody) en cada request: lo necesita
// whatsapp.js para verificar la firma X-Hub-Signature-256 de Meta.
app.use(express.json({ verify: (req, res, buf) => { req.rawBody = buf; } }));

// CORS restringido a nuestro propio dominio (el frontend se sirve desde el
// mismo origen, asi que esto solo bloquea a terceros llamando la API desde
// otro sitio -- no afecta a nuestra propia app).
const ORIGENES_PERMITIDOS = [
  "https://chocolate-oryx-165743.hostingersite.com",
  "http://localhost:8000",
];
app.use(cors({
  origin: (origin, callback) => {
    if (!origin || ORIGENES_PERMITIDOS.includes(origin)) return callback(null, true);
    return callback(new Error("Origen no permitido por CORS"));
  },
}));

// Limite de peticiones: el general protege la DB, el de chat protege el
// costo de las llamadas a Claude (y al webhook de WhatsApp, mismo motivo).
const limiteGeneral = rateLimit({ windowMs: 60_000, max: 60, standardHeaders: true, legacyHeaders: false });
const limiteChat = rateLimit({ windowMs: 60_000, max: 20, standardHeaders: true, legacyHeaders: false });
app.use("/api/", limiteGeneral);
app.use("/api/chat", limiteChat);
app.use("/api/whatsapp/webhook", limiteChat);

app.use("/api/whatsapp", whatsapp.router);
whatsapp.iniciarMonitorInactividad();

app.get("/api/health", (req, res) => res.json({ status: "ok" }));

app.get("/api/casos-demo", async (req, res) => {
  const casos = await engine.buscarCasosDemo();
  res.json(casos);
});

app.get("/api/identificar/:cuenta", async (req, res) => {
  const lineas = await engine.buscarCuenta(req.params.cuenta);
  if (!lineas) {
    return res.status(404).json({ detail: "No encontramos esa cuenta. Verifica el número e intenta de nuevo." });
  }
  res.json({ cuenta: req.params.cuenta, lineas });
});

app.get("/api/recibo/:cuenta", async (req, res) => {
  const { numero, linea } = req.query;
  const diag = await engine.diagnosticar(req.params.cuenta, numero || null, linea || null);
  if (!diag.encontrado) {
    return res.status(404).json({ detail: diag.error });
  }
  res.json({
    cuenta: diag.cuenta,
    recibo_actual: diag.recibo_actual,
    recibo_previo: diag.recibo_previo,
    total_actual: diag.total_actual,
    total_previo: diag.total_previo,
    monto_habitual: diag.monto_habitual,
    diferencia: diag.diferencia,
    historial: diag.historial,
    causas: diag.causas,
    explicacion: nlg.explicarVariacion(diag),
  });
});

app.post("/api/chat", async (req, res) => {
  const { cuenta, mensaje, recibo, linea, historial } = req.body;
  const resp = await assistant.responder(cuenta, mensaje, recibo || null, linea || null, Array.isArray(historial) ? historial : [], "web");
  res.json(resp);
});

// Metricas de la "tasa de silencio post-explicacion" pedida por la ficha.
app.get("/api/metricas/satisfaccion", async (req, res) => {
  res.json(await engine.metricasSatisfaccion());
});

const FRONTEND_DIR = path.join(__dirname, "..", "public");
app.use(express.static(FRONTEND_DIR));

if (!process.env.META_APP_SECRET) {
  console.warn(
    "⚠️  META_APP_SECRET no configurado: el webhook de WhatsApp NO está verificando " +
    "que los mensajes vengan realmente de Meta. Agrega META_APP_SECRET al .env cuanto antes."
  );
}

const PORT = process.env.PORT || 8000;
app.listen(PORT, () => console.log(`Servidor listo en puerto ${PORT}`));
