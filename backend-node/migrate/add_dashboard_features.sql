-- Migracion ADITIVA (no toca ni borra nada existente) para las funcionalidades
-- nuevas del dashboard: calificacion 1-5 del cliente y derivaciones a agentes.
-- A diferencia de schema.sql, este archivo NUNCA se corre con DROP TABLE --
-- se ejecuta aparte, una sola vez, con migrate/run_dashboard_features.js.

ALTER TABLE satisfaccion_log ADD COLUMN IF NOT EXISTS puntaje TINYINT NULL AFTER clasificacion;

CREATE TABLE IF NOT EXISTS derivaciones_asesor (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  cuenta VARCHAR(30),
  canal VARCHAR(20),
  telefono VARCHAR(20),
  agente_nombre VARCHAR(100),
  agente_area VARCHAR(100),
  contexto TEXT,
  creado_en DATETIME DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_cuenta (cuenta),
  INDEX idx_creado (creado_en)
);
