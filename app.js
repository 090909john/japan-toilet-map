const CATEGORIES = {
  toilets: {
    label: "公共廁所",
    query: '["amenity"="toilets"]',
    color: "#2563eb",
    icon: "厠",
  },
  convenience: {
    label: "便利商店",
    query: '["shop"="convenience"]',
    color: "#16a34a",
    icon: "便",
  },
  station: {
    label: "車站",
    query: '["railway"="station"]',
    color: "#dc2626",
    icon: "駅",
  },
  park: {
    label: "公園",
    query: '["leisure"="park"]',
    color: "#65a30d",
    icon: "公",
  },
  department: {
    label: "百貨公司",
    query: '["shop"="department_store"]',
    color: "#9333ea",
    icon: "百",
  },
};

const OVERPASS_ENDPOINTS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
  "https://overpass.private.coffee/api/interpreter",
];

const DEFAULT_CENTER = [35.681236, 139.767125]; // 東京車站，定位失敗時仍可從日本中心地區開始操作。
const WALKING_METERS_PER_MINUTE = 80;
const CACHE_TTL_MS = 1000 * 60 * 30;
const state = {
  map: null,
  userMarker: null,
  queryCenter: null,
  activeRadius: 1500,
  rawPlaces: [],
  markers: new Map(),
  activePlaceId: null,
  activeCategories: new Set(Object.keys(CATEGORIES)),
  requireWheelchair: false,
  requireChanging: false,
  debounceTimer: null,
};

const els = {
  statusText: document.querySelector("#statusText"),
  startLocateBtn: document.querySelector("#startLocateBtn"),
  skipLocateBtn: document.querySelector("#skipLocateBtn"),
  relocateBtn: document.querySelector("#relocateBtn"),
  queryCenterBtn: document.querySelector("#queryCenterBtn"),
  refreshBtn: document.querySelector("#refreshBtn"),
  expandRadiusBtn: document.querySelector("#expandRadiusBtn"),
  radiusOptions: document.querySelector("#radiusOptions"),
  categoryFilters: document.querySelector("#categoryFilters"),
  wheelchairFilter: document.querySelector("#wheelchairFilter"),
  changingFilter: document.querySelector("#changingFilter"),
  resultsList: document.querySelector("#resultsList"),
  resultSummary: document.querySelector("#resultSummary"),
  emptyState: document.querySelector("#emptyState"),
  privacyNotice: document.querySelector("#privacyNotice"),
  searchForm: document.querySelector("#searchForm"),
  placeSearch: document.querySelector("#placeSearch"),
};

document.addEventListener("DOMContentLoaded", init);

function init() {
  initMap();
  renderCategoryFilters();
  bindEvents();
  scheduleMapResize();
  updateStatus("請先允許定位，或直接拖曳地圖後搜尋中心附近。");
}

function initMap() {
  state.map = L.map("map", {
    zoomControl: true,
    preferCanvas: true,
  }).setView(DEFAULT_CENTER, 15);

  const gsiLayer = L.tileLayer("https://cyberjapandata.gsi.go.jp/xyz/std/{z}/{x}/{y}.png", {
    attribution:
      '<a href="https://maps.gsi.go.jp/development/ichiran.html" target="_blank" rel="noopener">地理院タイル</a>',
    maxZoom: 18,
  });

  const osmLayer = L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    attribution: "&copy; OpenStreetMap contributors",
    maxZoom: 19,
  });

  gsiLayer.on("tileerror", () => {
    if (state.map.hasLayer(gsiLayer)) {
      state.map.removeLayer(gsiLayer);
      osmLayer.addTo(state.map);
      updateStatus("GSI 圖磚暫時無法載入，已切換到 OpenStreetMap 底圖。");
    }
  });

  gsiLayer.addTo(state.map);

  L.control
    .layers(
      {
        "GSI 地理院地圖": gsiLayer,
        "OpenStreetMap": osmLayer,
      },
      {},
      { position: "bottomright" },
    )
    .addTo(state.map);

  state.map.on("moveend", () => {
    window.clearTimeout(state.debounceTimer);
    state.debounceTimer = window.setTimeout(() => {
      updateStatus("地圖已移動，可搜尋此中心附近。");
    }, 500);
  });

  // 手機瀏覽器的網址列收合、旋轉螢幕或 CSS breakpoint 改變時，
  // Leaflet 需要重新計算容器大小，否則圖磚會錯位或破碎。
  window.addEventListener("resize", scheduleMapResize);
  window.addEventListener("orientationchange", scheduleMapResize);

  // ResizeObserver 能捕捉 window.resize 捕捉不到的容器尺寸變化，
  // 例如手機網址列收合、鍵盤彈出等。
  if (window.ResizeObserver) {
    new ResizeObserver(scheduleMapResize).observe(document.getElementById("map"));
  }
}

