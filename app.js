/* ==========================================================
   Tu Sueños — app.js
   Lógica de la aplicación. Organizado en secciones:
     1. Estado global y utilidades
     2. Autenticación
     3. Listeners en tiempo real (Firestore)
     4. Navegación / render de vistas
     5. Acciones: ventas, entradas, transferencias, ajustes
     6. Aprobación / rechazo (con transacciones)
     7. Productos (admin)
     8. Historial y filtros
     9. Datos de prueba
   ========================================================== */

// ---------------------------------------------------------
// 1. ESTADO GLOBAL Y UTILIDADES
// ---------------------------------------------------------

let currentUser = null; // { uid, nombre, rol, localId }

const cache = {
  products: {},   // productId -> data
  stock: {},      // `${localId}_${productId}` -> data
  sales: {},
  transfers: {},
  entries: {},
  movements: []
};

let unsubscribers = []; // listeners activos de Firestore, se limpian al salir
let activeStockLocaleTab = null; // para el admin, qué local está mirando en la pestaña de stock

function $(id) { return document.getElementById(id); }

function showToast(message, type = "") {
  const toast = $("toast");
  toast.textContent = message;
  toast.className = "toast" + (type ? " toast-" + type : "");
  toast.classList.remove("hidden");
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => toast.classList.add("hidden"), 3200);
}

function formatFechaHora(timestamp) {
  if (!timestamp) return "";
  const d = timestamp.toDate ? timestamp.toDate() : new Date(timestamp);
  return d.toLocaleDateString("es-AR") + " " + d.toLocaleTimeString("es-AR", { hour: "2-digit", minute: "2-digit" });
}

function stockKey(localId, productId) { return `${localId}_${productId}`; }

function getStockCantidad(localId, productId) {
  const doc = cache.stock[stockKey(localId, productId)];
  return doc ? doc.cantidad : 0;
}

function getStockTotal(productId) {
  return Object.keys(LOCALES).reduce((sum, localId) => sum + getStockCantidad(localId, productId), 0);
}

function productosActivos() {
  return Object.entries(cache.products)
    .filter(([, p]) => p.activo !== false)
    .sort((a, b) => a[1].nombre.localeCompare(b[1].nombre));
}

// ---------------------------------------------------------
// 2. AUTENTICACIÓN
// ---------------------------------------------------------

$("login-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const email = $("login-email").value.trim();
  const password = $("login-password").value;
  $("login-error").classList.add("hidden");
  try {
    await auth.signInWithEmailAndPassword(email, password);
  } catch (err) {
    $("login-error").textContent = "No se pudo iniciar sesión. Revisá el correo y la contraseña.";
    $("login-error").classList.remove("hidden");
  }
});

$("logout-btn").addEventListener("click", () => auth.signOut());

auth.onAuthStateChanged(async (user) => {
  cleanupListeners();
  if (!user) {
    currentUser = null;
    $("app").classList.add("hidden");
    $("login-screen").classList.remove("hidden");
    return;
  }

  try {
    const userDoc = await db.collection("users").doc(user.uid).get();
    if (!userDoc.exists) {
      showToast("Tu usuario no tiene un perfil configurado. Avisá al administrador.", "error");
      await auth.signOut();
      return;
    }
    const data = userDoc.data();
    if (data.activo === false) {
      showToast("Tu usuario está desactivado.", "error");
      await auth.signOut();
      return;
    }
    currentUser = { uid: user.uid, nombre: data.nombre || user.email, rol: data.rol, localId: data.localId || null };

    $("login-screen").classList.add("hidden");
    $("app").classList.remove("hidden");
    $("user-name").textContent = currentUser.nombre;
    $("topbar-location").textContent = currentUser.rol === "admin" ? "Administración" : LOCALES[currentUser.localId];

    setupUIForRole();
    startListeners();
  } catch (err) {
    console.error(err);
    showToast("Error al cargar tu perfil.", "error");
  }
});

function cleanupListeners() {
  unsubscribers.forEach((u) => u());
  unsubscribers = [];
}

function setupUIForRole() {
  const isAdmin = currentUser.rol === "admin";
  document.querySelectorAll(".admin-only").forEach((el) => el.classList.toggle("hidden", !isAdmin));
  $("admin-dashboard").classList.toggle("hidden", !isAdmin);
  $("local-dashboard").classList.toggle("hidden", isAdmin);
  $("admin-locale-tabs").classList.toggle("hidden", !isAdmin);
  $("local-dashboard-title").textContent = LOCALES[currentUser.localId] || "";

  // El nav de "pendientes" siempre visible: admin aprueba, local ve las suyas.
  $("nav-pending-btn").querySelector("span:last-of-type").textContent = isAdmin ? "Aprobar" : "Pendientes";

  populateLocaleSelects();
  goToView("view-dashboard");
}

function populateLocaleSelects() {
  // Combo de filtro de historial
  const filterLocal = $("filter-local");
  filterLocal.innerHTML = '<option value="">Todos los locales</option>';
  Object.entries(LOCALES).forEach(([id, nombre]) => {
    filterLocal.innerHTML += `<option value="${id}">${nombre}</option>`;
  });

  // Combos de transferencia
  const destino = $("transferencia-destino");
  const origen = $("transferencia-origen");
  destino.innerHTML = "";
  origen.innerHTML = "";
  Object.entries(LOCALES).forEach(([id, nombre]) => {
    destino.innerHTML += `<option value="${id}">${nombre}</option>`;
    origen.innerHTML += `<option value="${id}">${nombre}</option>`;
  });

  if (currentUser.rol === "local") {
    // El local solicitante siempre transfiere desde su propio local
    $("transferencia-origen-wrap").classList.add("hidden");
    origen.value = currentUser.localId;
    // No puede elegir su propio local como destino
    Array.from(destino.options).forEach((opt) => { opt.disabled = opt.value === currentUser.localId; });
    const firstEnabled = Array.from(destino.options).find((o) => !o.disabled);
    if (firstEnabled) destino.value = firstEnabled.value;
  } else {
    $("transferencia-origen-wrap").classList.remove("hidden");
  }
}

// ---------------------------------------------------------
// 3. LISTENERS EN TIEMPO REAL
// ---------------------------------------------------------

