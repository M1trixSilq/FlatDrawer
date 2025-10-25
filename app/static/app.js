const STATUS_COLORS = {
  red: '#f87171',
  yellow: '#fbbf24',
  green: '#34d399'
};

const COMMENT_ZOOM_THRESHOLD = 15;

let mapInstance;
let infoWindow = null;
let lastZoomLevel = 4;
let openHouseId = null;
let pendingInfoWindowContext = null;

const houseState = new Map();
const overlayState = new Map();
const geometryCache = new Map();
const commentsCache = new Map();

const creationModal = {
  container: null,
  overlay: null,
  closeButtons: [],
  form: null,
  statusSelect: null,
  commentInput: null,
  submitButton: null,
  addressField: null,
  initialized: false
};

let activeCreationContext = null;
let creationInProgress = false;

function escapeHtml(value) {
  if (value === null || value === undefined) {
    return '';
  }
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function showNotification(message, type = 'success') {
  const container = document.getElementById('notifications');
  if (!container) {
    return;
  }

  const notification = document.createElement('div');
  notification.className = `notification ${type}`;
  notification.innerHTML = `
    <span>${message}</span>
    <button aria-label="Закрыть уведомление">&times;</button>
  `;

  const closeButton = notification.querySelector('button');
  closeButton.addEventListener('click', () => {
    container.removeChild(notification);
  });

  container.appendChild(notification);

  setTimeout(() => {
    if (container.contains(notification)) {
      container.removeChild(notification);
    }
  }, 5000);
}

function ensureCreationModalElements() {
  if (creationModal.initialized) {
    return creationModal;
  }

  creationModal.container = document.getElementById('create-modal');
  creationModal.overlay = creationModal.container?.querySelector('.modal__overlay') ?? null;
  creationModal.form = document.getElementById('create-modal-form');
  creationModal.statusSelect = document.getElementById('create-modal-status');
  creationModal.commentInput = document.getElementById('create-modal-comment');
  creationModal.submitButton = creationModal.form?.querySelector('button[type="submit"]') ?? null;
  creationModal.addressField = document.getElementById('create-modal-address');
  creationModal.closeButtons = Array.from(
    creationModal.container?.querySelectorAll('[data-modal-close]') ?? []
  );

  if (creationModal.overlay) {
    creationModal.overlay.addEventListener('click', closeCreateModal);
  }

  creationModal.closeButtons.forEach((button) => {
    button.addEventListener('click', closeCreateModal);
  });

  if (creationModal.form) {
    creationModal.form.addEventListener('submit', handleCreateModalSubmit);
  }

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && creationModal.container && !creationModal.container.classList.contains('hidden')) {
      closeCreateModal();
    }
  });

  creationModal.initialized = true;
  return creationModal;
}

function openCreateModal(context) {
  const elements = ensureCreationModalElements();
  if (!elements.container || !elements.form) {
    showNotification('Форма создания недоступна', 'error');
    return;
  }

  activeCreationContext = context;
  creationInProgress = false;

  if (elements.addressField) {
    elements.addressField.textContent = context.address || 'Адрес не найден';
  }

  if (elements.statusSelect) {
    elements.statusSelect.value = 'yellow';
  }

  if (elements.commentInput) {
    elements.commentInput.value = '';
  }

  if (elements.submitButton) {
    elements.submitButton.disabled = false;
  }

  elements.container.classList.remove('hidden');
  elements.container.setAttribute('aria-hidden', 'false');

  if (elements.statusSelect) {
    elements.statusSelect.focus();
  }
}

function closeCreateModal() {
  const elements = ensureCreationModalElements();
  if (!elements.container) {
    return;
  }

  elements.container.classList.add('hidden');
  elements.container.setAttribute('aria-hidden', 'true');
  activeCreationContext = null;
  creationInProgress = false;
}

