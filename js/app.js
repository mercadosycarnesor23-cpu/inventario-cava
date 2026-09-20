/* ==========================================================================
   Inventario Cava - version en la nube (Supabase)
   Misma app que la version local, pero los datos viven en Supabase en vez de
   en un servidor propio, para que se pueda entrar desde cualquier lugar.
   ========================================================================== */

const MOTIVOS = ["Merma / daño", "Consumo interno", "Error de conteo", "Robo / pérdida", "Ajuste", "Otro"];
const MOTIVOS_CORRECCION = ["Error de edición", "Código incorrecto", "Peso/kilaje incorrecto", "Otro"];
const TOLERANCIA = 0.01;

const sb = window.supabase.createClient(window.SUPABASE_URL, window.SUPABASE_ANON_KEY);

let productos = [];
let productosPorId = {};
let estado = [];
let editandoProductoId = null;

/* ---------- utilidades ---------- */

function todayISO() {
  const d = new Date();
  const tz = d.getTimezoneOffset() * 60000;
  return new Date(d.getTime() - tz).toISOString().slice(0, 10);
}

function horaActual() {
  const d = new Date();
  return String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0");
}

function fechaTrabajo() {
  return document.getElementById("fechaTrabajo").value || todayISO();
}

function fmt(n, unidad) {
  if (n === null || n === undefined) return "—";
  const num = Number(n);
  const texto = unidad === "UND" ? num.toLocaleString("es-CO", { maximumFractionDigits: 0 })
                                  : num.toLocaleString("es-CO", { maximumFractionDigits: 2 });
  return texto + " " + (unidad || "");
}

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function toast(msg, isError) {
  const el = document.getElementById("toast");
  el.textContent = msg;
  el.hidden = false;
  el.classList.toggle("error", !!isError);
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { el.hidden = true; }, 3200);
}

function throwIfError(error) {
  if (error) throw new Error(error.message || "Error de Supabase");
}

/* ---------- puerta de acceso (clave simple, no es seguridad real) ----------
   Dos claves: una de edicion ("editar") y una de solo consulta ("ver"). El
   rol se guarda en sessionStorage y se usa para ocultar los controles de
   guardar/editar/eliminar y para bloquear esas acciones a nivel de datos. */

function rolActual() {
  return sessionStorage.getItem("inv_rol") || "";
}
function esSoloLectura() {
  return rolActual() === "ver";
}
function aplicarRolEnPantalla() {
  document.body.classList.toggle("rol-ver", esSoloLectura());
  const badge = document.getElementById("badgeSoloLectura");
  if (badge) badge.hidden = !esSoloLectura();
}
function abrirCompuerta() {
  const ok = !!rolActual();
  document.getElementById("gateOverlay").hidden = ok;
  aplicarRolEnPantalla();
}
document.getElementById("gateEntrar").addEventListener("click", intentarEntrar);
document.getElementById("gatePassword").addEventListener("keydown", (e) => { if (e.key === "Enter") intentarEntrar(); });
function intentarEntrar() {
  const val = document.getElementById("gatePassword").value;
  if (val === window.APP_PASSWORD) {
    sessionStorage.setItem("inv_rol", "editar");
  } else if (val === window.APP_PASSWORD_VIEW) {
    sessionStorage.setItem("inv_rol", "ver");
  } else {
    document.getElementById("gateError").hidden = false;
    return;
  }
  document.getElementById("gateError").hidden = true;
  document.getElementById("gateOverlay").hidden = true;
  aplicarRolEnPantalla();
}
abrirCompuerta();

/* ---------- modal generico ---------- */

function abrirModal(titulo, bodyHtml, { textoConfirmar = "Guardar", onConfirm = null, textoCancelar = "Cancelar", ocultarCancelar = false } = {}) {
  document.getElementById("modalTitulo").textContent = titulo;
  document.getElementById("modalBody").innerHTML = bodyHtml;
  document.getElementById("modalConfirmar").textContent = textoConfirmar;
  document.getElementById("modalCancelar").textContent = textoCancelar;
  document.getElementById("modalCancelar").hidden = ocultarCancelar;
  document.getElementById("modalOverlay").hidden = false;
  document.getElementById("modalConfirmar").onclick = () => { if (onConfirm) onConfirm(); };
}
function cerrarModal() { document.getElementById("modalOverlay").hidden = true; }
document.getElementById("modalCancelar").addEventListener("click", cerrarModal);
document.getElementById("modalOverlay").addEventListener("click", (e) => { if (e.target.id === "modalOverlay") cerrarModal(); });

/* ==========================================================================
   TABS
   ========================================================================== */

function actualizarTabActualLabel(btn) {
  document.getElementById("tabActualLabel").textContent = btn.textContent.trim();
}
document.getElementById("tabs").addEventListener("click", (e) => {
  const btn = e.target.closest(".tab-btn");
  if (!btn) return;
  document.querySelectorAll(".tab-btn").forEach(b => b.classList.remove("active"));
  document.querySelectorAll(".tab-panel").forEach(p => p.classList.remove("active"));
  btn.classList.add("active");
  document.getElementById("tab-" + btn.dataset.tab).classList.add("active");
  actualizarTabActualLabel(btn);
  cerrarMenu();
  refrescarTodo();
});
actualizarTabActualLabel(document.querySelector(".tab-btn.active"));
document.getElementById("fechaTrabajo").addEventListener("change", refrescarTodo);

/* Menu hamburguesa (solo se ve en pantallas chicas, ver css) */
function cerrarMenu() {
  document.getElementById("tabs").classList.remove("open");
  document.getElementById("menuToggle").setAttribute("aria-expanded", "false");
}
document.getElementById("menuToggle").addEventListener("click", () => {
  const abierto = document.getElementById("tabs").classList.toggle("open");
  document.getElementById("menuToggle").setAttribute("aria-expanded", abierto ? "true" : "false");
});

/* ==========================================================================
   CAPA DE DATOS (Supabase)
   ========================================================================== */

function mapProducto(row) {
  return { id: row.id, codigo: row.codigo, nombre: row.nombre, unidad: row.unidad };
}
function mapInventario(row) {
  return {
    tipo: "inventario", id: row.id, productoId: row.producto_id, fecha: row.fecha, hora: row.hora,
    modo: row.modo, valor: Number(row.valor), notas: row.notas, creadoEn: row.creado_en,
    pesoBruto: row.peso_bruto === null || row.peso_bruto === undefined ? null : Number(row.peso_bruto),
    numCanastas: row.num_canastas === null || row.num_canastas === undefined ? null : Number(row.num_canastas),
  };
}
function mapDespacho(row) {
  return {
    tipo: "despacho", id: row.id, productoId: row.producto_id, fecha: row.fecha, hora: row.hora,
    disponibleAntes: Number(row.disponible_antes), bello: Number(row.bello), colores: Number(row.colores),
    puntosExpres: Number(row.puntos_expres), totalDespachado: Number(row.total_despachado),
    queda: Number(row.queda), notas: row.notas, creadoEn: row.creado_en,
  };
}
function mapDiferencia(row) {
  return {
    id: row.id, productoId: row.producto_id, fecha: row.fecha,
    valorEsperado: Number(row.valor_esperado), valorReal: Number(row.valor_real),
    diferencia: Number(row.diferencia), motivo: row.motivo, nota: row.nota, creadoEn: row.creado_en,
  };
}
function mapCorreccion(row) {
  return {
    id: row.id, tipo: row.tipo, productoId: row.producto_id, fecha: row.fecha,
    valorAnterior: row.valor_anterior === null ? null : Number(row.valor_anterior),
    valorNuevo: row.valor_nuevo === null ? null : Number(row.valor_nuevo),
    motivo: row.motivo, nota: row.nota, creadoEn: row.creado_en,
  };
}

async function fetchStockRow(productoId) {
  const { data, error } = await sb.from("stock").select("*").eq("producto_id", productoId).maybeSingle();
  throwIfError(error);
  return data;
}

async function upsertStock(productoId, valor, fecha, origen) {
  const { error } = await sb.from("stock").upsert({
    producto_id: productoId, valor, fecha, origen, actualizado_en: new Date().toISOString(),
  });
  throwIfError(error);
}

async function movimientosDeProducto(productoId) {
  const [{ data: invs, error: e1 }, { data: desps, error: e2 }] = await Promise.all([
    sb.from("inventarios").select("*").eq("producto_id", productoId),
    sb.from("despachos").select("*").eq("producto_id", productoId),
  ]);
  throwIfError(e1); throwIfError(e2);
  const items = [
    ...(invs || []).map(r => ({ id: r.id, tipo: "inventario", valor: Number(r.valor), fecha: r.fecha, creadoEn: r.creado_en })),
    ...(desps || []).map(r => ({ id: r.id, tipo: "despacho", valor: Number(r.queda), fecha: r.fecha, creadoEn: r.creado_en })),
  ];
  items.sort((a, b) => a.creadoEn.localeCompare(b.creadoEn));
  return items;
}

async function ultimoMovimientoDeProducto(productoId) {
  const items = await movimientosDeProducto(productoId);
  return items.length ? items[items.length - 1] : null;
}

async function registrarCorreccion({ tipo, productoId, fecha, valorAnterior, valorNuevo, motivo, nota, inventarioId }) {
  const { error } = await sb.from("correcciones").insert({
    tipo, producto_id: productoId, fecha, valor_anterior: valorAnterior, valor_nuevo: valorNuevo,
    motivo: motivo || null, nota: nota || null, inventario_id: inventarioId || null,
  });
  throwIfError(error);
}