function startListeners() {
  const isAdmin = currentUser.rol === "admin";

  // Productos: todos los usuarios necesitan verlos (nombre, categoría) para operar.
  unsubscribers.push(
    db.collection("products").onSnapshot((snap) => {
      cache.products = {};
      snap.forEach((doc) => (cache.products[doc.id] = doc.data()));
      renderAll();
    })
  );

  // Stock: el local solo se suscribe a SU propio stock (además las reglas de
  // seguridad impiden leer el de otros locales aunque se cambie la query).
  const stockQuery = isAdmin
    ? db.collection("stock")
    : db.collection("stock").where("localId", "==", currentUser.localId);

  unsubscribers.push(
    stockQuery.onSnapshot((snap) => {
      cache.stock = {};
      snap.forEach((doc) => (cache.stock[doc.id] = doc.data()));
      renderAll();
    })
  );

  // Ventas
  const salesQuery = isAdmin
    ? db.collection("sales")
    : db.collection("sales").where("localId", "==", currentUser.localId);
  unsubscribers.push(
    salesQuery.onSnapshot((snap) => {
      cache.sales = {};
      snap.forEach((doc) => (cache.sales[doc.id] = doc.data()));
      renderAll();
    })
  );

  // Transferencias: local ve las que salen o entran de su local
  const transfersQuery = isAdmin ? db.collection("transfers") : null;
  if (isAdmin) {
    unsubscribers.push(
      transfersQuery.onSnapshot((snap) => {
        cache.transfers = {};
        snap.forEach((doc) => (cache.transfers[doc.id] = doc.data()));
        renderAll();
      })
    );
  } else {
    unsubscribers.push(
      db.collection("transfers").where("localOrigen", "==", currentUser.localId).onSnapshot((snap) => {
        snap.forEach((doc) => (cache.transfers[doc.id] = doc.data()));
        renderAll();
      })
    );
    unsubscribers.push(
      db.collection("transfers").where("localDestino", "==", currentUser.localId).onSnapshot((snap) => {
        snap.forEach((doc) => (cache.transfers[doc.id] = doc.data()));
        renderAll();
      })
    );
  }

  // Entradas
  const entriesQuery = isAdmin
    ? db.collection("entries")
    : db.collection("entries").where("localId", "==", currentUser.localId);
  unsubscribers.push(
    entriesQuery.onSnapshot((snap) => {
      cache.entries = {};
      snap.forEach((doc) => (cache.entries[doc.id] = doc.data()));
      renderAll();
    })
  );

  // Historial de movimientos (últimos 200, ordenado por fecha desc)
  const movementsQuery = isAdmin
    ? db.collection("movements").orderBy("fecha", "desc").limit(200)
    : db.collection("movements").where("localId", "==", currentUser.localId).orderBy("fecha", "desc").limit(200);
  unsubscribers.push(
    movementsQuery.onSnapshot(
      (snap) => {
        cache.movements = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
        renderAll();
      },
      (err) => console.error("movements listener:", err)
    )
  );
}

function renderAll() {
  if (!currentUser) return;
  renderDashboard();
  renderStockView();
  renderPendingView();
  renderHistoryView();
  if (currentUser.rol === "admin") renderProductsAdminView();
  updatePendingBadge();
}

// ---------------------------------------------------------
// 4. NAVEGACIÓN / RENDER DE VISTAS
// ---------------------------------------------------------

document.querySelectorAll(".nav-btn").forEach((btn) => {
  btn.addEventListener("click", () => goToView(btn.dataset.view));
});

function goToView(viewId) {
  document.querySelectorAll(".view").forEach((v) => v.classList.add("hidden"));
  $(viewId).classList.remove("hidden");
  document.querySelectorAll(".nav-btn").forEach((b) => b.classList.toggle("active", b.dataset.view === viewId));
}

function updatePendingBadge() {
  let count;
  if (currentUser.rol === "admin") {
    count =
      Object.values(cache.sales).filter((s) => s.estado === "pendiente").length +
      Object.values(cache.transfers).filter((t) => t.estado === "pendiente").length +
      Object.values(cache.entries).filter((e) => e.estado === "pendiente").length;
  } else {
    count =
      Object.values(cache.sales).filter((s) => s.estado === "pendiente").length +
      Object.values(cache.transfers).filter((t) => t.estado === "pendiente").length +
      Object.values(cache.entries).filter((e) => e.estado === "pendiente").length;
  }
  const badge = $("pending-badge");
  if (count > 0) {
    badge.textContent = count;
    badge.classList.remove("hidden");
  } else {
    badge.classList.add("hidden");
  }
}

function renderDashboard() {
  if (currentUser.rol === "admin") {
    const ventasPend = Object.values(cache.sales).filter((s) => s.estado === "pendiente").length;
    const transfPend = Object.values(cache.transfers).filter((t) => t.estado === "pendiente").length;
    const entradasPend = Object.values(cache.entries).filter((e) => e.estado === "pendiente").length;

    $("admin-summary-cards").innerHTML = `
      <div class="stat-card stat-pendiente"><span class="stat-value">${ventasPend}</span><span class="stat-label">Ventas pend.</span></div>
      <div class="stat-card stat-pendiente"><span class="stat-value">${transfPend}</span><span class="stat-label">Transf. pend.</span></div>
      <div class="stat-card stat-pendiente"><span class="stat-value">${entradasPend}</span><span class="stat-label">Entradas pend.</span></div>
    `;

    $("admin-locales-grid").innerHTML = Object.entries(LOCALES)
      .map(([id, nombre]) => {
        const total = productosActivos().reduce((sum, [pid]) => sum + getStockCantidad(id, pid), 0);
        return `<div class="locale-card" data-locale="${id}">
          <h3>${nombre}</h3>
          <span class="locale-count">${total}</span>
          <div class="locale-sub">unidades en stock</div>
        </div>`;
      })
      .join("");

    document.querySelectorAll(".locale-card").forEach((el) => {
      el.addEventListener("click", () => {
        activeStockLocaleTab = el.dataset.locale;
        goToView("view-stock");
        renderStockView();
      });
    });

    $("admin-recent-movements").innerHTML =
      cache.movements.slice(0, 6).map(renderMovementCard).join("") || `<div class="empty-state">Todavía no hay movimientos registrados.</div>`;
  } else {
    const total = productosActivos().reduce((sum, [pid]) => sum + getStockCantidad(currentUser.localId, pid), 0);
    const misPend =
      Object.values(cache.sales).filter((s) => s.estado === "pendiente").length +
      Object.values(cache.transfers).filter((t) => t.estado === "pendiente").length +
      Object.values(cache.entries).filter((e) => e.estado === "pendiente").length;

    $("local-summary-cards").innerHTML = `
      <div class="stat-card"><span class="stat-value">${productosActivos().length}</span><span class="stat-label">Productos</span></div>
      <div class="stat-card"><span class="stat-value">${total}</span><span class="stat-label">Unidades</span></div>
      <div class="stat-card stat-pendiente"><span class="stat-value">${misPend}</span><span class="stat-label">Pendientes</span></div>
    `;

    const items = [
      ...Object.entries(cache.sales).filter(([, s]) => s.estado === "pendiente").map(([id, s]) => ({ id, tipo: "venta", ...s })),
      ...Object.entries(cache.transfers).filter(([, t]) => t.estado === "pendiente").map(([id, t]) => ({ id, tipo: "transferencia", ...t })),
      ...Object.entries(cache.entries).filter(([, e]) => e.estado === "pendiente").map(([id, e]) => ({ id, tipo: "entrada", ...e }))
    ].sort((a, b) => (b.fechaCreacion?.seconds || 0) - (a.fechaCreacion?.seconds || 0));

    $("local-mis-pendientes").innerHTML =
      items.map((it) => renderPendingCard(it, it.tipo, false)).join("") || `<div class="empty-state">No tenés movimientos pendientes.</div>`;
  }
}