async function handleCreateModalSubmit(event) {
  event.preventDefault();

  const elements = ensureCreationModalElements();
  if (!elements.form || !activeCreationContext || creationInProgress) {
    return;
  }

  const status = elements.statusSelect ? elements.statusSelect.value : 'yellow';
  const comment = elements.commentInput ? elements.commentInput.value.trim() : '';
  const { address, coords, geometry } = activeCreationContext;

  creationInProgress = true;
  if (elements.submitButton) {
    elements.submitButton.disabled = true;
  }

  try {
    const payload = {
      address,
      latitude: coords[0],
      longitude: coords[1],
      status
    };

    const response = await fetch('/api/houses', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload)
    });

    if (!response.ok) {
      throw new Error('Не удалось создать карточку дома');
    }

    const newHouse = await response.json();
    houseState.set(newHouse.id, newHouse);

    if (geometry) {
      geometryCache.set(newHouse.id, geometry);
    }

    const overlayRecord = await createHouseOverlay(newHouse, geometry);
    closeCreateModal();
    showNotification('Карточка дома создана');

    if (overlayRecord) {
      const anchor = getOverlayAnchorPosition(overlayRecord, [newHouse.latitude, newHouse.longitude]);
      await handleOverlayOpen(newHouse, overlayRecord, anchor);
    }

    if (comment) {
      try {
        const newComment = await submitComment({
          house_id: newHouse.id,
          text: comment,
          author: null
        });
        const updatedComments = [newComment, ...(commentsCache.get(newHouse.id) || [])];
        commentsCache.set(newHouse.id, updatedComments);
        const targetOverlay = overlayState.get(newHouse.id);
        if (targetOverlay && infoWindow && openHouseId === newHouse.id) {
          pendingInfoWindowContext = {
            house: newHouse,
            overlayRecord: targetOverlay,
            comments: updatedComments
          };
          infoWindow.setContent(
            renderBalloonContent(newHouse, updatedComments, { enableComments: true })
          );
        }
        showNotification('Комментарий добавлен');
      } catch (commentError) {
        console.error(commentError);
        showNotification('Комментарий не удалось сохранить', 'error');
      }
    }
  } catch (error) {
    console.error(error);
    showNotification(error.message || 'Не удалось создать карточку дома', 'error');
  } finally {
    creationInProgress = false;
    if (elements.submitButton) {
      elements.submitButton.disabled = false;
    }
  }
}

function initMap() {
  const mapElement = document.getElementById('map');
  if (!mapElement) {
    showNotification('Элемент карты не найден на странице', 'error');
    return;
  }

  if (!window.google || !google.maps) {
    showNotification('Скрипт Google Maps не загрузился', 'error');
    return;
  }

  mapInstance = new google.maps.Map(mapElement, {
    center: { lat: 61.524, lng: 105.3188 },
    zoom: 4,
    mapTypeId: 'roadmap',
    disableDoubleClickZoom: true,
    zoomControl: true,
    streetViewControl: false,
    mapTypeControl: true,
    fullscreenControl: true
  });

  infoWindow = new google.maps.InfoWindow();
  infoWindow.addListener('closeclick', () => {
    openHouseId = null;
    pendingInfoWindowContext = null;
  });

  infoWindow.addListener('domready', onInfoWindowDomReady);

  lastZoomLevel = mapInstance.getZoom();

  mapInstance.addListener('zoom_changed', () => {
    const newZoom = mapInstance.getZoom();
    if (typeof newZoom !== 'number') {
      return;
    }

    if (openHouseId !== null && newZoom !== lastZoomLevel) {
      const crossedThreshold =
        (lastZoomLevel < COMMENT_ZOOM_THRESHOLD && newZoom >= COMMENT_ZOOM_THRESHOLD) ||
        (lastZoomLevel >= COMMENT_ZOOM_THRESHOLD && newZoom < COMMENT_ZOOM_THRESHOLD);

      if (crossedThreshold) {
        const house = houseState.get(openHouseId);
        const overlayRecord = overlayState.get(openHouseId);
        if (house && overlayRecord) {
          const anchor = getOverlayAnchorPosition(overlayRecord, [house.latitude, house.longitude]);
          handleOverlayOpen(house, overlayRecord, anchor);
        }
      }
    }

    lastZoomLevel = newZoom;
  });

  mapInstance.addListener('dblclick', (event) => {
    if (event && typeof event.stop === 'function') {
      event.stop();
    }
    if (!event || !event.latLng) {
      return;
    }
    const coords = [event.latLng.lat(), event.latLng.lng()];
    handleHouseDoubleClick(coords);
  });

  loadHouses();
}