function bindEvents() {
  els.startLocateBtn.addEventListener("click", locateUser);
  els.relocateBtn.addEventListener("click", locateUser);
  els.skipLocateBtn.addEventListener("click", () => {
    els.privacyNotice.hidden = true;
    queryFromMapCenter();
  });
  els.queryCenterBtn.addEventListener("click", queryFromMapCenter);
  els.refreshBtn.addEventListener("click", () => queryNearby(state.queryCenter || latLngToObject(state.map.getCenter()), true));
  els.expandRadiusBtn.addEventListener("click", () => setRadius(3000, true));

  els.radiusOptions.addEventListener("click", (event) => {
    const button = event.target.closest("button[data-radius]");
    if (!button) return;
    setRadius(Number(button.dataset.radius), true);
  });

  els.wheelchairFilter.addEventListener("change", () => {
    state.requireWheelchair = els.wheelchairFilter.checked;
    renderPlaces();
  });

  els.changingFilter.addEventListener("change", () => {
    state.requireChanging = els.changingFilter.checked;
    renderPlaces();
  });

  els.searchForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const keyword = els.placeSearch.value.trim();
    if (!keyword) return;
    await searchPlace(keyword);
  });
}

function renderCategoryFilters() {
  els.categoryFilters.innerHTML = Object.entries(CATEGORIES)
    .map(
      ([key, category]) => `
        <label class="filter-chip">
          <input type="checkbox" value="${key}" checked />
          <span class="swatch" style="background:${category.color}"></span>
          ${category.label}
        </label>
      `,
    )
    .join("");

  els.categoryFilters.addEventListener("change", (event) => {
    const input = event.target.closest("input[type='checkbox']");
    if (!input) return;
    if (input.checked) {
      state.activeCategories.add(input.value);
    } else {
      state.activeCategories.delete(input.value);
    }
    renderPlaces();
  });
}

function locateUser() {
  if (!navigator.geolocation) {
    updateStatus("這個瀏覽器不支援定位。請拖曳地圖或搜尋地名後查詢。");
    els.privacyNotice.hidden = true;
    return;
  }

  updateStatus("定位中…");
  navigator.geolocation.getCurrentPosition(
    (position) => {
      const center = {
        lat: position.coords.latitude,
        lng: position.coords.longitude,
      };
      els.privacyNotice.hidden = true;
      setUserMarker(center);
      state.map.setView([center.lat, center.lng], 16);
      scheduleMapResize();
      queryNearby(center);
    },
    () => {
      els.privacyNotice.hidden = true;
      updateStatus("無法取得定位。你仍可拖曳地圖或搜尋地名，以地圖中心點查詢。");
    },
    {
      enableHighAccuracy: true,
      timeout: 10000,
      maximumAge: 60000,
    },
  );
}

function setUserMarker(center) {
  if (state.userMarker) {
    state.userMarker.setLatLng([center.lat, center.lng]);
    return;
  }

  state.userMarker = L.marker([center.lat, center.lng], {
    icon: L.divIcon({
      className: "",
      html: '<div class="user-marker" title="你的位置"></div>',
      iconSize: [26, 26],
      iconAnchor: [13, 13],
    }),
  })
    .addTo(state.map)
    .bindPopup("你的位置");
}

function queryFromMapCenter() {
  scheduleMapResize();
  const center = latLngToObject(state.map.getCenter());
  queryNearby(center);
}

async function queryNearby(center, forceRefresh = false) {
  state.queryCenter = center;
  updateStatus("查詢附近廁所中…");
  els.emptyState.hidden = true;

  try {
    const cached = forceRefresh ? null : readCache(center, state.activeRadius);
    const elements = cached || (await fetchOverpass(center, state.activeRadius));
    if (!cached) writeCache(center, state.activeRadius, elements);

    state.rawPlaces = normalizeElements(elements, center);
    renderPlaces();
    updateStatus(cached ? "已使用快取結果。移動較遠或重新查詢會更新資料。" : "附近資料已更新。");
  } catch (error) {
    console.error(error);
    updateStatus("查詢失敗，Overpass API 可能忙碌中。請稍後再試或縮小半徑。");
  }
}

async function fetchOverpass(center, radius) {
  const query = buildOverpassQuery(center, radius);
  let lastError = null;

  for (const endpoint of OVERPASS_ENDPOINTS) {
    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8" },
        body: new URLSearchParams({ data: query }),
      });
      if (!response.ok) throw new Error(`Overpass ${response.status}`);
      const data = await response.json();
      return data.elements || [];
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError || new Error("Overpass 查詢失敗");
}

