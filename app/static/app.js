const STATUS_COLORS = {
  red: '#f87171',
  yellow: '#fbbf24',
  green: '#34d399'
};

const COMMENT_ZOOM_THRESHOLD = 15;

let mapInstance;
let lastZoomLevel = 4;
let openHouseId = null;

const houseState = new Map();
const geoObjectState = new Map();
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

    const geoObject = await createHouseGeoObject(newHouse, geometry);
    closeCreateModal();
    showNotification('Карточка дома создана');

    if (geoObject && geoObject.balloon) {
      geoObject.balloon.open();
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
        const targetGeoObject = geoObjectState.get(newHouse.id);
        if (targetGeoObject) {
          const enableComments = mapInstance.getZoom() >= COMMENT_ZOOM_THRESHOLD;
          targetGeoObject.properties.set(
            'balloonContent',
            renderBalloonContent(newHouse, updatedComments, {
              enableComments,
              zoomLimited: !enableComments
            })
          );
          setTimeout(() => attachBalloonEvents(newHouse, targetGeoObject, updatedComments), 0);
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
  mapInstance = new ymaps.Map(
    'map',
    {
      center: [61.524, 105.3188],
      zoom: 4,
      type: 'yandex#map',
      controls: ['zoomControl', 'geolocationControl', 'typeSelector']
    },
    {
      suppressMapOpenBlock: true
    }
  );

  mapInstance.behaviors.disable('dblClickZoom');
  lastZoomLevel = mapInstance.getZoom();

  mapInstance.events.add('boundschange', (event) => {
    const newZoom = event.get('newZoom');
    if (typeof newZoom === 'number' && newZoom !== lastZoomLevel) {
      const previousZoom = lastZoomLevel;
      lastZoomLevel = newZoom;
      if (openHouseId !== null) {
        const crossedThreshold =
          (previousZoom < COMMENT_ZOOM_THRESHOLD && newZoom >= COMMENT_ZOOM_THRESHOLD) ||
          (previousZoom >= COMMENT_ZOOM_THRESHOLD && newZoom < COMMENT_ZOOM_THRESHOLD);
        if (crossedThreshold) {
          const house = houseState.get(openHouseId);
          const geoObject = geoObjectState.get(openHouseId);
          if (house && geoObject) {
            handleBalloonOpen(house, geoObject);
          }
        }
      }
    }
  });

  mapInstance.events.add('dblclick', (event) => {
    if (typeof event.preventDefault === 'function') {
      event.preventDefault();
    }
    const domEvent = event.get('domEvent');
    if (domEvent && typeof domEvent.preventDefault === 'function') {
      domEvent.preventDefault();
    }
    handleHouseDoubleClick(event.get('coords'));
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
      await createHouseGeoObject(house);
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
    const hasGeometry = Boolean(cachedGeometry);
    logHouseDebug(
      `Using cached geometry for house #${house.id} (${house.address}). Cached: ${hasGeometry}`
    );
    return cachedGeometry;
  }

  const coordinateInfo = `${house.latitude}, ${house.longitude}`;
  logHouseDebug(
    `Resolving geometry for house #${house.id} (${house.address}) at coordinates ${coordinateInfo}`
  );

  try {
    const result = await resolveHouseLocation([house.latitude, house.longitude], {
      knownAddress: house.address,
      suppressErrors: true
    });
    geometryCache.set(house.id, result.geometry || null);
    const resolvedAddress = result.address || 'unknown';
    logHouseInfo(
      `Resolved geometry for house #${house.id}. Has geometry: ${Boolean(result.geometry)}. Address: ${resolvedAddress}`
    );
    return result.geometry || null;
  } catch (error) {
    logHouseError(`Failed to resolve geometry for house #${house.id}`, error);
    geometryCache.set(house.id, null);
    return null;
  }
}

function collectGeoObjects(geoObjectsCollection) {
  const items = [];
  if (!geoObjectsCollection || typeof geoObjectsCollection.each !== 'function') {
    return items;
  }
  geoObjectsCollection.each((item) => {
    items.push(item);
  });
  return items;
}

function findGeoObjectWithPolygon(candidates) {
  for (const candidate of candidates) {
    const geometry = extractPolygonGeometry(candidate);
    if (geometry) {
      return { geoObject: candidate, geometry };
    }
  }
  return { geoObject: null, geometry: null };
}

async function resolveHouseLocation(coords, options = {}) {
  const { knownAddress = null, suppressErrors = false } = options;
  const searchOptions = {
    kind: 'house',
    results: 10
  };

  let primaryGeoObjects;
  try {
    logHouseDebug(
      `Geocoding by coordinates ${coords.join(', ')} with known address: ${knownAddress || 'none'}`
    );
    const geocode = await ymaps.geocode(coords, searchOptions);
    primaryGeoObjects = collectGeoObjects(geocode.geoObjects);
    logHouseDebug(`Received ${primaryGeoObjects.length} primary geocode candidates`);
  } catch (error) {
    if (!suppressErrors) {
      logHouseError('Error during coordinate geocoding', error);
    }
    primaryGeoObjects = [];
  }

  const bestCandidate = findGeoObjectWithPolygon(primaryGeoObjects);
  let resolvedGeoObject = bestCandidate.geoObject || primaryGeoObjects[0] || null;
  let resolvedGeometry = bestCandidate.geometry;
  let resolvedAddress = resolvedGeoObject?.getAddressLine() || knownAddress || null;

  if (resolvedGeoObject) {
    const candidateAddress = resolvedGeoObject.getAddressLine() || 'unknown';
    logHouseDebug(`Selected candidate address: ${candidateAddress}. Polygon detected: ${Boolean(resolvedGeometry)}`);
  } else {
    logHouseWarn('No suitable geoObject candidates found by coordinates');
  }

  if (!resolvedGeometry && resolvedAddress) {
    logHouseDebug(`Attempting address-based geocoding for ${resolvedAddress}`);
    try {
      const addressGeocode = await ymaps.geocode(resolvedAddress, {
        kind: 'house',
        results: 10
      });
      const addressCandidates = collectGeoObjects(addressGeocode.geoObjects);
      logHouseDebug(`Received ${addressCandidates.length} candidates from address geocoding`);
      const byAddress = findGeoObjectWithPolygon(addressCandidates);
      if (byAddress.geometry) {
        resolvedGeometry = byAddress.geometry;
        if (!resolvedGeoObject) {
          resolvedGeoObject = byAddress.geoObject;
        }
        resolvedAddress =
          byAddress.geoObject?.getAddressLine() || resolvedAddress || knownAddress || null;
        logHouseInfo(`Resolved polygon geometry via address geocoding for ${resolvedAddress}`);
      }
    } catch (error) {
      if (!suppressErrors) {
        logHouseError(`Error during address geocoding for ${resolvedAddress}`, error);
      }
    }
  }

  return {
    geoObject: resolvedGeoObject,
    geometry: resolvedGeometry,
    address: resolvedAddress
  };
}

function extractPolygonGeometry(geoObject) {
  if (!geoObject || !geoObject.geometry || typeof geoObject.geometry.getType !== 'function') {
    return null;
  }

  const type = geoObject.geometry.getType();
  if (type === 'Polygon' || type === 'MultiPolygon') {
    return {
      type,
      coordinates: geoObject.geometry.getCoordinates()
    };
  }

  return null;
}

function applyStatusStyle(geoObject, status) {
  if (!geoObject || !geoObject.options) {
    return;
  }

  const color = STATUS_COLORS[status] || STATUS_COLORS.yellow;
  const geometry = geoObject.geometry;

  if (geometry && typeof geometry.getType === 'function') {
    const type = geometry.getType();
    if (type === 'Polygon' || type === 'MultiPolygon') {
      geoObject.options.set('fillColor', color);
      geoObject.options.set('fillOpacity', 0.45);
      geoObject.options.set('strokeColor', color);
      geoObject.options.set('strokeOpacity', 0.9);
      return;
    }
  }

  if (geoObject.options.get('preset')) {
    geoObject.options.set('iconColor', color);
  } else {
    geoObject.options.set('fillColor', color);
    geoObject.options.set('strokeColor', color);
  }
}

async function createHouseGeoObject(house, providedGeometry = null) {
  if (!mapInstance) {
    return null;
  }

  const zoomLimited = mapInstance.getZoom() < COMMENT_ZOOM_THRESHOLD;
  const properties = {
    balloonContent: renderBalloonContent(house, [], { zoomLimited })
  };

  let geometry = providedGeometry;
  if (!geometry) {
    logHouseDebug(`No geometry provided for house #${house.id}, fetching via geocoding`);
    geometry = await ensureHouseGeometry(house);
  }

  let geoObject;

  try {
    if (geometry) {
      logHouseDebug(`Creating polygon geo object for house #${house.id} with ${geometry.type} geometry`);
      geometryCache.set(house.id, geometry);
      geoObject = new ymaps.GeoObject(
        {
          geometry: {
            type: geometry.type,
            coordinates: geometry.coordinates
          },
          properties
        },
        {
          fillColor: STATUS_COLORS[house.status] || STATUS_COLORS.yellow,
          fillOpacity: 0.45,
          strokeColor: STATUS_COLORS[house.status] || STATUS_COLORS.yellow,
          strokeOpacity: 0.9,
          strokeWidth: 2,
          cursor: 'pointer',
          hasBalloon: true,
          openBalloonOnClick: true,
          interactivityModel: 'default#geoObject'
        }
      );
    } else {
      logHouseDebug(`Falling back to point placemark for house #${house.id}`);
      geoObject = new ymaps.Placemark(
        [house.latitude, house.longitude],
        properties,
        {
          preset: 'islands#circleIcon',
          iconColor: STATUS_COLORS[house.status] || STATUS_COLORS.yellow
        }
      );
    }
  } catch (error) {
    logHouseError(`Failed to create geo object for house #${house.id}`, error);
    return null;
  }

  geoObject.events.add('balloonopen', () => {
    openHouseId = house.id;
    const latestHouse = houseState.get(house.id) || house;
    handleBalloonOpen(latestHouse, geoObject);
  });

  geoObject.events.add('balloonclose', () => {
    if (openHouseId === house.id) {
      openHouseId = null;
    }
  });

  mapInstance.geoObjects.add(geoObject);
  geoObjectState.set(house.id, geoObject);
  applyStatusStyle(geoObject, house.status);
  setTimeout(() => attachBalloonEvents(house, geoObject, []), 0);
  return geoObject;
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

async function handleBalloonOpen(house, geoObject) {
  const latestHouse = houseState.get(house.id) || house;
  house = latestHouse;
  const zoom = mapInstance.getZoom();
  const canShowComments = zoom >= COMMENT_ZOOM_THRESHOLD;

  if (!canShowComments) {
    geoObject.properties.set('balloonContent', renderBalloonContent(house, [], { zoomLimited: true }));
    setTimeout(() => attachBalloonEvents(house, geoObject, []), 0);
    return;
  }

  geoObject.properties.set('balloonContent', renderBalloonContent(house, [], { loading: true }));
  setTimeout(() => attachBalloonEvents(house, geoObject, []), 0);

  try {
    const comments = await loadComments(house.id);
    geoObject.properties.set(
      'balloonContent',
      renderBalloonContent(house, comments, { enableComments: true })
    );
    setTimeout(() => attachBalloonEvents(house, geoObject, comments), 0);
  } catch (error) {
    showNotification(error.message, 'error');
  }
}

function attachBalloonEvents(house, geoObject, comments) {
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
        house.status = updatedHouse.status;
        applyStatusStyle(geoObject, updatedHouse.status);
        geoObject.properties.set(
          'balloonContent',
          renderBalloonContent(updatedHouse, comments, {
            enableComments: mapInstance.getZoom() >= COMMENT_ZOOM_THRESHOLD,
            zoomLimited: mapInstance.getZoom() < COMMENT_ZOOM_THRESHOLD
          })
        );
        setTimeout(() => attachBalloonEvents(updatedHouse, geoObject, comments), 0);
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
        geoObject.properties.set(
          'balloonContent',
          renderBalloonContent(house, updatedComments, { enableComments: true })
        );
        setTimeout(() => attachBalloonEvents(house, geoObject, updatedComments), 0);
        showNotification('Комментарий добавлен');
      } catch (error) {
        showNotification(error.message, 'error');
      }
    });
  }
}

async function handleHouseDoubleClick(coords) {
  if (!mapInstance || !coords) {
    return;
  }

  try {
    const { geoObject, geometry, address } = await resolveHouseLocation(coords);

    if (!geoObject) {
      showNotification('Не удалось определить дом. Попробуйте приблизить карту.', 'error');
      return;
    }

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
  if (typeof ymaps !== 'undefined') {
    ymaps.ready(initMap);
  } else {
    showNotification('Скрипт Яндекс.Карт не загрузился', 'error');
  }
});