async function loadHouses() {
  try {
    const response = await fetch('/api/houses');
    if (!response.ok) {
      throw new Error('Не удалось загрузить список домов');
    }
    const houses = await response.json();
    for (const house of houses) {
      houseState.set(house.id, house);
      await createHouseOverlay(house);
    }
  } catch (error) {
    console.error(error);
    showNotification(error.message, 'error');
  }
}


const HOUSE_RECOGNITION_LOG_PREFIX = '[HouseRecognition]';

function logHouseDebug(message, ...args) {
  console.debug(`${HOUSE_RECOGNITION_LOG_PREFIX} ${message}`, ...args);
}

function logHouseInfo(message, ...args) {
  console.info(`${HOUSE_RECOGNITION_LOG_PREFIX} ${message}`, ...args);
}

function logHouseWarn(message, ...args) {
  console.warn(`${HOUSE_RECOGNITION_LOG_PREFIX} ${message}`, ...args);
}

function logHouseError(message, ...args) {
  console.error(`${HOUSE_RECOGNITION_LOG_PREFIX} ${message}`, ...args);
}

async function ensureHouseGeometry(house) {
  if (geometryCache.has(house.id)) {
    const cachedGeometry = geometryCache.get(house.id);
    logHouseDebug(
      `Using cached geometry for house #${house.id} (${house.address}). Cached: ${Boolean(cachedGeometry)}`
    );
    return cachedGeometry;
  }

  logHouseDebug(
    `Resolving geometry for house #${house.id} (${house.address}) at coordinates ${house.latitude}, ${house.longitude}`
  );

  try {
    const result = await resolveHouseLocation([house.latitude, house.longitude], {
      knownAddress: house.address,
      suppressErrors: true
    });
    geometryCache.set(house.id, result.geometry || null);
    logHouseInfo(
      `Resolved geometry for house #${house.id}. Has geometry: ${Boolean(result.geometry)}. Address: ${result.address || 'unknown'}`
    );
    return result.geometry || null;
  } catch (error) {
    logHouseError(`Failed to resolve geometry for house #${house.id}`, error);
    geometryCache.set(house.id, null);
    return null;
  }
}

function getPolygonRings(geometry) {
  if (!geometry || !geometry.type || !Array.isArray(geometry.coordinates)) {
    return [];
  }

  if (geometry.type === 'Polygon') {
    return geometry.coordinates;
  }

  if (geometry.type === 'MultiPolygon') {
    const rings = [];
    for (const polygon of geometry.coordinates) {
      if (Array.isArray(polygon)) {
        for (const ring of polygon) {
          if (Array.isArray(ring)) {
            rings.push(ring);
          }
        }
      }
    }
    return rings;
  }

  return [];
}

function normalizeRingCoordinates(ring) {
  if (!Array.isArray(ring) || !ring.length) {
    return [];
  }
  const normalized = ring
    .map((point) => [Number(point[0]), Number(point[1])])
    .filter((point) => !Number.isNaN(point[0]) && !Number.isNaN(point[1]));
  if (!normalized.length) {
    return [];
  }
  const first = normalized[0];
  const last = normalized[normalized.length - 1];
  if (first[0] !== last[0] || first[1] !== last[1]) {
    normalized.push([...first]);
  }
  return normalized;
}

async function resolveHouseLocation(coords, options = {}) {
  const { knownAddress = null, suppressErrors = false } = options;
  if (!Array.isArray(coords) || coords.length !== 2) {
    return { geometry: null, address: knownAddress || null };
  }

  const [lat, lng] = coords.map(Number);
  const params = new URLSearchParams({
    lat: lat.toFixed(7),
    lon: lng.toFixed(7)
  });

  try {
    const response = await fetch(`/api/buildings/resolve?${params.toString()}`);
    if (response.status === 404) {
      logHouseWarn('Backend did not return building geometry for the selected point.');
      return { geometry: null, address: knownAddress || null };
    }

    if (!response.ok) {
      throw new Error('Не удалось определить дом через сервер');
    }

    const payload = await response.json();
    const geometry = payload?.geometry ?? null;
    const address = payload?.address || knownAddress || null;

    if (geometry) {
      logHouseInfo('Resolved building footprint using backend detector.');
    } else {
      logHouseWarn('Backend response did not include geometry.');
    }

    return { geometry, address };
  } catch (error) {
    if (!suppressErrors) {
      logHouseError('Failed to resolve building via backend service', error);
    }
    return { geometry: null, address: knownAddress || null };
  }
}