/* ==========================================================================
   CARGA DE DATOS
   ========================================================================== */

async function cargarProductos() {
  const { data, error } = await sb.from("productos").select("*").order("nombre");
  throwIfError(error);
  productos = (data || []).map(mapProducto);
  productosPorId = {};
  productos.forEach(p => { productosPorId[p.id] = p; });
}

async function cargarEstado() {
  const fecha = fechaTrabajo();
  const [{ data: stockRows, error: e1 }, { data: invHoy, error: e2 }, { data: despHoy, error: e3 }, { data: sugHoy, error: e4 }] = await Promise.all([
    sb.from("stock").select("*"),
    sb.from("inventarios").select("*").eq("fecha", fecha),
    sb.from("despachos").select("*").eq("fecha", fecha),
    sb.from("sugeridos").select("*").eq("fecha", fecha),
  ]);
  throwIfError(e1); throwIfError(e2); throwIfError(e3); throwIfError(e4);

  const stockPorProd = {};
  (stockRows || []).forEach(r => { stockPorProd[r.producto_id] = r; });

  const invPorProd = {};
  (invHoy || []).map(mapInventario).forEach(r => { invPorProd[r.productoId] = r; }); // un solo registro por producto y fecha

  const despPorProd = {};
  (despHoy || []).map(mapDespacho).forEach(r => {
    if (!despPorProd[r.productoId]) despPorProd[r.productoId] = { total: 0, bello: 0, colores: 0, expres: 0 };
    despPorProd[r.productoId].total += r.totalDespachado;
    despPorProd[r.productoId].bello += r.bello;
    despPorProd[r.productoId].colores += r.colores;
    despPorProd[r.productoId].expres += r.puntosExpres;
  });

  const sugPorProd = {};
  (sugHoy || []).forEach(r => { sugPorProd[r.producto_id] = r; });

  estado = productos.map(p => {
    const s = stockPorProd[p.id];
    const inv = invPorProd[p.id];
    const d = despPorProd[p.id] || { total: 0, bello: 0, colores: 0, expres: 0 };
    const sug = sugPorProd[p.id];
    return {
      id: p.id, codigo: p.codigo, nombre: p.nombre, unidad: p.unidad,
      stockActual: s ? Number(s.valor) : null, stockFecha: s ? s.fecha : null, stockOrigen: s ? s.origen : null,
      inventarioId: inv ? inv.id : null, inventariadoHoy: !!inv,
      inventarioHoyValor: inv ? inv.valor : null, inventarioHoyNotas: inv ? inv.notas : null,
      inventarioHoyHora: inv ? inv.hora : null,
      inventarioHoyPesoBruto: inv ? inv.pesoBruto : null,
      inventarioHoyNumCanastas: inv ? inv.numCanastas : null,
      despachadoHoyTotal: d.total, despachadoHoyBello: d.bello, despachadoHoyColores: d.colores, despachadoHoyExpres: d.expres,
      sugeridoBello: sug ? Number(sug.bello) : 0, sugeridoColores: sug ? Number(sug.colores) : 0, sugeridoExpres: sug ? Number(sug.puntos_expres) : 0,
      tieneSugerido: !!sug,
    };
  });
}

async function refrescarTodo() {
  try {
    await cargarProductos();
    await cargarEstado();
    renderInventarioHoy();
    await renderDespachoHoy();
    renderTablaProductos();
    try {
      await cargarPlatano();
      renderPlatano();
    } catch (errPlatano) {
      // No bloquea el resto de la app si todavia no existen las tablas de platano
      // (por ejemplo, antes de correr migration_v4.sql en Supabase).
    }
    await renderHistorial();
    await renderDiferencias();
    await renderCorrecciones();
    await renderResumen();
  } catch (err) {
    toast(err.message || "Error cargando datos", true);
  }
}

/* ==========================================================================
   BUSCADOR CON SUGERENCIAS (compartido por Inventario y Despacho)
   ========================================================================== */

function buscarProductosPorTexto(texto, limite = 8) {
  if (!texto) return [];
  texto = texto.toLowerCase();
  return productos
    .filter(p => p.codigo.toLowerCase().includes(texto) || p.nombre.toLowerCase().includes(texto))
    .slice(0, limite);
}

function wireAutocomplete(inputId, dropdownId, onSelect) {
  const input = document.getElementById(inputId);
  const dropdown = document.getElementById(dropdownId);
  input.addEventListener("input", () => {
    const texto = input.value.trim();
    if (!texto) { dropdown.hidden = true; return; }
    const resultados = buscarProductosPorTexto(texto);
    dropdown.innerHTML = resultados.map(p => `
      <div class="dropdown-item" data-id="${p.id}">
        <span>${escapeHtml(p.nombre)}</span>
        <span class="codigo">${escapeHtml(p.codigo)} · ${p.unidad}</span>
      </div>
    `).join("") || `<div class="dropdown-empty">Sin resultados</div>`;
    dropdown.hidden = false;
    dropdown.querySelectorAll("[data-id]").forEach(el => {
      el.addEventListener("click", () => {
        dropdown.hidden = true;
        input.value = "";
        onSelect(el.dataset.id);
      });
    });
  });
  document.addEventListener("click", (e) => {
    if (e.target !== input && !dropdown.contains(e.target)) dropdown.hidden = true;
  });
}

/* ==========================================================================
   INVENTARIO
   ========================================================================== */

function renderInventarioHoy() {
  const tbody = document.getElementById("tablaInventarioHoy");
  const filas = estado.filter(it => it.inventariadoHoy);
  tbody.innerHTML = filas.map(it => `
    <tr>
      <td>${escapeHtml(it.codigo)}</td>
      <td>${escapeHtml(it.nombre)}</td>
      <td>${fmt(it.inventarioHoyValor, it.unidad)}</td>
      <td>${escapeHtml(it.inventarioHoyNotas || "-")}</td>
      <td>
        <button class="btn-icon" data-editar-inv="${it.id}">Editar</button>
        <button class="btn-icon danger" data-quitar-inv="${it.inventarioId}">Quitar</button>
      </td>
    </tr>
  `).join("") || `<tr class="empty-row"><td colspan="5">Todavía no has agregado productos al inventario de hoy.</td></tr>`;

  tbody.querySelectorAll("[data-editar-inv]").forEach(b => b.addEventListener("click", () => seleccionarProductoInventario(b.dataset.editarInv, true)));
  tbody.querySelectorAll("[data-quitar-inv]").forEach(b => b.addEventListener("click", () => quitarInventario(b.dataset.quitarInv)));
}

/* Copiar el inventario de hoy al portapapeles en columnas separadas por tabulador,
   en el mismo orden de Libro1.xlsx: Peso bruto, Canastas 2.2, (C,D,E vacías),
   Codigo, producto, Peso neto, Destino, Salida, Fecha, Hora. Al pegarlo con Ctrl+V
   en Excel cada valor cae en su propia columna. */
function numExcel(n) {
  if (n === null || n === undefined) return "";
  return String(Math.round(Number(n) * 100) / 100);
}
function fechaExcel(iso) {
  if (!iso) return "";
  const [y, m, d] = iso.split("-");
  return `${d}/${m}/${y}`;
}
async function copiarInventarioParaExcel() {
  const filas = estado.filter(it => it.inventariadoHoy);
  if (filas.length === 0) { toast("No hay productos en el inventario de hoy todavía", true); return; }
  const fechaTexto = fechaExcel(fechaTrabajo());
  const lineas = filas.map(it => {
    const esKg = it.unidad === "KG";
    const bruto = esKg ? numExcel(it.inventarioHoyPesoBruto !== null ? it.inventarioHoyPesoBruto : it.inventarioHoyValor) : "";
    const canastas = esKg ? numExcel(it.inventarioHoyNumCanastas !== null ? it.inventarioHoyNumCanastas : 0) : "";
    const columnas = [
      bruto, canastas, "", "", "",
      it.codigo, it.nombre, numExcel(it.inventarioHoyValor),
      "INVENTARIO", "1", fechaTexto, it.inventarioHoyHora || "",
    ];
    return columnas.join("\t");
  });
  const texto = lineas.join("\n");
  try {
    await navigator.clipboard.writeText(texto);
    toast(`Copiado: ${filas.length} producto(s). Pégalo con Ctrl+V en tu Excel.`);
  } catch (err) {
    toast("No se pudo copiar automáticamente (revisa permisos del navegador)", true);
  }
}
document.getElementById("btnCopiarExcel").addEventListener("click", copiarInventarioParaExcel);

/* Modal generico para pedir un motivo al editar o eliminar un conteo de un dia anterior. */
function abrirModalMotivoCorreccion(titulo, mensajeExtra, onConfirmar) {
  const bodyHtml = `
    <div class="modal-body-grid">
      <div class="alerta-box">${mensajeExtra}</div>
      <label>Motivo
        <select id="motivoCorreccionSelect">${MOTIVOS_CORRECCION.map(m => `<option value="${escapeHtml(m)}">${escapeHtml(m)}</option>`).join("")}</select>
      </label>
      <label>Nota (opcional)
        <input type="text" id="motivoCorreccionNota" placeholder="Detalle adicional...">
      </label>
    </div>
  `;
  abrirModal(titulo, bodyHtml, {
    textoConfirmar: "Confirmar",
    onConfirm: () => {
      const motivo = document.getElementById("motivoCorreccionSelect").value;
      const nota = document.getElementById("motivoCorreccionNota").value.trim();
      onConfirmar(motivo, nota);
    },
  });
}

