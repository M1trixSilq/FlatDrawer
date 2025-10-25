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
const placemarkState = new Map();
const commentsCache = new Map();
let createModeEnabled = false;
let pendingPlacemark = null;
let createFormElements = {
  form: null,
  addressInput: null,
  latitudeInput: null,
  longitudeInput: null,
  statusSelect: null,
  pickButton: null,
  cancelButton: null
};

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

function initMap() {
  mapInstance = new ymaps.Map('map', {
    center: [61.524, 105.3188],
    zoom: 4,
    controls: ['zoomControl', 'geolocationControl', 'typeSelector', 'searchControl']
  });

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
          const placemark = placemarkState.get(openHouseId);
          if (house && placemark) {
            handleBalloonOpen(house, placemark);
          }
        }
      }
    }
  });

  mapInstance.events.add('click', (event) => {
    if (!createModeEnabled) {
      return;
    }
    handleCreateHouseSelection(event.get('coords'));
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
    houses.forEach((house) => {
      houseState.set(house.id, house);
      createPlacemark(house);
    });
  } catch (error) {
    console.error(error);
    showNotification(error.message, 'error');
  }
}

function createPlacemark(house) {
  const placemark = new ymaps.Placemark(
    [house.latitude, house.longitude],
    {
      balloonContent: renderBalloonContent(house, [], { zoomLimited: true })
    },
    {
      preset: 'islands#circleIcon',
      iconColor: STATUS_COLORS[house.status] || STATUS_COLORS.yellow
    }
  );

  placemark.events.add('balloonopen', () => {
    openHouseId = house.id;
    const latestHouse = houseState.get(house.id) || house;
    handleBalloonOpen(latestHouse, placemark);
  });

  placemark.events.add('balloonclose', () => {
    if (openHouseId === house.id) {
      openHouseId = null;
    }
  });

  mapInstance.geoObjects.add(placemark);
  placemarkState.set(house.id, placemark);
}

function ensureCreateFormElements() {
  if (createFormElements.form) {
    return createFormElements;
  }

  createFormElements = {
    form: document.getElementById('create-house-form'),
    addressInput: document.getElementById('create-house-address'),
    latitudeInput: document.getElementById('create-house-latitude'),
    longitudeInput: document.getElementById('create-house-longitude'),
    statusSelect: document.getElementById('create-house-status'),
    pickButton: document.getElementById('pick-house-location'),
    cancelButton: document.getElementById('cancel-pick-house')
  };

  return createFormElements;
}

function toggleCreateMode(enabled) {
  const { pickButton, cancelButton } = ensureCreateFormElements();
  createModeEnabled = enabled;

  if (pickButton) {
    pickButton.disabled = enabled;
  }

  if (cancelButton) {
    cancelButton.hidden = !enabled;
  }

  if (!enabled && pendingPlacemark && mapInstance) {
    mapInstance.geoObjects.remove(pendingPlacemark);
    pendingPlacemark = null;
  }
}

function resetCreateForm() {
  const { form, addressInput, latitudeInput, longitudeInput, statusSelect, pickButton } = ensureCreateFormElements();

  if (form) {
    form.reset();
  }

  if (addressInput) {
    addressInput.value = '';
    addressInput.placeholder = 'Выберите точку на карте';
  }

  if (latitudeInput) {
    latitudeInput.value = '';
  }

  if (longitudeInput) {
    longitudeInput.value = '';
  }

  if (statusSelect) {
    statusSelect.value = 'yellow';
  }

  if (pickButton) {
    pickButton.disabled = false;
  }
}

function handleCreateHouseSelection(coords) {
  const { addressInput, latitudeInput, longitudeInput } = ensureCreateFormElements();

  if (!coords || !mapInstance) {
    return;
  }

  if (!pendingPlacemark) {
    pendingPlacemark = new ymaps.Placemark(
      coords,
      { hintContent: 'Новая карточка' },
      {
        preset: 'islands#circleDotIcon',
        iconColor: '#38bdf8',
        draggable: true
      }
    );

    pendingPlacemark.events.add('dragend', (event) => {
      const newCoords = event.get('target').geometry.getCoordinates();
      handleCreateHouseSelection(newCoords);
    });

    mapInstance.geoObjects.add(pendingPlacemark);
  } else {
    pendingPlacemark.geometry.setCoordinates(coords);
  }

  if (latitudeInput) {
    latitudeInput.value = coords[0].toFixed(6);
  }

  if (longitudeInput) {
    longitudeInput.value = coords[1].toFixed(6);
  }

  if (addressInput) {
    addressInput.placeholder = 'Определяем адрес…';
  }

  ymaps
    .geocode(coords, { kind: 'house', results: 1 })
    .then((res) => {
      const firstGeoObject = res.geoObjects.get(0);
      if (firstGeoObject && addressInput) {
        addressInput.value = firstGeoObject.getAddressLine();
        addressInput.placeholder = 'Адрес выбран';
      } else if (addressInput) {
        addressInput.placeholder = 'Введите адрес вручную';
      }
    })
    .catch(() => {
      if (addressInput) {
        addressInput.placeholder = 'Введите адрес вручную';
      }
    });
}