function applyStatusStyleToOverlay(overlayRecord, status) {
  if (
    !overlayRecord ||
    !Array.isArray(overlayRecord.overlays) ||
    !window.google ||
    !google.maps
  ) {
    return;
  }

  const color = STATUS_COLORS[status] || STATUS_COLORS.yellow;

  if (overlayRecord.type === 'polygon') {
    overlayRecord.overlays.forEach((polygon) => {
      if (polygon && typeof polygon.setOptions === 'function') {
        polygon.setOptions({
          fillColor: color,
          fillOpacity: 0.45,
          strokeColor: color,
          strokeOpacity: 0.9,
          strokeWeight: 2
        });
      }
    });
    return;
  }

  overlayRecord.overlays.forEach((marker) => {
    if (marker && typeof marker.setIcon === 'function') {
      marker.setIcon({
        path: google.maps.SymbolPath.CIRCLE,
        fillColor: color,
        fillOpacity: 0.9,
        strokeColor: '#ffffff',
        strokeOpacity: 1,
        strokeWeight: 2,
        scale: 8
      });
    }
  });
}

function getOverlayAnchorPosition(overlayRecord, fallbackCoords = null) {
  if (!overlayRecord) {
    return null;
  }

  if (overlayRecord.lastAnchor) {
    return overlayRecord.lastAnchor;
  }

  if (overlayRecord.type === 'marker' && overlayRecord.overlays.length) {
    const marker = overlayRecord.overlays[0];
    if (marker && typeof marker.getPosition === 'function') {
      return marker.getPosition();
    }
  }

  if (overlayRecord.geometry && window.google && google.maps) {
    const centroid = computePolygonCentroid(overlayRecord.geometry);
    if (centroid) {
      return new google.maps.LatLng(centroid.lat, centroid.lng);
    }
  }

  if (Array.isArray(fallbackCoords) && fallbackCoords.length === 2 && window.google && google.maps) {
    return new google.maps.LatLng(Number(fallbackCoords[0]), Number(fallbackCoords[1]));
  }

  return mapInstance?.getCenter() ?? null;
}

function createPolygonsFromGeometry(geometry) {
  if (!geometry || !window.google || !google.maps) {
    return [];
  }

  const polygons = [];
  const polygonCoordinates = geometry.type === 'MultiPolygon' ? geometry.coordinates : [geometry.coordinates];

  for (const polygon of polygonCoordinates) {
    if (!Array.isArray(polygon) || !polygon.length) {
      continue;
    }
    return {
      type: 'Polygon',
      coordinates: [ring]
    };
  }

    const paths = polygon
      .map((ring) => {
        const normalized = normalizeRingCoordinates(ring);
        return normalized.map(([lat, lon]) => ({ lat: Number(lat), lng: Number(lon) }));
      })
      .filter((path) => path.length >= 3);

    if (!paths.length) {
      continue;
    }

    const polygonOverlay = new google.maps.Polygon({
      paths,
      map: mapInstance,
      strokeWeight: 2,
      strokeOpacity: 0.9,
      fillOpacity: 0.45,
      clickable: true
    });
    polygons.push(polygonOverlay);
  }

  return polygons;
}

function createMarkerForHouse(house) {
  if (!window.google || !google.maps) {
    return null;
  }

  return new google.maps.Marker({
    position: { lat: Number(house.latitude), lng: Number(house.longitude) },
    map: mapInstance,
    title: house.address || ''
  });
}