// ---------- Vista Stock ----------

function renderStockView() {
  const isAdmin = currentUser.rol === "admin";

  if (isAdmin) {
    if (!activeStockLocaleTab) activeStockLocaleTab = Object.keys(LOCALES)[0];
    $("admin-locale-tabs").innerHTML = Object.entries(LOCALES)
      .map(([id, nombre]) => `<button class="locale-tab-btn ${id === activeStockLocaleTab ? "active" : ""}" data-locale="${id}">${nombre}</button>`)
      .join("");
    document.querySelectorAll(".locale-tab-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        activeStockLocaleTab = btn.dataset.locale;
        renderStockView();
      });
    });
  }

  const localId = isAdmin ? activeStockLocaleTab : currentUser.localId;
  const query = $("search-input").value.trim().toLowerCase();

  const list = productosActivos().filter(([, p]) => {
    if (!query) return true;
    return [p.nombre, p.medida, p.categoria].join(" ").toLowerCase().includes(query);
  });

  $("stock-list").innerHTML =
    list
      .map(([pid, p]) => {
        const cantidad = getStockCantidad(localId, pid);
        const zeroClass = cantidad === 0 ? "stock-zero" : "";
        let extra = "";
        if (isAdmin) {
          extra = `<div class="product-card-actions">
            <button class="btn btn-outline btn-small btn-ajustar" data-product="${pid}" data-locale="${localId}">Ajustar stock</button>
            <button class="btn btn-secondary btn-small btn-transferir" data-product="${pid}" data-locale="${localId}">Transferir</button>
            <button class="btn btn-secondary btn-small btn-entrada-admin" data-product="${pid}" data-locale="${localId}">Registrar entrada</button>
          </div>`;
        } else {
          extra = `<div class="product-card-actions">
            <button class="btn btn-primary btn-small btn-vender" data-product="${pid}">Informar venta</button>
          </div>`;
        }
        return `<div class="product-card">
          <div class="product-card-top">
            <div>
              <h4>${p.nombre}</h4>
              <div class="product-meta">${[p.categoria, p.medida].filter(Boolean).join(" · ")}</div>
            </div>
            <div class="product-stock ${zeroClass}">${cantidad}</div>
          </div>
          ${extra}
        </div>`;
      })
      .join("") || `<div class="empty-state">No se encontraron productos.</div>`;

  document.querySelectorAll(".btn-vender").forEach((btn) => btn.addEventListener("click", () => openVentaModal(btn.dataset.product)));
  document.querySelectorAll(".btn-ajustar").forEach((btn) => btn.addEventListener("click", () => openAjusteModal(btn.dataset.locale, btn.dataset.product)));
  document.querySelectorAll(".btn-transferir").forEach((btn) =>
    btn.addEventListener("click", () => openTransferenciaModal(btn.dataset.product, btn.dataset.locale))
  );
  document.querySelectorAll(".btn-entrada-admin").forEach((btn) =>
    btn.addEventListener("click", () => openEntradaModal(btn.dataset.product))
  );
}

$("search-input").addEventListener("input", renderStockView);

// ---------- Vista Pendientes ----------

document.querySelectorAll(".tab-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".tab-btn").forEach((b) => b.classList.remove("active"));
    document.querySelectorAll(".tab-panel").forEach((p) => p.classList.add("hidden"));
    btn.classList.add("active");
    $(btn.dataset.tab).classList.remove("hidden");
  });
});

function renderPendingView() {
  const isAdmin = currentUser.rol === "admin";

  const ventas = Object.entries(cache.sales)
    .filter(([, s]) => s.estado === "pendiente")
    .map(([id, s]) => ({ id, ...s }))
    .sort((a, b) => (b.fechaCreacion?.seconds || 0) - (a.fechaCreacion?.seconds || 0));
  $("pending-sales").innerHTML =
    ventas.map((v) => renderPendingCard(v, "venta", isAdmin)).join("") || `<div class="empty-state">No hay ventas pendientes.</div>`;

  const transferencias = Object.entries(cache.transfers)
    .filter(([, t]) => t.estado === "pendiente")
    .map(([id, t]) => ({ id, ...t }))
    .sort((a, b) => (b.fechaCreacion?.seconds || 0) - (a.fechaCreacion?.seconds || 0));
  $("pending-transfers").innerHTML =
    transferencias.map((t) => renderPendingCard(t, "transferencia", isAdmin)).join("") ||
    `<div class="empty-state">No hay transferencias pendientes.</div>`;

  const entradas = Object.entries(cache.entries)
    .filter(([, e]) => e.estado === "pendiente")
    .map(([id, e]) => ({ id, ...e }))
    .sort((a, b) => (b.fechaCreacion?.seconds || 0) - (a.fechaCreacion?.seconds || 0));
  $("pending-entries").innerHTML =
    entradas.map((e) => renderPendingCard(e, "entrada", isAdmin)).join("") || `<div class="empty-state">No hay entradas pendientes.</div>`;

  attachApprovalHandlers();
}

