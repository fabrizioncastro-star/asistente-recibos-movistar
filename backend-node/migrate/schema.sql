-- Esquema para el Asistente de Explicacion de Recibos (Desafio 1)
-- Refleja 1 a 1 los 8 datasets originales; las llaves de cruce (cuenta,
-- recibo, subscriber/anexo) quedan indexadas para que las consultas del
-- chat respondan al instante.

DROP TABLE IF EXISTS planta_clientes;
CREATE TABLE planta_clientes (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  cod_cliente VARCHAR(30) NOT NULL,
  financial_account VARCHAR(30) NOT NULL,
  num_anexo VARCHAR(30) NOT NULL,
  telefono_hash VARCHAR(80),
  fecha_activacion DATETIME NULL,
  ciclo INT NULL,
  lob_type VARCHAR(20),
  negocio VARCHAR(30),
  INDEX idx_financial_account (financial_account),
  INDEX idx_cod_cliente (cod_cliente)
);

DROP TABLE IF EXISTS facturacion;
CREATE TABLE facturacion (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  financial_account_key VARCHAR(30) NOT NULL,
  customer_key VARCHAR(30) NOT NULL,
  billing_arrangement_key VARCHAR(30),
  legal_invoice_number VARCHAR(40) NOT NULL,
  billing_cycle_key VARCHAR(10),
  charge_net_amount DECIMAL(14,2) DEFAULT 0,
  charge_total_amount DECIMAL(14,2) DEFAULT 0,
  charge_code_id VARCHAR(40),
  charge_code_desc VARCHAR(200),
  charge_code_classification VARCHAR(150),
  subscriber_key VARCHAR(30),
  period_start_date DATETIME NULL,
  period_end_date DATETIME NULL,
  ciclo INT,
  grupo VARCHAR(150),
  sub_grupo VARCHAR(150),
  fecha_vencimiento DATETIME NULL,
  deuda VARCHAR(20),
  INDEX idx_account (financial_account_key),
  INDEX idx_invoice (legal_invoice_number),
  INDEX idx_subscriber (subscriber_key),
  INDEX idx_account_invoice (financial_account_key, legal_invoice_number),
  INDEX idx_charge_code (charge_code_id)
);

DROP TABLE IF EXISTS catalogo_ofertas;
CREATE TABLE catalogo_ofertas (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  charge_code VARCHAR(40) NOT NULL,
  rate_final DECIMAL(14,2),
  tipo_renta VARCHAR(50),
  INDEX idx_charge_code (charge_code)
);

DROP TABLE IF EXISTS ordenes;
CREATE TABLE ordenes (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  completion_date DATETIME NULL,
  start_date DATETIME NULL,
  customer_key VARCHAR(30),
  subscriber_key VARCHAR(30),
  reason_desc VARCHAR(200),
  reason_id VARCHAR(50),
  item_type_desc VARCHAR(100),
  status_desc VARCHAR(100),
  last_updator VARCHAR(100),
  creator VARCHAR(100),
  INDEX idx_customer (customer_key),
  INDEX idx_subscriber (subscriber_key)
);

DROP TABLE IF EXISTS notas_credito;
CREATE TABLE notas_credito (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  receiver_customer VARCHAR(30),
  ba_no VARCHAR(30),
  service_receiver_id VARCHAR(30),
  charge_code VARCHAR(40),
  cancel_charge_type VARCHAR(10),
  effective_date DATETIME NULL,
  amount DECIMAL(14,4),
  period_start_date DATETIME NULL,
  period_end_date DATETIME NULL,
  ciclo VARCHAR(15),
  INDEX idx_ba (ba_no),
  INDEX idx_service_receiver (service_receiver_id)
);

DROP TABLE IF EXISTS brainy_prorrateo;
CREATE TABLE brainy_prorrateo (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  ba VARCHAR(30),
  cuenta_financiera VARCHAR(30),
  numero VARCHAR(30),
  numero_recibo VARCHAR(40) NOT NULL,
  ciclica DATE NULL,
  fecha_inicio_minima DATETIME NULL,
  fecha_fin_maxima DATETIME NULL,
  suma_prorrateo DECIMAL(14,2),
  q_cargos INT,
  tiponumero VARCHAR(5),
  INDEX idx_recibo (numero_recibo),
  INDEX idx_cuenta (cuenta_financiera)
);

DROP TABLE IF EXISTS brainy_reconexiones;
CREATE TABLE brainy_reconexiones (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  ba VARCHAR(30),
  cuenta_financiera VARCHAR(30),
  numero VARCHAR(30),
  codigo VARCHAR(50),
  numero_recibo VARCHAR(40) NOT NULL,
  descripcion VARCHAR(200),
  fecha_reconexion DATETIME NULL,
  monto DECIMAL(14,2),
  ciclica DATE NULL,
  fecha_corte DATETIME NULL,
  INDEX idx_recibo (numero_recibo),
  INDEX idx_cuenta (cuenta_financiera)
);

DROP TABLE IF EXISTS brainy_descuentos_cuotas;
CREATE TABLE brainy_descuentos_cuotas (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  tipo_proceso VARCHAR(10),
  flag_factura VARCHAR(5),
  tipo_renta VARCHAR(5),
  billing_arrangement VARCHAR(30),
  ciclo DATE NULL,
  telefono VARCHAR(30),
  fecha_inicio DATETIME NULL,
  promotion_duration INT,
  porcentaje_promo DECIMAL(6,2),
  chargecode VARCHAR(40),
  fecha_fin DATETIME NULL,
  dias_vencidos INT,
  dias_adelantados INT,
  flag_inicio_ciclica INT,
  cuota_actual INT,
  traduccion VARCHAR(2000),
  descripcion VARCHAR(2000),
  flag_descuento_completo INT,
  tipo_descuento VARCHAR(20),
  cuentafinanciera VARCHAR(30),
  monto_descuento DECIMAL(14,2),
  tiponumero VARCHAR(5),
  tipodoc VARCHAR(10),
  numerodocumento VARCHAR(30),
  INDEX idx_cuenta (cuentafinanciera)
);

-- Tabla de seguimiento de satisfaccion / "tasa de silencio post-explicacion"
-- (pedido textual de la ficha del Desafio 1). No se recrea en cada
-- migracion completa para no perder el historial acumulado.
CREATE TABLE IF NOT EXISTS satisfaccion_log (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  cuenta VARCHAR(30),
  canal VARCHAR(20),
  clasificacion VARCHAR(20),
  detalle VARCHAR(255),
  creado_en DATETIME DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_clasificacion (clasificacion)
);
