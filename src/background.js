const BASE_URLS = ['https://clearlydev.com', 'https://www.clearlydev.com'];
const PRODUCT_LIST_PATHS = ['/assets', '/products', '/shop'];
const LIBRARY_PATHS = ['/library', '/my-account/downloads', '/downloads'];

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

  const productUrls = await collectProductUrls();
  if (!productUrls.length) {
    throw new Error('Could not find product links on known catalog pages.');
  }

  const freeProducts = [];
  for (const url of productUrls) {
    const tabId = await createInactiveTab(url);
    try {
      await waitForTabLoaded(tabId);
      const pageInfo = await runOnTab(tabId, extractProductPageInfo);
      if (pageInfo?.isFree && pageInfo?.addToCartSelector) {
        const clicked = await runOnTab(tabId, clickElementBySelector, [pageInfo.addToCartSelector]);
        if (clicked) {
          freeProducts.push(pageInfo.title || url);
        }
      }
    } finally {
      await chrome.tabs.remove(tabId);
    }
  }

  if (!freeProducts.length) {
    return 'No free products with an add-to-cart button were detected.';
  }

  return `Added ${freeProducts.length} free product(s) to cart.`;
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

async function collectProductUrls() {
  const all = new Set();

  for (const path of PRODUCT_LIST_PATHS) {
    const tabId = await openFirstWorkingPage([path]);
    if (!tabId) {
      continue;
    }

    try {
      await waitForTabLoaded(tabId);
      const links = await runOnTab(tabId, collectProductLinksFromListing);
      for (const link of links) {
        all.add(link);
      }
    } finally {
      await chrome.tabs.remove(tabId);
    }
  }

  return [...all];
}

async function openFirstWorkingPage(paths) {
  for (const base of BASE_URLS) {
    for (const path of paths) {
      const url = `${base}${path}`;
      try {
        const tabId = await createInactiveTab(url);
        return tabId;
      } catch {
        // Try next candidate URL.
      }
    }
  }

  return null;
}

async function createInactiveTab(url) {
  const tab = await chrome.tabs.create({
    url,
    active: false
  });

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

    chrome.tabs.onUpdated.addListener(listener);
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

function collectProductLinksFromListing() {
  const anchors = [...document.querySelectorAll('a[href]')];
  const productLinks = anchors
    .map((a) => a.href)
    .filter(Boolean)
    .filter((href) => /\/product\//i.test(href) || /\/assets\//i.test(href));

  return [...new Set(productLinks)];
}

function extractProductPageInfo() {
  const bodyText = document.body?.innerText || '';
  const title = document.querySelector('h1, .product_title, .entry-title')?.textContent?.trim() || document.title;
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
    return label.includes('add') || label.includes('cart') || node.getAttribute('href')?.includes('add-to-cart');
  });

  return {
    title,
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