function renderPendingCard(item, tipo, showActions) {
  let titulo = "";
  let detalle = "";
  const producto = cache.products[item.productId]?.nombre || item.productNombre || "Producto";

  if (tipo === "venta") {
    titulo = `${LOCALES[item.localId]} · ${producto} x${item.cantidad}`;
    detalle = `Vendedor: ${item.usuarioNombre}${item.cliente ? " · Cliente: " + item.cliente : ""}<br>${formatFechaHora(item.fechaCreacion)}`;
  } else if (tipo === "transferencia") {
    titulo = `${LOCALES[item.localOrigen]} → ${LOCALES[item.localDestino]} · ${producto} x${item.cantidad}`;
    detalle = `Solicitado por: ${item.usuarioNombre}<br>${formatFechaHora(item.fechaCreacion)}`;
  } else if (tipo === "entrada") {
    titulo = `${LOCALES[item.localId]} · ${producto} x${item.cantidad}`;
    detalle = `Solicitado por: ${item.usuarioNombre}<br>${formatFechaHora(item.fechaCreacion)}`;
  }

  const actions = showActions
    ? `<div class="movement-actions">
        <button class="btn btn-approve btn-small btn-aprobar" data-tipo="${tipo}" data-id="${item.id}">Aprobar</button>
        <button class="btn btn-reject btn-small btn-rechazar" data-tipo="${tipo}" data-id="${item.id}">Rechazar</button>
      </div>`
    : "";

  return `<div class="movement-card estado-pendiente">
    <div class="movement-top">
      <span class="movement-title">${titulo}</span>
      <span class="pill pill-pendiente">Pendiente</span>
    </div>
    <div class="movement-detail">${detalle}</div>
    ${actions}
  </div>`;
}

function attachApprovalHandlers() {
  document.querySelectorAll(".btn-aprobar").forEach((btn) => {
    btn.onclick = () => handleApprove(btn.dataset.tipo, btn.dataset.id);
  });
  document.querySelectorAll(".btn-rechazar").forEach((btn) => {
    btn.onclick = () => handleReject(btn.dataset.tipo, btn.dataset.id);
  });
}

// ---------- Historial ----------

["filter-local", "filter-tipo", "filter-estado", "filter-producto", "filter-fecha"].forEach((id) => {
  $(id).addEventListener("input", renderHistoryView);
});

function renderMovementCard(m) {
  const producto = cache.products[m.productId]?.nombre || m.productNombre || "Producto";
  let titulo = "";
  if (m.tipo === "venta") titulo = `Venta · ${LOCALES[m.localId]} · ${producto} x${m.cantidad}`;
  else if (m.tipo === "transferencia") titulo = `Transferencia · ${LOCALES[m.localId]} → ${LOCALES[m.localDestino]} · ${producto} x${m.cantidad}`;
  else if (m.tipo === "entrada") titulo = `Entrada · ${LOCALES[m.localId]} · ${producto} x${m.cantidad}`;
  else if (m.tipo === "ajuste") titulo = `Ajuste manual · ${LOCALES[m.localId]} · ${producto}`;

  const detalle = `${m.usuarioNombre ? "Usuario: " + m.usuarioNombre + "<br>" : ""}${
    m.administradorNombre ? "Admin: " + m.administradorNombre + "<br>" : ""
  }${m.stockAntes !== undefined ? `Stock: ${m.stockAntes} → ${m.stockDespues}<br>` : ""}${formatFechaHora(m.fecha)}`;

  const estadoClass = m.estado ? `estado-${m.estado}` : "";
  const pillClass = m.estado ? `pill-${m.estado}` : "pill-aprobada";
  const pillText = m.estado === "pendiente" ? "Pendiente" : m.estado === "rechazada" ? "Rechazado" : "Aprobado";

  return `<div class="movement-card ${estadoClass}">
    <div class="movement-top">
      <span class="movement-title">${titulo}</span>
      <span class="pill ${pillClass}">${pillText}</span>
    </div>
    <div class="movement-detail">${detalle}</div>
  </div>`;
}

function renderHistoryView() {
  const fLocal = $("filter-local").value;
  const fTipo = $("filter-tipo").value;
  const fEstado = $("filter-estado").value;
  const fProducto = $("filter-producto").value.trim().toLowerCase();
  const fFecha = $("filter-fecha").value; // YYYY-MM-DD

  const filtered = cache.movements.filter((m) => {
    if (fLocal && m.localId !== fLocal) return false;
    if (fTipo && m.tipo !== fTipo) return false;
    if (fEstado && (m.estado || "aprobada") !== fEstado) return false;
    if (fProducto) {
      const nombre = (cache.products[m.productId]?.nombre || m.productNombre || "").toLowerCase();
      if (!nombre.includes(fProducto)) return false;
    }
    if (fFecha && m.fecha) {
      const d = m.fecha.toDate ? m.fecha.toDate() : new Date(m.fecha);
      const iso = d.toISOString().slice(0, 10);
      if (iso !== fFecha) return false;
    }
    return true;
  });

  $("history-list").innerHTML = filtered.map(renderMovementCard).join("") || `<div class="empty-state">No hay movimientos con esos filtros.</div>`;
}

// ---------------------------------------------------------
// 5. ACCIONES: VENTAS, ENTRADAS, TRANSFERENCIAS, AJUSTES
// ---------------------------------------------------------

// ----- Modal genérico -----
document.querySelectorAll("[data-close-modal]").forEach((btn) => {
  btn.addEventListener("click", () => btn.closest(".modal").classList.add("hidden"));
});
document.querySelectorAll(".qty-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    const input = $(btn.dataset.target);
    const next = Math.max(1, parseInt(input.value || "1", 10) + parseInt(btn.dataset.delta, 10));
    input.value = next;
    input.dispatchEvent(new Event("input"));
  });
});

function fillProductSelect(selectEl) {
  selectEl.innerHTML = productosActivos()
    .map(([id, p]) => `<option value="${id}">${p.nombre}</option>`)
    .join("");
}

// ----- Nueva venta -----

$("btn-nueva-venta")?.addEventListener("click", openVentaModal);

