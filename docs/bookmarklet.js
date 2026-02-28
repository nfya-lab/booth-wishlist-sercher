// Capture script src before IIFE (document.currentScript is null inside IIFE)
var _bwsScriptSrc = document.currentScript ? document.currentScript.src : "";
(() => {
  "use strict";

  // ===== Inject CSS (bookmarklet mode) =====
  if (!document.getElementById("bws-injected-style") && _bwsScriptSrc) {
    const baseUrl = _bwsScriptSrc.replace(/[^/]+(\?.*)?$/, "");
    const link = document.createElement("link");
    link.id = "bws-injected-style";
    link.rel = "stylesheet";
    link.href = baseUrl + "bookmarklet.css";
    document.head.appendChild(link);
  }

  // ===== Config =====
  const FETCH_CONCURRENCY = 5;
  const DEBOUNCE_MS = 300;

  function isMobile() { return window.innerWidth < 744; }

  // ===== State =====
  let itemsPerPage = 20;
  let gridColumns = isMobile() ? 2 : 5;
  let allItems = [];
  let filteredItems = [];
  let currentPage = 1;
  let totalApiPages = 1;
  let searchQuery = "";
  let excludeQuery = "";
  let selectedTags = new Set();
  let sortMode = "default";
  let selectedParentCategory = "";
  let selectedSubCategory = "";
  let priceMin = null;
  let priceMax = null;
  let selectedEvent = "";
  let selectedAgeRestriction = "";
  let includeSoldOut = true;
  let detailFetchComplete = false;
  let filterPanelOpen = false;
  let abortController = null;
  let contentObserver = null;
  let contentObserverTimer = null;
  let isInitializing = false;

  // ===== Management mode =====
  let managementMode = false;
  let selectedItemIds = new Set();
  let managementToolbar = null;

  // ===== List cache (keyed by wish list code) =====
  const CACHE_STORAGE_KEY = "bws_cache";
  const CACHE_TTL_MS = 30 * 60 * 1000; // 30 minutes
  const listCache = new Map();
  let currentListKey = null;

  // ===== DOM References =====
  let originalGrid = null;
  let originalPagination = null;
  let gridGap24 = null;
  let customGrid = null;
  let paginationEl = null;
  let progressContainer = null;
  let progressBar = null;
  let progressText = null;
  let resultCountEl = null;
  let searchInput = null;
  let clearBtn = null;
  let filterPanel = null;
  let filterToggleBtn = null;
  let filterBadge = null;
  let excludeInput = null;
  let tagInput = null;
  let parentCategorySelect = null;
  let subCategorySelect = null;
  let eventSelect = null;
  let priceMinInput = null;
  let priceMaxInput = null;
  let ageSelect = null;
  let soldOutCheckbox = null;

  // ===== URL helpers =====
  function getWishListCode() {
    const m = window.location.pathname.match(/\/wish_lists\/([^/?#]+)/);
    return m ? m[1] : null;
  }

  function getApiPageUrl(page) {
    const code = getWishListCode();
    let url = "/wish_list_name_items.json?page=" + page;
    if (code) {
      url += "&wish_list_name_code=" + encodeURIComponent(code);
    }
    return url;
  }

  // ===== Cache helpers =====
  function getCacheKey() {
    return getWishListCode() || "__all__";
  }

  function saveToCache() {
    if (currentListKey && allItems.length > 0) {
      const entry = {
        items: allItems,
        detailDone: detailFetchComplete,
        ts: Date.now(),
      };
      listCache.set(currentListKey, entry);
      persistCache();
    }
  }

  function persistCache() {
    try {
      const obj = {};
      listCache.forEach((val, key) => { obj[key] = val; });
      localStorage.setItem(CACHE_STORAGE_KEY, JSON.stringify(obj));
    } catch (_) { /* quota exceeded — ignore */ }
  }

  function loadPersistedCache() {
    try {
      const raw = localStorage.getItem(CACHE_STORAGE_KEY);
      if (!raw) return;
      const obj = JSON.parse(raw);
      const now = Date.now();
      for (const [key, entry] of Object.entries(obj)) {
        if (entry.ts && now - entry.ts < CACHE_TTL_MS) {
          listCache.set(key, entry);
        }
      }
    } catch (_) { /* corrupt data — ignore */ }
  }

  // ===== Cleanup =====
  function cleanup() {
    if (contentObserver) {
      contentObserver.disconnect();
      contentObserver = null;
    }
    clearTimeout(contentObserverTimer);

    if (abortController) {
      abortController.abort();
      abortController = null;
    }

    ["bws-search-sort-container", "bws-custom-grid", "bws-pagination"].forEach(
      (id) => {
        const el = document.getElementById(id);
        if (el) el.remove();
      }
    );

    document.querySelectorAll(".bws-hidden").forEach((el) => {
      el.classList.remove("bws-hidden");
    });

    allItems = [];
    filteredItems = [];
    currentPage = 1;
    itemsPerPage = 20;
    gridColumns = isMobile() ? 2 : 5;
    searchQuery = "";
    excludeQuery = "";
    selectedTags = new Set();
    sortMode = "default";
    selectedParentCategory = "";
    selectedSubCategory = "";
    priceMin = null;
    priceMax = null;
    selectedEvent = "";
    selectedAgeRestriction = "";
    includeSoldOut = true;
    detailFetchComplete = false;
    filterPanelOpen = false;
    exitManagementMode();
    originalGrid = null;
    originalPagination = null;
    gridGap24 = null;
    customGrid = null;
    paginationEl = null;
    progressContainer = null;
    progressBar = null;
    progressText = null;
    resultCountEl = null;
    searchInput = null;
    clearBtn = null;
    filterPanel = null;
    filterToggleBtn = null;
    filterBadge = null;
    excludeInput = null;
    tagInput = null;
    parentCategorySelect = null;
    subCategorySelect = null;
    eventSelect = null;
    priceMinInput = null;
    priceMaxInput = null;
    ageSelect = null;
    soldOutCheckbox = null;
  }

  // ===== Find DOM anchors =====
  function findDomAnchors() {
    const mp = document.getElementById("js-mount-point-wish-list");
    if (!mp) return null;

    const wrapper = mp.firstElementChild?.firstElementChild;
    if (!wrapper) return null;

    const g24 = wrapper.querySelector(".grid.gap-24");
    if (!g24) return null;

    const itemGrid = g24.querySelector(".grid.gap-x-16.gap-y-24");
    if (!itemGrid) return null;

    let pagination = null;
    const last = g24.lastElementChild;
    if (last && last !== itemGrid) {
      pagination = last;
    }

    return { gridGap24: g24, originalGrid: itemGrid, originalPagination: pagination };
  }

  // ===== Init =====
  function init() {
    isInitializing = true;

    // Save current list to cache before switching
    saveToCache();

    cleanup();

    const anchors = findDomAnchors();
    if (!anchors) {
      isInitializing = false;
      return;
    }

    gridGap24 = anchors.gridGap24;
    originalGrid = anchors.originalGrid;
    originalPagination = anchors.originalPagination;

    insertUI();

    // Check cache for the new list
    currentListKey = getCacheKey();
    const cached = listCache.get(currentListKey);

    if (cached) {
      // Show cache instantly, then validate against API
      allItems = cached.items;
      detailFetchComplete = cached.detailDone;
      if (progressContainer) progressContainer.style.display = "none";
      switchToCustomView();
      populateFilterOptions();
      applyFilterAndSort();
      // Resume detail fetch if it wasn't finished
      if (!detailFetchComplete) {
        fetchItemDetails();
      }
      // Validate cache in background (fetch only page 1)
      validateCache(cached);
    } else {
      loadAllPages();
    }

    isInitializing = false;
    setupContentObserver();
  }

  // ===== Persistent content observer =====
  // Detects when BOOTH re-renders content (e.g. tab switch) and our UI disappears
  function setupContentObserver() {
    if (contentObserver) contentObserver.disconnect();

    const mp = document.getElementById("js-mount-point-wish-list");
    if (!mp) return;

    contentObserver = new MutationObserver(() => {
      if (isInitializing) return;
      clearTimeout(contentObserverTimer);
      contentObserverTimer = setTimeout(() => {
        // If our UI was removed by BOOTH re-rendering, re-init
        if (!document.getElementById("bws-search-sort-container") && findDomAnchors()) {
          init();
        }
      }, 300);
    });
    contentObserver.observe(mp, { childList: true, subtree: true });
  }

  // ===== Insert UI =====
  function insertUI() {
    const container = document.createElement("div");
    container.id = "bws-search-sort-container";

    // ----- Helpers -----
    function createFilterSection(labelText, contentEl) {
      const section = document.createElement("div");
      section.className = "bws-filter-section";
      const label = document.createElement("div");
      label.className = "bws-filter-section-label";
      label.textContent = labelText;
      const content = document.createElement("div");
      content.className = "bws-filter-section-content";
      content.appendChild(contentEl);
      section.append(label, content);
      return section;
    }

    function createSelectWrapper(selectEl) {
      const wrapper = document.createElement("div");
      wrapper.className = "bws-select-wrapper";
      wrapper.appendChild(selectEl);
      return wrapper;
    }

    function createCheckbox(id, labelText, checked) {
      const label = document.createElement("label");
      label.className = "bws-checkbox-label";
      const input = document.createElement("input");
      input.type = "checkbox";
      input.id = id;
      input.checked = checked || false;
      const box = document.createElement("div");
      box.className = "bws-checkbox-box";
      box.innerHTML = '<svg viewBox="0 0 16 16"><polyline points="3 8 7 12 13 4"/></svg>';
      const text = document.createElement("div");
      text.className = "bws-checkbox-text";
      text.textContent = labelText;
      label.append(input, box, text);
      return { label, input };
    }

    function createSelect(id, options) {
      const select = document.createElement("select");
      select.id = id;
      options.forEach((o) => {
        const opt = document.createElement("option");
        opt.value = o.value;
        opt.textContent = o.label;
        select.appendChild(opt);
      });
      return select;
    }

    // ===== Search bar =====
    const searchWrapper = document.createElement("div");
    searchWrapper.id = "bws-search-wrapper";

    searchInput = document.createElement("input");
    searchInput.id = "bws-search-input";
    searchInput.type = "search";
    searchInput.placeholder = "\u30ad\u30fc\u30ef\u30fc\u30c9\u3092\u5165\u529b";
    searchInput.autocomplete = "off";

    clearBtn = document.createElement("button");
    clearBtn.id = "bws-clear-btn";
    clearBtn.textContent = "\u00d7";
    clearBtn.title = "\u30af\u30ea\u30a2";

    const searchIcon = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    searchIcon.id = "bws-search-icon";
    searchIcon.setAttribute("viewBox", "0 0 24 24");
    searchIcon.setAttribute("fill", "none");
    searchIcon.setAttribute("stroke", "currentColor");
    searchIcon.setAttribute("stroke-width", "2");
    searchIcon.innerHTML = '<circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>';

    searchWrapper.append(searchInput, clearBtn, searchIcon);

    // ===== Controls row: toggle + sort + count =====
    const controlsRow = document.createElement("div");
    controlsRow.id = "bws-controls-row";

    // Filter toggle button
    filterToggleBtn = document.createElement("button");
    filterToggleBtn.id = "bws-filter-toggle-btn";
    filterToggleBtn.type = "button";
    filterToggleBtn.innerHTML =
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="4" y1="6" x2="20" y2="6"/><line x1="7" y1="12" x2="17" y2="12"/><line x1="10" y1="18" x2="14" y2="18"/></svg>' +
      "\u7d5e\u308a\u8fbc\u307f";

    filterBadge = document.createElement("span");
    filterBadge.className = "bws-filter-badge";
    filterToggleBtn.appendChild(filterBadge);

    // Sort select
    const sortSelect = document.createElement("select");
    sortSelect.id = "bws-sort-select";
    [
      { value: "default", label: "\u30c7\u30d5\u30a9\u30eb\u30c8\u9806" },
      { value: "price-asc", label: "\u4fa1\u683c\uff1a\u5b89\u3044\u9806" },
      { value: "price-desc", label: "\u4fa1\u683c\uff1a\u9ad8\u3044\u9806" },
      { value: "likes-desc", label: "\u30b9\u30ad\u6570\uff1a\u591a\u3044\u9806" },
      { value: "likes-asc", label: "\u30b9\u30ad\u6570\uff1a\u5c11\u306a\u3044\u9806" },
      { value: "name-asc", label: "\u5546\u54c1\u540d\uff1a\u3042 \u2192 \u3093" },
      { value: "name-desc", label: "\u5546\u54c1\u540d\uff1a\u3093 \u2192 \u3042" },
    ].forEach((opt) => {
      const option = document.createElement("option");
      option.value = opt.value;
      option.textContent = opt.label;
      sortSelect.appendChild(option);
    });

    // Grid columns select
    const gridSelect = document.createElement("select");
    gridSelect.id = "bws-grid-select";
    function populateGridSelect() {
      gridSelect.innerHTML = "";
      const opts = isMobile()
        ? [2, 3, 4]
        : [3, 4, 5, 6, 7, 8, 9, 10];
      const defaultVal = isMobile() ? 2 : 5;
      opts.forEach(function(n) {
        const o = document.createElement("option");
        o.value = n;
        o.textContent = n + "列";
        if (n === gridColumns) o.selected = true;
        gridSelect.appendChild(o);
      });
      // clamp if current gridColumns not in range
      if (opts.indexOf(gridColumns) === -1) {
        gridColumns = defaultVal;
        gridSelect.value = defaultVal;
        updateGridColumns();
      }
    }
    populateGridSelect();

    gridSelect.addEventListener("change", function() {
      gridColumns = parseInt(gridSelect.value, 10);
      updateGridColumns();
    });

    // Per-page select
    const perPageSelect = document.createElement("select");
    perPageSelect.id = "bws-perpage-select";
    [20, 40, 60, 100].forEach(function(n) {
      const o = document.createElement("option");
      o.value = n;
      o.textContent = n + "件";
      if (n === itemsPerPage) o.selected = true;
      perPageSelect.appendChild(o);
    });

    perPageSelect.addEventListener("change", function() {
      itemsPerPage = parseInt(perPageSelect.value, 10);
      currentPage = 1;
      applyFilterAndSort();
    });

    // Resize handler: rebuild grid select choices on mobile<->PC switch
    let wasMobile = isMobile();
    window.addEventListener("resize", function() {
      const nowMobile = isMobile();
      if (nowMobile !== wasMobile) {
        wasMobile = nowMobile;
        populateGridSelect();
      }
    });

    resultCountEl = document.createElement("div");
    resultCountEl.id = "bws-result-count";

    controlsRow.append(filterToggleBtn, sortSelect, gridSelect, perPageSelect, resultCountEl);

    // ===== Filter panel (hidden by default) =====
    filterPanel = document.createElement("div");
    filterPanel.id = "bws-filter-panel";
    filterPanel.classList.add("bws-panel-hidden");

    // -- Exclude keyword --
    excludeInput = document.createElement("input");
    excludeInput.id = "bws-exclude-input";
    excludeInput.className = "bws-filter-input";
    excludeInput.type = "text";
    excludeInput.placeholder = "\u9664\u5916\u3057\u305f\u3044\u30ad\u30fc\u30ef\u30fc\u30c9\u3092\u5165\u529b";
    excludeInput.autocomplete = "off";
    const excludeContent = document.createElement("div");
    excludeContent.appendChild(excludeInput);
    const excludeHelper = document.createElement("div");
    excludeHelper.className = "bws-filter-helper";
    excludeHelper.textContent = "\u30b9\u30da\u30fc\u30b9\u533a\u5207\u308a\u3067\u8907\u6570\u6307\u5b9a\u53ef\u3002\u3044\u305a\u308c\u304b\u306b\u30de\u30c3\u30c1\u3057\u305f\u5546\u54c1\u3092\u9664\u5916\u3057\u307e\u3059\u3002";
    excludeContent.appendChild(excludeHelper);
    filterPanel.appendChild(createFilterSection("\u9664\u5916\u30ad\u30fc\u30ef\u30fc\u30c9", excludeContent));

    // -- Tag search (chip-based with autocomplete) --
    const tagContent = document.createElement("div");
    tagContent.className = "bws-tag-filter-content";

    const tagChipsArea = document.createElement("div");
    tagChipsArea.id = "bws-tag-chips";
    tagChipsArea.className = "bws-tag-chips";
    tagContent.appendChild(tagChipsArea);

    const tagInputWrapper = document.createElement("div");
    tagInputWrapper.className = "bws-tag-input-wrapper";

    tagInput = document.createElement("input");
    tagInput.id = "bws-tag-input";
    tagInput.className = "bws-filter-input";
    tagInput.type = "text";
    tagInput.placeholder = "タグ名を入力";
    tagInput.autocomplete = "off";
    tagInputWrapper.appendChild(tagInput);

    const tagSuggestList = document.createElement("div");
    tagSuggestList.id = "bws-tag-suggest";
    tagSuggestList.className = "bws-tag-suggest";
    tagInputWrapper.appendChild(tagSuggestList);

    tagContent.appendChild(tagInputWrapper);

    const tagHelper = document.createElement("div");
    tagHelper.className = "bws-filter-helper";
    tagHelper.textContent = "入力すると候補が表示されます。詳細読み込み完了後に有効。";
    tagContent.appendChild(tagHelper);
    filterPanel.appendChild(createFilterSection("タグ", tagContent));

    // -- Parent category --
    parentCategorySelect = createSelect("bws-parent-category-select", [
      { value: "", label: "\u6307\u5b9a\u306a\u3057" },
    ]);
    filterPanel.appendChild(createFilterSection("\u30ab\u30c6\u30b4\u30ea", createSelectWrapper(parentCategorySelect)));

    // -- Sub category (disabled until parent is selected) --
    subCategorySelect = createSelect("bws-sub-category-select", [
      { value: "", label: "\u6307\u5b9a\u306a\u3057" },
    ]);
    subCategorySelect.disabled = true;
    filterPanel.appendChild(createFilterSection("\u30b5\u30d6\u30ab\u30c6\u30b4\u30ea", createSelectWrapper(subCategorySelect)));

    // -- Event --
    eventSelect = createSelect("bws-event-select", [
      { value: "", label: "\u6307\u5b9a\u306a\u3057" },
    ]);
    filterPanel.appendChild(createFilterSection("\u30a4\u30d9\u30f3\u30c8", createSelectWrapper(eventSelect)));

    // -- Age restriction --
    ageSelect = createSelect("bws-age-select", [
      { value: "", label: "\u6307\u5b9a\u306a\u3057" },
      { value: "all-ages", label: "\u5168\u5e74\u9f62\u306e\u307f" },
      { value: "r18", label: "R18\u5546\u54c1\u306e\u307f" },
    ]);
    filterPanel.appendChild(createFilterSection("\u5e74\u9f62\u5236\u9650", createSelectWrapper(ageSelect)));

    // -- Sold out checkbox --
    const checkboxContent = document.createElement("div");
    const soldOutCb = createCheckbox("bws-soldout-checkbox", "\u5728\u5eab\u306a\u3057\u30fb\u8ca9\u58f2\u7d42\u4e86\u3092\u542b\u3080", true);
    soldOutCheckbox = soldOutCb.input;
    checkboxContent.appendChild(soldOutCb.label);
    filterPanel.appendChild(createFilterSection("\u305d\u306e\u4ed6", checkboxContent));

    // -- Price --
    const priceContent = document.createElement("div");
    const priceInputs = document.createElement("div");
    priceInputs.className = "bws-price-inputs";
    priceMinInput = document.createElement("input");
    priceMinInput.id = "bws-price-min";
    priceMinInput.className = "bws-price-input";
    priceMinInput.type = "number";
    priceMinInput.placeholder = "\u00a5 min";
    priceMinInput.min = "0";
    const priceSep = document.createElement("span");
    priceSep.className = "bws-price-sep";
    priceSep.textContent = "\u301c";
    priceMaxInput = document.createElement("input");
    priceMaxInput.id = "bws-price-max";
    priceMaxInput.className = "bws-price-input";
    priceMaxInput.type = "number";
    priceMaxInput.placeholder = "\u00a5 max";
    priceMaxInput.min = "0";
    priceInputs.append(priceMinInput, priceSep, priceMaxInput);
    priceContent.appendChild(priceInputs);
    filterPanel.appendChild(createFilterSection("\u4fa1\u683c", priceContent));

    // ===== Progress bar =====
    progressContainer = document.createElement("div");
    progressContainer.id = "bws-progress-container";

    const progressBarWrapper = document.createElement("div");
    progressBarWrapper.id = "bws-progress-bar-wrapper";

    progressBar = document.createElement("div");
    progressBar.id = "bws-progress-bar";

    progressText = document.createElement("span");
    progressText.id = "bws-progress-text";
    progressText.textContent = "\u8aad\u307f\u8fbc\u307f\u4e2d... 0/? \u30da\u30fc\u30b8";

    progressBarWrapper.appendChild(progressBar);
    progressContainer.append(progressBarWrapper, progressText);

    // ===== Assemble container =====
    container.append(searchWrapper, controlsRow, filterPanel, progressContainer);

    // Insert into page
    const countRow = gridGap24.children[1];
    if (countRow) {
      countRow.after(container);
    } else {
      gridGap24.prepend(container);
    }

    // Custom grid
    customGrid = document.createElement("div");
    customGrid.id = "bws-custom-grid";
    customGrid.style.display = "none";
    if (originalGrid) {
      originalGrid.after(customGrid);
    } else {
      gridGap24.appendChild(customGrid);
    }

    // Custom pagination
    paginationEl = document.createElement("div");
    paginationEl.id = "bws-pagination";
    paginationEl.style.display = "none";
    if (originalPagination) {
      originalPagination.after(paginationEl);
    } else {
      gridGap24.appendChild(paginationEl);
    }

    // ===== Event listeners =====
    // Search input
    let debounceTimer = null;
    searchInput.addEventListener("input", () => {
      clearBtn.style.display = searchInput.value ? "block" : "none";
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        searchQuery = searchInput.value.trim().toLowerCase();
        currentPage = 1;
        applyFilterAndSort();
      }, DEBOUNCE_MS);
    });

    clearBtn.addEventListener("click", () => {
      searchInput.value = "";
      clearBtn.style.display = "none";
      searchQuery = "";
      currentPage = 1;
      applyFilterAndSort();
    });

    // Sort
    sortSelect.addEventListener("change", () => {
      sortMode = sortSelect.value;
      currentPage = 1;
      applyFilterAndSort();
    });

    // Filter toggle
    filterToggleBtn.addEventListener("click", () => {
      filterPanelOpen = !filterPanelOpen;
      filterPanel.classList.toggle("bws-panel-hidden", !filterPanelOpen);
      filterToggleBtn.classList.toggle("active", filterPanelOpen);
    });

    // Exclude keyword
    let excludeTimer = null;
    excludeInput.addEventListener("input", () => {
      clearTimeout(excludeTimer);
      excludeTimer = setTimeout(() => {
        excludeQuery = excludeInput.value.trim().toLowerCase();
        currentPage = 1;
        applyFilterAndSort();
      }, DEBOUNCE_MS);
    });

    // Tag search (input → show suggestions, Enter or click → add chip)
    tagInput.addEventListener("input", () => {
      showTagSuggestions(tagInput.value.trim(), tagSuggestList);
    });
    tagInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        const val = tagInput.value.trim();
        if (val && !selectedTags.has(val)) {
          addTagToFilter(val);
          tagInput.value = "";
          tagSuggestList.innerHTML = "";
          tagSuggestList.classList.remove("show");
        }
      } else if (e.key === "Escape") {
        tagSuggestList.innerHTML = "";
        tagSuggestList.classList.remove("show");
      }
    });
    tagInput.addEventListener("blur", () => {
      // Delay to allow click on suggestion
      setTimeout(() => {
        tagSuggestList.innerHTML = "";
        tagSuggestList.classList.remove("show");
      }, 200);
    });

    // Parent category
    parentCategorySelect.addEventListener("change", () => {
      selectedParentCategory = parentCategorySelect.value;
      selectedSubCategory = "";
      subCategorySelect.disabled = !selectedParentCategory;
      updateSubCategoryOptions();
      currentPage = 1;
      applyFilterAndSort();
    });

    // Sub category
    subCategorySelect.addEventListener("change", () => {
      selectedSubCategory = subCategorySelect.value;
      currentPage = 1;
      applyFilterAndSort();
    });

    // Event
    eventSelect.addEventListener("change", () => {
      selectedEvent = eventSelect.value;
      currentPage = 1;
      applyFilterAndSort();
    });

    // Price range
    let priceTimer = null;
    const onPriceChange = () => {
      clearTimeout(priceTimer);
      priceTimer = setTimeout(() => {
        priceMin = priceMinInput.value !== "" ? parseInt(priceMinInput.value, 10) : null;
        priceMax = priceMaxInput.value !== "" ? parseInt(priceMaxInput.value, 10) : null;
        currentPage = 1;
        applyFilterAndSort();
      }, DEBOUNCE_MS);
    };
    priceMinInput.addEventListener("input", onPriceChange);
    priceMaxInput.addEventListener("input", onPriceChange);

    // Age restriction
    ageSelect.addEventListener("change", () => {
      selectedAgeRestriction = ageSelect.value;
      currentPage = 1;
      applyFilterAndSort();
    });

    // Sold out
    soldOutCheckbox.addEventListener("change", () => {
      includeSoldOut = soldOutCheckbox.checked;
      currentPage = 1;
      applyFilterAndSort();
    });

    // ===== Intercept BOOTH's "スキの管理" button =====
    interceptBoothManageButton();
  }

  // ===== API-based data loading =====
  async function validateCache(cached) {
    try {
      const data = await fetchItemPage(1);
      const totalItems = data.pagination.total_pages * 20; // rough estimate
      const actualFirstIds = data.items.map((i) => i.id);
      const cachedFirstIds = cached.items.slice(0, 20).map((i) => i.id);

      // Check if first page IDs match and total pages match
      const totalPages = data.pagination.total_pages;
      const cachedPages = Math.ceil(cached.items.length / 20);
      const idsMatch = actualFirstIds.length === cachedFirstIds.length &&
        actualFirstIds.every((id, i) => id === cachedFirstIds[i]);

      if (idsMatch && totalPages === cachedPages) {
        // Cache is still valid
        return;
      }

      // Cache is stale — reload everything
      console.log("BWS: Cache stale, reloading...");
      listCache.delete(currentListKey);
      persistCache();
      loadAllPages();
    } catch (e) {
      // Network error — just keep using cache
      console.warn("BWS: Cache validation failed, using cache", e);
    }
  }

  async function loadAllPages() {
    if (abortController) abortController.abort();
    abortController = new AbortController();
    const signal = abortController.signal;

    allItems = [];
    let loaded = 0;

    try {
      const data = await fetchItemPage(1, signal);
      totalApiPages = data.pagination.total_pages;
      loaded = 1;
      updateProgress(loaded, totalApiPages);

      const items = transformItems(data.items);
      const likes = await fetchLikes(data.items.map((i) => i.id), signal);
      items.forEach((item) => {
        item.likes = likes[item.id] || 0;
      });
      allItems = items;
    } catch (e) {
      if (e.name === "AbortError") return;
      console.error("BWS: Failed to fetch page 1", e);
      finishLoading();
      return;
    }

    if (totalApiPages <= 1) {
      finishLoading();
      return;
    }

    const pageNums = [];
    for (let p = 2; p <= totalApiPages; p++) {
      pageNums.push(p);
    }

    for (let i = 0; i < pageNums.length; i += FETCH_CONCURRENCY) {
      if (signal.aborted) return;

      const batch = pageNums.slice(i, i + FETCH_CONCURRENCY);
      const results = await Promise.allSettled(
        batch.map(async (p) => {
          const data = await fetchItemPage(p, signal);
          const items = transformItems(data.items);
          const likes = await fetchLikes(data.items.map((it) => it.id), signal);
          items.forEach((item) => {
            item.likes = likes[item.id] || 0;
          });
          return items;
        })
      );

      if (signal.aborted) return;

      results.forEach((result) => {
        if (result.status === "fulfilled") {
          allItems = allItems.concat(result.value);
        }
        loaded++;
        updateProgress(loaded, totalApiPages);
      });
    }

    finishLoading();
  }

  async function fetchItemPage(page, signal) {
    const url = getApiPageUrl(page);
    const resp = await fetch(url, {
      credentials: "same-origin",
      headers: { Accept: "application/json" },
      signal,
    });
    if (!resp.ok) throw new Error("HTTP " + resp.status);
    return resp.json();
  }

  async function fetchLikes(itemIds, signal) {
    if (!itemIds.length) return {};
    const params = itemIds.map((id) => "item_ids[]=" + id).join("&");
    const resp = await fetch("/wish_lists.json?" + params, {
      credentials: "same-origin",
      headers: { Accept: "application/json" },
      signal,
    });
    if (!resp.ok) return {};
    const data = await resp.json();
    return data.wishlists_counts || {};
  }

  function transformItems(apiItems) {
    return apiItems.map((item) => ({
      id: item.id,
      name: item.name || "",
      itemUrl: item.url || "",
      imageUrls: item.thumbnail_image_urls || [],
      parentCategory: getCategoryName(item.category?.parent) || "",
      category: getCategoryName(item.category) || "",
      categoryUrl: item.category?.url || "",
      isVrchat: item.is_vrchat || false,
      isAdult: item.is_adult || false,
      isSoldOut: item.is_sold_out || false,
      isEndOfSale: item.is_end_of_sale || false,
      eventName: item.event?.name || null,
      shopName: item.shop?.name || "",
      shopUrl: item.shop?.url || "",
      shopIconUrl: item.shop?.thumbnail_url || "",
      priceText: item.price || "\u00a5 0",
      priceNum: parsePrice(item.price || "0"),
      tags: [],
      likes: 0,
    }));
  }

  function getCategoryName(cat) {
    if (!cat) return "";
    if (typeof cat.name === "string") return cat.name;
    return cat.name?.ja || "";
  }

  function parsePrice(text) {
    const match = text.replace(/,/g, "").match(/(\d+)/);
    return match ? parseInt(match[1], 10) : 0;
  }

  // ===== Progress =====
  function updateProgress(loaded, total) {
    const pct = Math.round((loaded / total) * 100);
    if (progressBar) progressBar.style.width = pct + "%";
    if (progressText) {
      progressText.textContent = "\u8aad\u307f\u8fbc\u307f\u4e2d... " + loaded + "/" + total + " \u30da\u30fc\u30b8";
    }
  }

  function finishLoading() {
    if (progressContainer) progressContainer.style.display = "none";
    switchToCustomView();
    populateFilterOptions();
    applyFilterAndSort();
    saveToCache();
    fetchItemDetails();
  }

  // ===== Populate filter dropdowns =====
  function populateFilterOptions() {
    // Parent categories
    const parentCats = [...new Set(allItems.map((i) => i.parentCategory).filter(Boolean))].sort();
    if (parentCategorySelect) {
      while (parentCategorySelect.options.length > 1) parentCategorySelect.remove(1);
      parentCats.forEach((cat) => {
        const opt = document.createElement("option");
        opt.value = cat;
        opt.textContent = cat;
        parentCategorySelect.appendChild(opt);
      });
    }

    // Sub categories
    updateSubCategoryOptions();

    // Events
    const events = [...new Set(allItems.map((i) => i.eventName).filter(Boolean))].sort();
    if (eventSelect) {
      while (eventSelect.options.length > 1) eventSelect.remove(1);
      events.forEach((ev) => {
        const opt = document.createElement("option");
        opt.value = ev;
        opt.textContent = ev;
        eventSelect.appendChild(opt);
      });
    }
  }

  function updateSubCategoryOptions() {
    if (!subCategorySelect) return;

    // Preserve current selection if still valid
    const prevValue = subCategorySelect.value;
    while (subCategorySelect.options.length > 1) subCategorySelect.remove(1);

    let items = allItems;
    if (selectedParentCategory) {
      items = items.filter((i) => i.parentCategory === selectedParentCategory);
    }

    const subCats = [...new Set(items.map((i) => i.category).filter(Boolean))].sort();
    subCats.forEach((cat) => {
      const opt = document.createElement("option");
      opt.value = cat;
      opt.textContent = cat;
      subCategorySelect.appendChild(opt);
    });

    // Restore selection if the value still exists
    if (subCats.includes(prevValue)) {
      subCategorySelect.value = prevValue;
    } else {
      subCategorySelect.value = "";
      selectedSubCategory = "";
    }
  }

  // ===== Fetch item details (background, via service worker) =====
  async function fetchItemDetails() {
    if (!allItems.length) return;
    const signal = abortController?.signal;
    if (!signal || signal.aborted) return;

    if (progressContainer) {
      progressContainer.style.display = "";
      if (progressBar) progressBar.style.width = "0%";
      if (progressText) progressText.textContent = "\u8a73\u7d30\u8aad\u307f\u8fbc\u307f\u4e2d... 0/" + allItems.length;
    }

    let loaded = 0;
    const total = allItems.length;

    for (let i = 0; i < allItems.length; i += FETCH_CONCURRENCY) {
      if (signal.aborted) return;

      const batch = allItems.slice(i, i + FETCH_CONCURRENCY);
      const batchIds = batch.map((item) => item.id);

      try {
        const results = await fetchDetailsBatch(batchIds);
        if (signal.aborted) return;

        results.forEach((result) => {
          if (result.data) {
            const item = allItems.find((it) => it.id === result.id);
            if (!item) return;

            // Fill in tags
            if (result.data.tags && Array.isArray(result.data.tags)) {
              item.tags = result.data.tags.map((t) => t.name || "").filter(Boolean);
            }

            // Fill in parent category if missing
            if (!item.parentCategory && result.data.category) {
              const parentCat = result.data.category.parent;
              if (parentCat) {
                item.parentCategory = getCategoryName(parentCat);
              }
            }
          }
          loaded++;
        });
      } catch (e) {
        // If sendMessage fails (e.g., extension reloaded), stop gracefully
        console.warn("BWS: Detail fetch batch failed", e);
        loaded += batch.length;
      }

      const pct = Math.round((loaded / total) * 100);
      if (progressBar) progressBar.style.width = pct + "%";
      if (progressText) progressText.textContent = "\u8a73\u7d30\u8aad\u307f\u8fbc\u307f\u4e2d... " + loaded + "/" + total;
    }

    detailFetchComplete = true;
    if (progressContainer) progressContainer.style.display = "none";
    // Re-populate in case parent categories were filled from detail API
    populateFilterOptions();
    applyFilterAndSort();
    saveToCache();
  }

  async function fetchDetailsBatch(itemIds) {
    const results = await Promise.allSettled(
      itemIds.map(function(id) {
        return fetch("https://booth.pm/ja/items/" + id + ".json", {
          headers: { Accept: "application/json" },
          credentials: "include",
        })
          .then(function(r) { return r.ok ? r.json() : null; })
          .then(function(data) { return { id: id, data: data }; })
          .catch(function() { return { id: id, data: null }; });
      })
    );
    return results
      .filter(function(r) { return r.status === "fulfilled"; })
      .map(function(r) { return r.value; });
  }

  // ===== Grid columns =====
  function updateGridColumns() {
    if (!customGrid) return;
    customGrid.style.gridTemplateColumns = "repeat(" + gridColumns + ", 1fr)";
  }

  // ===== View switching =====
  function switchToCustomView() {
    if (originalGrid) originalGrid.classList.add("bws-hidden");
    if (originalPagination) originalPagination.classList.add("bws-hidden");
    if (customGrid) customGrid.style.display = "";
    if (paginationEl) paginationEl.style.display = "";
    updateGridColumns();
  }

  // ===== Filter and sort =====
  // ===== Tag chip helpers =====
  function renderTagChips() {
    const area = document.getElementById("bws-tag-chips");
    if (!area) return;
    area.innerHTML = "";
    selectedTags.forEach((tag) => {
      const chip = document.createElement("span");
      chip.className = "bws-tag-chip";
      chip.textContent = "タグ: " + tag;
      const closeBtn = document.createElement("span");
      closeBtn.className = "bws-tag-chip-close";
      closeBtn.textContent = "\u00d7";
      closeBtn.addEventListener("click", () => {
        selectedTags.delete(tag);
        renderTagChips();
        currentPage = 1;
        applyFilterAndSort();
      });
      chip.appendChild(closeBtn);
      area.appendChild(chip);
    });
  }

  function addTagToFilter(tagName) {
    if (!tagName || selectedTags.has(tagName)) return;
    selectedTags.add(tagName);
    renderTagChips();
    // Open filter panel if closed
    if (!filterPanelOpen && filterToggleBtn) {
      filterPanelOpen = true;
      filterPanel.classList.remove("bws-panel-hidden");
      filterToggleBtn.classList.add("active");
    }
    currentPage = 1;
    applyFilterAndSort();
  }

  function showTagSuggestions(query, container) {
    container.innerHTML = "";
    if (!query) {
      container.classList.remove("show");
      return;
    }
    const q = query.toLowerCase();
    // Collect all tags with counts
    const tagCounts = new Map();
    allItems.forEach((item) => {
      item.tags.forEach((t) => {
        tagCounts.set(t, (tagCounts.get(t) || 0) + 1);
      });
    });
    // Filter matching tags, exclude already selected
    const matches = [...tagCounts.entries()]
      .filter(([tag]) => tag.toLowerCase().includes(q) && !selectedTags.has(tag))
      .sort((a, b) => b[1] - a[1])
      .slice(0, 20);

    if (matches.length === 0) {
      container.classList.remove("show");
      return;
    }
    matches.forEach(([tag, count]) => {
      const item = document.createElement("div");
      item.className = "bws-tag-suggest-item";
      const nameSpan = document.createElement("span");
      nameSpan.className = "bws-tag-suggest-name";
      nameSpan.textContent = tag;
      const countSpan = document.createElement("span");
      countSpan.className = "bws-tag-suggest-count";
      countSpan.textContent = count;
      item.append(nameSpan, countSpan);
      item.addEventListener("mousedown", (e) => {
        e.preventDefault(); // Prevent blur
        addTagToFilter(tag);
        tagInput.value = "";
        container.innerHTML = "";
        container.classList.remove("show");
        tagInput.focus();
      });
      container.appendChild(item);
    });
    container.classList.add("show");
  }

  function applyFilterAndSort() {
    filteredItems = [...allItems];

    // 1. Keyword search (AND, space-separated)
    if (searchQuery) {
      const queries = searchQuery.split(/\s+/).filter(Boolean);
      filteredItems = filteredItems.filter((item) => {
        const haystack = (item.name + " " + item.shopName + " " + item.category + " " + item.parentCategory + " " + item.tags.join(" ")).toLowerCase();
        return queries.every((q) => haystack.includes(q));
      });
    }

    // 2. Exclude keywords (OR, space-separated)
    if (excludeQuery) {
      const excludes = excludeQuery.split(/\s+/).filter(Boolean);
      filteredItems = filteredItems.filter((item) => {
        const haystack = (item.name + " " + item.shopName + " " + item.category + " " + item.parentCategory + " " + item.tags.join(" ")).toLowerCase();
        return !excludes.some((q) => haystack.includes(q));
      });
    }

    // 3. Tag filter (AND — item must have all selected tags)
    if (selectedTags.size > 0) {
      filteredItems = filteredItems.filter((item) => {
        const tagsLower = item.tags.map((t) => t.toLowerCase());
        return [...selectedTags].every((q) =>
          tagsLower.some((t) => t.includes(q.toLowerCase()))
        );
      });
    }

    // 4. Parent category filter
    if (selectedParentCategory) {
      filteredItems = filteredItems.filter((item) => item.parentCategory === selectedParentCategory);
    }

    // 4. Sub category filter
    if (selectedSubCategory) {
      filteredItems = filteredItems.filter((item) => item.category === selectedSubCategory);
    }

    // 5. Price filter
    if (priceMin !== null) {
      filteredItems = filteredItems.filter((item) => item.priceNum >= priceMin);
    }
    if (priceMax !== null) {
      filteredItems = filteredItems.filter((item) => item.priceNum <= priceMax);
    }

    // 6. Event filter
    if (selectedEvent) {
      filteredItems = filteredItems.filter((item) => item.eventName === selectedEvent);
    }

    // 7. Age restriction filter
    if (selectedAgeRestriction === "all-ages") {
      filteredItems = filteredItems.filter((item) => !item.isAdult);
    } else if (selectedAgeRestriction === "r18") {
      filteredItems = filteredItems.filter((item) => item.isAdult);
    }

    // 8. Sold out / end of sale filter (default: exclude)
    if (!includeSoldOut) {
      filteredItems = filteredItems.filter(
        (item) => !item.isSoldOut && !item.isEndOfSale
      );
    }

    // Sort
    if (sortMode !== "default") {
      filteredItems.sort((a, b) => {
        switch (sortMode) {
          case "price-asc":
            return a.priceNum - b.priceNum;
          case "price-desc":
            return b.priceNum - a.priceNum;
          case "likes-desc":
            return b.likes - a.likes;
          case "likes-asc":
            return a.likes - b.likes;
          case "name-asc":
            return a.name.localeCompare(b.name, "ja");
          case "name-desc":
            return b.name.localeCompare(a.name, "ja");
          default:
            return 0;
        }
      });
    }

    // Update filter badge
    updateFilterBadge();

    // Update result count
    const hasActiveFilter = searchQuery || excludeQuery || selectedTags.size > 0 || selectedParentCategory ||
      selectedSubCategory || priceMin !== null || priceMax !== null ||
      selectedEvent || selectedAgeRestriction || !includeSoldOut;

    if (resultCountEl) {
      if (hasActiveFilter) {
        resultCountEl.textContent = filteredItems.length + " / " + allItems.length + " \u4ef6\u304c\u30d2\u30c3\u30c8";
      } else {
        resultCountEl.textContent = "\u5168 " + allItems.length + " \u4ef6";
      }
    }

    renderItems();
    renderPagination();
  }

  function updateFilterBadge() {
    let count = 0;
    if (excludeQuery) count++;
    if (selectedTags.size > 0) count++;
    if (selectedParentCategory) count++;
    if (selectedSubCategory) count++;
    if (priceMin !== null || priceMax !== null) count++;
    if (selectedEvent) count++;
    if (selectedAgeRestriction) count++;
    if (includeSoldOut) count++;

    if (filterBadge) {
      filterBadge.textContent = count;
      filterBadge.classList.toggle("show", count > 0);
    }
  }

  // ===== Render items =====
  function renderItems() {
    if (!customGrid) return;
    customGrid.innerHTML = "";

    // No items in wish list at all
    if (allItems.length === 0) {
      const empty = document.createElement("div");
      empty.className = "bws-empty-message";
      empty.textContent = "スキした商品がありません";
      customGrid.appendChild(empty);
      return;
    }

    // Filters returned no results
    if (filteredItems.length === 0) {
      const empty = document.createElement("div");
      empty.className = "bws-empty-message";
      empty.textContent = "検索条件に一致する商品がありません";
      customGrid.appendChild(empty);
      return;
    }

    const start = (currentPage - 1) * itemsPerPage;
    const end = start + itemsPerPage;
    const pageItems = filteredItems.slice(start, end);

    pageItems.forEach((item) => {
      customGrid.appendChild(createItemCard(item));
    });

    if (currentPage > 1 || searchQuery || excludeQuery) {
      const target = document.getElementById("bws-search-sort-container") || customGrid;
      target.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  }

  // ===== Wish list management API =====
  function getCSRFToken() {
    const meta = document.querySelector('meta[name="csrf-token"]');
    return meta ? meta.getAttribute("content") : "";
  }

  async function fetchWishListItemsForItem(itemId) {
    const resp = await fetch("/items/" + itemId + "/wish_list_items.json", {
      credentials: "same-origin",
      headers: { Accept: "application/json" },
    });
    if (!resp.ok) throw new Error("HTTP " + resp.status);
    return resp.json();
  }

  async function updateWishListItems(itemId, codes) {
    const token = getCSRFToken();
    const resp = await fetch("/items/" + itemId + "/wish_list_items.json", {
      method: "PATCH",
      credentials: "include",
      headers: {
        "X-CSRF-Token": token,
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ wish_list_name_codes: codes }),
    });
    if (!resp.ok) throw new Error("HTTP " + resp.status);
  }

  async function removeFromAllWishLists(itemId) {
    const token = getCSRFToken();
    const resp = await fetch("/items/" + itemId + "/wish_list", {
      method: "DELETE",
      credentials: "include",
      headers: {
        "X-CSRF-Token": token,
        Accept: "application/json",
        "Content-Type": "application/json",
      },
    });
    if (!resp.ok) throw new Error("HTTP " + resp.status);
  }

  // ===== Management mode functions =====
  function interceptBoothManageButton() {
    const findAndBind = () => {
      const btns = document.querySelectorAll("button");
      for (const btn of btns) {
        if (btn.textContent.trim() === "スキの管理" && !btn.dataset.bwsIntercepted) {
          btn.dataset.bwsIntercepted = "true";
          btn.addEventListener("click", (e) => {
            if (customGrid && customGrid.style.display !== "none") {
              e.preventDefault();
              e.stopPropagation();
              e.stopImmediatePropagation();
              enterManagementMode();
            }
          }, true);
        }
      }
    };
    findAndBind();
    const mp = document.getElementById("js-mount-point-wish-list");
    if (mp) {
      const obs = new MutationObserver(() => findAndBind());
      obs.observe(mp, { childList: true, subtree: true });
    }
  }

  function enterManagementMode() {
    managementMode = true;
    selectedItemIds.clear();
    buildManagementToolbar();
    renderItems();
  }

  function exitManagementMode() {
    managementMode = false;
    selectedItemIds.clear();
    if (managementToolbar) {
      managementToolbar.remove();
      managementToolbar = null;
    }
    closeMgmtModal();
    if (customGrid) renderItems();
  }

  function buildManagementToolbar() {
    if (managementToolbar) managementToolbar.remove();

    managementToolbar = document.createElement("div");
    managementToolbar.id = "bws-management-toolbar";

    // Left group: すべてを選択 / 選択解除
    const leftGroup = document.createElement("div");
    leftGroup.className = "bws-mgmt-left";

    const selectAllBtn = document.createElement("button");
    selectAllBtn.className = "bws-mgmt-btn";
    selectAllBtn.textContent = "すべてを選択";
    selectAllBtn.addEventListener("click", () => {
      const start = (currentPage - 1) * itemsPerPage;
      const end = start + itemsPerPage;
      filteredItems.slice(start, end).forEach((item) => selectedItemIds.add(item.id));
      syncManagementState();
    });

    const deselectBtn = document.createElement("button");
    deselectBtn.className = "bws-mgmt-btn";
    deselectBtn.disabled = true;
    deselectBtn.textContent = "選択解除";
    deselectBtn.addEventListener("click", () => {
      selectedItemIds.clear();
      syncManagementState();
    });

    leftGroup.append(selectAllBtn, deselectBtn);

    // Right group: キャンセル / ゴミ箱 / スキリストに追加
    const rightGroup = document.createElement("div");
    rightGroup.className = "bws-mgmt-right";

    const cancelBtn = document.createElement("button");
    cancelBtn.className = "bws-mgmt-btn";
    cancelBtn.textContent = "キャンセル";
    cancelBtn.addEventListener("click", () => exitManagementMode());

    const trashBtn = document.createElement("button");
    trashBtn.className = "bws-mgmt-btn bws-mgmt-trash";
    trashBtn.title = "すべてのスキリストから解除";
    trashBtn.disabled = true;
    trashBtn.innerHTML = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/></svg>';
    trashBtn.addEventListener("click", () => {
      if (selectedItemIds.size === 0) return;
      bulkRemoveFromAllLists();
    });

    const addBtn = document.createElement("button");
    addBtn.className = "bws-mgmt-btn bws-mgmt-add";
    addBtn.disabled = true;
    addBtn.textContent = "スキリストに追加";
    addBtn.addEventListener("click", () => {
      if (selectedItemIds.size === 0) return;
      openMgmtModal();
    });

    rightGroup.append(cancelBtn, trashBtn, addBtn);
    managementToolbar.append(leftGroup, rightGroup);

    // Store refs for enable/disable
    managementToolbar._deselectBtn = deselectBtn;
    managementToolbar._trashBtn = trashBtn;
    managementToolbar._addBtn = addBtn;

    // Insert after controls row, before custom grid
    const container = document.getElementById("bws-search-sort-container");
    if (container) {
      container.after(managementToolbar);
    }
  }

  function syncManagementState() {
    const hasSelection = selectedItemIds.size > 0;
    if (managementToolbar) {
      managementToolbar._deselectBtn.disabled = !hasSelection;
      managementToolbar._trashBtn.disabled = !hasSelection;
      managementToolbar._addBtn.disabled = !hasSelection;
    }
    // Update checkboxes
    if (customGrid) {
      customGrid.querySelectorAll(".bws-mgmt-checkbox").forEach((cb) => {
        cb.checked = selectedItemIds.has(parseInt(cb.dataset.itemId, 10));
      });
    }
  }

  async function bulkRemoveFromAllLists() {
    if (!confirm("すべてのスキリストから解除します。よろしいですか？")) return;

    const ids = [...selectedItemIds];
    let failed = 0;

    for (const id of ids) {
      try {
        await removeFromAllWishLists(id);
        allItems = allItems.filter((item) => item.id !== id);
      } catch (err) {
        console.error("BWS: Failed to remove item " + id, err);
        failed++;
      }
    }

    selectedItemIds.clear();
    saveToCache();
    applyFilterAndSort();
    if (failed > 0) alert(failed + "件の解除に失敗しました。");
    exitManagementMode();
  }

  // ===== Management modal (matches BOOTH's modal) =====
  function openMgmtModal() {
    closeMgmtModal();

    const overlay = document.createElement("div");
    overlay.id = "bws-mgmt-modal-overlay";
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) closeMgmtModal();
    });

    const modal = document.createElement("div");
    modal.className = "bws-mgmt-modal";

    // Close button
    const closeBtn = document.createElement("button");
    closeBtn.className = "bws-mgmt-modal-close";
    closeBtn.textContent = "\u00d7";
    closeBtn.addEventListener("click", () => closeMgmtModal());

    // Title
    const title = document.createElement("div");
    title.className = "bws-mgmt-modal-title";
    title.textContent = "スキを管理";

    // Subtitle
    const subtitle = document.createElement("div");
    subtitle.className = "bws-mgmt-modal-subtitle";
    const listName = getCurrentListName();
    subtitle.textContent = listName + "から " + selectedItemIds.size + "件の商品を選択中";

    // Dropdown label
    const dropdownLabel = document.createElement("div");
    dropdownLabel.className = "bws-mgmt-modal-label";
    dropdownLabel.textContent = "追加するリストを選択";

    // Select dropdown
    const selectEl = document.createElement("select");
    selectEl.className = "bws-mgmt-modal-select";
    selectEl.innerHTML = '<option value="">読み込み中...</option>';
    selectEl.disabled = true;

    // Save button
    const saveBtn = document.createElement("button");
    saveBtn.className = "bws-mgmt-modal-save";
    saveBtn.textContent = "保存する";
    saveBtn.disabled = true;

    modal.append(closeBtn, title, subtitle, dropdownLabel, selectEl, saveBtn);
    overlay.appendChild(modal);
    document.body.appendChild(overlay);

    // Fetch wish list names
    fetch("/wish_list_names.json", {
      credentials: "same-origin",
      headers: { Accept: "application/json" },
    })
      .then((r) => r.ok ? r.json() : Promise.reject("HTTP " + r.status))
      .then((lists) => {
        selectEl.innerHTML = "";
        lists.forEach((list) => {
          const opt = document.createElement("option");
          opt.value = list.code || list.wish_list_name_code || "";
          opt.textContent = list.name || list.wish_list_name_name || "";
          selectEl.appendChild(opt);
        });
        selectEl.disabled = false;
        saveBtn.disabled = false;
      })
      .catch(() => {
        selectEl.innerHTML = '<option value="">読み込みに失敗しました</option>';
      });

    saveBtn.addEventListener("click", async () => {
      const code = selectEl.value;
      if (!code) return;
      saveBtn.disabled = true;
      saveBtn.textContent = "保存中...";

      const ids = [...selectedItemIds];
      let failed = 0;

      for (const id of ids) {
        try {
          const currentLists = await fetchWishListItemsForItem(id);
          const currentCodes = currentLists
            .filter((l) => l.is_item_in_wish_list_name)
            .map((l) => l.wish_list_name_code);
          const mergedCodes = [...new Set([...currentCodes, code])];
          await updateWishListItems(id, mergedCodes);
        } catch (err) {
          console.error("BWS: Failed to add item " + id, err);
          failed++;
        }
      }

      closeMgmtModal();
      if (failed > 0) alert(failed + "件の追加に失敗しました。");
      exitManagementMode();
    });
  }

  function closeMgmtModal() {
    const overlay = document.getElementById("bws-mgmt-modal-overlay");
    if (overlay) overlay.remove();
  }

  function getCurrentListName() {
    const code = getWishListCode();
    if (!code) return "すべてのスキ";
    // Try to find from tab buttons
    const mp = document.getElementById("js-mount-point-wish-list");
    if (mp) {
      const activeTab = mp.querySelector("button[class*='bg-primary']") ||
        mp.querySelector("button.charcoal-button[data-variant='Primary']");
      if (activeTab) return activeTab.textContent.trim();
    }
    return "スキリスト";
  }

  // Close any open wish list popup when clicking outside
  document.addEventListener("click", (e) => {
    if (!e.target.closest(".bws-wish-popup") && !e.target.closest(".bws-likes")) {
      document.querySelectorAll(".bws-wish-popup").forEach((el) => el.remove());
    }
  });

  function openWishListPopup(item, anchorEl) {
    // Close any existing popup
    document.querySelectorAll(".bws-wish-popup").forEach((el) => el.remove());

    const popup = document.createElement("div");
    popup.className = "bws-wish-popup";
    popup.innerHTML = '<div class="bws-wish-popup-loading">読み込み中...</div>';

    // Position relative to anchor
    const card = anchorEl.closest(".bws-item-card");
    card.style.position = "relative";
    card.appendChild(popup);

    // Prevent closing immediately
    popup.addEventListener("click", (e) => e.stopPropagation());

    // Fetch wish list data
    fetchWishListItemsForItem(item.id).then((lists) => {
      popup.innerHTML = "";

      const title = document.createElement("div");
      title.className = "bws-wish-popup-title";
      title.textContent = "スキを管理";
      popup.appendChild(title);

      const listContainer = document.createElement("div");
      listContainer.className = "bws-wish-popup-lists";

      lists.forEach((list) => {
        const row = document.createElement("label");
        row.className = "bws-wish-popup-row";
        const cb = document.createElement("input");
        cb.type = "checkbox";
        cb.value = list.wish_list_name_code;
        cb.checked = list.is_item_in_wish_list_name;
        if (list.is_limit_reached && !list.is_item_in_wish_list_name) {
          cb.disabled = true;
        }
        const text = document.createElement("span");
        text.textContent = list.wish_list_name_name;
        row.append(cb, text);
        listContainer.appendChild(row);
      });
      popup.appendChild(listContainer);

      const actions = document.createElement("div");
      actions.className = "bws-wish-popup-actions";

      const saveBtn = document.createElement("button");
      saveBtn.className = "bws-wish-popup-save";
      saveBtn.textContent = "保存する";
      saveBtn.addEventListener("click", async () => {
        saveBtn.disabled = true;
        saveBtn.textContent = "保存中...";
        try {
          const codes = [];
          listContainer.querySelectorAll("input:checked").forEach((cb) => {
            codes.push(cb.value);
          });
          await updateWishListItems(item.id, codes);
          popup.remove();
        } catch (err) {
          console.error("BWS: Failed to update wish lists", err);
          alert("保存に失敗しました。");
          saveBtn.disabled = false;
          saveBtn.textContent = "保存する";
        }
      });

      const removeBtn = document.createElement("button");
      removeBtn.className = "bws-wish-popup-remove";
      removeBtn.textContent = "スキを解除";
      removeBtn.addEventListener("click", async () => {
        if (!confirm("「" + item.name + "」のスキを解除しますか？")) return;
        removeBtn.disabled = true;
        removeBtn.textContent = "解除中...";
        try {
          await removeFromAllWishLists(item.id);
          popup.remove();
          allItems = allItems.filter((i) => i.id !== item.id);
          saveToCache();
          applyFilterAndSort();
        } catch (err) {
          console.error("BWS: Failed to remove wish", err);
          alert("スキの解除に失敗しました。");
          removeBtn.disabled = false;
          removeBtn.textContent = "スキを解除";
        }
      });

      actions.append(saveBtn, removeBtn);
      popup.appendChild(actions);
    }).catch((err) => {
      console.error("BWS: Failed to fetch wish list items", err);
      popup.innerHTML = '<div class="bws-wish-popup-loading">読み込みに失敗しました</div>';
    });
  }

  // ===== Item card =====
  function createItemCard(item) {
    const card = document.createElement("div");
    card.className = "bws-item-card";

    // Management mode checkbox (top-left, like BOOTH's native)
    if (managementMode) {
      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.className = "bws-mgmt-checkbox";
      cb.dataset.itemId = String(item.id);
      cb.checked = selectedItemIds.has(item.id);
      cb.addEventListener("change", () => {
        if (cb.checked) {
          selectedItemIds.add(item.id);
        } else {
          selectedItemIds.delete(item.id);
        }
        syncManagementState();
      });
      card.appendChild(cb);
    }

    // Thumbnail carousel
    const thumbWrapper = document.createElement("div");
    thumbWrapper.className = "bws-thumb-wrapper";

    const images = item.imageUrls.length > 0 ? item.imageUrls : [""];
    let currentSlide = 0;

    const track = document.createElement("div");
    track.className = "bws-carousel-track";

    images.forEach((url, i) => {
      const slide = document.createElement("a");
      slide.href = item.itemUrl;
      slide.className = "bws-carousel-slide";
      if (i === 0) slide.classList.add("active");
      const img = document.createElement("img");
      img.src = url;
      img.alt = item.name;
      img.loading = "lazy";
      slide.appendChild(img);
      track.appendChild(slide);
    });
    thumbWrapper.appendChild(track);

    if (images.length > 1) {
      const dots = document.createElement("div");
      dots.className = "bws-carousel-dots";
      images.forEach((_, i) => {
        const dot = document.createElement("span");
        dot.className = "bws-carousel-dot" + (i === 0 ? " active" : "");
        dots.appendChild(dot);
      });

      const goToSlide = (idx) => {
        if (idx === currentSlide) return;
        currentSlide = idx;
        const slides = track.querySelectorAll(".bws-carousel-slide");
        slides.forEach((s, i) => s.classList.toggle("active", i === idx));
        const dotEls = dots.querySelectorAll(".bws-carousel-dot");
        dotEls.forEach((d, i) => d.classList.toggle("active", i === idx));
      };

      // Switch image based on cursor X position within the thumbnail
      thumbWrapper.addEventListener("mousemove", (e) => {
        const rect = thumbWrapper.getBoundingClientRect();
        const x = e.clientX - rect.left;
        const pct = x / rect.width;
        const idx = Math.min(Math.floor(pct * images.length), images.length - 1);
        goToSlide(idx);
      });

      // Reset to first image when mouse leaves
      thumbWrapper.addEventListener("mouseleave", () => {
        goToSlide(0);
      });

      thumbWrapper.appendChild(dots);
    }

    // Category
    const categoryDiv = document.createElement("div");
    categoryDiv.className = "bws-category";
    if (item.category) {
      const catLink = document.createElement("a");
      catLink.href = item.categoryUrl;
      catLink.textContent = item.category;
      categoryDiv.appendChild(catLink);
    }

    // Badges
    const badgesDiv = document.createElement("div");
    badgesDiv.className = "bws-badges";
    if (item.isVrchat) {
      const badgeLink = document.createElement("a");
      badgeLink.href = "https://booth.pm/ja/items?tags%5B%5D=VRChat";
      const badgeImg = document.createElement("img");
      badgeImg.src = "https://accounts.booth.pm/static-images/shops/badges/vrchat.png";
      badgeImg.alt = "VRChat";
      badgeLink.appendChild(badgeImg);
      badgesDiv.appendChild(badgeLink);
    }

    // Title
    const titleDiv = document.createElement("div");
    titleDiv.className = "bws-title";
    const titleLink = document.createElement("a");
    titleLink.href = item.itemUrl;
    titleLink.textContent = item.name;
    titleDiv.appendChild(titleLink);

    // Shop
    const shopDiv = document.createElement("div");
    shopDiv.className = "bws-shop";
    if (item.shopUrl) {
      const shopLink = document.createElement("a");
      shopLink.href = item.shopUrl;
      if (item.shopIconUrl) {
        const shopIcon = document.createElement("img");
        shopIcon.src = item.shopIconUrl;
        shopIcon.alt = item.shopName;
        shopLink.appendChild(shopIcon);
      }
      const shopNameSpan = document.createElement("span");
      shopNameSpan.className = "bws-shop-name";
      shopNameSpan.textContent = item.shopName;
      shopLink.appendChild(shopNameSpan);
      shopDiv.appendChild(shopLink);
    }

    // Bottom row
    const bottomDiv = document.createElement("div");
    bottomDiv.className = "bws-bottom";

    const priceDiv = document.createElement("div");
    priceDiv.className = "bws-price";
    priceDiv.textContent = item.priceText;

    const likesBtn = document.createElement("button");
    likesBtn.className = "bws-likes";
    likesBtn.type = "button";
    likesBtn.innerHTML =
      '<svg viewBox="0 0 24 24"><path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z"/></svg>' +
      "<span>" + item.likes.toLocaleString() + "</span>";
    likesBtn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (managementMode) return; // Don't open popup in management mode
      openWishListPopup(item, likesBtn);
    });

    bottomDiv.append(priceDiv, likesBtn);

    card.append(thumbWrapper, categoryDiv, badgesDiv, titleDiv, shopDiv, bottomDiv);
    return card;
  }

  // ===== Render pagination =====
  function renderPagination() {
    if (!paginationEl) return;
    paginationEl.innerHTML = "";

    const totalFilteredPages = Math.ceil(filteredItems.length / itemsPerPage);
    if (totalFilteredPages <= 1) return;

    if (currentPage > 1) {
      paginationEl.appendChild(createPageBtn("\u2039", currentPage - 1));
    }

    const pages = getPageNumbers(currentPage, totalFilteredPages);
    pages.forEach((p) => {
      if (p === "...") {
        const dots = document.createElement("span");
        dots.className = "bws-page-dots";
        dots.textContent = "...";
        paginationEl.appendChild(dots);
      } else {
        const btn = createPageBtn(p, p);
        if (p === currentPage) btn.classList.add("active");
        paginationEl.appendChild(btn);
      }
    });

    if (currentPage < totalFilteredPages) {
      paginationEl.appendChild(createPageBtn("\u203a", currentPage + 1));
    }
  }

  function createPageBtn(label, page) {
    const btn = document.createElement("button");
    btn.className = "bws-page-btn";
    btn.textContent = label;
    btn.addEventListener("click", () => {
      currentPage = page;
      renderItems();
      renderPagination();
    });
    return btn;
  }

  function getPageNumbers(current, total) {
    if (total <= 7) {
      return Array.from({ length: total }, (_, i) => i + 1);
    }
    const pages = [1];
    if (current > 3) pages.push("...");
    for (let i = Math.max(2, current - 1); i <= Math.min(total - 1, current + 1); i++) {
      pages.push(i);
    }
    if (current < total - 2) pages.push("...");
    pages.push(total);
    return pages;
  }

  // ===== SPA navigation detection =====
  function setupNavigationListener() {
    let currentUrl = window.location.href;

    const onUrlChange = () => {
      const newUrl = window.location.href;
      if (newUrl !== currentUrl) {
        currentUrl = newUrl;
        onNavigate();
      }
    };

    // Browser back/forward
    window.addEventListener("popstate", onUrlChange);

    // Poll for URL changes (catches pushState/replaceState from page context)
    setInterval(onUrlChange, 300);
  }

  function onNavigate() {
    if (!window.location.pathname.startsWith("/wish_lists")) {
      cleanup();
      return;
    }
    // Wait a tick for BOOTH to start re-rendering, then re-init
    cleanup();
    waitForAnchorsAndInit();
  }

  function waitForAnchorsAndInit() {
    const mp = document.getElementById("js-mount-point-wish-list");
    if (!mp) return;

    // If anchors are already there, init after a short delay
    if (findDomAnchors()) {
      setTimeout(init, 200);
      return;
    }

    // Wait for BOOTH to render new content
    const obs = new MutationObserver((_m, o) => {
      if (findDomAnchors()) {
        o.disconnect();
        setTimeout(init, 200);
      }
    });
    obs.observe(mp, { childList: true, subtree: true });

    // Fallback timeout
    setTimeout(() => {
      obs.disconnect();
      if (!document.getElementById("bws-search-sort-container") && findDomAnchors()) {
        init();
      }
    }, 5000);
  }

  // ===== Start =====
  function start() {
    loadPersistedCache();
    setupNavigationListener();
    waitForAnchorsAndInit();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start);
  } else {
    start();
  }
})();