// Guarda el conteo de inventario. Devuelve { requiereMotivo } si el conteo no
// coincide con el stock esperado, o { requiereMotivoEdicion } si el registro
// que se esta tocando es de un dia anterior al de hoy (real), en vez de guardar
// directamente -- asi la UI pide el motivo antes de continuar.
async function guardarInventario(p, cuerpo) {
  if (esSoloLectura()) throw new Error("Estás en modo solo lectura, no puedes guardar cambios.");
  const numCanastas = Number(cuerpo.numCanastas) || 0;
  const pesoCanasta = Number(cuerpo.pesoCanasta) > 0 ? Number(cuerpo.pesoCanasta) : 2.2;
  const valorIngresado = Number(cuerpo.valor) || 0;
  let modo = "neto";
  let valorEntrada = valorIngresado;
  if (p.unidad === "UND") {
    modo = "unidad";
  } else if (numCanastas > 0) {
    modo = "bruto";
    valorEntrada = valorIngresado - (numCanastas * pesoCanasta);
  }
  if (valorEntrada < 0) throw new Error("El valor calculado es negativo, revisa canastas/peso");

  const { data: existentesHoy, error: eExist } = await sb.from("inventarios").select("*")
    .eq("producto_id", p.id).eq("fecha", cuerpo.fecha);
  throwIfError(eExist);
  const existenteHoy = (existentesHoy && existentesHoy.length > 0) ? existentesHoy[0] : null;
  const acumular = !!cuerpo.acumular && !!existenteHoy;

  const hoyReal = todayISO();
  const esEdicionDiaAnterior = !!existenteHoy && existenteHoy.fecha !== hoyReal;
  if (esEdicionDiaAnterior && !cuerpo.motivoEdicion) {
    return { requiereMotivoEdicion: true, fecha: existenteHoy.fecha, valorActual: Number(existenteHoy.valor), unidad: p.unidad };
  }

  const stockRow = await fetchStockRow(p.id);
  const anterior = stockRow ? Number(stockRow.valor) : null;

  let valor;
  if (acumular) {
    valor = Number(existenteHoy.valor) + valorEntrada;
  } else {
    valor = valorEntrada;
    if (anterior !== null && Math.abs(valor - anterior) > TOLERANCIA && !cuerpo.motivo) {
      return { requiereMotivo: true, valorEsperado: anterior, valorNuevo: valor, unidad: p.unidad };
    }
  }

  let invRow;
  if (existenteHoy) {
    const patch = { valor, hora: horaActual() };
    if (acumular) {
      patch.modo = modo;
      if (modo === "bruto") {
        const prevBruto = Number(existenteHoy.peso_bruto) || 0;
        const prevCanastas = Number(existenteHoy.num_canastas) || 0;
        patch.peso_bruto = prevBruto + valorIngresado;
        patch.num_canastas = prevCanastas + numCanastas;
        patch.peso_canasta = pesoCanasta;
      } else {
        patch.peso_bruto = null; patch.num_canastas = null; patch.peso_canasta = null;
      }
      const notaNueva = (cuerpo.notas || "").trim();
      const notaPrevia = (existenteHoy.notas || "").trim();
      patch.notas = notaNueva && notaPrevia ? `${notaPrevia}; ${notaNueva}` : (notaNueva || notaPrevia || null);
    } else {
      patch.modo = modo;
      patch.peso_bruto = modo === "bruto" ? valorIngresado : null;
      patch.num_canastas = modo === "bruto" ? numCanastas : null;
      patch.peso_canasta = modo === "bruto" ? pesoCanasta : null;
      patch.notas = cuerpo.notas || null;
    }
    const { data, error } = await sb.from("inventarios").update(patch).eq("id", existenteHoy.id).select().single();
    throwIfError(error);
    invRow = data;
    await sb.from("diferencias").delete().eq("inventario_id", invRow.id);
  } else {
    const { data, error } = await sb.from("inventarios").insert({
      producto_id: p.id, fecha: cuerpo.fecha, hora: horaActual(), modo,
      peso_bruto: modo === "bruto" ? valorIngresado : null,
      num_canastas: modo === "bruto" ? numCanastas : null,
      peso_canasta: modo === "bruto" ? pesoCanasta : null,
      valor, notas: cuerpo.notas || null,
    }).select().single();
    throwIfError(error);
    invRow = data;
  }

  let diferencia = null;
  if (!acumular && anterior !== null && Math.abs(valor - anterior) > TOLERANCIA) {
    const { data: difRow, error: e2 } = await sb.from("diferencias").insert({
      producto_id: p.id, fecha: cuerpo.fecha, valor_esperado: anterior, valor_real: valor,
      diferencia: valor - anterior, motivo: cuerpo.motivo || null, nota: cuerpo.motivoNota || null,
      inventario_id: invRow.id,
    }).select().single();
    throwIfError(e2);
    diferencia = mapDiferencia(difRow);
  }

  if (esEdicionDiaAnterior) {
    await registrarCorreccion({
      tipo: acumular ? "sumar" : "editar", productoId: p.id, fecha: invRow.fecha,
      valorAnterior: existenteHoy ? Number(existenteHoy.valor) : null, valorNuevo: valor,
      motivo: cuerpo.motivoEdicion, nota: cuerpo.motivoEdicionNota, inventarioId: invRow.id,
    });
  }

  await upsertStock(p.id, valor, cuerpo.fecha, "inventario");
  return { inventario: mapInventario(invRow), diferencia };
}

// Elimina un conteo. Devuelve { requiereMotivoEdicion } en vez de borrar si el
// registro es de un dia anterior al de hoy (real) y no viene motivo.
async function eliminarInventarioCloud(id, motivoEdicion, motivoEdicionNota) {
  if (esSoloLectura()) throw new Error("Estás en modo solo lectura, no puedes eliminar registros.");
  const { data: inv, error } = await sb.from("inventarios").select("*").eq("id", id).single();
  throwIfError(error);
  const ultimo = await ultimoMovimientoDeProducto(inv.producto_id);
  if (!ultimo || ultimo.id !== id) throw new Error("Solo se puede eliminar el ultimo movimiento registrado de este producto");

  const hoyReal = todayISO();
  if (inv.fecha !== hoyReal && !motivoEdicion) {
    return { requiereMotivoEdicion: true, fecha: inv.fecha, valorActual: Number(inv.valor) };
  }
  if (inv.fecha !== hoyReal) {
    await registrarCorreccion({
      tipo: "eliminar", productoId: inv.producto_id, fecha: inv.fecha,
      valorAnterior: Number(inv.valor), valorNuevo: null,
      motivo: motivoEdicion, nota: motivoEdicionNota, inventarioId: inv.id,
    });
  }

  const historial = await movimientosDeProducto(inv.producto_id);
  const idx = historial.findIndex(h => h.id === id);

  await sb.from("diferencias").delete().eq("inventario_id", id);
  await sb.from("inventarios").delete().eq("id", id);

  if (idx > 0) {
    const prev = historial[idx - 1];
    await upsertStock(inv.producto_id, prev.valor, prev.fecha, prev.tipo);
  } else {
    await sb.from("stock").delete().eq("producto_id", inv.producto_id);
  }
  return { ok: true };
}

async function quitarInventario(inventarioId) {
  if (!confirm("¿Quitar este producto del inventario de hoy?")) return;
  try {
    const resultado = await eliminarInventarioCloud(inventarioId);
    if (resultado.requiereMotivoEdicion) {
      abrirModalMotivoCorreccion(
        "Explica por qué eliminas este registro",
        `Este conteo es del <strong>${resultado.fecha}</strong> (un día anterior). Indica el motivo para eliminarlo.`,
        async (motivo, nota) => {
          try {
            await eliminarInventarioCloud(inventarioId, motivo, nota);
            cerrarModal();
            toast("Eliminado con motivo registrado");
            await refrescarTodo();
          } catch (err2) {
            toast(err2.message || "No se pudo eliminar", true);
          }
        }
      );
      return;
    }
    toast("Quitado del inventario de hoy");
    await refrescarTodo();
  } catch (err) {
    toast(err.message || "No se pudo quitar (puede que ya se haya despachado)", true);
  }
}