function openVentaModal(productId) {
  fillProductSelect($("venta-producto"));
  if (productId) $("venta-producto").value = productId;
  $("venta-cantidad").value = 1;
  $("venta-cliente").value = "";
  $("venta-observaciones").value = "";
  $("venta-error").classList.add("hidden");
  updateVentaStockInfo();
  $("modal-venta").classList.remove("hidden");
}

$("venta-producto").addEventListener("change", updateVentaStockInfo);
$("venta-cantidad").addEventListener("input", updateVentaStockInfo);

function updateVentaStockInfo() {
  const pid = $("venta-producto").value;
  const disponible = getStockCantidad(currentUser.localId, pid);
  $("venta-stock-info").textContent = `Disponible en tu local: ${disponible} unidades`;
}

$("venta-submit-btn").addEventListener("click", async () => {
  const productId = $("venta-producto").value;
  const cantidad = parseInt($("venta-cantidad").value, 10);
  const cliente = $("venta-cliente").value.trim();
  const observaciones = $("venta-observaciones").value.trim();
  const errorEl = $("venta-error");
  errorEl.classList.add("hidden");

  if (!productId || !cantidad || cantidad < 1) {
    errorEl.textContent = "Elegí un producto y una cantidad válida.";
    errorEl.classList.remove("hidden");
    return;
  }

  const disponible = getStockCantidad(currentUser.localId, productId);
  if (cantidad > disponible) {
    errorEl.textContent = `Stock insuficiente. Este local tiene solamente ${disponible} unidades.`;
    errorEl.classList.remove("hidden");
    return;
  }

  try {
    await db.collection("sales").add({
      productId,
      productNombre: cache.products[productId]?.nombre || "",
      cantidad,
      localId: currentUser.localId,
      usuarioUid: currentUser.uid,
      usuarioNombre: currentUser.nombre,
      cliente: cliente || null,
      observaciones: observaciones || null,
      estado: "pendiente",
      fechaCreacion: firebase.firestore.FieldValue.serverTimestamp()
    });
    $("modal-venta").classList.add("hidden");
    showToast("Venta enviada correctamente. Está pendiente de aprobación.", "success");
  } catch (err) {
    console.error(err);
    errorEl.textContent = "No se pudo enviar la venta. Intentá de nuevo.";
    errorEl.classList.remove("hidden");
  }
});

// ----- Nueva entrada de mercadería -----

$("btn-nueva-entrada")?.addEventListener("click", () => openEntradaModal());

function openEntradaModal(productId) {
  fillProductSelect($("entrada-producto"));
  if (productId) $("entrada-producto").value = productId;
  $("entrada-cantidad").value = 1;
  $("entrada-notas").value = "";
  $("entrada-error").classList.add("hidden");
  $("modal-entrada").classList.remove("hidden");
}

$("entrada-submit-btn").addEventListener("click", async () => {
  const productId = $("entrada-producto").value;
  const cantidad = parseInt($("entrada-cantidad").value, 10);
  const notas = $("entrada-notas").value.trim();
  const errorEl = $("entrada-error");
  errorEl.classList.add("hidden");

  if (!productId || !cantidad || cantidad < 1) {
    errorEl.textContent = "Elegí un producto y una cantidad válida.";
    errorEl.classList.remove("hidden");
    return;
  }

  const localId = currentUser.rol === "admin" ? activeStockLocaleTab : currentUser.localId;

  try {
    await db.collection("entries").add({
      productId,
      productNombre: cache.products[productId]?.nombre || "",
      cantidad,
      localId,
      usuarioUid: currentUser.uid,
      usuarioNombre: currentUser.nombre,
      notas: notas || null,
      estado: "pendiente",
      fechaCreacion: firebase.firestore.FieldValue.serverTimestamp()
    });
    $("modal-entrada").classList.add("hidden");
    showToast("Entrada solicitada. Queda pendiente de aprobación.", "success");
  } catch (err) {
    console.error(err);
    errorEl.textContent = "No se pudo enviar la solicitud. Intentá de nuevo.";
    errorEl.classList.remove("hidden");
  }
});

// ----- Nueva transferencia -----

$("btn-nueva-transferencia")?.addEventListener("click", () => openTransferenciaModal());

function openTransferenciaModal(productId, localOrigenPreset) {
  fillProductSelect($("transferencia-producto"));
  populateLocaleSelects();
  if (productId) $("transferencia-producto").value = productId;
  if (localOrigenPreset && currentUser.rol === "admin") $("transferencia-origen").value = localOrigenPreset;
  $("transferencia-cantidad").value = 1;
  $("transferencia-error").classList.add("hidden");
  updateTransferenciaStockInfo();
  $("modal-transferencia").classList.remove("hidden");
}

["transferencia-producto", "transferencia-origen", "transferencia-cantidad"].forEach((id) => {
  $(id).addEventListener("input", updateTransferenciaStockInfo);
  $(id).addEventListener("change", updateTransferenciaStockInfo);
});

function updateTransferenciaStockInfo() {
  const pid = $("transferencia-producto").value;
  const origen = $("transferencia-origen").value;
  const disponible = getStockCantidad(origen, pid);
  $("transferencia-stock-info").textContent = `Disponible en ${LOCALES[origen]}: ${disponible} unidades`;
}

$("transferencia-submit-btn").addEventListener("click", async () => {
  const productId = $("transferencia-producto").value;
  const localOrigen = $("transferencia-origen").value;
  const localDestino = $("transferencia-destino").value;
  const cantidad = parseInt($("transferencia-cantidad").value, 10);
  const errorEl = $("transferencia-error");
  errorEl.classList.add("hidden");

  if (!productId || !cantidad || cantidad < 1) {
    errorEl.textContent = "Elegí un producto y una cantidad válida.";
    errorEl.classList.remove("hidden");
    return;
  }
  if (localOrigen === localDestino) {
    errorEl.textContent = "El local de origen y destino no pueden ser el mismo.";
    errorEl.classList.remove("hidden");
    return;
  }
  const disponible = getStockCantidad(localOrigen, productId);
  if (cantidad > disponible) {
    errorEl.textContent = `Stock insuficiente en ${LOCALES[localOrigen]}. Solamente hay ${disponible} unidades.`;
    errorEl.classList.remove("hidden");
    return;
  }

  try {
    await db.collection("transfers").add({
      productId,
      productNombre: cache.products[productId]?.nombre || "",
      cantidad,
      localOrigen,
      localDestino,
      usuarioUid: currentUser.uid,
      usuarioNombre: currentUser.nombre,
      estado: "pendiente",
      fechaCreacion: firebase.firestore.FieldValue.serverTimestamp()
    });
    $("modal-transferencia").classList.add("hidden");
    showToast("Transferencia solicitada. Queda pendiente de aprobación.", "success");
  } catch (err) {
    console.error(err);
    errorEl.textContent = "No se pudo enviar la solicitud. Intentá de nuevo.";
    errorEl.classList.remove("hidden");
  }
});