async function createHouseOverlay(house, providedGeometry = null) {
  if (!mapInstance) {
    return null;
  }

  let geometry = providedGeometry;
  if (!geometry) {
    geometry = await ensureHouseGeometry(house);
  }

  let overlays = [];
  if (geometry) {
    overlays = createPolygonsFromGeometry(geometry);
    if (!overlays.length) {
      geometry = null;
    }
  }

  if (!geometry) {
    const marker = createMarkerForHouse(house);
    if (marker) {
      overlays = [marker];
    }
  }

  if (!overlays.length) {
    return null;
  }

  const overlayRecord = {
    type: geometry ? 'polygon' : 'marker',
    overlays,
    geometry: geometry || null,
    houseId: house.id,
    lastAnchor: null
  };

  overlayState.set(house.id, overlayRecord);
  applyStatusStyleToOverlay(overlayRecord, house.status);

  overlays.forEach((overlay) => {
    if (overlay && typeof overlay.addListener === 'function') {
      overlay.addListener('click', (event) => {
        const anchor = event?.latLng || getOverlayAnchorPosition(overlayRecord, [house.latitude, house.longitude]);
        overlayRecord.lastAnchor = anchor;
        const latestHouse = houseState.get(house.id) || house;
        handleOverlayOpen(latestHouse, overlayRecord, anchor);
      });
    }
  });

  return overlayRecord;
}

function onInfoWindowDomReady() {
  if (!pendingInfoWindowContext) {
    return;
  }

  const { house, overlayRecord, comments } = pendingInfoWindowContext;
  attachBalloonEvents(house, overlayRecord, comments);
  pendingInfoWindowContext = null;
}

async function handleOverlayOpen(house, overlayRecord, anchorPosition) {
  if (!mapInstance || !infoWindow || !overlayRecord) {
    return;
  }

  const latestHouse = houseState.get(house.id) || house;
  const zoom = mapInstance.getZoom();
  const canShowComments = typeof zoom === 'number' && zoom >= COMMENT_ZOOM_THRESHOLD;

  openHouseId = latestHouse.id;
  overlayRecord.lastAnchor = anchorPosition || getOverlayAnchorPosition(overlayRecord, [latestHouse.latitude, latestHouse.longitude]);

  pendingInfoWindowContext = { house: latestHouse, overlayRecord, comments: [] };
  infoWindow.setContent(
    renderBalloonContent(latestHouse, [], { zoomLimited: !canShowComments, loading: canShowComments })
  );
  infoWindow.setPosition(overlayRecord.lastAnchor || anchorPosition);
  infoWindow.open({ map: mapInstance });

  if (!canShowComments) {
    return;
  }

  try {
    const comments = await loadComments(latestHouse.id);
    pendingInfoWindowContext = { house: latestHouse, overlayRecord, comments };
    infoWindow.setContent(renderBalloonContent(latestHouse, comments, { enableComments: true }));
  } catch (error) {
    showNotification(error.message, 'error');
  }
}

function attachBalloonEvents(house, overlayRecord, comments) {
  if (!overlayRecord) {
    return;
  }

  const statusForm = document.getElementById(`status-form-${house.id}`);
  if (statusForm) {
    statusForm.addEventListener('submit', async (event) => {
      event.preventDefault();
      const formData = new FormData(statusForm);
      const status = formData.get('status');

      try {
        const updatedHouse = await updateHouseStatus(house.id, status);
        showNotification('Статус обновлён');
        houseState.set(house.id, updatedHouse);
        applyStatusStyleToOverlay(overlayRecord, updatedHouse.status);

        const enableComments = mapInstance.getZoom() >= COMMENT_ZOOM_THRESHOLD;
        const zoomLimited = !enableComments;
        const renderedComments = enableComments ? comments : [];
        house = updatedHouse;
        pendingInfoWindowContext = { house: updatedHouse, overlayRecord, comments: renderedComments };
        infoWindow.setContent(
          renderBalloonContent(updatedHouse, renderedComments, {
            enableComments,
            zoomLimited
          })
        );
      } catch (error) {
        showNotification(error.message, 'error');
      }
    });
  }

  const commentForm = document.getElementById(`comment-form-${house.id}`);
  if (commentForm) {
    commentForm.addEventListener('submit', async (event) => {
      event.preventDefault();
      const formData = new FormData(commentForm);
      const payload = {
        house_id: house.id,
        text: formData.get('text'),
        author: formData.get('author') || null
      };

      try {
        const newComment = await submitComment(payload);
        const updatedComments = [newComment, ...(commentsCache.get(house.id) || [])];
        commentsCache.set(house.id, updatedComments);
        comments = updatedComments;
        pendingInfoWindowContext = { house, overlayRecord, comments: updatedComments };
        infoWindow.setContent(
          renderBalloonContent(house, updatedComments, { enableComments: true })
        );
        showNotification('Комментарий добавлен');
      } catch (error) {
        showNotification(error.message, 'error');
      }
    });
  }
}