function seleccionarProductoInventario(productoId, modoEdicion = false) {
  const p = productosPorId[productoId];
  const it = estado.find(e => e.id === productoId);
  if (!p) return;
  const container = document.getElementById("formInventarioInline");
  container.hidden = false;

  const yaHoy = it.inventariadoHoy;
  const acumulando = yaHoy && !modoEdicion;

  const camposHtml = p.unidad === "KG" ? `
    <div class="form-grid">
      <label>Peso (kg)
        <input type="number" id="invValor" min="0" step="0.01" inputmode="decimal">
      </label>
      <label>N° de canastas (opcional)
        <input type="number" id="invNumCanastas" min="0" step="1" placeholder="Vacío = peso ya neto">
      </label>
      <label>Peso por canasta (kg)
        <input type="number" id="invPesoCanasta" min="0" step="0.01" value="2.2">
      </label>
    </div>
    <div class="calc-line" id="calcLinea">Peso neto: <strong>0 kg</strong></div>
  ` : `
    <div class="form-grid">
      <label>Cantidad (unidades)
        <input type="number" id="invValor" min="0" step="1" inputmode="numeric">
      </label>
    </div>
  `;

  let badge = "";
  if (modoEdicion && yaHoy) {
    badge = '<span class="badge badge-ok">Editando el registro de hoy</span>';
  } else if (acumulando) {
    badge = `<span class="badge badge-ok">Ya tienes ${fmt(it.inventarioHoyValor, p.unidad)} hoy · esto se sumará</span>`;
  }

  container.innerHTML = `
    <div class="producto-elegido">${escapeHtml(p.codigo)} · ${escapeHtml(p.nombre)} ${badge}</div>
    ${camposHtml}
    <label class="campo-simple">Notas (opcional)
      <input type="text" id="invNotas" placeholder="Opcional">
    </label>
    <div class="form-actions">
      <button type="button" class="btn-primary" id="btnGuardarInventarioInline">${modoEdicion && yaHoy ? "Guardar cambios" : (acumulando ? "Sumar al inventario de hoy" : "Agregar al inventario de hoy")}</button>
      <button type="button" class="btn-ghost" id="btnCancelarInventarioInline">Cancelar</button>
    </div>
  `;

  if (modoEdicion && yaHoy) {
    document.getElementById("invValor").value = it.inventarioHoyValor;
    document.getElementById("invNotas").value = it.inventarioHoyNotas || "";
  }

  if (p.unidad === "KG") {
    const recalcular = () => {
      const valor = Number(document.getElementById("invValor").value) || 0;
      const n = Number(document.getElementById("invNumCanastas").value) || 0;
      const tara = Number(document.getElementById("invPesoCanasta").value) || 2.2;
      const neto = n > 0 ? valor - (n * tara) : valor;
      const el = document.getElementById("calcLinea");
      el.innerHTML = `Peso neto: <strong>${neto.toLocaleString("es-CO", { maximumFractionDigits: 2 })} kg</strong>` +
        (n > 0 ? "" : ` <small style="color:var(--muted)">(directo, sin canastas)</small>`);
      el.classList.toggle("negativo", neto < 0);
    };
    ["invValor", "invNumCanastas", "invPesoCanasta"].forEach(id => document.getElementById(id).addEventListener("input", recalcular));
    recalcular();
  }

  document.getElementById("btnGuardarInventarioInline").addEventListener("click", () => confirmarInventarioInline(p, acumulando ? { acumular: true } : null));
  document.getElementById("btnCancelarInventarioInline").addEventListener("click", cerrarFormInventarioInline);
  document.getElementById("invValor").focus();
}

function cerrarFormInventarioInline() {
  const container = document.getElementById("formInventarioInline");
  container.hidden = true;
  container.innerHTML = "";
}

function leerCuerpoInventarioInline(p) {
  const fecha = fechaTrabajo();
  const notas = document.getElementById("invNotas").value.trim();
  const valor = Number(document.getElementById("invValor").value) || 0;
  if (p.unidad === "UND") {
    return { productoId: p.id, fecha, valor, notas };
  }
  return {
    productoId: p.id, fecha, valor, notas,
    numCanastas: Number(document.getElementById("invNumCanastas").value) || 0,
    pesoCanasta: Number(document.getElementById("invPesoCanasta").value) || 2.2,
  };
}

async function confirmarInventarioInline(p, cuerpoExtra) {
  let cuerpo;
  try {
    cuerpo = leerCuerpoInventarioInline(p);
  } catch (e) {
    toast("Revisa los datos ingresados", true);
    return;
  }
  if (cuerpoExtra) Object.assign(cuerpo, cuerpoExtra);

  try {
    const resultado = await guardarInventario(p, cuerpo);
    if (resultado.requiereMotivo) {
      abrirModalMotivoInventario(p, cuerpo, resultado);
      return;
    }
    if (resultado.requiereMotivoEdicion) {
      abrirModalMotivoCorreccion(
        "Explica por qué editas este registro",
        `Este conteo es del <strong>${resultado.fecha}</strong> (un día anterior). Indica el motivo del cambio.`,
        async (motivo, nota) => {
          try {
            const cuerpo2 = Object.assign({}, cuerpo, { motivoEdicion: motivo, motivoEdicionNota: nota });
            const resultado2 = await guardarInventario(p, cuerpo2);
            if (resultado2.requiereMotivo) {
              cerrarModal();
              abrirModalMotivoInventario(p, cuerpo2, resultado2);
              return;
            }
            cerrarModal();
            cerrarFormInventarioInline();
            toast("Guardado con motivo registrado");
            await refrescarTodo();
          } catch (err2) {
            toast(err2.message || "No se pudo guardar", true);
          }
        }
      );
      return;
    }
    cerrarFormInventarioInline();
    toast("Guardado en el inventario de hoy");
    await refrescarTodo();
    document.getElementById("buscarInventario").focus();
  } catch (err) {
    toast(err.message || "No se pudo guardar el conteo", true);
  }
}

function abrirModalMotivoInventario(p, cuerpoOriginal, info) {
  const bodyHtml = `
    <div class="modal-body-grid">
      <div class="alerta-box">
        El conteo no coincide con lo esperado.<br>
        Se esperaba: <strong>${fmt(info.valorEsperado, info.unidad)}</strong> ·
        Contaste: <strong>${fmt(info.valorNuevo, info.unidad)}</strong>
      </div>
      <label>Motivo de la diferencia
        <select id="motivoSelect">${MOTIVOS.map(m => `<option value="${escapeHtml(m)}">${escapeHtml(m)}</option>`).join("")}</select>
      </label>
      <label>Nota (opcional)
        <input type="text" id="motivoNota" placeholder="Detalle adicional...">
      </label>
    </div>
  `;
  abrirModal("Explica la diferencia", bodyHtml, {
    textoConfirmar: "Guardar con motivo",
    onConfirm: async () => {
      const motivo = document.getElementById("motivoSelect").value;
      const motivoNota = document.getElementById("motivoNota").value.trim();
      try {
        await guardarInventario(p, Object.assign({}, cuerpoOriginal, { motivo, motivoNota }));
        cerrarModal();
        cerrarFormInventarioInline();
        toast("Guardado con motivo registrado");
        await refrescarTodo();
      } catch (err) {
        toast(err.message || "No se pudo guardar", true);
      }
    },
  });
}

/* ==========================================================================
   SUGERIDO DEL DIA (importado desde Google Sheets, pegando el rango copiado)
   ========================================================================== */

// Interpreta el texto pegado desde la hoja "PEDIDO LEGUMBRE OR": cada fila es
// codigo, producto, unidad, Bello, Colores, y de ahi en adelante (hasta la
// columna M) el resto de los puntos, que se suman como Puntos Expres.
async function importarSugeridos(texto, fecha) {
  if (esSoloLectura()) throw new Error("Estás en modo solo lectura, no puedes importar el sugerido.");
  const parseNum = (v) => {
    const n = Number(String(v ?? "").replace(/,/g, "").trim());
    return isNaN(n) ? 0 : n;
  };
  const filas = texto.split(/\r?\n/).map(l => l.split("\t"));
  // Se acumula por producto_id (en vez de empujar directo a un arreglo) porque si el
  // mismo codigo aparece repetido en lo pegado, Supabase rechaza un upsert que toque
  // la misma fila (producto_id, fecha) dos veces en un solo envio.
  const porProducto = new Map();
  let noEncontrados = 0;

  for (const cols of filas) {
    const codigo = String(cols[0] ?? "").trim();
    if (!codigo) continue;
    const producto = productos.find(p => p.codigo.trim() === codigo);
    if (!producto) { noEncontrados++; continue; }

    const bello = parseNum(cols[3]);
    const colores = parseNum(cols[4]);
    let expres = 0;
    for (let i = 5; i <= 12; i++) expres += parseNum(cols[i]);

    if (bello === 0 && colores === 0 && expres === 0) continue;

    const previo = porProducto.get(producto.id) || { bello: 0, colores: 0, expres: 0 };
    porProducto.set(producto.id, {
      bello: previo.bello + bello, colores: previo.colores + colores, expres: previo.expres + expres,
    });
  }

  const registros = Array.from(porProducto.entries()).map(([producto_id, v]) => ({
    producto_id, fecha, bello: v.bello, colores: v.colores, puntos_expres: v.expres,
    actualizado_en: new Date().toISOString(),
  }));

  if (registros.length > 0) {
    const { error } = await sb.from("sugeridos").upsert(registros, { onConflict: "producto_id,fecha" });
    throwIfError(error);
  }
  return { encontrados: registros.length, noEncontrados };
}

document.getElementById("btnImportarSugerido").addEventListener("click", async () => {
  const textarea = document.getElementById("sugeridoTexto");
  const texto = textarea.value;
  if (!texto.trim()) { toast("Pega primero los datos copiados de la hoja", true); return; }
  try {
    const { encontrados, noEncontrados } = await importarSugeridos(texto, fechaTrabajo());
    if (encontrados === 0) { toast("No se reconoció ningún código en lo pegado", true); return; }
    textarea.value = "";
    toast(`Sugerido importado: ${encontrados} producto(s)` + (noEncontrados ? ` · ${noEncontrados} código(s) no encontrado(s)` : ""));
    await refrescarTodo();
  } catch (err) {
    toast(err.message || "No se pudo importar el sugerido", true);
  }
});

/* ==========================================================================
   DESPACHO
   ========================================================================== */

function celdaConPedido(valor, pedido, unidad) {
  const pedidoHtml = pedido !== null
    ? `<div style="font-size:10.5px;color:var(--muted);line-height:1.3">Pedido: ${fmt(pedido, unidad)}</div>`
    : "";
  return `<td>${pedidoHtml}${fmt(valor, unidad)}</td>`;
}