// ----- Ajuste manual de stock (admin) -----

let ajusteContext = null;

function openAjusteModal(localId, productId) {
  ajusteContext = { localId, productId };
  const actual = getStockCantidad(localId, productId);
  $("ajuste-info").textContent = `${LOCALES[localId]} · ${cache.products[productId]?.nombre} · Stock actual: ${actual}`;
  $("ajuste-cantidad").value = actual;
  $("ajuste-motivo").value = "";
  $("ajuste-error").classList.add("hidden");
  $("modal-ajuste").classList.remove("hidden");
}

$("ajuste-submit-btn").addEventListener("click", async () => {
  const nuevaCantidad = parseInt($("ajuste-cantidad").value, 10);
  const motivo = $("ajuste-motivo").value.trim();
  const errorEl = $("ajuste-error");
  errorEl.classList.add("hidden");

  if (isNaN(nuevaCantidad) || nuevaCantidad < 0) {
    errorEl.textContent = "Ingresá una cantidad válida (0 o mayor).";
    errorEl.classList.remove("hidden");
    return;
  }

  const { localId, productId } = ajusteContext;
  const stockRef = db.collection("stock").doc(stockKey(localId, productId));
  const movementRef = db.collection("movements").doc();

  try {
    await db.runTransaction(async (tx) => {
      const stockDoc = await tx.get(stockRef);
      const stockAntes = stockDoc.exists ? stockDoc.data().cantidad : 0;

      tx.set(stockRef, { localId, productId, cantidad: nuevaCantidad }, { merge: true });
      tx.set(movementRef, {
        tipo: "ajuste",
        productId,
        productNombre: cache.products[productId]?.nombre || "",
        cantidad: nuevaCantidad - stockAntes,
        localId,
        usuarioNombre: currentUser.nombre,
        administradorNombre: currentUser.nombre,
        motivo: motivo || null,
        stockAntes,
        stockDespues: nuevaCantidad,
        estado: "aprobada",
        fecha: firebase.firestore.FieldValue.serverTimestamp()
      });
    });
    $("modal-ajuste").classList.add("hidden");
    showToast("Stock ajustado correctamente.", "success");
  } catch (err) {
    console.error(err);
    errorEl.textContent = "No se pudo guardar el ajuste. Intentá de nuevo.";
    errorEl.classList.remove("hidden");
  }
});

// ---------------------------------------------------------
// 6. APROBACIÓN / RECHAZO (transacciones atómicas)
// ---------------------------------------------------------

async function handleApprove(tipo, id) {
  if (currentUser.rol !== "admin") return;
  try {
    if (tipo === "venta") await approveSale(id);
    else if (tipo === "transferencia") await approveTransfer(id);
    else if (tipo === "entrada") await approveEntry(id);
    showToast("Aprobado correctamente.", "success");
  } catch (err) {
    console.error(err);
    showToast(err.message || "No se pudo aprobar. Verificá el stock disponible.", "error");
  }
}

async function handleReject(tipo, id) {
  if (currentUser.rol !== "admin") return;
  try {
    if (tipo === "venta") await rejectSale(id);
    else if (tipo === "transferencia") await rejectTransfer(id);
    else if (tipo === "entrada") await rejectEntry(id);
    showToast("Rechazado.", "success");
  } catch (err) {
    console.error(err);
    showToast("No se pudo rechazar. Intentá de nuevo.", "error");
  }
}

async function approveSale(saleId) {
  const saleRef = db.collection("sales").doc(saleId);
  const movementRef = db.collection("movements").doc();

  await db.runTransaction(async (tx) => {
    const saleDoc = await tx.get(saleRef);
    if (!saleDoc.exists || saleDoc.data().estado !== "pendiente") throw new Error("Esta venta ya fue procesada.");
    const sale = saleDoc.data();

    const stockRef = db.collection("stock").doc(stockKey(sale.localId, sale.productId));
    const stockDoc = await tx.get(stockRef);
    const stockAntes = stockDoc.exists ? stockDoc.data().cantidad : 0;

    // Re-chequeo de stock negativo al momento de aprobar (puede haber cambiado).
    if (stockAntes < sale.cantidad) {
      throw new Error(`Stock insuficiente. ${LOCALES[sale.localId]} tiene solamente ${stockAntes} unidades.`);
    }

    const stockDespues = stockAntes - sale.cantidad;
    tx.set(stockRef, { localId: sale.localId, productId: sale.productId, cantidad: stockDespues }, { merge: true });

    tx.update(saleRef, {
      estado: "aprobada",
      aprobadoPorUid: currentUser.uid,
      aprobadoPorNombre: currentUser.nombre,
      fechaResolucion: firebase.firestore.FieldValue.serverTimestamp()
    });

    tx.set(movementRef, {
      tipo: "venta",
      productId: sale.productId,
      productNombre: sale.productNombre,
      cantidad: sale.cantidad,
      localId: sale.localId,
      usuarioNombre: sale.usuarioNombre,
      administradorNombre: currentUser.nombre,
      stockAntes,
      stockDespues,
      estado: "aprobada",
      fecha: firebase.firestore.FieldValue.serverTimestamp()
    });
  });
}

async function rejectSale(saleId) {
  const saleRef = db.collection("sales").doc(saleId);
  const movementRef = db.collection("movements").doc();

  await db.runTransaction(async (tx) => {
    const saleDoc = await tx.get(saleRef);
    if (!saleDoc.exists || saleDoc.data().estado !== "pendiente") throw new Error("Esta venta ya fue procesada.");
    const sale = saleDoc.data();

    tx.update(saleRef, {
      estado: "rechazada",
      aprobadoPorUid: currentUser.uid,
      aprobadoPorNombre: currentUser.nombre,
      fechaResolucion: firebase.firestore.FieldValue.serverTimestamp()
    });

    tx.set(movementRef, {
      tipo: "venta",
      productId: sale.productId,
      productNombre: sale.productNombre,
      cantidad: sale.cantidad,
      localId: sale.localId,
      usuarioNombre: sale.usuarioNombre,
      administradorNombre: currentUser.nombre,
      estado: "rechazada",
      fecha: firebase.firestore.FieldValue.serverTimestamp()
    });
  });
}