function initCreateHouseForm() {
  const { form, pickButton, cancelButton, statusSelect, addressInput } = ensureCreateFormElements();

  if (!form) {
    return;
  }

  if (pickButton) {
    pickButton.addEventListener('click', () => {
      resetCreateForm();
      toggleCreateMode(true);
      showNotification('Кликните по карте, чтобы выбрать дом');
    });
  }

  if (cancelButton) {
    cancelButton.addEventListener('click', () => {
      toggleCreateMode(false);
      resetCreateForm();
    });
  }

  form.addEventListener('submit', async (event) => {
    event.preventDefault();

    const { latitudeInput, longitudeInput } = ensureCreateFormElements();
    const address = addressInput ? addressInput.value.trim() : '';
    const latitude = latitudeInput ? parseFloat(latitudeInput.value) : NaN;
    const longitude = longitudeInput ? parseFloat(longitudeInput.value) : NaN;
    const status = statusSelect ? statusSelect.value : 'yellow';

    if (!address || Number.isNaN(latitude) || Number.isNaN(longitude)) {
      showNotification('Укажите точку на карте и адрес дома', 'error');
      return;
    }

    const payload = {
      address,
      latitude,
      longitude,
      status
    };

    try {
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
      createPlacemark(newHouse);
      const createdPlacemark = placemarkState.get(newHouse.id);
      if (createdPlacemark) {
        createdPlacemark.balloon.open();
      }
      showNotification('Карточка дома создана');
      toggleCreateMode(false);
      resetCreateForm();
    } catch (error) {
      console.error(error);
      showNotification(error.message || 'Не удалось создать карточку дома', 'error');
    }
  });
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

async function handleBalloonOpen(house, placemark) {
  const latestHouse = houseState.get(house.id) || house;
  house = latestHouse;
  const zoom = mapInstance.getZoom();
  const canShowComments = zoom >= COMMENT_ZOOM_THRESHOLD;

  if (!canShowComments) {
    placemark.properties.set('balloonContent', renderBalloonContent(house, [], { zoomLimited: true }));
    setTimeout(() => attachBalloonEvents(house, placemark, []), 0);
    return;
  }

  placemark.properties.set('balloonContent', renderBalloonContent(house, [], { loading: true }));
  setTimeout(() => attachBalloonEvents(house, placemark, []), 0);

  try {
    const comments = await loadComments(house.id);
    placemark.properties.set('balloonContent', renderBalloonContent(house, comments, { enableComments: true }));
    setTimeout(() => attachBalloonEvents(house, placemark, comments), 0);
  } catch (error) {
    showNotification(error.message, 'error');
  }
}

function attachBalloonEvents(house, placemark, comments) {
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
        placemark.options.set('iconColor', STATUS_COLORS[updatedHouse.status] || STATUS_COLORS.yellow);
        placemark.properties.set('balloonContent', renderBalloonContent(updatedHouse, comments, {
          enableComments: mapInstance.getZoom() >= COMMENT_ZOOM_THRESHOLD,
          zoomLimited: mapInstance.getZoom() < COMMENT_ZOOM_THRESHOLD
        }));
        setTimeout(() => attachBalloonEvents(updatedHouse, placemark, comments), 0);
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
        placemark.properties.set('balloonContent', renderBalloonContent(house, updatedComments, { enableComments: true }));
        setTimeout(() => attachBalloonEvents(house, placemark, updatedComments), 0);
        showNotification('Комментарий добавлен');
      } catch (error) {
        showNotification(error.message, 'error');
      }
    });
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
  if (typeof ymaps !== 'undefined') {
    ymaps.ready(initMap);
  } else {
    showNotification('Скрипт Яндекс.Карт не загрузился', 'error');
  }
  initCreateHouseForm();
});