function filaDespachoHoy(d) {
  const p = productosPorId[d.productoId];
  const unidad = p ? p.unidad : "";
  const it = estado.find(e => e.id === d.productoId);
  const tieneSugerido = it && it.tieneSugerido;
  return `
    <tr>
      <td>${d.hora || ""}</td>
      <td>${p ? escapeHtml(p.codigo) : "-"}</td>
      <td>${p ? escapeHtml(p.nombre) : "(eliminado)"}</td>
      ${celdaConPedido(d.bello, tieneSugerido ? it.sugeridoBello : null, unidad)}
      ${celdaConPedido(d.colores, tieneSugerido ? it.sugeridoColores : null, unidad)}
      ${celdaConPedido(d.puntosExpres, tieneSugerido ? it.sugeridoExpres : null, unidad)}
      <td>${fmt(d.queda, unidad)}</td>
      <td><button class="btn-icon danger" data-quitar-desp="${d.id}">✕</button></td>
    </tr>
  `;
}

async function renderDespachoHoy() {
  let items;
  try {
    const { data, error } = await sb.from("despachos").select("*").eq("fecha", fechaTrabajo()).order("hora");
    throwIfError(error);
    items = (data || []).map(mapDespacho);
  } catch (err) {
    toast(err.message || "No se pudo cargar el despacho de hoy", true);
    return;
  }
  const tbody = document.getElementById("tablaDespachoHoy");
  tbody.innerHTML = items.map(filaDespachoHoy).join("") || `<tr class="empty-row"><td colspan="8">Sin despachos todavía.</td></tr>`;
  tbody.querySelectorAll("[data-quitar-desp]").forEach(b => b.addEventListener("click", async () => {
    if (!confirm("¿Eliminar este despacho? Solo se puede si es el último movimiento de ese producto.")) return;
    try {
      await eliminarDespachoCloud(b.dataset.quitarDesp);
      toast("Despacho eliminado");
      await refrescarTodo();
    } catch (err) {
      toast(err.message || "No se pudo eliminar", true);
    }
  }));
}

function seleccionarProductoDespacho(productoId) {
  const p = productosPorId[productoId];
  const it = estado.find(e => e.id === productoId);
  if (!p) return;
  const container = document.getElementById("formDespachoInline");
  container.hidden = false;

  const sinInventario = it.stockActual === null;
  const disponibleBase = sinInventario ? 0 : Number(it.stockActual);

  const step = p.unidad === "UND" ? "1" : "0.01";
  const sugerido = it.tieneSugerido
    ? `<span class="sep">·</span><span>Piden: <strong>Bello ${fmt(it.sugeridoBello, p.unidad)} · Colores ${fmt(it.sugeridoColores, p.unidad)} · Expres ${fmt(it.sugeridoExpres, p.unidad)}</strong></span>`
    : "";
  const avisoSinInventario = sinInventario
    ? `<div class="alerta-box">Este producto no tiene inventario registrado todavía. Puedes despacharlo igual, pero va a quedar la diferencia en negativo hasta que lo cuentes en Inventario.</div>`
    : "";
  container.innerHTML = `
    <div class="producto-elegido">${escapeHtml(p.codigo)} · ${escapeHtml(p.nombre)}</div>
    <div class="datos-referencia">
      <span>Disponible: <strong>${sinInventario ? "Sin registrar (0)" : fmt(it.stockActual, p.unidad)}</strong></span>
      ${sugerido}
    </div>
    ${avisoSinInventario}
    <div class="form-grid">
      <label>Bello
        <input type="number" id="despBello" min="0" step="${step}" value="0">
      </label>
      <label>Colores
        <input type="number" id="despColores" min="0" step="${step}" value="0">
      </label>
      <label>Puntos Expres
        <input type="number" id="despExpres" min="0" step="${step}" value="0">
      </label>
    </div>
    <div class="calc-line" id="calcDespacho">Despachando: <strong>0</strong> · Queda: <strong>${fmt(disponibleBase, p.unidad)}</strong></div>
    <label class="campo-simple">Notas (opcional)
      <input type="text" id="despNotas" placeholder="Opcional">
    </label>
    <div class="form-actions">
      <button type="button" class="btn-primary" id="btnGuardarDespachoInline">Registrar despacho</button>
      <button type="button" class="btn-ghost" id="btnCancelarDespachoInline">Cancelar</button>
    </div>
  `;

  const recalcular = () => {
    const bello = Number(document.getElementById("despBello").value) || 0;
    const colores = Number(document.getElementById("despColores").value) || 0;
    const expres = Number(document.getElementById("despExpres").value) || 0;
    const total = bello + colores + expres;
    const queda = disponibleBase - total;
    const el = document.getElementById("calcDespacho");
    el.innerHTML = `Despachando: <strong>${fmt(total, p.unidad)}</strong> · Queda: <strong>${fmt(queda, p.unidad)}</strong>`;
    el.classList.toggle("negativo", queda < 0);
  };
  ["despBello", "despColores", "despExpres"].forEach(id => document.getElementById(id).addEventListener("input", recalcular));
  recalcular();

  document.getElementById("btnGuardarDespachoInline").addEventListener("click", () => confirmarDespachoInline(p));
  document.getElementById("btnCancelarDespachoInline").addEventListener("click", cerrarFormDespachoInline);
  document.getElementById("despBello").focus();
}

function cerrarFormDespachoInline() {
  const container = document.getElementById("formDespachoInline");
  container.hidden = true;
  container.innerHTML = "";
}

async function guardarDespacho(p, cuerpo) {
  if (esSoloLectura()) throw new Error("Estás en modo solo lectura, no puedes registrar despachos.");
  const stockRow = await fetchStockRow(p.id);
  const disponible = stockRow ? Number(stockRow.valor) : 0;
  const bello = Number(cuerpo.bello) || 0;
  const colores = Number(cuerpo.colores) || 0;
  const expres = Number(cuerpo.puntosExpres) || 0;
  const total = bello + colores + expres;
  if (total <= 0) throw new Error("Debes despachar una cantidad mayor a 0");

  if (total > disponible && !cuerpo.forzar) {
    return { excedeDisponible: true, disponible, total, unidad: p.unidad };
  }

  const queda = disponible - total;
  const { data: despRow, error } = await sb.from("despachos").insert({
    producto_id: p.id, fecha: cuerpo.fecha, hora: horaActual(), disponible_antes: disponible,
    bello, colores, puntos_expres: expres,
    total_despachado: total, queda, notas: cuerpo.notas || null, excede_inventario: total > disponible,
  }).select().single();
  throwIfError(error);

  await upsertStock(p.id, queda, cuerpo.fecha, "despacho");
  return { despacho: mapDespacho(despRow) };
}

async function eliminarDespachoCloud(id) {
  if (esSoloLectura()) throw new Error("Estás en modo solo lectura, no puedes eliminar despachos.");
  const { data: desp, error } = await sb.from("despachos").select("*").eq("id", id).single();
  throwIfError(error);
  const ultimo = await ultimoMovimientoDeProducto(desp.producto_id);
  if (!ultimo || ultimo.id !== id) throw new Error("Solo se puede eliminar el ultimo movimiento registrado de este producto");

  await sb.from("despachos").delete().eq("id", id);
  await upsertStock(desp.producto_id, Number(desp.disponible_antes), desp.fecha, "inventario");
  return { ok: true };
}

async function confirmarDespachoInline(p, forzar) {
  const cuerpo = {
    productoId: p.id,
    fecha: fechaTrabajo(),
    bello: Number(document.getElementById("despBello").value) || 0,
    colores: Number(document.getElementById("despColores").value) || 0,
    puntosExpres: Number(document.getElementById("despExpres").value) || 0,
    notas: document.getElementById("despNotas").value.trim(),
  };
  if (forzar) cuerpo.forzar = true;

  try {
    const resultado = await guardarDespacho(p, cuerpo);
    if (resultado.excedeDisponible) {
      abrirModal("Estás despachando de más", `
        <div class="alerta-box">
          Disponible: <strong>${fmt(resultado.disponible, resultado.unidad)}</strong> ·
          Vas a despachar: <strong>${fmt(resultado.total, resultado.unidad)}</strong><br>
          ¿Continuar de todas formas? Quedará registrado con saldo negativo.
        </div>
      `, {
        textoConfirmar: "Sí, despachar igual",
        onConfirm: () => confirmarDespachoForzado(p, cuerpo),
      });
      return;
    }
    cerrarFormDespachoInline();
    toast("Despacho registrado");
    await refrescarTodo();
    document.getElementById("buscarDespacho").focus();
  } catch (err) {
    toast(err.message || "No se pudo registrar el despacho", true);
  }
}

async function confirmarDespachoForzado(p, cuerpo) {
  try {
    await guardarDespacho(p, Object.assign({}, cuerpo, { forzar: true }));
    cerrarModal();
    cerrarFormDespachoInline();
    toast("Despacho registrado (excede lo inventariado)");
    await refrescarTodo();
  } catch (err) {
    toast(err.message || "No se pudo registrar el despacho", true);
  }
}

wireAutocomplete("buscarInventario", "dropdownInventario", seleccionarProductoInventario);
wireAutocomplete("buscarDespacho", "dropdownDespacho", seleccionarProductoDespacho);

/* ==========================================================================
   PLATANO (libro contable acumulado: Entradas, Maduracion, Salidas -- no se
   reinicia cada dia, a diferencia del inventario normal)
   ========================================================================== */

let platanoEntradas = [];
let platanoMaduraciones = [];
let platanoSalidas = [];

async function cargarPlatano() {
  const [{ data: e, error: e1 }, { data: m, error: e2 }, { data: s, error: e3 }] = await Promise.all([
    sb.from("platano_entradas").select("*").order("fecha", { ascending: false }).order("creado_en", { ascending: false }),
    sb.from("platano_maduracion").select("*").order("fecha", { ascending: false }).order("creado_en", { ascending: false }),
    sb.from("platano_salidas").select("*").order("fecha", { ascending: false }).order("creado_en", { ascending: false }),
  ]);
  throwIfError(e1); throwIfError(e2); throwIfError(e3);
  platanoEntradas = e || [];
  platanoMaduraciones = m || [];
  platanoSalidas = s || [];
}

