const BASE_URLS = ['https://clearlydev.com', 'https://www.clearlydev.com'];
const PRODUCT_LIST_START_PATHS = ['/shop/roblox/roblox-games', '/shop', '/assets', '/products'];
const LIBRARY_PATHS = ['/library', '/my-account/downloads', '/downloads'];
const MAX_LISTING_PAGES = 25;

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.action === 'addFreeProductsToCart') {
    runAddFreeProductsFlow()
      .then((result) => sendResponse({ ok: true, message: result }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message?.action === 'downloadAllLibraryAssets') {
    runDownloadAllFlow()
      .then((result) => sendResponse({ ok: true, message: result }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  sendResponse({ ok: false, error: 'Unknown action.' });
  return false;
});

async function runAddFreeProductsFlow() {
  const loggedIn = await checkLoggedIn();
  if (!loggedIn) {
    throw new Error('You appear to be logged out. Please sign in on clearlydev.com first.');
  }

  const productUrls = await collectProductUrlsFromListingPagination();
  if (!productUrls.length) {
    throw new Error('No product links found on the shop pages.');
  }

  let addedCount = 0;

  for (const url of productUrls) {
    const tabId = await createInactiveTab(url);
    try {
      await waitForTabLoaded(tabId);
      const pageInfo = await runOnTab(tabId, extractProductPageInfo);

      if (!pageInfo?.isFree || !pageInfo?.addToCartSelector) {
        continue;
      }

      const clicked = await runOnTab(tabId, clickElementBySelector, [pageInfo.addToCartSelector]);
      if (clicked) {
        addedCount += 1;
      }
    } finally {
      await chrome.tabs.remove(tabId);
    }
  }

  if (!addedCount) {
    return `Scanned ${productUrls.length} product page(s), but none matched free + add-to-cart.`;
  }

  return `Scanned ${productUrls.length} product page(s). Added ${addedCount} free product(s) to cart.`;
}

async function runDownloadAllFlow() {
  const loggedIn = await checkLoggedIn();
  if (!loggedIn) {
    throw new Error('You appear to be logged out. Please sign in on clearlydev.com first.');
  }

  const libraryTabId = await openFirstWorkingPage(LIBRARY_PATHS);
  if (!libraryTabId) {
    throw new Error('Could not open a library/download page.');
  }

  try {
    await waitForTabLoaded(libraryTabId);

    const downloadUrls = await runOnTab(libraryTabId, collectDownloadUrlsFromPage);
    if (!downloadUrls.length) {
      throw new Error('No downloadable assets found in your library.');
    }

    for (const url of downloadUrls) {
      await chrome.downloads.download({
        url,
        saveAs: false,
        conflictAction: 'uniquify'
      });
    }

    return `Triggered download for ${downloadUrls.length} asset(s).`;
  } finally {
    await chrome.tabs.remove(libraryTabId);
  }
}

async function checkLoggedIn() {
  const tabId = await openFirstWorkingPage(['/my-account', '/account', '/']);
  if (!tabId) {
    return false;
  }

  try {
    await waitForTabLoaded(tabId);
    return await runOnTab(tabId, detectLoginStatusOnPage);
  } finally {
    await chrome.tabs.remove(tabId);
  }
}

async function collectProductUrlsFromListingPagination() {
  const discoveredProductUrls = new Set();
  const visitedListingPages = new Set();
  const pendingListingPages = [];

  for (const base of BASE_URLS) {
    for (const path of PRODUCT_LIST_START_PATHS) {
      pendingListingPages.push(`${base}${path}`);
    }
  }

  while (pendingListingPages.length && visitedListingPages.size < MAX_LISTING_PAGES) {
    const listingUrl = pendingListingPages.shift();
    if (!listingUrl || visitedListingPages.has(listingUrl)) {
      continue;
    }

    visitedListingPages.add(listingUrl);

    const tabId = await createInactiveTab(listingUrl);
    try {
      await waitForTabLoaded(tabId);
      const listingData = await runOnTab(tabId, collectListingPageData);

      for (const productUrl of listingData.productUrls || []) {
        discoveredProductUrls.add(productUrl);
      }

      for (const nextPageUrl of listingData.nextPageUrls || []) {
        if (!visitedListingPages.has(nextPageUrl)) {
          pendingListingPages.push(nextPageUrl);
        }
      }
    } finally {
      await chrome.tabs.remove(tabId);
    }
  }

  return [...discoveredProductUrls];
}

async function openFirstWorkingPage(paths) {
  for (const base of BASE_URLS) {
    for (const path of paths) {
      const url = `${base}${path}`;
      try {
        return await createInactiveTab(url);
      } catch {
        // Ignore and continue candidates.
      }
    }
  }

  return null;
}

async function createInactiveTab(url) {
  const tab = await chrome.tabs.create({ url, active: false });
  if (!tab.id) {
    throw new Error(`Failed to open tab for ${url}`);
  }

  return tab.id;
}

function waitForTabLoaded(tabId, timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      reject(new Error('Page load timeout.'));
    }, timeoutMs);

    const listener = (updatedTabId, info) => {
      if (updatedTabId === tabId && info.status === 'complete') {
        clearTimeout(timeout);
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    };

    chrome.tabs.get(tabId).then((tab) => {
      if (tab.status === 'complete') {
        clearTimeout(timeout);
        resolve();
        return;
      }
      chrome.tabs.onUpdated.addListener(listener);
    }).catch((error) => {
      clearTimeout(timeout);
      reject(error);
    });
  });
}