async function approveTransfer(transferId) {
  const transferRef = db.collection("transfers").doc(transferId);
  const movementRef = db.collection("movements").doc();

  await db.runTransaction(async (tx) => {
    const transferDoc = await tx.get(transferRef);
    if (!transferDoc.exists || transferDoc.data().estado !== "pendiente") throw new Error("Esta transferencia ya fue procesada.");
    const transfer = transferDoc.data();

    const origenRef = db.collection("stock").doc(stockKey(transfer.localOrigen, transfer.productId));
    const destinoRef = db.collection("stock").doc(stockKey(transfer.localDestino, transfer.productId));

    const origenDoc = await tx.get(origenRef);
    const destinoDoc = await tx.get(destinoRef);
    const origenAntes = origenDoc.exists ? origenDoc.data().cantidad : 0;
    const destinoAntes = destinoDoc.exists ? destinoDoc.data().cantidad : 0;

    if (origenAntes < transfer.cantidad) {
      throw new Error(`Stock insuficiente en ${LOCALES[transfer.localOrigen]}. Solamente hay ${origenAntes} unidades.`);
    }

    const origenDespues = origenAntes - transfer.cantidad;
    const destinoDespues = destinoAntes + transfer.cantidad;

    tx.set(origenRef, { localId: transfer.localOrigen, productId: transfer.productId, cantidad: origenDespues }, { merge: true });
    tx.set(destinoRef, { localId: transfer.localDestino, productId: transfer.productId, cantidad: destinoDespues }, { merge: true });

    tx.update(transferRef, {
      estado: "aprobada",
      aprobadoPorUid: currentUser.uid,
      aprobadoPorNombre: currentUser.nombre,
      fechaResolucion: firebase.firestore.FieldValue.serverTimestamp()
    });

    tx.set(movementRef, {
      tipo: "transferencia",
      productId: transfer.productId,
      productNombre: transfer.productNombre,
      cantidad: transfer.cantidad,
      localId: transfer.localOrigen,
      localDestino: transfer.localDestino,
      usuarioNombre: transfer.usuarioNombre,
      administradorNombre: currentUser.nombre,
      stockAntes: origenAntes,
      stockDespues: origenDespues,
      estado: "aprobada",
      fecha: firebase.firestore.FieldValue.serverTimestamp()
    });
  });
}

async function rejectTransfer(transferId) {
  const transferRef = db.collection("transfers").doc(transferId);
  const movementRef = db.collection("movements").doc();

  await db.runTransaction(async (tx) => {
    const transferDoc = await tx.get(transferRef);
    if (!transferDoc.exists || transferDoc.data().estado !== "pendiente") throw new Error("Esta transferencia ya fue procesada.");
    const transfer = transferDoc.data();

    tx.update(transferRef, {
      estado: "rechazada",
      aprobadoPorUid: currentUser.uid,
      aprobadoPorNombre: currentUser.nombre,
      fechaResolucion: firebase.firestore.FieldValue.serverTimestamp()
    });

    tx.set(movementRef, {
      tipo: "transferencia",
      productId: transfer.productId,
      productNombre: transfer.productNombre,
      cantidad: transfer.cantidad,
      localId: transfer.localOrigen,
      localDestino: transfer.localDestino,
      usuarioNombre: transfer.usuarioNombre,
      administradorNombre: currentUser.nombre,
      estado: "rechazada",
      fecha: firebase.firestore.FieldValue.serverTimestamp()
    });
  });
}

async function approveEntry(entryId) {
  const entryRef = db.collection("entries").doc(entryId);
  const movementRef = db.collection("movements").doc();

  await db.runTransaction(async (tx) => {
    const entryDoc = await tx.get(entryRef);
    if (!entryDoc.exists || entryDoc.data().estado !== "pendiente") throw new Error("Esta entrada ya fue procesada.");
    const entry = entryDoc.data();

    const stockRef = db.collection("stock").doc(stockKey(entry.localId, entry.productId));
    const stockDoc = await tx.get(stockRef);
    const stockAntes = stockDoc.exists ? stockDoc.data().cantidad : 0;
    const stockDespues = stockAntes + entry.cantidad;

    tx.set(stockRef, { localId: entry.localId, productId: entry.productId, cantidad: stockDespues }, { merge: true });

    tx.update(entryRef, {
      estado: "aprobada",
      aprobadoPorUid: currentUser.uid,
      aprobadoPorNombre: currentUser.nombre,
      fechaResolucion: firebase.firestore.FieldValue.serverTimestamp()
    });

    tx.set(movementRef, {
      tipo: "entrada",
      productId: entry.productId,
      productNombre: entry.productNombre,
      cantidad: entry.cantidad,
      localId: entry.localId,
      usuarioNombre: entry.usuarioNombre,
      administradorNombre: currentUser.nombre,
      stockAntes,
      stockDespues,
      estado: "aprobada",
      fecha: firebase.firestore.FieldValue.serverTimestamp()
    });
  });
}

async function rejectEntry(entryId) {
  const entryRef = db.collection("entries").doc(entryId);
  const movementRef = db.collection("movements").doc();

  await db.runTransaction(async (tx) => {
    const entryDoc = await tx.get(entryRef);
    if (!entryDoc.exists || entryDoc.data().estado !== "pendiente") throw new Error("Esta entrada ya fue procesada.");
    const entry = entryDoc.data();

    tx.update(entryRef, {
      estado: "rechazada",
      aprobadoPorUid: currentUser.uid,
      aprobadoPorNombre: currentUser.nombre,
      fechaResolucion: firebase.firestore.FieldValue.serverTimestamp()
    });

    tx.set(movementRef, {
      tipo: "entrada",
      productId: entry.productId,
      productNombre: entry.productNombre,
      cantidad: entry.cantidad,
      localId: entry.localId,
      usuarioNombre: entry.usuarioNombre,
      administradorNombre: currentUser.nombre,
      estado: "rechazada",
      fecha: firebase.firestore.FieldValue.serverTimestamp()
    });
  });
}