function pesoNetoPlatano(bruto, canastas) {
  return Math.max(0, (Number(bruto) || 0) - (Number(canastas) || 0) * 2.2);
}
function fmtKgPlatano(n) { return Number(n || 0).toLocaleString("es-CO", { maximumFractionDigits: 1 }) + " kg"; }
function fmtCanastasPlatano(n) { return Number(n || 0).toLocaleString("es-CO", { maximumFractionDigits: 0 }) + " canastas"; }

function platanoVerdeDisponible() {
  const sumar = (arr, campo) => arr.reduce((a, r) => a + Number(r[campo]), 0);
  const salidasVerde = platanoSalidas.filter(s => s.producto === "VERDE");
  return {
    kg: sumar(platanoEntradas, "peso_neto") - sumar(salidasVerde, "peso_neto") - sumar(platanoMaduraciones, "peso_neto"),
    canastas: sumar(platanoEntradas, "canastas") - sumar(salidasVerde, "canastas") - sumar(platanoMaduraciones, "canastas"),
  };
}

// Todos los lotes que alguna vez existieron, con su saldo actual (puede ser 0
// si ya se vendio por completo -- igual se puede volver a usar ese numero).
function platanoTodosLosLotes() {
  const numeros = new Set(platanoMaduraciones.map(m => Number(m.lote)));
  const lista = [];
  numeros.forEach(lote => {
    const entradasLote = platanoMaduraciones.filter(m => Number(m.lote) === lote);
    const salidasLote = platanoSalidas.filter(s => s.producto === "MADURO" && Number(s.lote) === lote);
    const kg = entradasLote.reduce((a, r) => a + Number(r.peso_neto), 0) - salidasLote.reduce((a, r) => a + Number(r.peso_neto), 0);
    const canastas = entradasLote.reduce((a, r) => a + Number(r.canastas), 0) - salidasLote.reduce((a, r) => a + Number(r.canastas), 0);
    lista.push({ lote, kg, canastas });
  });
  return lista.sort((a, b) => a.lote - b.lote);
}
function platanoLotesActivos() {
  return platanoTodosLosLotes().filter(l => l.kg > 0.01);
}
function platanoProximoLote() {
  const todos = platanoTodosLosLotes();
  return todos.length ? Math.max(...todos.map(l => l.lote)) + 1 : 1;
}

function renderPlatanoResumen() {
  const verde = platanoVerdeDisponible();
  const activos = platanoLotesActivos();
  const coloresLote = ["kpi-gold", "kpi-blue", "kpi-green", "kpi-danger"];
  let html = `
    <div class="kpi-card kpi-green">
      <span class="kpi-label">Verde disponible</span>
      <span class="kpi-value">${fmtKgPlatano(verde.kg)}</span>
      <span class="kpi-label">${fmtCanastasPlatano(verde.canastas)}</span>
    </div>
  `;
  activos.forEach((l, i) => {
    html += `
      <div class="kpi-card ${coloresLote[i % coloresLote.length]}">
        <span class="kpi-label">Maduro · Lote ${l.lote}</span>
        <span class="kpi-value">${fmtKgPlatano(l.kg)}</span>
        <span class="kpi-label">${fmtCanastasPlatano(l.canastas)}</span>
      </div>
    `;
  });
  if (activos.length === 0) {
    html += `
      <div class="kpi-card" style="background:#eef0f1;color:var(--muted)">
        <span class="kpi-label">Maduro disponible</span>
        <span class="kpi-value">0 kg</span>
      </div>
    `;
  }
  document.getElementById("platanoResumenGrid").innerHTML = html;
}

function renderPlatanoFormularios() {
  const verde = platanoVerdeDisponible();
  document.getElementById("platanoVerdeRefMaduracion").innerHTML =
    `<span>Verde disponible: <strong>${fmtKgPlatano(verde.kg)} · ${fmtCanastasPlatano(verde.canastas)}</strong></span>`;

  const todos = platanoTodosLosLotes();
  const proximo = platanoProximoLote();
  const selectorPmLote = document.getElementById("pmLote");
  const valorPrevioPm = selectorPmLote.value;
  selectorPmLote.innerHTML = todos.map(l =>
    `<option value="${l.lote}">Lote ${l.lote} (${fmtKgPlatano(l.kg)}${l.kg <= 0.01 ? " · vacío" : ""})</option>`
  ).join("") + `<option value="nuevo">+ Nuevo lote (${proximo})</option>`;
  if ([...selectorPmLote.options].some(o => o.value === valorPrevioPm)) selectorPmLote.value = valorPrevioPm;

  const activos = platanoLotesActivos();
  const selectorPsLote = document.getElementById("psLote");
  const valorPrevioPs = selectorPsLote.value;
  selectorPsLote.innerHTML = activos.map(l =>
    `<option value="${l.lote}">Lote ${l.lote} (${fmtKgPlatano(l.kg)})</option>`
  ).join("") || `<option value="">Sin lotes con saldo</option>`;
  if ([...selectorPsLote.options].some(o => o.value === valorPrevioPs)) selectorPsLote.value = valorPrevioPs;

  const proveedores = [...new Set(platanoEntradas.map(e => e.proveedor).filter(Boolean))];
  document.getElementById("platanoProveedores").innerHTML = proveedores.map(p => `<option value="${escapeHtml(p)}"></option>`).join("");

  actualizarRefSalidaPlatano();
}

function actualizarRefSalidaPlatano() {
  const producto = document.getElementById("psProducto").value;
  document.getElementById("psLoteWrap").hidden = producto !== "MADURO";
  const ref = document.getElementById("platanoDisponibleRefSalida");
  if (producto === "VERDE") {
    const verde = platanoVerdeDisponible();
    ref.innerHTML = `<span>Disponible (verde): <strong>${fmtKgPlatano(verde.kg)} · ${fmtCanastasPlatano(verde.canastas)}</strong></span>`;
  } else {
    const lote = document.getElementById("psLote").value;
    const info = platanoTodosLosLotes().find(l => String(l.lote) === String(lote));
    ref.innerHTML = info
      ? `<span>Disponible (lote ${info.lote}): <strong>${fmtKgPlatano(info.kg)} · ${fmtCanastasPlatano(info.canastas)}</strong></span>`
      : `<span>Selecciona un lote con saldo.</span>`;
  }
}
document.getElementById("psProducto").addEventListener("change", actualizarRefSalidaPlatano);
document.getElementById("psLote").addEventListener("change", actualizarRefSalidaPlatano);

function wireCalcPlatano(idBruto, idCanastas, idCalc) {
  const recalc = () => {
    const bruto = Number(document.getElementById(idBruto).value) || 0;
    const canastas = Number(document.getElementById(idCanastas).value) || 0;
    const neto = pesoNetoPlatano(bruto, canastas);
    document.getElementById(idCalc).innerHTML = `Peso neto: <strong>${fmtKgPlatano(neto)}</strong>`;
  };
  document.getElementById(idBruto).addEventListener("input", recalc);
  document.getElementById(idCanastas).addEventListener("input", recalc);
}
wireCalcPlatano("peBruto", "peCanastas", "calcPlatanoEntrada");
wireCalcPlatano("pmBruto", "pmCanastas", "calcPlatanoMaduracion");
wireCalcPlatano("psBruto", "psCanastas", "calcPlatanoSalida");

function renderPlatanoHistorial() {
  const items = [
    ...platanoEntradas.map(r => ({ tipo: "Entrada verde", detalle: r.proveedor || "-", ...r })),
    ...platanoMaduraciones.map(r => ({ tipo: "A maduración", detalle: `Lote ${r.lote}`, ...r })),
    ...platanoSalidas.map(r => ({ tipo: "Salida " + r.producto.toLowerCase(), detalle: r.destino + (r.lote ? ` (lote ${r.lote})` : ""), ...r })),
  ];
  items.sort((a, b) => (b.creado_en || "").localeCompare(a.creado_en || ""));
  const tabla = items.slice(0, 300);
  const tablaOrigen = { "Entrada verde": "entrada", "A maduración": "maduracion" };
  document.getElementById("tablaPlatanoHistorial").innerHTML = tabla.map(it => {
    const origen = it.tipo.startsWith("Salida") ? "salida" : tablaOrigen[it.tipo];
    return `
      <tr>
        <td>${it.fecha}</td>
        <td>${it.tipo}</td>
        <td>${escapeHtml(it.detalle)}</td>
        <td>${fmtKgPlatano(it.peso_bruto)}</td>
        <td>${fmtCanastasPlatano(it.canastas)}</td>
        <td>${fmtKgPlatano(it.peso_neto)}</td>
        <td><button class="btn-icon danger" data-plat-del="${origen}|${it.id}">✕</button></td>
      </tr>
    `;
  }).join("") || `<tr class="empty-row"><td colspan="7">Sin movimientos de plátano todavía.</td></tr>`;

  document.getElementById("tablaPlatanoHistorial").querySelectorAll("[data-plat-del]").forEach(b => {
    b.addEventListener("click", async () => {
      const [origen, id] = b.dataset.platDel.split("|");
      if (!confirm("¿Eliminar este movimiento de plátano?")) return;
      try {
        await eliminarPlatanoMovimiento(origen, id);
        toast("Movimiento eliminado");
        await cargarPlatano();
        renderPlatano();
      } catch (err) {
        toast(err.message || "No se pudo eliminar", true);
      }
    });
  });
}

