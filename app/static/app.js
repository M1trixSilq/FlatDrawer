const STATUS_COLORS = {
  red: '#f87171',
  yellow: '#fbbf24',
  green: '#34d399'
};

const COMMENT_ZOOM_THRESHOLD = 15;

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
  initialized: false,
  addressFieldListenerAttached: false
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

  if (creationModal.addressField && !creationModal.addressFieldListenerAttached) {
    creationModal.addressField.addEventListener('input', (event) => {
      if (!activeCreationContext) {
        return;
      }
      activeCreationContext.address = event.target.value;
    });
    creationModal.addressFieldListenerAttached = true;
  }

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

  const coords = Array.isArray(context.coords) ? [...context.coords] : context.coords;
  const initialAddress = context.address ?? '';
  const placeholder =
    typeof context.addressPlaceholder === 'string'
      ? context.addressPlaceholder
      : initialAddress
        ? 'Уточните адрес при необходимости'
        : 'Адрес не найден. Укажите вручную';
  const isResolving = Boolean(context.isResolving);

  activeCreationContext = {
    coords,
    address: initialAddress,
    isResolving
  };
  creationInProgress = false;

  if (elements.addressField) {
    elements.addressField.value = initialAddress;
    elements.addressField.placeholder = placeholder;
    elements.addressField.classList.toggle('is-loading', isResolving && !initialAddress);
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
  if (elements.addressField) {
    elements.addressField.value = '';
    elements.addressField.placeholder = 'Адрес не найден. Укажите вручную';
    elements.addressField.classList.remove('is-loading');
  }
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
  const coords = Array.isArray(activeCreationContext.coords)
    ? [...activeCreationContext.coords]
    : activeCreationContext.coords;

  const addressFieldValue = elements.addressField
    ? elements.addressField.value.trim()
    : (activeCreationContext.address || '').trim();

  if (addressFieldValue.length < 3) {
    showNotification('Укажите корректный адрес дома', 'error');
    if (elements.addressField) {
      elements.addressField.focus();
    }
    return;
  }

  if (!Array.isArray(coords) || coords.length !== 2) {
    showNotification('Не удалось определить координаты для новой точки', 'error');
    return;
  }

  activeCreationContext.address = addressFieldValue;

  creationInProgress = true;
  if (elements.submitButton) {
    elements.submitButton.disabled = true;
  }

  try {
    const payload = {
      address: addressFieldValue,
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

function waitForYandexMaps() {
  return new Promise((resolve, reject) => {
    let intervalId = null;

    const clearWatcher = () => {
      if (intervalId !== null) {
        clearInterval(intervalId);
        intervalId = null;
      }
    };

    const handleReady = () => {
      if (window.ymaps && typeof window.ymaps.ready === 'function') {
        clearWatcher();
        resolve(window.ymaps);
        return true;
      }
      return false;
    };

    if (handleReady()) {
      return;
    }

    intervalId = setInterval(handleReady, 200);

    const mapScript = document.querySelector('script[src*="api-maps.yandex.ru"]');
    if (!mapScript) {
      clearWatcher();
      const error = new Error('Yandex Maps script tag not found');
      error.code = 'SCRIPT_NOT_FOUND';
      reject(error);
      return;
    }

    mapScript.addEventListener('load', handleReady, { once: true });
    mapScript.addEventListener(
      'error',
      () => {
        clearWatcher();
        const error = new Error('Yandex Maps script failed to load');
        error.code = 'SCRIPT_FAILED';
        reject(error);
      },
      { once: true }
    );
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

  openCreateModal({
    coords,
    address: '',
    addressPlaceholder: 'Адрес не найден. Укажите вручную',
    isResolving: false
  });
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
    [52.35, 39.3],
    [52.9, 40.0]
  ];
  mapInstance.setBounds(lipetskBounds, { checkZoomRange: true, duration: 0 });
  mapInstance.options.set('restrictMapArea', lipetskBounds);

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

  });

  mapInstance.events.add('dblclick', (event) => {
    event.preventDefault();
    event.stopPropagation();
    const coords = event.get('coords');
    handleHouseDoubleClick(coords);
  });

  await loadHouses();
}


function bootstrapApplication() {
  ensureCreationModalElements();
  initStatusFilters();

  waitForYandexMaps()
    .then(() => ymaps.ready(initMap))
    .catch((error) => {
      console.error(error);
      const message =
        error && error.code === 'SCRIPT_NOT_FOUND'
          ? 'Скрипт Яндекс.Карт не найден на странице'
          : 'Скрипт Яндекс.Карт не загрузился';
      showNotification(message, 'error');
    });
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', bootstrapApplication);
} else {
  bootstrapApplication();
}