function buildOverpassQuery(center, radius) {
  const parts = Object.values(CATEGORIES)
    .flatMap((category) => {
      const nodeQuery = `node${category.query}(around:${radius},${center.lat},${center.lng});`;
      const wayQuery = `way${category.query}(around:${radius},${center.lat},${center.lng});`;
      return [nodeQuery, wayQuery];
    })
    .join("\n  ");

  return `[out:json][timeout:25];
(
  ${parts}
);
out center tags;`;
}

function normalizeElements(elements, origin) {
  const seen = new Set();
  return elements
    .map((element) => {
      const tags = element.tags || {};
      const categoryKey = detectCategory(tags);
      const lat = element.lat ?? element.center?.lat;
      const lng = element.lon ?? element.center?.lon;
      if (!categoryKey || typeof lat !== "number" || typeof lng !== "number") return null;

      const id = `${element.type}-${element.id}`;
      if (seen.has(id)) return null;
      seen.add(id);

      const distance = haversineMeters(origin.lat, origin.lng, lat, lng);
      const category = CATEGORIES[categoryKey];
      const rawName = tags["name:zh"] || tags["name:ja"] || tags.name || "名稱未標示";
      const displayName = rawName === "名稱未標示" ? category.label : `${category.label}・${rawName}`;

      return {
        id,
        categoryKey,
        categoryLabel: category.label,
        name: displayName,
        rawName,
        lat,
        lng,
        distance,
        walkingMinutes: Math.max(1, Math.round(distance / WALKING_METERS_PER_MINUTE)),
        wheelchair: tags.wheelchair === "yes",
        changingTable: tags.changing_table === "yes",
        tags,
      };
    })
    .filter(Boolean)
    .sort((a, b) => a.distance - b.distance);
}

function detectCategory(tags) {
  if (tags.amenity === "toilets") return "toilets";
  if (tags.shop === "convenience") return "convenience";
  if (tags.railway === "station") return "station";
  if (tags.leisure === "park") return "park";
  if (tags.shop === "department_store") return "department";
  return null;
}

function renderPlaces() {
  const places = getFilteredPlaces();
  renderMarkers(places);
  renderList(places);
  els.resultSummary.textContent = places.length ? `${places.length} 個地點，依距離排序` : "沒有符合篩選的地點";

  const noRawData = state.rawPlaces.length === 0;
  els.emptyState.hidden = !(noRawData && state.queryCenter);
  if (noRawData) {
    els.emptyState.querySelector("p").textContent = `附近 ${formatDistance(state.activeRadius)} 內查無資料，要擴大到 3 公里嗎？`;
  }
}

function getFilteredPlaces() {
  return state.rawPlaces.filter((place) => {
    if (!state.activeCategories.has(place.categoryKey)) return false;
    if (state.requireWheelchair && !place.wheelchair) return false;
    if (state.requireChanging && !place.changingTable) return false;
    return true;
  });
}

function renderMarkers(places) {
  state.markers.forEach((marker) => marker.remove());
  state.markers.clear();

  places.forEach((place) => {
    const marker = L.marker([place.lat, place.lng], {
      icon: makePlaceIcon(place, place.id === state.activePlaceId),
      title: place.name,
    })
      .addTo(state.map)
      .bindPopup(
        `<strong>${escapeHtml(place.name)}</strong><br>${formatDistance(place.distance)}・步行約 ${place.walkingMinutes} 分鐘`,
      );

    marker.on("click", () => focusPlace(place.id, false));
    state.markers.set(place.id, marker);
  });
}

function renderList(places) {
  if (!places.length) {
    els.resultsList.innerHTML = "";
    return;
  }

  els.resultsList.innerHTML = places.map(renderCard).join("");
  els.resultsList.querySelectorAll(".result-card").forEach((card) => {
    card.addEventListener("click", (event) => {
      if (event.target.closest("a")) return;
      focusPlace(card.dataset.id, true);
    });
  });
}

function renderCard(place) {
  const category = CATEGORIES[place.categoryKey];
  const badges = [
    place.wheelchair ? '<span class="badge">♿ 無障礙</span>' : "",
    place.changingTable ? '<span class="badge">親子尿布台</span>' : "",
  ].join("");
  const navUrl = `https://www.google.com/maps/dir/?api=1&destination=${place.lat},${place.lng}`;

  return `
    <article class="result-card ${place.id === state.activePlaceId ? "active" : ""}" data-id="${place.id}">
      <div class="card-top">
        <div>
          <div class="category-label">
            <span class="swatch" style="background:${category.color}"></span>
            ${place.categoryLabel}
          </div>
          <p class="place-name">${escapeHtml(place.name)}</p>
        </div>
        <div class="distance">${formatDistance(place.distance)}</div>
      </div>
      <div class="meta-row">
        <span>步行約 ${place.walkingMinutes} 分鐘</span>
        ${badges}
        <a class="nav-link" href="${navUrl}" target="_blank" rel="noopener">導航</a>
      </div>
    </article>
  `;
}