function renderBalloonContent(house, comments = [], options = {}) {
  const { zoomLimited = false, loading = false, enableComments = false } = options;
  const commentsBlock = (() => {
    if (loading) {
      return '<p>Загрузка комментариев...</p>';
    }
    if (zoomLimited) {
      return '<p>Для просмотра комментариев приблизьте карту до уровня 15 и выше.</p>';
    }
    if (!comments.length) {
      return '<p>Комментариев пока нет. Добавьте первый!</p>';
    }
    return `
      <div class="comments-list">
        ${comments
          .map(
            (comment) => `
              <div class="comment-item">
                ${comment.author ? `<strong>${escapeHtml(comment.author)}</strong>` : ''}
                <div class="comment-meta">${new Date(comment.created_at).toLocaleString('ru-RU')}</div>
                <div class="comment-text">${escapeHtml(comment.text)}</div>
              </div>
            `
          )
          .join('')}
      </div>
    `;
  })();

  const commentForm = enableComments
    ? `
      <form id="comment-form-${house.id}" class="comment-form">
        <input type="text" name="author" placeholder="Ваше имя (необязательно)" maxlength="255" />
        <textarea name="text" placeholder="Комментарий" required maxlength="1000"></textarea>
        <button type="submit">Добавить комментарий</button>
      </form>
    `
    : '';

  return `
    <div class="balloon" data-house-id="${house.id}">
      <h3>${escapeHtml(house.address)}</h3>
      <form id="status-form-${house.id}" class="status-select">
        <label for="status-select-input-${house.id}">Статус</label>
        <select id="status-select-input-${house.id}" name="status">
          <option value="red" ${house.status === 'red' ? 'selected' : ''}>Неинтересный</option>
          <option value="yellow" ${house.status === 'yellow' ? 'selected' : ''}>Спорный</option>
          <option value="green" ${house.status === 'green' ? 'selected' : ''}>Интересный</option>
        </select>
        <button type="submit">Сохранить</button>
      </form>
      <section>
        <h4>Комментарии</h4>
        ${commentsBlock}
        ${enableComments ? commentForm : ''}
        ${!enableComments ? '<p class="comment-hint">Чтобы оставлять комментарии, приблизьте карту.</p>' : ''}
      </section>
    </div>
  `;
}


async function handleHouseDoubleClick(coords) {
  if (!mapInstance || !Array.isArray(coords)) {
    return;
  }

  try {
    const { geometry, address } = await resolveHouseLocation(coords);

    if (!geometry) {
      showNotification('Контур дома не найден. Попробуйте выбрать другой дом.', 'error');
      return;
    }

    openCreateModal({
      address: address || 'Адрес не найден',
      coords,
      geometry
    });
  } catch (error) {
    console.error(error);
    showNotification('Не удалось определить дом. Попробуйте ещё раз.', 'error');
  }
}

async function loadComments(houseId) {
  if (commentsCache.has(houseId)) {
    return commentsCache.get(houseId);
  }
  const response = await fetch(`/api/comments?house_id=${houseId}`);
  if (!response.ok) {
    throw new Error('Не удалось загрузить комментарии');
  }
  const data = await response.json();
  commentsCache.set(houseId, data);
  return data;
}

async function updateHouseStatus(houseId, status) {
  const response = await fetch(`/api/houses/${houseId}`, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ status })
  });

  if (!response.ok) {
    throw new Error('Не удалось обновить статус дома');
  }

  const updatedHouse = await response.json();
  houseState.set(houseId, updatedHouse);
  return updatedHouse;
}

async function submitComment(payload) {
  const response = await fetch('/api/comments', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    throw new Error('Не удалось добавить комментарий');
  }

  return await response.json();
}

document.addEventListener('DOMContentLoaded', () => {
  ensureCreationModalElements();
  setTimeout(() => {
    if (!window.google || !window.google.maps) {
      showNotification('Скрипт Google Maps не загрузился', 'error');
    }
  }, 5000);
});

if (typeof window !== 'undefined') {
  window.initMap = initMap;
}