async function eliminarPlatanoMovimiento(origen, id) {
  if (esSoloLectura()) throw new Error("Estás en modo solo lectura, no puedes eliminar movimientos.");
  const tabla = { entrada: "platano_entradas", maduracion: "platano_maduracion", salida: "platano_salidas" }[origen];
  const { error } = await sb.from(tabla).delete().eq("id", id);
  throwIfError(error);
}

function renderPlatano() {
  renderPlatanoResumen();
  renderPlatanoFormularios();
  renderPlatanoHistorial();
}

async function guardarPlatanoEntrada() {
  if (esSoloLectura()) { toast("Estás en modo solo lectura, no puedes registrar entradas.", true); return; }
  const proveedor = document.getElementById("peProveedor").value.trim();
  const bruto = Number(document.getElementById("peBruto").value) || 0;
  const canastas = Number(document.getElementById("peCanastas").value) || 0;
  if (bruto <= 0) { toast("Ingresa el peso bruto", true); return; }
  const neto = pesoNetoPlatano(bruto, canastas);
  try {
    const { error } = await sb.from("platano_entradas").insert({
      fecha: todayISO(), proveedor: proveedor || null, peso_bruto: bruto, canastas, peso_neto: neto,
    });
    throwIfError(error);
    document.getElementById("peProveedor").value = "";
    document.getElementById("peBruto").value = "";
    document.getElementById("peCanastas").value = "0";
    toast("Entrada de verde registrada");
    await cargarPlatano();
    renderPlatano();
  } catch (err) {
    toast(err.message || "No se pudo registrar la entrada", true);
  }
}
document.getElementById("btnGuardarPlatanoEntrada").addEventListener("click", guardarPlatanoEntrada);

async function guardarPlatanoMaduracion(forzar) {
  if (esSoloLectura()) { toast("Estás en modo solo lectura, no puedes registrar maduración.", true); return; }
  const selectorLote = document.getElementById("pmLote");
  const lote = selectorLote.value === "nuevo" ? platanoProximoLote() : Number(selectorLote.value);
  const bruto = Number(document.getElementById("pmBruto").value) || 0;
  const canastas = Number(document.getElementById("pmCanastas").value) || 0;
  if (bruto <= 0) { toast("Ingresa el peso bruto", true); return; }
  const neto = pesoNetoPlatano(bruto, canastas);
  const verde = platanoVerdeDisponible();
  if (neto > verde.kg && !forzar) {
    abrirModal("Vas a pasar más verde del disponible", `
      <div class="alerta-box">
        Verde disponible: <strong>${fmtKgPlatano(verde.kg)}</strong> ·
        Vas a pasar a maduración: <strong>${fmtKgPlatano(neto)}</strong><br>
        ¿Continuar de todas formas? El verde quedará en negativo.
      </div>
    `, { textoConfirmar: "Sí, continuar", onConfirm: () => { cerrarModal(); guardarPlatanoMaduracion(true); } });
    return;
  }
  try {
    const { error } = await sb.from("platano_maduracion").insert({
      fecha: todayISO(), lote, peso_bruto: bruto, canastas, peso_neto: neto,
    });
    throwIfError(error);
    document.getElementById("pmBruto").value = "";
    document.getElementById("pmCanastas").value = "0";
    toast(`Pasado a maduración en el lote ${lote}`);
    await cargarPlatano();
    renderPlatano();
  } catch (err) {
    toast(err.message || "No se pudo registrar la maduración", true);
  }
}
document.getElementById("btnGuardarPlatanoMaduracion").addEventListener("click", () => guardarPlatanoMaduracion(false));

async function guardarPlatanoSalida(forzar) {
  if (esSoloLectura()) { toast("Estás en modo solo lectura, no puedes registrar salidas.", true); return; }
  const producto = document.getElementById("psProducto").value;
  const destino = document.getElementById("psDestino").value.trim();
  const lote = producto === "MADURO" ? Number(document.getElementById("psLote").value) : null;
  const bruto = Number(document.getElementById("psBruto").value) || 0;
  const canastas = Number(document.getElementById("psCanastas").value) || 0;
  if (!destino) { toast("Indica a quién se despachó", true); return; }
  if (bruto <= 0) { toast("Ingresa el peso bruto", true); return; }
  if (producto === "MADURO" && !lote) { toast("Selecciona un lote", true); return; }
  const neto = pesoNetoPlatano(bruto, canastas);

  const disponible = producto === "VERDE"
    ? platanoVerdeDisponible().kg
    : (platanoTodosLosLotes().find(l => l.lote === lote) || { kg: 0 }).kg;

  if (neto > disponible && !forzar) {
    abrirModal("Estás despachando de más", `
      <div class="alerta-box">
        Disponible: <strong>${fmtKgPlatano(disponible)}</strong> ·
        Vas a despachar: <strong>${fmtKgPlatano(neto)}</strong><br>
        ¿Continuar de todas formas? Quedará registrado con saldo negativo.
      </div>
    `, { textoConfirmar: "Sí, despachar igual", onConfirm: () => { cerrarModal(); guardarPlatanoSalida(true); } });
    return;
  }
  try {
    const { error } = await sb.from("platano_salidas").insert({
      fecha: todayISO(), destino, producto, lote, peso_bruto: bruto, canastas, peso_neto: neto,
    });
    throwIfError(error);
    document.getElementById("psDestino").value = "";
    document.getElementById("psBruto").value = "";
    document.getElementById("psCanastas").value = "0";
    toast("Salida registrada");
    await cargarPlatano();
    renderPlatano();
  } catch (err) {
    toast(err.message || "No se pudo registrar la salida", true);
  }
}
document.getElementById("btnGuardarPlatanoSalida").addEventListener("click", () => guardarPlatanoSalida(false));

/* ==========================================================================
   HISTORIAL
   ========================================================================== */

["btnFiltrarHistorial"].forEach(id => document.getElementById(id).addEventListener("click", renderHistorial));
["filtroTipo", "filtroDesde", "filtroHasta"].forEach(id => document.getElementById(id).addEventListener("change", renderHistorial));
document.getElementById("filtroProductoTexto").addEventListener("input", renderHistorial);

function detalleHistorial(m) {
  const p = productosPorId[m.productoId];
  const unidad = p ? p.unidad : "";
  if (m.tipo === "inventario") {
    return `Conteo: <strong>${fmt(m.valor, unidad)}</strong> <small style="color:var(--muted)">(${m.modo})</small>`;
  }
  return `Bello: ${fmt(m.bello, unidad)} · Colores: ${fmt(m.colores, unidad)} · Expres: ${fmt(m.puntosExpres, unidad)} · Total: <strong>${fmt(m.totalDespachado, unidad)}</strong> · Queda: ${fmt(m.queda, unidad)}`;
}

async function obtenerHistorialCompleto({ desde, hasta, tipo } = {}) {
  let invQuery = sb.from("inventarios").select("*");
  let despQuery = sb.from("despachos").select("*");
  if (desde) { invQuery = invQuery.gte("fecha", desde); despQuery = despQuery.gte("fecha", desde); }
  if (hasta) { invQuery = invQuery.lte("fecha", hasta); despQuery = despQuery.lte("fecha", hasta); }

  const tareas = [];
  tareas.push(tipo === "despacho" ? Promise.resolve({ data: [] }) : invQuery);
  tareas.push(tipo === "inventario" ? Promise.resolve({ data: [] }) : despQuery);
  const [{ data: invs, error: e1 }, { data: desps, error: e2 }] = await Promise.all(tareas);
  throwIfError(e1); throwIfError(e2);

  const items = [...(invs || []).map(mapInventario), ...(desps || []).map(mapDespacho)];
  items.sort((a, b) => b.creadoEn.localeCompare(a.creadoEn));
  return items;
}

async function renderHistorial() {
  const tipo = document.getElementById("filtroTipo").value;
  const desde = document.getElementById("filtroDesde").value;
  const hasta = document.getElementById("filtroHasta").value;
  const texto = document.getElementById("filtroProductoTexto").value.trim().toLowerCase();

  let items;
  try {
    items = await obtenerHistorialCompleto({ desde, hasta, tipo: tipo || null });
  } catch (err) {
    toast(err.message || "No se pudo cargar el historial", true);
    return;
  }
  if (texto) {
    items = items.filter(m => {
      const p = productosPorId[m.productoId];
      return p && (p.codigo.toLowerCase().includes(texto) || p.nombre.toLowerCase().includes(texto));
    });
  }
  items = items.slice(0, 300);

  const tbody = document.getElementById("tablaHistorial");
  tbody.innerHTML = items.map(m => {
    const p = productosPorId[m.productoId];
    return `
      <tr>
        <td>${m.fecha}</td>
        <td>${m.hora || ""}</td>
        <td>${m.tipo === "inventario" ? "Inventario" : "Despacho"}</td>
        <td>${p ? escapeHtml(p.codigo + " · " + p.nombre) : "(eliminado)"}</td>
        <td>${detalleHistorial(m)}</td>
        <td>${escapeHtml(m.notas || "-")}</td>
        <td><button class="btn-icon danger" data-del-hist="${m.tipo}|${m.id}">✕</button></td>
      </tr>
    `;
  }).join("") || `<tr class="empty-row"><td colspan="7">Sin movimientos con estos filtros.</td></tr>`;

  tbody.querySelectorAll("[data-del-hist]").forEach(b => b.addEventListener("click", async () => {
    const [tipoMov, id] = b.dataset.delHist.split("|");
    if (tipoMov === "inventario") { await quitarInventario(id); return; }
    if (!confirm("¿Eliminar este movimiento? Solo se puede si es el último registrado para ese producto.")) return;
    try {
      await eliminarDespachoCloud(id);
      toast("Movimiento eliminado");
      await refrescarTodo();
    } catch (err) {
      toast(err.message || "No se pudo eliminar", true);
    }
  }));
}