function makePlaceIcon(place, active = false) {
  const category = CATEGORIES[place.categoryKey];
  return L.divIcon({
    className: "",
    html: `<div class="custom-marker ${active ? "active" : ""}" style="background:${category.color}">${category.icon}</div>`,
    iconSize: active ? [38, 38] : [30, 30],
    iconAnchor: active ? [19, 19] : [15, 15],
    popupAnchor: [0, -16],
  });
}

function focusPlace(placeId, panMap) {
  state.activePlaceId = placeId;
  const place = state.rawPlaces.find((item) => item.id === placeId);
  if (!place) return;

  renderPlaces();
  const marker = state.markers.get(placeId);
  if (marker) {
    if (panMap) state.map.setView([place.lat, place.lng], Math.max(state.map.getZoom(), 17));
    marker.openPopup();
  }

  const card = els.resultsList.querySelector(`[data-id="${CSS.escape(placeId)}"]`);
  card?.scrollIntoView({ block: "nearest", behavior: "smooth" });
}

function setRadius(radius, shouldQuery) {
  state.activeRadius = radius;
  els.radiusOptions.querySelectorAll("button").forEach((button) => {
    button.classList.toggle("active", Number(button.dataset.radius) === radius);
  });

  if (shouldQuery) {
    queryNearby(state.queryCenter || latLngToObject(state.map.getCenter()));
  }
}

async function searchPlace(keyword) {
  updateStatus("搜尋地名中…");
  const encoded = encodeURIComponent(keyword);
  const urls = [
    `https://msearch.gsi.go.jp/address-search/AddressSearch?q=${encoded}`,
    `https://nominatim.openstreetmap.org/search?format=json&limit=1&countrycodes=jp&q=${encoded}`,
  ];

  for (const url of urls) {
    try {
      const response = await fetch(url, { headers: { Accept: "application/json" } });
      if (!response.ok) continue;
      const data = await response.json();
      const result = parseSearchResult(data);
      if (!result) continue;
      state.map.setView([result.lat, result.lng], 16);
      scheduleMapResize();
      queryNearby(result);
      return;
    } catch (error) {
      console.warn("地名搜尋失敗", error);
    }
  }

  updateStatus("找不到這個地名。請換個關鍵字，或直接拖曳地圖。");
}

function parseSearchResult(data) {
  if (Array.isArray(data) && data[0]?.geometry?.coordinates) {
    const [lng, lat] = data[0].geometry.coordinates;
    return { lat, lng };
  }
  if (Array.isArray(data) && data[0]?.lat && data[0]?.lon) {
    return { lat: Number(data[0].lat), lng: Number(data[0].lon) };
  }
  return null;
}

function readCache(center, radius) {
  const key = cacheKey(center, radius);
  const raw = localStorage.getItem(key);
  if (!raw) return null;

  try {
    const cached = JSON.parse(raw);
    if (Date.now() - cached.createdAt > CACHE_TTL_MS) return null;
    return cached.elements;
  } catch {
    return null;
  }
}

function writeCache(center, radius, elements) {
  try {
    localStorage.setItem(
      cacheKey(center, radius),
      JSON.stringify({
        createdAt: Date.now(),
        elements,
      }),
    );
  } catch {
    // localStorage 滿了或被停用時不影響主要功能。
  }
}

function cacheKey(center, radius) {
  const roundedLat = Math.round(center.lat * 100) / 100;
  const roundedLng = Math.round(center.lng * 100) / 100;
  return `toilet-map:${roundedLat}:${roundedLng}:${radius}`;
}

function haversineMeters(lat1, lng1, lat2, lng2) {
  const earthRadius = 6371000;
  const toRad = (value) => (value * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
  return earthRadius * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function formatDistance(meters) {
  if (meters >= 1000) return `${(meters / 1000).toFixed(meters >= 3000 ? 0 : 1)} 公里`;
  return `${Math.round(meters)} 公尺`;
}

function latLngToObject(latLng) {
  return { lat: latLng.lat, lng: latLng.lng };
}

function updateStatus(message) {
  els.statusText.textContent = message;
}

function scheduleMapResize() {
  if (!state.map) return;
  window.requestAnimationFrame(() => {
    state.map.invalidateSize({ pan: false });
  });
  window.setTimeout(() => state.map.invalidateSize({ pan: false }), 250);
  window.setTimeout(() => state.map.invalidateSize({ pan: false }), 800);
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => {
    const entities = {
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#039;",
    };
    return entities[char];
  });
}
