(function () {
  'use strict';

  const data = window.PEREIRA_DATA;
  const STORAGE_URL = '/api/storage';
  const CONFIRM_URL = '/api/confirm';
  const GEOCODE_URL = '/api/geocode';
  const SHELTER_NEEDS_URL = '/api/shelter-needs';
  const MODERATOR_URL = '/api/moderator';
  const CONFIRMED_LOCAL_KEY = 'pereira-confirmed-reports-v1';
  const NEARBY_RADIUS_KM = 3;
  const STORAGE_KEYS = { acopio: 'acopio-reports', riesgo: 'riesgo-reports', comercio: 'comercio-reports' };
  const COLORS = {
    acopio: '#4C8DFF', riesgo: '#E4483C', zona: '#E8B339',
    hospital: '#D86EFF', albergue: '#35C48B', comercio: '#FF8A4C'
  };
  const MAP_CATEGORIES = [
    ['zona', '🏚️', 'Zonas'], ['hospital', '🏥', 'Hospitales'],
    ['acopio', '📦', 'Acopios'], ['albergue', '🛟', 'Albergues'],
    ['riesgo', '⚠️', 'Reportes'], ['comercio', '🛒', 'Comercios']
  ];
  const SHELTER_NEEDS = [
    ['water', '💧', 'Agua'], ['food', '🥫', 'Alimentos'], ['clothing', '🧥', 'Ropa y abrigo'],
    ['medical', '💊', 'Medicamentos'], ['shelter', '⛺', 'Carpas y colchonetas'],
    ['hygiene', '🧼', 'Higiene'], ['baby', '🍼', 'Artículos para bebés']
  ];

  let activeTab = 'todos';
  let reports = { acopio: [], riesgo: [], comercio: [] };
  let map;
  let categoryLayers = {};
  let reportMarkers = [];
  let locationLayer;
  let pickMap;
  let pickMarker;
  let pickedLocation = null;
  let formType = 'acopio';
  let locationRequest = 0;
  let manualLocationMode = false;
  let shelterNeeds = {};
  let shelterNeedProposals = [];
  let editingShelterId = null;

  function byId(id) { return document.getElementById(id); }

  function escapeHtml(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#039;');
  }

  function validCoordinates(item) {
    return item.lat !== null && item.lat !== '' && item.lng !== null && item.lng !== '' &&
      Number.isFinite(Number(item.lat)) && Number.isFinite(Number(item.lng));
  }

  function normalizeReport(item, type) {
    if (!item || typeof item !== 'object') return null;
    const address = String(item.address || item.addr || '').trim();
    if (!address) return null;
    return {
      id: String(item.id || `${Date.now()}-${Math.random().toString(36).slice(2)}`).replace(/[^a-zA-Z0-9_-]/g, ''),
      type,
      address,
      barrio: String(item.barrio || '').trim(),
      need: String(item.need || '').trim(),
      severity: String(item.severity || item.sev || '').trim(),
      description: String(item.description || item.desc || '').trim(),
      name: String(item.name || '').trim(),
      category: String(item.category || '').trim(),
      hours: String(item.hours || '').trim(),
      products: String(item.products || '').trim(),
      payment: String(item.payment || '').trim(),
      lat: validCoordinates(item) ? Number(item.lat) : null,
      lng: validCoordinates(item) ? Number(item.lng) : null,
      createdAt: item.createdAt || item.created || new Date().toISOString(),
      verified: false,
      confirmations: Math.max(0, Number(item.confirmations || item.confirms || 0) || 0)
    };
  }

  function parseStoredValue(payload, type) {
    let value = payload && Object.prototype.hasOwnProperty.call(payload, 'value') ? payload.value : payload;
    if (typeof value === 'string') {
      try { value = JSON.parse(value); } catch { return []; }
    }
    if (!Array.isArray(value)) return [];
    return value.map(item => normalizeReport(item, type)).filter(Boolean);
  }

  async function readReports(type) {
    const response = await fetch(`${STORAGE_URL}?key=${encodeURIComponent(STORAGE_KEYS[type])}`, {
      headers: { Accept: 'application/json' }, cache: 'no-store'
    });
    if (!response.ok) throw new Error(`No se pudo leer ${type}`);
    return parseStoredValue(await response.json(), type);
  }

  async function writeReports(type) {
    const response = await fetch(STORAGE_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: STORAGE_KEYS[type], value: reports[type] })
    });
    if (!response.ok) throw new Error(`No se pudo guardar ${type}`);
  }

  async function readConfirmationCounts(type) {
    const response = await fetch(`${CONFIRM_URL}?type=${encodeURIComponent(type)}`, {
      headers: { Accept: 'application/json' }, cache: 'no-store'
    });
    if (!response.ok) throw new Error(`No se pudieron leer confirmaciones de ${type}`);
    const payload = await response.json();
    return payload && payload.counts && typeof payload.counts === 'object' ? payload.counts : {};
  }

  function localConfirmationKey(type, id) { return `${type}:${id}`; }

  function locallyConfirmed(type, id) {
    try { return JSON.parse(localStorage.getItem(CONFIRMED_LOCAL_KEY) || '[]').includes(localConfirmationKey(type, id)); }
    catch { return false; }
  }

  function rememberConfirmation(type, id) {
    try {
      const values = new Set(JSON.parse(localStorage.getItem(CONFIRMED_LOCAL_KEY) || '[]'));
      values.add(localConfirmationKey(type, id));
      localStorage.setItem(CONFIRMED_LOCAL_KEY, JSON.stringify([...values].slice(-500)));
    } catch { /* La cookie segura del servidor sigue siendo la fuente de verdad. */ }
  }

  function directionsUrl(lat, lng) {
    return `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(`${Number(lat)},${Number(lng)}`)}`;
  }

  function shelterId(item) {
    return item.n.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  }

  function activeShelterUpdate(id) {
    const update = shelterNeeds[id];
    if (!update || !Array.isArray(update.needs)) return null;
    const age = Date.now() - new Date(update.updatedAt).getTime();
    return Number.isFinite(age) && age >= 0 && age < 12 * 60 * 60 * 1000 ? update : null;
  }

  function relativeUpdateTime(value) {
    const minutes = Math.max(0, Math.floor((Date.now() - new Date(value).getTime()) / 60000));
    if (minutes < 1) return 'ahora';
    if (minutes < 60) return `hace ${minutes} min`;
    return `hace ${Math.floor(minutes / 60)} h`;
  }

  function shelterNeedsHtml(item) {
    const update = activeShelterUpdate(shelterId(item));
    const pending = shelterNeedProposals.filter(proposal => proposal.shelterId === shelterId(item));
    const pendingHtml = pending.map(proposal => {
      const needs = SHELTER_NEEDS.filter(([key]) => proposal.needs.includes(key));
      return `<details class="pending-needs"><summary><span>🟡 Propuesta comunitaria</span><b>${proposal.confirmations} de 5 verificaciones</b></summary><div class="pending-needs-detail"><div class="needs-chips">${needs.map(([, emoji, label]) => `<span>${emoji} ${escapeHtml(label)}</span>`).join('')}</div><small>Confirma únicamente si verificaste estas necesidades en el albergue.</small><button onclick="confirmShelterNeeds('${proposal.id}')">✓ Confirmar propuesta</button></div></details>`;
    }).join('');
    if (!update) return `<div class="needs-empty">Necesidades: sin reporte confirmado</div>${pendingHtml}`;
    const selected = new Set(update.needs);
    const source = update.source === 'moderator-verified' ? 'Verificado por moderación' : 'Confirmado por la comunidad';
    return `<div class="needs-label">Necesidades · ${relativeUpdateTime(update.updatedAt)}</div><div class="needs-chips">${SHELTER_NEEDS.filter(([key]) => selected.has(key)).map(([, emoji, label]) => `<span>${emoji} ${escapeHtml(label)}</span>`).join('')}</div><small class="community-note">${source} · verificar antes de donar</small>${pendingHtml}`;
  }

  async function loadShelterNeeds() {
    const response = await fetch(SHELTER_NEEDS_URL, { cache: 'no-store' });
    if (!response.ok) throw new Error('needs unavailable');
    const payload = await response.json();
    shelterNeeds = payload && payload.updates && typeof payload.updates === 'object' ? payload.updates : {};
    shelterNeedProposals = Array.isArray(payload && payload.pending) ? payload.pending : [];
  }

  function marker(lat, lng, color, title, detail, category, navigable) {
    const tag = category
      ? `<span class="map-tag">${escapeHtml(category)}</span>`
      : '';
    const directions = navigable
      ? `<a class="popup-navigate" href="${directionsUrl(lat, lng)}" target="_blank" rel="noreferrer">↗ Cómo llegar</a>`
      : '';
    return L.circleMarker([lat, lng], {
      radius: 7, color: '#10131A', weight: 2, fillColor: color, fillOpacity: 1
    }).bindPopup(`${tag}<b class="map-popup-title">${escapeHtml(title)}</b><br>${escapeHtml(detail || '')}${directions}`);
  }

  function distanceKm(from, to) {
    const radians = value => value * Math.PI / 180;
    const earthRadiusKm = 6371;
    const dLat = radians(Number(to.lat) - Number(from.lat));
    const dLng = radians(Number(to.lng) - Number(from.lng));
    const lat1 = radians(Number(from.lat));
    const lat2 = radians(Number(to.lat));
    const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
    return earthRadiusKm * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }

  function nearbyCandidates() {
    return [
      ...data.acopio.map(item => ({ ...item, icon: '📦', type: 'Centro de acopio' })),
      ...data.shelters.map(item => ({ ...item, icon: '🛟', type: 'Albergue' }))
    ];
  }

  function renderNearby(position) {
    const nearby = nearbyCandidates().map(item => ({ ...item, distance: distanceKm(position, item) }))
      .filter(item => item.distance <= NEARBY_RADIUS_KM).sort((a, b) => a.distance - b.distance);
    const results = byId('nearbyResults');
    results.hidden = false;
    results.innerHTML = `<div class="nearby-head"><b>Ayuda a menos de 3 km</b><button aria-label="Cerrar lista" onclick="clearNearby()">×</button></div>` +
      (nearby.length ? nearby.map(item => `<article class="nearby-item"><button class="nearby-focus" onclick="focusNearby(${Number(item.lat)},${Number(item.lng)})"><span class="nearby-icon">${item.icon}</span><span><b>${escapeHtml(item.n)}</b><small>${escapeHtml(item.type)} · ${escapeHtml(item.d || '')}</small></span><strong>${item.distance.toFixed(1).replace('.', ',')} km</strong></button><a class="navigate-btn" href="https://www.google.com/maps/dir/?api=1&amp;destination=${encodeURIComponent(`${Number(item.lat)},${Number(item.lng)}`)}" target="_blank" rel="noreferrer">↗ Cómo llegar</a></article>`).join('') :
        '<div class="nearby-empty">No hay puntos registrados dentro de 3 km. Verifique los canales oficiales.</div>') +
      '<div class="nearby-note">Distancias en línea recta. La ruta puede estar bloqueada o no ser segura.</div>';
  }

  function applyNearbyLocation(current, approximate) {
    locationLayer.clearLayers();
    L.circle(current, { radius: NEARBY_RADIUS_KM * 1000, color: COLORS.acopio, weight: 2, fillColor: COLORS.acopio, fillOpacity: .08 }).addTo(locationLayer);
    L.circleMarker(current, { radius: 8, color: '#fff', weight: 3, fillColor: COLORS.acopio, fillOpacity: 1 })
      .bindPopup(`<b>📍 ${approximate ? 'Ubicación seleccionada' : 'Tu ubicación aproximada'}</b><br>No se guarda ni se comparte.`).addTo(locationLayer);
    map.fitBounds(L.circle(current, { radius: NEARBY_RADIUS_KM * 1000 }).getBounds(), { padding: [18, 18] });
    renderNearby(current);
    const button = byId('nearbyBtn');
    button.disabled = false;
    button.textContent = '✓ Ubicación activada';
  }

  function showLocationFallback(message) {
    const button = byId('nearbyBtn');
    button.disabled = false;
    button.textContent = '📍 Ver ayuda cerca de mí';
    const results = byId('nearbyResults');
    results.hidden = false;
    results.innerHTML = `<div class="nearby-head"><b>No pudimos ubicarte</b><button aria-label="Cerrar lista" onclick="clearNearby()">×</button></div><div class="nearby-empty">${escapeHtml(message)}</div><div class="nearby-fallback"><button onclick="findNearby()">Reintentar</button><button onclick="pickNearbyLocation()">Elegir en el mapa</button></div>`;
  }

  function initMap() {
    map = L.map('map', { zoomControl: true }).setView(data.center, 13);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19, attribution: '&copy; OpenStreetMap'
    }).addTo(map);

    MAP_CATEGORIES.forEach(([key]) => { categoryLayers[key] = L.layerGroup().addTo(map); });
    data.zones.forEach(item => marker(item.lat, item.lng, COLORS.zona, item.n, item.d, '🏚️ Edificio / zona afectada').addTo(categoryLayers.zona));
    data.hospitals.forEach(item => marker(item.lat, item.lng, COLORS.hospital, item.n, item.d, '🏥 Hospital').addTo(categoryLayers.hospital));
    data.acopio.forEach(item => marker(item.lat, item.lng, COLORS.acopio, item.n, item.d, '📦 Centro de acopio', true).addTo(categoryLayers.acopio));
    data.shelters.forEach(item => marker(item.lat, item.lng, COLORS.albergue, item.n, item.d, '🛟 Albergue', true).addTo(categoryLayers.albergue));
    locationLayer = L.layerGroup().addTo(map);
    map.on('click', event => {
      if (!manualLocationMode) return;
      manualLocationMode = false;
      map.getContainer().classList.remove('picking-location');
      applyNearbyLocation({ lat: event.latlng.lat, lng: event.latlng.lng }, true);
    });

    byId('legend').innerHTML = [
      ['zona', 'Zona afectada'], ['hospital', 'Hospital'], ['acopio', 'Acopio'],
      ['albergue', 'Albergue'], ['riesgo', 'Reporte'], ['comercio', 'Comercio reportado']
    ].map(([key, label]) => `<span><i class="dot" style="background:${COLORS[key]}"></i>${label}</span>`).join('');
    byId('mapFilters').innerHTML = MAP_CATEGORIES.map(([key, emoji, label]) =>
      `<button class="map-filter active" data-category="${key}" aria-pressed="true" onclick="toggleMapFilter('${key}')"><i style="background:${COLORS[key]}"></i><span>${emoji} ${label}</span></button>`
    ).join('');
  }

  window.toggleMapFilter = function (category) {
    const layer = categoryLayers[category];
    if (!layer) return;
    const visible = map.hasLayer(layer);
    if (visible) map.removeLayer(layer); else layer.addTo(map);
    const button = byId('mapFilters').querySelector(`[data-category="${category}"]`);
    if (button) {
      button.classList.toggle('active', !visible);
      button.setAttribute('aria-pressed', String(!visible));
    }
  };

  window.findNearby = function () {
    const request = ++locationRequest;
    const button = byId('nearbyBtn');
    if (!navigator.geolocation) {
      alert('Este navegador no permite obtener la ubicación.');
      return;
    }
    button.disabled = true;
    button.textContent = '📍 Ubicando…';
    const results = byId('nearbyResults');
    results.hidden = false;
    results.innerHTML = '<div class="nearby-loading">📍 Esperando permiso de ubicación…</div>';
    const fallbackTimer = setTimeout(() => {
      if (request !== locationRequest) return;
      locationRequest += 1;
      showLocationFallback('El navegador no respondió a tiempo, aunque el permiso puede estar activo. Puedes reintentar o marcar tu ubicación aproximada en el mapa.');
    }, 12000);
    navigator.geolocation.getCurrentPosition(position => {
      if (request !== locationRequest) return;
      clearTimeout(fallbackTimer);
      const current = { lat: position.coords.latitude, lng: position.coords.longitude };
      applyNearbyLocation(current, false);
    }, error => {
      if (request !== locationRequest) return;
      clearTimeout(fallbackTimer);
      button.disabled = false;
      button.textContent = '📍 Ver ayuda cerca de mí';
      const message = error.code === 1 ? 'No se concedió permiso para usar la ubicación.' : 'No fue posible obtener tu ubicación. Inténtalo de nuevo.';
      showLocationFallback(message);
    }, { enableHighAccuracy: false, timeout: 10000, maximumAge: 300000 });
  };

  window.pickNearbyLocation = function () {
    locationRequest += 1;
    manualLocationMode = true;
    byId('nearbyResults').innerHTML = '<div class="nearby-loading">📌 Toca tu ubicación aproximada en el mapa.</div>';
    map.getContainer().classList.add('picking-location');
  };

  window.clearNearby = function () {
    locationRequest += 1;
    manualLocationMode = false;
    map.getContainer().classList.remove('picking-location');
    locationLayer.clearLayers();
    byId('nearbyResults').hidden = true;
    byId('nearbyBtn').textContent = '📍 Ver ayuda cerca de mí';
    map.setView(data.center, 13);
  };

  window.focusNearby = function (lat, lng) {
    map.setView([lat, lng], 17);
    window.scrollTo({ top: byId('map').getBoundingClientRect().top + window.scrollY - 80, behavior: 'smooth' });
  };

  function renderStaticContent() {
    byId('officialAlerts').innerHTML = '<div class="ah"><span>Alertas oficiales reportadas</span><span>Verifique vigencia</span></div>' +
      data.alerts.map(item => `<div class="alertitem"><b>${escapeHtml(item.title)}</b> ${escapeHtml(item.text)}</div>`).join('');

    byId('shelterList').innerHTML = data.shelters.map(item => {
      const label = item.status === 'ok' ? 'Disponible' : item.status === 'full' ? 'Aforo límite' : 'Verificar';
      const severityClass = item.status === 'ok' ? 'alto' : '';
      const id = shelterId(item);
      return `<div class="zone shelter-zone ${severityClass}"><div class="shelter-main"><div class="zn">${escapeHtml(item.n)}</div><div class="zd">${escapeHtml(item.d)}</div>${shelterNeedsHtml(item)}</div><div class="zone-actions"><span class="tag">${label}</span><a class="zone-nav" href="${directionsUrl(item.lat, item.lng)}" target="_blank" rel="noreferrer">↗ Cómo llegar</a><button class="needs-update" onclick="openNeedsForm('${id}')">✏️ Actualizar necesidades</button></div></div>`;
    }).join('');

    byId('acopioList').innerHTML = data.acopio.map(item =>
      `<div class="zone alto"><div><div class="zn">${escapeHtml(item.n)}</div><div class="zd">${escapeHtml(item.d)}</div></div><div class="zone-actions"><span class="tag">Acopio</span><a class="zone-nav" href="${directionsUrl(item.lat, item.lng)}" target="_blank" rel="noreferrer">↗ Cómo llegar</a></div></div>`
    ).join('');

    byId('newsList').innerHTML = data.news.map(item =>
      `<article class="newsitem"><div class="nh"><span class="src">${escapeHtml(item.src)}</span><span>${escapeHtml(item.date)}</span></div><p>${escapeHtml(item.text)}</p></article>`
    ).join('');
  }

  window.openNeedsForm = function (id) {
    const shelter = data.shelters.find(item => shelterId(item) === id);
    if (!shelter) return;
    editingShelterId = id;
    const current = activeShelterUpdate(id);
    const selected = new Set(current ? current.needs : []);
    byId('needsShelterName').textContent = shelter.n;
    byId('needPicker').innerHTML = SHELTER_NEEDS.map(([key, emoji, label]) => `<label><input type="checkbox" value="${key}" ${selected.has(key) ? 'checked' : ''}><span>${emoji}<b>${escapeHtml(label)}</b></span></label>`).join('');
    byId('needsOverlay').style.display = 'flex';
    document.body.style.overflow = 'hidden';
  };

  window.closeNeedsForm = function () {
    byId('needsOverlay').style.display = 'none';
    document.body.style.overflow = '';
    editingShelterId = null;
  };

  window.submitShelterNeeds = async function () {
    if (!editingShelterId) return;
    const needs = [...byId('needPicker').querySelectorAll('input:checked')].map(input => input.value);
    if (!needs.length) return alert('Selecciona al menos una necesidad actual.');
    const button = byId('needsSubmitBtn');
    button.disabled = true;
    button.textContent = 'Publicando…';
    try {
      const response = await fetch(SHELTER_NEEDS_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'propose', shelterId: editingShelterId, needs }) });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || 'No fue posible publicar la actualización.');
      closeNeedsForm();
      await loadShelterNeeds();
      renderStaticContent();
      renderReports();
      alert('La propuesta quedó pendiente. Se publicará con 5 confirmaciones únicas o aprobación de moderación.');
    } catch (error) {
      alert(error.message || 'No fue posible publicar la actualización.');
    } finally {
      button.disabled = false;
      button.textContent = 'Publicar actualización';
    }
  };

  window.confirmShelterNeeds = async function (proposalId) {
    try {
      const response = await fetch(SHELTER_NEEDS_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'confirm', proposalId }) });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || 'No fue posible confirmar.');
      await loadShelterNeeds(); renderStaticContent(); renderReports();
      if (!payload.added) alert('Este dispositivo ya había confirmado esta propuesta.');
    } catch (error) { alert(error.message || 'No fue posible confirmar.'); }
  };

  function renderModeratorProposals() {
    byId('moderatorProposals').innerHTML = shelterNeedProposals.length ? shelterNeedProposals.map(proposal => {
      const shelter = data.shelters.find(item => shelterId(item) === proposal.shelterId);
      const needs = SHELTER_NEEDS.filter(([key]) => proposal.needs.includes(key)).map(([, emoji, label]) => `${emoji} ${escapeHtml(label)}`).join(' · ');
      return `<article class="moderator-proposal"><b>${escapeHtml(shelter ? shelter.n : proposal.shelterId)}</b><p>${needs}</p><small>${proposal.confirmations}/5 confirmaciones</small><div><button onclick="moderateShelterProposal('approve','${proposal.id}')">✓ Aprobar</button><button class="reject" onclick="moderateShelterProposal('reject','${proposal.id}')">× Rechazar</button></div></article>`;
    }).join('') : '<div class="empty">No hay propuestas pendientes.</div>';
  }

  window.openModerator = async function () {
    byId('moderatorOverlay').style.display = 'flex'; document.body.style.overflow = 'hidden';
    try {
      const response = await fetch(MODERATOR_URL, { cache: 'no-store' });
      const payload = await response.json();
      const authenticated = response.ok && payload.authenticated;
      byId('moderatorLogin').style.display = authenticated ? 'none' : '';
      byId('moderatorPanel').style.display = authenticated ? '' : 'none';
      if (authenticated) { await loadShelterNeeds(); renderModeratorProposals(); }
    } catch { byId('moderatorLogin').style.display = ''; }
  };
  window.closeModerator = function () { byId('moderatorOverlay').style.display = 'none'; document.body.style.overflow = ''; byId('moderatorPassword').value = ''; };
  window.loginModerator = async function () {
    const response = await fetch(MODERATOR_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: byId('moderatorPassword').value }) });
    const payload = await response.json();
    if (!response.ok) return alert(payload.error || 'No fue posible ingresar.');
    byId('moderatorLogin').style.display = 'none'; byId('moderatorPanel').style.display = '';
    await loadShelterNeeds(); renderModeratorProposals();
  };
  window.logoutModerator = async function () { await fetch(MODERATOR_URL, { method: 'DELETE' }); closeModerator(); };
  window.moderateShelterProposal = async function (action, proposalId) {
    const response = await fetch(SHELTER_NEEDS_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action, proposalId }) });
    const payload = await response.json(); if (!response.ok) return alert(payload.error || 'No fue posible moderar.');
    await loadShelterNeeds(); renderStaticContent(); renderReports(); renderModeratorProposals();
  };

  function reportTitle(item) {
    if (item.type === 'acopio') return item.need || 'Punto de acopio comunitario';
    if (item.type === 'comercio') return item.name || 'Comercio abierto reportado';
    const labels = { grietas: 'Grietas visibles', inclinado: 'Estructura inclinada', colapso_parcial: 'Colapso parcial', otro: 'Otro riesgo' };
    return labels[item.severity] || 'Edificio en riesgo';
  }

  function commerceCategory(item) {
    const labels = { supermercado: '🛒 Supermercado', tienda: '🏪 Tienda', farmacia: '💊 Farmacia', combustible: '⛽ Estación de servicio', alimentos: '🍞 Alimentos', otro: '📍 Comercio esencial' };
    return labels[item.category] || labels.otro;
  }

  function commerceDetail(item) {
    if (item.type !== 'comercio') return '';
    return `<div class="commerce-details"><span>${escapeHtml(commerceCategory(item))}</span>${item.hours ? `<span>🕐 ${escapeHtml(item.hours)}</span>` : ''}${item.products ? `<span>📦 ${escapeHtml(item.products)}</span>` : ''}${item.payment ? `<span>💳 ${escapeHtml(item.payment)}</span>` : ''}<small>Disponibilidad reportada; puede cambiar rápidamente.</small></div>`;
  }

  function reportTypeLabel(type) {
    const labels = { acopio: '📦 Acopio', riesgo: '⚠️ Edificio en riesgo', comercio: '🛒 Comercio abierto', necesidades: '🏠 Necesidades de albergue' };
    return labels[type] || '📍 Reporte';
  }

  function formatDate(value) {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return 'Fecha no disponible';
    return date.toLocaleString('es-CO', { dateStyle: 'short', timeStyle: 'short' });
  }

  function commerceFreshness(item) {
    if (item.type !== 'comercio') return null;
    const ageHours = (Date.now() - new Date(item.createdAt).getTime()) / 3600000;
    if (!Number.isFinite(ageHours) || ageHours >= 48) return { label: 'Reporte vencido', className: 'expired' };
    if (ageHours >= 24) return { label: 'Reconfirmar apertura', className: 'stale' };
    return { label: 'Abierto recientemente', className: 'recent' };
  }

  function renderReports() {
    const needReports = shelterNeedProposals.map(proposal => ({ ...proposal, type: 'necesidades' }));
    const list = (activeTab === 'todos' ? Object.values(reports).flat().concat(needReports) : activeTab === 'necesidades' ? needReports : reports[activeTab] || [])
      .slice().sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
    byId('tabTodos').classList.toggle('active', activeTab === 'todos');
    byId('tabAcopio').classList.toggle('active', activeTab === 'acopio');
    byId('tabRiesgo').classList.toggle('active', activeTab === 'riesgo');
    byId('tabComercio').classList.toggle('active', activeTab === 'comercio');
    byId('tabNecesidades').classList.toggle('active', activeTab === 'necesidades');
    byId('list').innerHTML = list.length ? list.map(item => {
      if (item.type === 'necesidades') {
        const shelter = data.shelters.find(candidate => shelterId(candidate) === item.shelterId);
        const needs = SHELTER_NEEDS.filter(([key]) => item.needs.includes(key));
        return `<article class="card shelter-report"><div class="report-category necesidades">${reportTypeLabel(item.type)}</div><div class="head"><div><div class="title">${escapeHtml(shelter ? shelter.n : 'Albergue')}</div><div class="addr">Propuesta comunitaria pendiente</div></div><span class="status unverified">${item.confirmations} de 5</span></div><div class="needs-chips">${needs.map(([, emoji, label]) => `<span>${emoji} ${escapeHtml(label)}</span>`).join('')}</div><div class="proposal-explanation">Se publicará como necesidad confirmada al alcanzar 5 verificaciones únicas.</div><div class="meta"><span>${formatDate(item.createdAt)}</span><div class="btnrow">${shelter ? `<a class="mini mini-link" href="${directionsUrl(shelter.lat, shelter.lng)}" target="_blank" rel="noreferrer">↗ Cómo llegar</a>` : ''}<button class="mini proposal-confirm" onclick="confirmShelterNeeds('${item.id}')">✓ Confirmar</button></div></div></article>`;
      }
      const freshness = commerceFreshness(item);
      const statusClass = item.verified ? 'verified' : item.confirmations >= 5 ? 'community' : 'unverified';
      const statusLabel = item.verified ? 'Verificado oficialmente' : item.confirmations >= 5 ? 'Confirmado por la comunidad' : 'Sin confirmar';
      const alreadyConfirmed = locallyConfirmed(item.type, item.id);
      return `
      <article class="card">
        <div class="report-category ${escapeHtml(item.type)}">${escapeHtml(reportTypeLabel(item.type))}</div>
        <div class="head"><div><div class="title">${escapeHtml(reportTitle(item))}</div><div class="addr">${escapeHtml(item.address)}${item.barrio ? ` · ${escapeHtml(item.barrio)}` : ''}</div></div><div class="status-stack"><span class="status ${statusClass}">${statusLabel}</span>${freshness ? `<span class="freshness ${freshness.className}">${freshness.label}</span>` : ''}</div></div>
        ${item.description ? `<div class="desc">${escapeHtml(item.description)}</div>` : ''}
        ${commerceDetail(item)}
        <div class="meta"><span>${formatDate(item.createdAt)}</span><div class="btnrow">${validCoordinates(item) ? `<button class="mini" onclick="showReport('${escapeHtml(item.type)}','${escapeHtml(item.id)}')">Ver mapa</button>${item.type === 'comercio' ? `<a class="mini mini-link" href="https://www.google.com/maps/dir/?api=1&amp;destination=${encodeURIComponent(`${item.lat},${item.lng}`)}" target="_blank" rel="noreferrer">↗ Cómo llegar</a>` : ''}` : ''}<button class="mini" ${alreadyConfirmed ? 'disabled' : ''} onclick="confirmReport('${escapeHtml(item.type)}','${escapeHtml(item.id)}')">${alreadyConfirmed ? '✓ Ya confirmaste' : `✓ Confirmar (${item.confirmations}/5)`}</button></div></div>
      </article>`;
    }).join('') : `<div class="empty">${activeTab === 'todos' ? 'Todavía no hay reportes comunitarios.' : 'Todavía no hay reportes comunitarios en esta categoría.'}</div>`;
    updateStats();
    renderReportMarkers();
  }

  function renderReportMarkers() {
    if (!map) return;
    reportMarkers.forEach(item => item.marker.removeFrom(categoryLayers[item.category]));
    reportMarkers = [];
    Object.values(reports).flat().filter(item => validCoordinates(item) && (!commerceFreshness(item) || commerceFreshness(item).className !== 'expired')).forEach(item => {
      const reportMarker = marker(item.lat, item.lng, COLORS[item.type] || COLORS.riesgo,
        reportTitle(item), `${item.address}${item.barrio ? ` · ${item.barrio}` : ''}`,
        item.type === 'acopio' ? '📍 Acopio comunitario' : item.type === 'comercio' ? commerceCategory(item) : '⚠️ Reporte de edificio');
      reportMarker.addTo(categoryLayers[item.type]);
      reportMarkers.push({ marker: reportMarker, category: item.type });
    });
  }

  window.toggleReportMenu = function () {
    const actions = byId('reportActions');
    const button = byId('reportToggle');
    const open = actions.classList.toggle('open');
    button.setAttribute('aria-expanded', String(open));
    button.innerHTML = open ? '<span>×</span> Cerrar' : '<span>＋</span> Nuevo reporte';
  };

  function updateStats() {
    const all = reports.acopio.concat(reports.riesgo, reports.comercio);
    byId('statAcopio').textContent = data.acopio.length + reports.acopio.length;
    byId('statRiesgo').textContent = data.zones.length + reports.riesgo.length;
    byId('statComercio').textContent = reports.comercio.length;
    byId('statVerif').textContent = all.filter(item => item.verified).length;
    byId('statConfirm').textContent = all.reduce((sum, item) => sum + item.confirmations, 0);
    byId('updatedAt').textContent = `Actualizado ${new Date().toLocaleTimeString('es-CO', { hour: '2-digit', minute: '2-digit' })}`;
  }

  window.switchTab = function (type) {
    if (type !== 'todos' && type !== 'necesidades' && !STORAGE_KEYS[type]) return;
    activeTab = type;
    renderReports();
  };

  window.showReport = function (type, id) {
    const item = reports[type] && reports[type].find(report => report.id === id);
    if (!item || !validCoordinates(item)) return;
    if (categoryLayers[type] && !map.hasLayer(categoryLayers[type])) window.toggleMapFilter(type);
    map.setView([item.lat, item.lng], 17);
    window.scrollTo({ top: byId('map').getBoundingClientRect().top + window.scrollY - 80, behavior: 'smooth' });
  };

  window.confirmReport = async function (type, id) {
    const item = reports[type] && reports[type].find(report => report.id === id);
    if (!item) return;
    try {
      const response = await fetch(CONFIRM_URL, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type, reportId: id })
      });
      if (!response.ok) throw new Error('confirmation failed');
      const result = await response.json();
      item.confirmations = Math.max(0, Number(result.confirmations) || 0);
      rememberConfirmation(type, id);
      renderReports();
      if (!result.added) alert('Este dispositivo ya había confirmado este reporte.');
    } catch (error) {
      alert('No fue posible guardar la confirmación. Inténtalo de nuevo.');
    }
  };

  function resetForm() {
    ['f_name', 'f_addr', 'f_barrio', 'f_need', 'f_hours', 'f_products', 'f_payment', 'f_desc'].forEach(id => { byId(id).value = ''; });
    byId('f_sev').value = 'grietas';
    byId('useLocationBtn').disabled = false;
    byId('useLocationBtn').textContent = '📍 Usar mi ubicación';
    byId('searchAddressBtn').disabled = false;
    byId('searchAddressBtn').textContent = '🔎 Buscar dirección escrita';
    pickedLocation = null;
    byId('pickhint').textContent = 'Ubicación obligatoria — usa una opción o toca el mapa para marcar.';
    if (pickMarker) { pickMarker.remove(); pickMarker = null; }
  }

  function setPickedLocation(lat, lng, message) {
    pickedLocation = { lat: Number(lat), lng: Number(lng) };
    const point = L.latLng(pickedLocation.lat, pickedLocation.lng);
    if (pickMarker) pickMarker.setLatLng(point);
    else pickMarker = L.marker(point).addTo(pickMap);
    pickMap.setView(point, 17);
    byId('pickhint').textContent = message || `${pickedLocation.lat.toFixed(5)}, ${pickedLocation.lng.toFixed(5)} — revisa el punto antes de publicar.`;
  }

  window.useMyReportLocation = function () {
    const button = byId('useLocationBtn');
    if (!navigator.geolocation) return alert('Este navegador no permite obtener la ubicación.');
    button.disabled = true;
    button.textContent = '📍 Ubicando…';
    navigator.geolocation.getCurrentPosition(position => {
      setPickedLocation(position.coords.latitude, position.coords.longitude, 'Tu ubicación aproximada — revisa el punto antes de publicar.');
      button.disabled = false;
      button.textContent = '✓ Ubicación aplicada';
    }, () => {
      button.disabled = false;
      button.textContent = '📍 Usar mi ubicación';
      alert('No fue posible obtener tu ubicación. Puedes buscar la dirección o marcar el mapa manualmente.');
    }, { enableHighAccuracy: true, timeout: 12000, maximumAge: 60000 });
  };

  window.searchReportAddress = async function () {
    const address = byId('f_addr').value.trim();
    const barrio = byId('f_barrio').value.trim();
    if (!address) return alert('Escribe primero la dirección que deseas buscar.');
    const button = byId('searchAddressBtn');
    button.disabled = true;
    button.textContent = '🔎 Buscando…';
    try {
      const response = await fetch(`${GEOCODE_URL}?q=${encodeURIComponent([address, barrio].filter(Boolean).join(', '))}`);
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || 'No fue posible buscar la dirección.');
      if (!payload.found) return alert('No encontramos esa dirección dentro de Pereira. Ajusta el texto o marca el punto manualmente.');
      setPickedLocation(payload.lat, payload.lng, `Resultado aproximado: ${payload.label}. Revisa y ajusta el punto si es necesario.`);
    } catch (error) {
      alert(error.message || 'No fue posible buscar la dirección.');
    } finally {
      button.disabled = false;
      button.textContent = '🔎 Buscar dirección escrita';
    }
  };

  window.openForm = function (type) {
    if (!STORAGE_KEYS[type]) return;
    formType = type;
    byId('reportActions').classList.remove('open');
    byId('reportToggle').setAttribute('aria-expanded', 'false');
    byId('reportToggle').innerHTML = '<span>＋</span> Nuevo reporte';
    resetForm();
    const isAcopio = type === 'acopio';
    const isCommerce = type === 'comercio';
    byId('formTitle').textContent = isAcopio ? 'Reportar punto de acopio' : isCommerce ? 'Reportar comercio abierto' : 'Reportar edificio en riesgo';
    byId('formHint').textContent = isAcopio ? 'Indica qué se recibe o necesita y cómo encontrar el punto.' : isCommerce ? 'Reporta únicamente un establecimiento que hayas visto funcionando recientemente. La disponibilidad puede cambiar.' : 'No ingreses a la estructura. Describe únicamente lo que observaste desde un lugar seguro.';
    byId('f_nameBlock').style.display = isCommerce ? '' : 'none';
    byId('f_needBlock').style.display = isAcopio ? '' : 'none';
    byId('f_sevBlock').style.display = isAcopio || isCommerce ? 'none' : '';
    byId('f_commerceBlock').style.display = isCommerce ? '' : 'none';
    byId('submitBtn').style.background = COLORS[type];
    byId('overlay').style.display = 'flex';
    document.body.style.overflow = 'hidden';

    setTimeout(() => {
      if (!pickMap) {
        pickMap = L.map('pickmap').setView(data.center, 13);
        L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '&copy; OpenStreetMap' }).addTo(pickMap);
        pickMap.on('click', event => {
          setPickedLocation(event.latlng.lat, event.latlng.lng);
        });
      }
      pickMap.invalidateSize();
      pickMap.setView(data.center, 13);
    }, 0);
  };

  window.closeForm = function () {
    byId('overlay').style.display = 'none';
    document.body.style.overflow = '';
  };

  window.submitForm = async function () {
    const address = byId('f_addr').value.trim();
    const need = byId('f_need').value.trim();
    const name = byId('f_name').value.trim();
    if (!address || !pickedLocation || (formType === 'acopio' && !need) || (formType === 'comercio' && !name)) {
      if (!pickedLocation) alert('Selecciona la ubicación usando tu posición, buscando la dirección o marcando el mapa.');
      else alert('Completa los campos obligatorios.');
      return;
    }

    const button = byId('submitBtn');
    button.disabled = true;
    button.textContent = 'Publicando…';
    const item = {
      id: window.crypto && crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`,
      type: formType,
      address,
      barrio: byId('f_barrio').value.trim(),
      need: formType === 'acopio' ? need : '',
      severity: formType === 'riesgo' ? byId('f_sev').value : '',
      description: byId('f_desc').value.trim(),
      name: formType === 'comercio' ? name : '',
      category: formType === 'comercio' ? byId('f_category').value : '',
      hours: formType === 'comercio' ? byId('f_hours').value.trim() : '',
      products: formType === 'comercio' ? byId('f_products').value.trim() : '',
      payment: formType === 'comercio' ? byId('f_payment').value.trim() : '',
      lat: pickedLocation ? pickedLocation.lat : null,
      lng: pickedLocation ? pickedLocation.lng : null,
      createdAt: new Date().toISOString(), verified: false, confirmations: 0
    };

    reports[formType].unshift(item);
    try {
      await writeReports(formType);
      activeTab = 'todos';
      closeForm();
      renderReports();
    } catch (error) {
      reports[formType] = reports[formType].filter(report => report.id !== item.id);
      alert('No fue posible publicar el reporte. Inténtalo de nuevo.');
    } finally {
      button.disabled = false;
      button.textContent = 'Publicar reporte';
    }
  };

  async function start() {
    if (!data || typeof L === 'undefined') return;
    renderStaticContent();
    initMap();
    renderReports();
    try {
      await loadShelterNeeds();
      renderStaticContent();
      renderReports();
    } catch (error) {
      console.warn('Las necesidades de albergues no están disponibles.', error);
    }
    try {
      const types = Object.keys(STORAGE_KEYS);
      const loaded = await Promise.all(types.map(async type => {
        const items = await readReports(type);
        try {
          const counts = await readConfirmationCounts(type);
          items.forEach(item => { item.confirmations = Math.max(0, Number(counts[item.id]) || 0); });
        } catch (error) {
          items.forEach(item => { item.confirmations = 0; });
          console.warn(`Las confirmaciones de ${type} no están disponibles.`, error);
        }
        return items;
      }));
      types.forEach((type, index) => { reports[type] = loaded[index]; });
      renderReports();
    } catch (error) {
      console.warn('Los reportes comunitarios no están disponibles.', error);
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
}());