async function renderDiferencias() {
  const { data, error } = await sb.from("diferencias").select("*").order("creado_en", { ascending: false }).limit(200);
  if (error) { toast(error.message, true); return; }
  const items = (data || []).map(mapDiferencia);
  const tbody = document.getElementById("tablaDiferencias");
  tbody.innerHTML = items.map(d => {
    const p = productosPorId[d.productoId];
    const unidad = p ? p.unidad : "";
    return `
      <tr class="${Math.abs(d.diferencia) > 0 ? 'row-warn' : ''}">
        <td>${d.fecha}</td>
        <td>${p ? escapeHtml(p.codigo + " · " + p.nombre) : "(eliminado)"}</td>
        <td>${fmt(d.valorEsperado, unidad)}</td>
        <td>${fmt(d.valorReal, unidad)}</td>
        <td>${d.diferencia > 0 ? "+" : ""}${fmt(d.diferencia, unidad)}</td>
        <td>${escapeHtml(d.motivo || "-")}</td>
        <td>${escapeHtml(d.nota || "-")}</td>
      </tr>
    `;
  }).join("") || `<tr class="empty-row"><td colspan="7">Sin diferencias registradas.</td></tr>`;
}

async function renderCorrecciones() {
  const { data, error } = await sb.from("correcciones").select("*").order("creado_en", { ascending: false }).limit(200);
  if (error) { toast(error.message, true); return; }
  const items = (data || []).map(mapCorreccion);
  const tbody = document.getElementById("tablaCorrecciones");
  const ACCION_LABEL = { editar: "Editado", sumar: "Sumado", eliminar: "Eliminado" };
  tbody.innerHTML = items.map(c => {
    const p = productosPorId[c.productoId];
    const unidad = p ? p.unidad : "";
    return `
      <tr>
        <td>${c.fecha}</td>
        <td>${p ? escapeHtml(p.codigo + " · " + p.nombre) : "(eliminado)"}</td>
        <td>${ACCION_LABEL[c.tipo] || c.tipo}</td>
        <td>${fmt(c.valorAnterior, unidad)}</td>
        <td>${c.valorNuevo === null || c.valorNuevo === undefined ? "-" : fmt(c.valorNuevo, unidad)}</td>
        <td>${escapeHtml(c.motivo || "-")}</td>
        <td>${escapeHtml(c.nota || "-")}</td>
      </tr>
    `;
  }).join("") || `<tr class="empty-row"><td colspan="7">Sin correcciones registradas.</td></tr>`;
}

/* ==========================================================================
   PRODUCTOS
   ========================================================================== */

document.getElementById("buscarProducto").addEventListener("input", renderTablaProductos);

function renderTablaProductos() {
  const texto = document.getElementById("buscarProducto").value.trim().toLowerCase();
  const tbody = document.getElementById("tablaProductos");
  let filas = productos.filter(p => !texto || p.codigo.toLowerCase().includes(texto) || p.nombre.toLowerCase().includes(texto));
  filas = filas.slice(0, 400);
  tbody.innerHTML = filas.map(p => `
    <tr>
      <td>${escapeHtml(p.codigo)}</td>
      <td>${escapeHtml(p.nombre)}</td>
      <td>${p.unidad}</td>
      <td>
        <button class="btn-icon" data-edit="${p.id}">Editar</button>
        <button class="btn-icon danger" data-del="${p.id}">Eliminar</button>
      </td>
    </tr>
  `).join("") || `<tr class="empty-row"><td colspan="4">Sin productos.</td></tr>`;

  tbody.querySelectorAll("[data-edit]").forEach(b => b.addEventListener("click", () => editarProducto(b.dataset.edit)));
  tbody.querySelectorAll("[data-del]").forEach(b => b.addEventListener("click", () => eliminarProducto(b.dataset.del)));
}

function editarProducto(id) {
  const p = productosPorId[id];
  if (!p) return;
  editandoProductoId = id;
  document.getElementById("prodId").value = id;
  document.getElementById("prodCodigo").value = p.codigo;
  document.getElementById("prodNombre").value = p.nombre;
  document.getElementById("prodUnidad").value = p.unidad;
  document.getElementById("formProductoTitulo").textContent = "Editar producto";
  document.getElementById("btnGuardarProducto").textContent = "Guardar cambios";
  document.getElementById("btnCancelarProducto").hidden = false;
  document.getElementById("tab-productos").scrollIntoView({ behavior: "smooth" });
}
document.getElementById("btnCancelarProducto").addEventListener("click", resetFormProducto);
function resetFormProducto() {
  editandoProductoId = null;
  document.getElementById("formProducto").reset();
  document.getElementById("prodId").value = "";
  document.getElementById("formProductoTitulo").textContent = "Nuevo producto";
  document.getElementById("btnGuardarProducto").textContent = "Guardar producto";
  document.getElementById("btnCancelarProducto").hidden = true;
}

document.getElementById("formProducto").addEventListener("submit", async (e) => {
  e.preventDefault();
  if (esSoloLectura()) { toast("Estás en modo solo lectura, no puedes guardar productos.", true); return; }
  const cuerpo = {
    codigo: document.getElementById("prodCodigo").value.trim(),
    nombre: document.getElementById("prodNombre").value.trim(),
    unidad: document.getElementById("prodUnidad").value,
  };
  if (!cuerpo.codigo || !cuerpo.nombre) { toast("Completa código y nombre", true); return; }
  try {
    if (editandoProductoId) {
      const { error } = await sb.from("productos").update(cuerpo).eq("id", editandoProductoId);
      throwIfError(error);
      toast("Producto actualizado");
    } else {
      const { data: existentes, error: e0 } = await sb.from("productos").select("id").eq("codigo", cuerpo.codigo);
      throwIfError(e0);
      if (existentes && existentes.length > 0) { toast("Ya existe un producto con ese código", true); return; }
      const { error } = await sb.from("productos").insert(cuerpo);
      throwIfError(error);
      toast("Producto creado");
    }
    resetFormProducto();
    await refrescarTodo();
  } catch (err) {
    toast(err.message || "No se pudo guardar el producto", true);
  }
});

async function eliminarProducto(id) {
  if (esSoloLectura()) { toast("Estás en modo solo lectura, no puedes eliminar productos.", true); return; }
  const p = productosPorId[id];
  if (!p) return;
  if (!confirm(`¿Eliminar "${p.nombre}"? También se borrará su historial de inventario y despachos.`)) return;
  try {
    const { error } = await sb.from("productos").delete().eq("id", id);
    throwIfError(error);
    toast("Producto eliminado");
    await refrescarTodo();
  } catch (err) {
    toast(err.message || "No se pudo eliminar", true);
  }
}

/* ==========================================================================
   RESUMEN
   ========================================================================== */

async function renderResumen() {
  document.getElementById("kpiTotalProductos").textContent = productos.length;
  document.getElementById("kpiInventariadosHoy").textContent = estado.filter(e => e.inventariadoHoy).length;
  document.getElementById("kpiDespachadosHoy").textContent = estado.filter(e => e.despachadoHoyTotal > 0).length;

  try {
    const { data: difs, error } = await sb.from("diferencias").select("id").eq("fecha", fechaTrabajo());
    throwIfError(error);
    document.getElementById("kpiDiferenciasHoy").textContent = (difs || []).length;
  } catch (e) { /* no bloquea el resto del resumen */ }

  try {
    const items = await obtenerHistorialCompleto({});
    const top = items.slice(0, 10);
    const tbody = document.getElementById("resumenUltimos");
    tbody.innerHTML = top.map(m => {
      const p = productosPorId[m.productoId];
      return `
        <tr>
          <td>${m.fecha}</td>
          <td>${m.hora || ""}</td>
          <td>${m.tipo === "inventario" ? "Inventario" : "Despacho"}</td>
          <td>${p ? escapeHtml(p.codigo + " · " + p.nombre) : "(eliminado)"}</td>
          <td>${detalleHistorial(m)}</td>
        </tr>
      `;
    }).join("") || `<tr class="empty-row"><td colspan="5">Sin movimientos todavía.</td></tr>`;
  } catch (e) { /* no bloquea el resto del resumen */ }
}

/* ==========================================================================
   RESPALDO (descarga todo como JSON)
   ========================================================================== */

document.getElementById("btnBackup").addEventListener("click", async () => {
  try {
    const [prods, stock, invs, desps, difs, corrs] = await Promise.all([
      sb.from("productos").select("*"),
      sb.from("stock").select("*"),
      sb.from("inventarios").select("*"),
      sb.from("despachos").select("*"),
      sb.from("diferencias").select("*"),
      sb.from("correcciones").select("*"),
    ]);
    const payload = {
      productos: prods.data, stock: stock.data, inventarios: invs.data,
      despachos: desps.data, diferencias: difs.data, correcciones: corrs.data,
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "inventario_respaldo_" + todayISO() + ".json";
    a.click();
    URL.revokeObjectURL(url);
  } catch (err) {
    toast("No se pudo generar el respaldo", true);
  }
});

/* ==========================================================================
   INICIO
   ========================================================================== */

document.getElementById("fechaTrabajo").value = todayISO();
document.getElementById("filtroDesde").value = "";
refrescarTodo();