// ---------------------------------------------------------
// 7. PRODUCTOS (admin)
// ---------------------------------------------------------

function renderProductsAdminView() {
  if (currentUser.rol !== "admin") return;
  const list = Object.entries(cache.products).sort((a, b) => a[1].nombre.localeCompare(b[1].nombre));

  $("products-admin-list").innerHTML =
    list
      .map(([pid, p]) => {
        const total = getStockTotal(pid);
        const chips = Object.entries(LOCALES)
          .map(([lid, lnombre]) => `<span class="stock-chip">${lnombre}: ${getStockCantidad(lid, pid)}</span>`)
          .join("");
        return `<div class="product-card">
          <div class="product-card-top">
            <div>
              <h4>${p.nombre} ${p.activo === false ? "<span class='pill pill-rechazada'>Inactivo</span>" : ""}</h4>
              <div class="product-meta">${[p.categoria, p.medida].filter(Boolean).join(" · ")}</div>
            </div>
            <div class="product-stock">${total}</div>
          </div>
          <div class="stock-breakdown">${chips}</div>
          <div class="product-card-actions">
            <button class="btn btn-outline btn-small btn-editar-producto" data-id="${pid}">Editar</button>
          </div>
        </div>`;
      })
      .join("") || `<div class="empty-state">Todavía no cargaste productos.</div>`;

  document.querySelectorAll(".btn-editar-producto").forEach((btn) => {
    btn.addEventListener("click", () => openProductoModal(btn.dataset.id));
  });
}

$("btn-nuevo-producto")?.addEventListener("click", () => openProductoModal(null));

function openProductoModal(productId) {
  const isEdit = !!productId;
  $("producto-modal-title").textContent = isEdit ? "Editar producto" : "Nuevo producto";
  $("producto-id").value = productId || "";
  const p = isEdit ? cache.products[productId] : {};
  $("producto-nombre").value = p.nombre || "";
  $("producto-categoria").value = p.categoria || "";
  $("producto-medida").value = p.medida || "";
  $("producto-notas").value = p.notas || "";
  $("producto-imagen").value = p.imagenUrl || "";
  $("producto-activo").checked = p.activo !== false;
  $("producto-error").classList.add("hidden");
  $("modal-producto").classList.remove("hidden");
}

$("producto-submit-btn").addEventListener("click", async () => {
  const id = $("producto-id").value;
  const nombre = $("producto-nombre").value.trim();
  const errorEl = $("producto-error");
  errorEl.classList.add("hidden");

  if (!nombre) {
    errorEl.textContent = "El nombre del producto es obligatorio.";
    errorEl.classList.remove("hidden");
    return;
  }

  const data = {
    nombre,
    categoria: $("producto-categoria").value.trim() || null,
    medida: $("producto-medida").value.trim() || null,
    notas: $("producto-notas").value.trim() || null,
    imagenUrl: $("producto-imagen").value.trim() || null,
    activo: $("producto-activo").checked
  };

  try {
    if (id) {
      await db.collection("products").doc(id).update(data);
    } else {
      const newDoc = await db.collection("products").add({ ...data, creadoPor: currentUser.nombre, fechaCreacion: firebase.firestore.FieldValue.serverTimestamp() });
      // Inicializa stock en 0 para los 4 locales
      const batch = db.batch();
      Object.keys(LOCALES).forEach((localId) => {
        batch.set(db.collection("stock").doc(stockKey(localId, newDoc.id)), { localId, productId: newDoc.id, cantidad: 0 });
      });
      await batch.commit();
    }
    $("modal-producto").classList.add("hidden");
    showToast("Producto guardado.", "success");
  } catch (err) {
    console.error(err);
    errorEl.textContent = "No se pudo guardar el producto. Intentá de nuevo.";
    errorEl.classList.remove("hidden");
  }
});

// ---------------------------------------------------------
// 9. DATOS DE PRUEBA
// ---------------------------------------------------------

$("seed-data-btn")?.addEventListener("click", async () => {
  if (!confirm("Esto va a crear productos y stock de ejemplo. ¿Continuar?")) return;
  try {
    await seedTestData();
    showToast("Datos de prueba cargados.", "success");
  } catch (err) {
    console.error(err);
    showToast("No se pudieron cargar los datos de prueba.", "error");
  }
});

async function seedTestData() {
  const productosDemo = [
    { nombre: "Dakar 0,80 x 1,90", categoria: "Colchones", medida: "0,80 x 1,90" },
    { nombre: "Dakar 1,00 x 1,90", categoria: "Colchones", medida: "1,00 x 1,90" },
    { nombre: "Dakar 1,40 x 1,90", categoria: "Colchones", medida: "1,40 x 1,90" },
    { nombre: "Dakar 1,60 x 1,90", categoria: "Colchones", medida: "1,60 x 1,90" },
    { nombre: "Piero Outlet 0,80", categoria: "Colchones", medida: "0,80" },
    { nombre: "Piero Outlet 1,00", categoria: "Colchones", medida: "1,00" },
    { nombre: "Piero Outlet 1,40", categoria: "Colchones", medida: "1,40" },
    { nombre: "Base 0,80", categoria: "Sommiers", medida: "0,80" },
    { nombre: "Base 1,00", categoria: "Sommiers", medida: "1,00" },
    { nombre: "Base 1,40", categoria: "Sommiers", medida: "1,40" },
    { nombre: "Respaldo 0,80", categoria: "Respaldos", medida: "0,80" },
    { nombre: "Respaldo 1,00", categoria: "Respaldos", medida: "1,00" },
    { nombre: "Respaldo 1,40", categoria: "Respaldos", medida: "1,40" },
    { nombre: "Living", categoria: "Muebles", medida: null },
    { nombre: "Mesa", categoria: "Muebles", medida: null },
    { nombre: "Silla", categoria: "Muebles", medida: null }
  ];

  const batch = db.batch();
  productosDemo.forEach((p) => {
    const ref = db.collection("products").doc();
    batch.set(ref, { ...p, notas: null, imagenUrl: null, activo: true, fechaCreacion: firebase.firestore.FieldValue.serverTimestamp() });
    Object.keys(LOCALES).forEach((localId) => {
      const cantidad = Math.floor(Math.random() * 20);
      batch.set(db.collection("stock").doc(stockKey(localId, ref.id)), { localId, productId: ref.id, cantidad });
    });
  });
  await batch.commit();
}
