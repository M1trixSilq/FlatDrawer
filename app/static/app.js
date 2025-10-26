const STATUS_COLORS = {
  red: '#f87171',
  yellow: '#fbbf24',
  green: '#34d399'
};

const COMMENT_ZOOM_THRESHOLD = 15;
const AUTO_OPEN_ZOOM_THRESHOLD = COMMENT_ZOOM_THRESHOLD;
const AUTO_OPEN_DISTANCE_METERS = 200;

let mapInstance;
let openHouseId = null;
const houseState = new Map();
const placemarkState = new Map();
const commentsCache = new Map();
const activeStatusFilters = new Set(Object.keys(STATUS_COLORS));

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

function formatDateToMoscow(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return '';
  }
  return date.toLocaleString('ru-RU', { timeZone: 'Europe/Moscow' });
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
  const { address, coords } = activeCreationContext;

  if (!Array.isArray(coords) || coords.length !== 2) {
    showNotification('Не удалось определить координаты для новой точки', 'error');
    return;
  }

  creationInProgress = true;
  if (elements.submitButton) {
    elements.submitButton.disabled = true;
  }

  try {
    const payload = {
      address,
      latitude: Number(coords[0]),
      longitude: Number(coords[1]),
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

    const placemark = createHousePlacemark(newHouse);
    closeCreateModal();
    showNotification('Карточка дома создана');

    if (placemark) {
      await openHouseBalloon(newHouse, placemark);
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
        if (placemark) {
          await openHouseBalloon(newHouse, placemark);
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

function waitForYandexMaps(timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const start = Date.now();

    function checkReady() {
      if (window.ymaps && typeof window.ymaps.ready === 'function') {
        resolve();
        return;
      }

      if (Date.now() - start >= timeoutMs) {
        reject(new Error('Yandex Maps script not loaded'));
        return;
      }

      setTimeout(checkReady, 200);
    }

    checkReady();
  });
}

function initStatusFilters() {
  const inputs = document.querySelectorAll('input[data-status-filter]');
  if (!inputs.length) {
    return;
  }

  activeStatusFilters.clear();
  inputs.forEach((input) => {
    if (input.checked) {
      activeStatusFilters.add(input.value);
    }

    input.addEventListener('change', () => {
      if (input.checked) {
        activeStatusFilters.add(input.value);
      } else {
        activeStatusFilters.delete(input.value);
      }
      updateAllPlacemarkVisibility();
    });
  });

  if (!activeStatusFilters.size) {
    Object.keys(STATUS_COLORS).forEach((status) => activeStatusFilters.add(status));
  }
}

function updatePlacemarkVisibility(houseId) {
  const placemark = placemarkState.get(houseId);
  const house = houseState.get(houseId);
  if (!placemark || !house) {
    return;
  }

  const isVisible = activeStatusFilters.has(house.status);
  placemark.options.set('visible', isVisible);
}

function updateAllPlacemarkVisibility() {
  placemarkState.forEach((_, houseId) => updatePlacemarkVisibility(houseId));
}

function applyStatusStyleToPlacemark(placemark, status) {
  if (!placemark) {
    return;
  }

  const color = STATUS_COLORS[status] || STATUS_COLORS.yellow;
  placemark.options.set('iconColor', color);
}

function createHousePlacemark(house) {
  if (!mapInstance || !window.ymaps) {
    return null;
  }

  const placemark = new ymaps.Placemark(
    [Number(house.latitude), Number(house.longitude)],
    {
      hintContent: escapeHtml(house.address || '')
    },
    {
      preset: 'islands#circleIcon',
      iconColor: STATUS_COLORS[house.status] || STATUS_COLORS.yellow,
      openBalloonOnClick: false,
      hideIconOnBalloonOpen: false
    }
  );

  placemark.events.add('click', (event) => {
    event.preventDefault();
    const latestHouse = houseState.get(house.id) || house;
    openHouseBalloon(latestHouse, placemark);
  });

  placemark.balloon.events.add('close', () => {
    if (openHouseId === house.id) {
      openHouseId = null;
    }
  });

  mapInstance.geoObjects.add(placemark);
  placemarkState.set(house.id, placemark);
  updatePlacemarkVisibility(house.id);
  return placemark;
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
      const placemark = createHousePlacemark(house);
      applyStatusStyleToPlacemark(placemark, house.status);
    }
    updateAllPlacemarkVisibility();
    return houses;
  } catch (error) {
    console.error(error);
    showNotification(error.message, 'error');
    return [];
  }
}