async function runOnTab(tabId, func, args = []) {
  const [result] = await chrome.scripting.executeScript({
    target: { tabId },
    func,
    args
  });

  return result?.result;
}

function detectLoginStatusOnPage() {
  const text = document.body?.innerText?.toLowerCase() || '';
  const hasLogoutLink = !!document.querySelector('a[href*="logout" i], a[href*="log-out" i]');
  const hasAccountDashboard = !!document.querySelector('.woocommerce-MyAccount-content, .my-account, [data-account]');
  const hasLoginForm = !!document.querySelector('form[action*="login" i], input[name="username" i], input[type="password"]');
  const mentionsLogout = text.includes('log out') || text.includes('logout');

  if (hasLogoutLink || hasAccountDashboard || mentionsLogout) {
    return true;
  }

  return !hasLoginForm;
}

function collectListingPageData() {
  const normalize = (href) => {
    try {
      const parsed = new URL(href, window.location.href);
      parsed.hash = '';
      return parsed.toString();
    } catch {
      return null;
    }
  };

  const anchors = [...document.querySelectorAll('a[href]')];

  const productUrls = anchors
    .map((a) => normalize(a.getAttribute('href')))
    .filter(Boolean)
    .filter((href) => /\/product\//i.test(href));

  const nextPageUrls = anchors
    .filter((a) => {
      const href = (a.getAttribute('href') || '').toLowerCase();
      const rel = (a.getAttribute('rel') || '').toLowerCase();
      const text = (a.textContent || '').toLowerCase();

      return (
        rel.includes('next') ||
        text.includes('next') ||
        href.includes('/page/') ||
        href.includes('paged=')
      );
    })
    .map((a) => normalize(a.getAttribute('href')))
    .filter(Boolean)
    .filter((href) => href.startsWith(window.location.origin));

  return {
    productUrls: [...new Set(productUrls)],
    nextPageUrls: [...new Set(nextPageUrls)]
  };
}

function extractProductPageInfo() {
  const bodyText = document.body?.innerText || '';
  const isFree = /(\$\s?0(?:\.00)?|free\b)/i.test(bodyText);

  const buttonCandidates = [
    'button[name="add-to-cart"]',
    'button.single_add_to_cart_button',
    'a.add_to_cart_button',
    'button[class*="add-to-cart"]',
    'a[href*="add-to-cart" i]'
  ];

  const addToCartSelector = buttonCandidates.find((selector) => {
    const node = document.querySelector(selector);
    if (!node) {
      return false;
    }

    const label = (node.textContent || '').toLowerCase();
    const href = (node.getAttribute('href') || '').toLowerCase();
    return label.includes('add') || label.includes('cart') || href.includes('add-to-cart');
  });

  return {
    isFree,
    addToCartSelector: addToCartSelector || null
  };
}

function clickElementBySelector(selector) {
  const node = document.querySelector(selector);
  if (!node) {
    return false;
  }

  node.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
  return true;
}

function collectDownloadUrlsFromPage() {
  const anchors = [...document.querySelectorAll('a[href]')];
  const downloadLinks = anchors
    .filter((a) => {
      const href = a.href.toLowerCase();
      const text = (a.textContent || '').toLowerCase();
      return (
        href.includes('/download') ||
        href.includes('download=') ||
        href.includes('.zip') ||
        text.includes('download')
      );
    })
    .map((a) => a.href);

  return [...new Set(downloadLinks)];
}