function renderBalloonContent(house, comments = [], options = {}) {
  const { zoomLimited = false, loading = false, enableComments = false } = options;
  const commentsBlock = (() => {
    if (loading) {
      return '<p>Загрузка комментариев...</p>';
    }

    if (!comments.length) {
      return '<p>Пока нет комментариев. Станьте первым!</p>';
    }

    return `
      <div class="comments-list">
        ${comments
          .map(
            (comment) => `
              <div class="comment-item">
                <div class="comment-meta">${formatDateToMoscow(comment.created_at)}</div>
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
        <textarea name="text" placeholder="Комментарий" required maxlength="1000"></textarea>
        <button type="submit">Добавить комментарий</button>
      </form>
    `
    : '';

  return `
    <div class="balloon" data-house-id="${house.id}">
      <h3>${escapeHtml(house.address || 'Без адреса')}</h3>
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
        ${zoomLimited && !enableComments ? '<p class="comment-hint">Комментарии доступны при увеличении карты.</p>' : ''}
      </section>
    </div>
  `;
}

function attachBalloonEvents(house, placemark, comments) {
  if (!placemark) {
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
        const placemarkRef = placemarkState.get(house.id);
        if (placemarkRef) {
          applyStatusStyleToPlacemark(placemarkRef, updatedHouse.status);
          updatePlacemarkVisibility(house.id);
        }

        const enableComments = mapInstance.getZoom() >= COMMENT_ZOOM_THRESHOLD;
        const zoomLimited = !enableComments;
        const renderedComments = enableComments ? comments : [];
        placemark.properties.set(
          'balloonContent',
          renderBalloonContent(updatedHouse, renderedComments, {
            enableComments,
            zoomLimited
          })
        );
        setTimeout(() => {
          attachBalloonEvents(updatedHouse, placemark, renderedComments);
        }, 0);
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
        text: formData.get('text')
      };

      try {
        const newComment = await submitComment(payload);
        const updatedComments = [newComment, ...(commentsCache.get(house.id) || [])];
        commentsCache.set(house.id, updatedComments);
        placemark.properties.set(
          'balloonContent',
          renderBalloonContent(house, updatedComments, { enableComments: true })
        );
        setTimeout(() => {
          attachBalloonEvents(house, placemark, updatedComments);
        }, 0);
        showNotification('Комментарий добавлен');
      } catch (error) {
        showNotification(error.message, 'error');
      }
    });
  }
}

async function resolveHouseAddress(coords) {
  if (!window.ymaps || typeof window.ymaps.geocode !== 'function') {
    return null;
  }

  try {
    const geocodeResult = await ymaps.geocode(coords, { kind: 'house', results: 1 });
    const firstGeoObject = geocodeResult.geoObjects.get(0);
    if (!firstGeoObject) {
      return null;
    }
    return firstGeoObject.getAddressLine();
  } catch (error) {
    console.error('Failed to resolve address via Yandex Maps', error);
    return null;
  }
}

async function openHouseBalloon(house, placemark) {
  if (!mapInstance || !placemark) {
    return;
  }

  const latestHouse = houseState.get(house.id) || house;
  const zoom = mapInstance.getZoom();
  const canShowComments = typeof zoom === 'number' && zoom >= COMMENT_ZOOM_THRESHOLD;

  openHouseId = latestHouse.id;

  placemark.properties.set(
    'balloonContent',
    renderBalloonContent(latestHouse, [], {
      zoomLimited: !canShowComments,
      loading: canShowComments,
      enableComments: canShowComments
    })
  );
  placemark.balloon.open();

  setTimeout(() => {
    attachBalloonEvents(latestHouse, placemark, []);
  }, 0);

  if (!canShowComments) {
    return;
  }

  try {
    const comments = await loadComments(latestHouse.id);
    const refreshedHouse = houseState.get(latestHouse.id) || latestHouse;
    placemark.properties.set(
      'balloonContent',
      renderBalloonContent(refreshedHouse, comments, { enableComments: true })
    );
    setTimeout(() => {
      attachBalloonEvents(refreshedHouse, placemark, comments);
    }, 0);
  } catch (error) {
    console.error(error);
    showNotification(error.message || 'Не удалось загрузить комментарии', 'error');
  }
}

async function handleHouseDoubleClick(coords) {
  if (!mapInstance || !Array.isArray(coords)) {
    return;
  }

  try {
    const address = (await resolveHouseAddress(coords)) || 'Адрес не найден';
    openCreateModal({ address, coords });
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
  const placemark = placemarkState.get(houseId);
  if (placemark) {
    applyStatusStyleToPlacemark(placemark, updatedHouse.status);
  }
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

function autoOpenHouseNearCenter(currentZoom) {
  if (!mapInstance || !window.ymaps) {
    return;
  }

  if (typeof currentZoom !== 'number' || currentZoom < AUTO_OPEN_ZOOM_THRESHOLD) {
    return;
  }

  const center = mapInstance.getCenter();
  if (!Array.isArray(center)) {
    return;
  }

  const ymapsGeo = window.ymaps && window.ymaps.coordSystem && window.ymaps.coordSystem.geo;
  if (!ymapsGeo || typeof ymapsGeo.getDistance !== 'function') {
    return;
  }

  let candidate = null;

  placemarkState.forEach((placemark, houseId) => {
    const house = houseState.get(houseId);
    if (!house || !placemark) {
      return;
    }

    const isVisible = placemark.options.get('visible');
    if (isVisible === false) {
      return;
    }

    const coords =
      placemark.geometry && typeof placemark.geometry.getCoordinates === 'function'
        ? placemark.geometry.getCoordinates()
        : null;

    if (!Array.isArray(coords)) {
      return;
    }

    const distance = ymapsGeo.getDistance(center, coords);
    if (!Number.isFinite(distance)) {
      return;
    }

    if (!candidate || distance < candidate.distance) {
      candidate = { house, placemark, distance };
    }
  });

  if (!candidate || candidate.distance > AUTO_OPEN_DISTANCE_METERS) {
    return;
  }

  if (openHouseId === candidate.house.id) {
    return;
  }

  openHouseBalloon(candidate.house, candidate.placemark);
}

function focusOnDensestArea(houses = []) {
  if (!mapInstance || !window.ymaps || !Array.isArray(houses) || !houses.length) {
    return;
  }

  const normalized = houses
    .map((house) => ({
      id: house.id,
      latitude: Number(house.latitude),
      longitude: Number(house.longitude)
    }))
    .filter((item) => Number.isFinite(item.latitude) && Number.isFinite(item.longitude));

  if (!normalized.length) {
    return;
  }

  const ymapsGeo = window.ymaps?.coordSystem?.geo;

  const moveToBounds = (points) => {
    const boundsFunction = window.ymaps?.util?.bounds?.fromPoints;
    const bounds = typeof boundsFunction === 'function' ? boundsFunction(points) : null;

    if (bounds) {
      mapInstance.setBounds(bounds, { checkZoomRange: true, duration: 300, zoomMargin: 40 });
    } else {
      const average = points.reduce(
        (acc, [lat, lon]) => {
          return { latitude: acc.latitude + lat, longitude: acc.longitude + lon };
        },
        { latitude: 0, longitude: 0 }
      );
      const center = [average.latitude / points.length, average.longitude / points.length];
      mapInstance.setCenter(center, Math.max(mapInstance.getZoom() || 0, 14), { duration: 300 });
    }
  };

  if (!ymapsGeo || typeof ymapsGeo.getDistance !== 'function') {
    moveToBounds(normalized.map((item) => [item.latitude, item.longitude]));
    return;
  }

  const radii = [200, 400, 800, 1600];
  let bestCluster = null;

  const calculateAverageDistance = (anchor, members) => {
    if (!members.length) {
      return Infinity;
    }
    const anchorPoint = [anchor.latitude, anchor.longitude];
    const totalDistance = members.reduce((acc, member) => {
      const distance = ymapsGeo.getDistance(anchorPoint, [member.latitude, member.longitude]);
      return Number.isFinite(distance) ? acc + distance : acc;
    }, 0);
    return totalDistance / members.length;
  };

  for (const radius of radii) {
    for (const anchor of normalized) {
      const anchorPoint = [anchor.latitude, anchor.longitude];
      const members = normalized.filter((candidate) => {
        const distance = ymapsGeo.getDistance(anchorPoint, [candidate.latitude, candidate.longitude]);
        return Number.isFinite(distance) && distance <= radius;
      });

      if (members.length <= 1 && normalized.length > 1) {
        continue;
      }

      const averageDistance = calculateAverageDistance(anchor, members);
      const bestCount = bestCluster ? bestCluster.members.length : 0;

      const isBetterCluster =
        !bestCluster ||
        members.length > bestCount ||
        (members.length === bestCount && averageDistance < bestCluster.averageDistance) ||
        (members.length === bestCount && averageDistance === bestCluster.averageDistance && radius < bestCluster.radius);

      if (isBetterCluster) {
        bestCluster = { members, radius, averageDistance };
      }
    }

    if (bestCluster && bestCluster.members.length >= 3) {
      break;
    }
  }

  const targetMembers =
    bestCluster && (bestCluster.members.length > 1 || normalized.length === 1)
      ? bestCluster.members
      : normalized;

  if (targetMembers.length === 1) {
    const [single] = targetMembers;
    mapInstance.setCenter([single.latitude, single.longitude], Math.max(mapInstance.getZoom() || 0, 16), {
      duration: 300
    });
    return;
  }

  moveToBounds(targetMembers.map((item) => [item.latitude, item.longitude]));
}

async function initMap() {
  const mapElement = document.getElementById('map');
  if (!mapElement) {
    showNotification('Элемент карты не найден на странице', 'error');
    return;
  }

  mapInstance = new ymaps.Map(
    mapElement,
    {
      center: [52.608, 39.599],
      zoom: 11,
      controls: ['zoomControl', 'typeSelector', 'fullscreenControl']
    },
    {
      suppressMapOpenBlock: true
    }
  );

  const lipetskBounds = [
    [52.75, 39.4],
    [52.45, 39.8]
  ];
  mapInstance.setBounds(lipetskBounds, { checkZoomRange: true, duration: 0 });

  mapInstance.options.set('doubleClickZoom', false);

  mapInstance.events.add('boundschange', (event) => {
    const newZoom = event.get('newZoom');
    const oldZoom = event.get('oldZoom');
    const newCenter = event.get('newCenter');
    const oldCenter = event.get('oldCenter');

    const centerChanged =
      Array.isArray(newCenter) && Array.isArray(oldCenter)
        ? newCenter.some((coord, index) => {
            const previous = oldCenter[index];
            if (typeof coord !== 'number' || typeof previous !== 'number') {
              return false;
            }
            return Math.abs(coord - previous) > 1e-6;
          })
        : Array.isArray(newCenter);

    const newZoomIsNumber = typeof newZoom === 'number';
    const oldZoomIsNumber = typeof oldZoom === 'number';
    const zoomChanged = newZoomIsNumber && oldZoomIsNumber && newZoom !== oldZoom;

    if (!zoomChanged && !centerChanged) {
      return;
    }

    if (zoomChanged && openHouseId !== null) {
      const crossedThreshold =
        (oldZoom < COMMENT_ZOOM_THRESHOLD && newZoom >= COMMENT_ZOOM_THRESHOLD) ||
        (oldZoom >= COMMENT_ZOOM_THRESHOLD && newZoom < COMMENT_ZOOM_THRESHOLD);

      if (crossedThreshold) {
        const house = houseState.get(openHouseId);
        const placemark = placemarkState.get(openHouseId);
        if (house && placemark) {
          openHouseBalloon(house, placemark);
        }
      }
    }

    const zoomForAutoOpen = newZoomIsNumber ? newZoom : mapInstance.getZoom();
    if (typeof zoomForAutoOpen === 'number' && zoomForAutoOpen >= AUTO_OPEN_ZOOM_THRESHOLD && (zoomChanged || centerChanged)) {
      autoOpenHouseNearCenter(zoomForAutoOpen);
    }
  });

  mapInstance.events.add('dblclick', (event) => {
    event.preventDefault();
    event.stopPropagation();
    const coords = event.get('coords');
    handleHouseDoubleClick(coords);
  });

  const houses = await loadHouses();
  focusOnDensestArea(houses);
}


document.addEventListener('DOMContentLoaded', () => {
  ensureCreationModalElements();
  initStatusFilters();

  waitForYandexMaps()
    .then(() => ymaps.ready(initMap))
    .catch(() => {
      showNotification('Скрипт Яндекс.Карт не загрузился', 'error');
    });
});
