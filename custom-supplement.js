/*
 * Tailor Fit — Custom Supplement Builder
 * Readable source-of-truth. Host on GitHub + jsDelivr and reference from Webflow:
 *   <script src="https://cdn.jsdelivr.net/gh/<user>/<repo>@<tag>/custom-supplement.js" defer></script>
 *
 * Behavior matches the original, with three fixes applied:
 *   1. The "Choose a Flavor" <option> string is now a backtick template (was a broken split string).
 *   2. The add-to-cart click handler no longer shadows the element map (`e` -> `ev`).
 *   3. Two `SameSite:Lax` cookie typos corrected to `SameSite=Lax`.
 */

// ---------- Config ----------
const NETLIFY_FUNCTION_URL = 'https://userpresets.netlify.app/.netlify/functions/foxy-presets';
const FOXY_PORTAL_SETTINGS_URL = 'https://tailorfit.foxycart.com/customer_portal_settings';
const FOXY_PORTAL_BASE_URL = 'https://tailorfit.foxycart.com/s/customer/';
const FOXY_SSO_FUNCTION_URL = 'https://userpresets.netlify.app/.netlify/functions/foxy-sso';
const FOXY_LAST_ORDER_FUNCTION_URL = 'https://userpresets.netlify.app/.netlify/functions/foxy-last-order';

const SERVINGS = 30; // servings per tub: converts per-serving dosage -> total weight

const pricing = {
  base: 15,
  rarity: { low: 2.5, mid: 2.0, high: 1.75, premium: 1.5 },
  volume: { max: 0.38, base: 0.15, steepness: 0.08 }
};

// ---------- Mutable state ----------
let selected = [];          // confirmed ingredients (Preview panel)
let draft = [];             // staged selection inside the builder modal
let flavor = null;          // chosen flavor value
let presetCache = new Map();
let flavorCostCache = 0;
let flavorCostKey = null;

// ---------- Foxy customer portal + SSO ----------
function findFoxyPortal() {
  const portalWrapper = document.getElementById('foxy-customer-portal') ||
    document.querySelector('#login-modal #foxy-customer-portal');
  return portalWrapper?.querySelector('foxy-customer-portal') ||
    document.querySelector('#login-modal foxy-customer-portal') ||
    document.querySelector('foxy-customer-portal');
}

function configureFoxyPortal(portal = findFoxyPortal()) {
  if (!portal) return null;
  let configured = false;
  if (portal.getAttribute('settings') !== FOXY_PORTAL_SETTINGS_URL) {
    portal.setAttribute('settings', FOXY_PORTAL_SETTINGS_URL);
    configured = true;
  }
  if (portal.settings !== FOXY_PORTAL_SETTINGS_URL) {
    portal.settings = FOXY_PORTAL_SETTINGS_URL;
    configured = true;
  }
  if (portal.getAttribute('sso') !== 'true') {
    portal.setAttribute('sso', 'true');
    configured = true;
  }
  if (portal.getAttribute('sso-callback-url') !== FOXY_SSO_FUNCTION_URL) {
    portal.setAttribute('sso-callback-url', FOXY_SSO_FUNCTION_URL);
    configured = true;
  }
  if (portal.getAttribute('base') !== FOXY_PORTAL_BASE_URL) {
    portal.setAttribute('base', FOXY_PORTAL_BASE_URL);
    configured = true;
  }
  if (configured) console.log('🔐 Foxy portal configured');
  if (!portal.dataset.foxyConfigured) portal.dataset.foxyConfigured = 'true';
  return portal;
}

function ensureFoxyPortalConfigured() {
  configureFoxyPortal();
}

function bootstrapFoxyPortal() {
  ensureFoxyPortalConfigured();
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', ensureFoxyPortalConfigured);
  }
  if (window?.customElements && typeof window.customElements.whenDefined === 'function') {
    window.customElements.whenDefined('foxy-customer-portal').then(() => configureFoxyPortal()).catch(() => {});
  }
  let tries = 0;
  const maxTries = 10;
  const timer = setInterval(() => {
    tries += 1;
    ensureFoxyPortalConfigured();
    if (findFoxyPortal() || tries >= maxTries) clearInterval(timer);
  }, 300);
  const observer = new MutationObserver(() => {
    if (configureFoxyPortal()) observer.disconnect();
  });
  if (document.body) observer.observe(document.body, { childList: true, subtree: true });
}

async function handleFoxySsoLogin(event) {
  try {
    const token = event?.detail?.jwt || event?.detail?.token;
    if (!token) {
      console.error('SSO event missing JWT payload');
      return;
    }
    const response = await fetch(FOXY_SSO_FUNCTION_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token })
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data?.error || `SSO verification failed (${response.status})`);
    if (data && data.customer_id) {
      document.cookie = `foxy_customer_id=${encodeURIComponent(data.customer_id)}; Path=/; Secure; SameSite=Lax; Max-Age=86400`;
      localStorage.setItem('foxy_customer_id', data.customer_id);
      localStorage.setItem('foxy_login_check_time', Date.now().toString());
      if (data.customer_email) localStorage.setItem('foxy_customer_email', data.customer_email);
      if (data.access_token) {
        localStorage.setItem('foxy_portal_access_token', data.access_token);
        const expires = parseInt(data.expires_in, 10);
        if (!Number.isNaN(expires)) {
          localStorage.setItem('foxy_portal_access_token_expiration', (Date.now() + expires * 1000).toString());
        }
      }
      if (data.customer_href) localStorage.setItem('foxy_customer_href', data.customer_href);
    }
    if (event?.detail) {
      const payload = {
        customer_id: data?.customer_id || null,
        access_token: data?.access_token || null,
        expires_in: data?.expires_in || null
      };
      if (typeof event.detail.done === 'function') event.detail.done(payload);
      else if (typeof event.detail.resolve === 'function') event.detail.resolve(payload);
    }
    console.log('✅ Foxy SSO handshake complete');
    syncPresetUIWithLogin();
  } catch (err) {
    console.error('SSO handshake error:', err);
    if (event?.detail && typeof event.detail.reject === 'function') event.detail.reject(err);
  }
}

bootstrapFoxyPortal();
document.addEventListener('foxy-sso-login', handleFoxySsoLogin, { once: false });

// ---------- Pricing & calories ----------
function rarityTier(costPerGram) {
  return costPerGram < 0.03 ? 'low' : costPerGram < 0.05 ? 'mid' : costPerGram < 0.10 ? 'high' : 'premium';
}

function volumeDiscount(ingredientValue) {
  const max = pricing.volume.max;
  const base = pricing.volume.base;
  const steepness = pricing.volume.steepness;
  const discount = Math.min(max, base + (Math.log(ingredientValue + 1) * steepness));
  return 1 - discount;
}

function calcPrice(ingredients) {
  if (!ingredients || ingredients.length === 0) return pricing.base;
  let ingredientCost = 0;
  let totalIngredientValue = 0;
  ingredients.forEach(item => {
    const costPerGram = parseFloat(item.costPerGram) || 0;
    const tier = rarityTier(costPerGram);
    const multiplier = pricing.rarity[tier];
    const totalWeight = item.dosage * SERVINGS;
    const cost = totalWeight * costPerGram * multiplier;
    ingredientCost += cost;
    totalIngredientValue += totalWeight * costPerGram * multiplier;
  });
  return pricing.base + (ingredientCost * volumeDiscount(totalIngredientValue));
}

function flavorPrice() {
  if (!flavor) return 0;
  if (flavorCostKey === flavor) return flavorCostCache;
  const option = els.flavorSelect?.querySelector(`option[value="${flavor}"]`);
  flavorCostCache = option ? (parseFloat(option.dataset.price || 0) * SERVINGS * 0.1) : 0;
  flavorCostKey = flavor;
  return flavorCostCache;
}

function calcTotalCalories() {
  let total = 0;
  if (selected && selected.length > 0) {
    selected.forEach(item => {
      const cmsItem = els.ingredientList?.querySelector(`.ingredient-item[data-name="${item.name}"]`);
      if (cmsItem) {
        const caloriesPerGram = parseFloat(cmsItem.dataset.calories) || 0;
        total += item.dosage * caloriesPerGram;
      }
    });
  }
  if (flavor) {
    const option = els.flavorSelect?.querySelector(`option[value="${flavor}"]`);
    let flavorCals = 0;
    if (option) flavorCals = parseFloat(option.dataset.calories) || 0;
    if (flavorCals === 0) {
      const item = els.flavorDataList?.querySelector(`[data-flavor-name="${flavor}"]`)?.closest('.w-dyn-item');
      if (item) flavorCals = parseFloat(item.dataset.calories) || 0;
    }
    if (flavorCals > 0) total += flavorCals;
  }
  return Math.round(total);
}

function updatePriceInfo() {
  if (!els.reviewSubtotal) return;
  if (selected.length === 0) {
    els.reviewSubtotal.textContent = "$0.00";
    updateCaloriesDisplay();
    return;
  }
  const ingredientsPrice = calcPrice(selected);
  const flavorPr = flavorPrice();
  els.reviewSubtotal.textContent = `$${(ingredientsPrice + flavorPr).toFixed(2)}`;
  updateCaloriesDisplay();
}

function updateCaloriesDisplay() {
  if (!els.caloriesDynamic) return;
  els.caloriesDynamic.textContent = calcTotalCalories().toString();
}

// ---------- DOM element map ----------
const els = {
  preSelector: document.getElementById("preSelector"),
  postSelector: document.getElementById("postSelector"),
  addEditBtn: document.getElementById("add-edit-button"),
  ingredientSelector: document.getElementById("ingredient-selector"),
  builderSelected: document.getElementById("builder-selected"),
  reviewSelected: document.getElementById("review-selected"),
  servingSize: document.getElementById("serving-size"),
  flavorSelect: document.getElementById("flavor-selector"),
  reviewSubtotal: document.getElementById("review-subtotal"),
  submitBtn: document.querySelector(".submit-button"),
  cartNotification: document.getElementById("cart-notification"),
  ingredientList: document.querySelector(".ingredient-list"),
  presetList: document.querySelector("#ingredient-selector .w-tab-pane[data-w-tab='Presets'] .w-dyn-items"),
  ingredientDescription: document.getElementById("ingredient-description"),
  dosageSliderContainer: document.getElementById("dosage-slider-container"),
  dosageSlider: document.getElementById("dosage-slider"),
  dosageValue: document.getElementById("dosage-value"),
  ingredientHeader: document.getElementById("ingredient-header"),
  addIngredientBtn: document.getElementById("add-ingredient"),
  confirmSelectionBtn: document.getElementById("confirm-selection"),
  backBtn: document.getElementById("back-button"),
  flavorDataList: document.getElementById("flavor-data-list"),
  cartCount: document.getElementById("cart-count"),
  closeSelectorBtn: document.getElementById("close-selector"),
  closeXIcon: document.getElementById("close-x-icon"),
  caloriesDynamic: document.querySelector(".calories-dynamic"),
  caloriesAmount: document.getElementById("calories-amount"),
  openPresetBtn: document.getElementById("open-preset"),
  savePresetBtn: document.getElementById("save-preset"),
  closePresetModalBtn: document.getElementById("close-preset-modal"),
  presetModal: document.getElementById("fs-modal-2-popup"),
  closeModal: document.getElementById("close-modal"),
  presetInput1: document.getElementById("preset-1"),
  presetInput2: document.getElementById("preset-2"),
  presetInput3: document.getElementById("preset-3"),
  loginText: document.getElementById("login-text"),
  lastOrderBtn: document.getElementById("last-order-button")
};

// ---------- Cookie / JWT / customer-id helpers ----------
function getCookie(name) {
  const cookie = document.cookie.split('; ').find(row => row.startsWith(name + '='));
  return cookie ? decodeURIComponent(cookie.split('=')[1]) : null;
}

function getQueryParam(name) {
  const params = new URLSearchParams(window.location.search);
  return params.get(name);
}

function customerIdFromHref(value) {
  if (!value) return null;
  try {
    const url = new URL(value, window.location.origin);
    const parts = url.pathname.split('/').filter(Boolean);
    if (parts.length) return parts[parts.length - 1];
  } catch (_) {
    const parts = value.split(/[\\/]/).filter(Boolean);
    if (parts.length) return parts[parts.length - 1];
  }
  return null;
}

function decodeJwtPayload(token) {
  try {
    const b64 = token.split('.')[1]?.replace(/-/g, '+').replace(/_/g, '/');
    if (!b64) return null;
    const json = decodeURIComponent(atob(b64).split('').map(ch => '%' + ('00' + ch.charCodeAt(0).toString(16)).slice(-2)).join(''));
    return JSON.parse(json);
  } catch (_) {
    return null;
  }
}

function persistCustomerIdFromSession() {
  try {
    const sessionKeys = ['session', 'foxy_session', 'foxy_session_session'];
    for (const key of sessionKeys) {
      const raw = localStorage.getItem(key);
      if (!raw) continue;
      const data = JSON.parse(raw);
      const jwt = data?.jwt || data?.token;
      if (!jwt) continue;
      const payload = decodeJwtPayload(jwt);
      if (!payload?.customer_id) continue;
      const customerId = String(payload.customer_id);
      localStorage.setItem('foxy_customer_id', customerId);
      localStorage.setItem('foxy_login_check_time', Date.now().toString());
      if (payload.customer_email) localStorage.setItem('foxy_customer_email', payload.customer_email);
      document.cookie = `foxy_customer_id=${encodeURIComponent(customerId)}; Path=/; Secure; SameSite=Lax; Max-Age=86400`;
      console.log('🔐 Customer ID from session:', customerId);
      return customerId;
    }
  } catch (_) {}
  return null;
}

function fetchCustomerFromFoxyApi() {
  return fetch('https://tailorfit.foxycart.com/s/customer', {
    method: 'GET',
    credentials: 'include',
    headers: { 'Accept': 'application/json', 'FOXY-API-VERSION': '1' }
  }).then(res => {
    if (!res.ok) return null;
    return res.json();
  }).then(data => {
    if (!data?.id) return null;
    const customerId = String(data.id);
    localStorage.setItem('foxy_customer_id', customerId);
    localStorage.setItem('foxy_login_check_time', Date.now().toString());
    if (data.email) localStorage.setItem('foxy_customer_email', data.email);
    document.cookie = `foxy_customer_id=${encodeURIComponent(customerId)}; Path=/; Secure; SameSite=Lax; Max-Age=86400`;
    console.log('🔐 Customer ID from /s/customer API:', customerId);
    return customerId;
  }).catch(() => null);
}

// Reads the portal's shadow DOM to decide if the customer is logged in. Caches 5 min.
function checkFoxyLoginStatus() {
  return new Promise(resolve => {
    console.log("🔐 FOXY LOGIN CHECK START");
    const storedCustomerId = localStorage.getItem('foxy_customer_id');
    const lastCheckTime = localStorage.getItem('foxy_login_check_time');
    const now = Date.now();
    console.log("🔐 Stored customer ID:", storedCustomerId);
    console.log("🔐 Last check time:", lastCheckTime);
    console.log("🔐 Current time:", now);
    if (storedCustomerId && lastCheckTime && (now - parseInt(lastCheckTime)) < 300000) {
      console.log("🔐 Using cached result - logged in:", true);
      resolve(true);
      return;
    }
    console.log("🔐 Cache expired or missing, running full check");

    const evaluateShadow = (root, removeOnLogout) => {
      const loggedOutView = root.querySelector('foxy-internal-customer-portal-logged-out-view');
      const loggedInView = root.querySelector('foxy-internal-customer-portal-logged-in-view');
      console.log("🔐 Logged out view found:", !!loggedOutView);
      console.log("🔐 Logged in view found:", !!loggedInView);
      const isLoggedIn = !!loggedInView && !loggedOutView;
      console.log("🔐 LOGIN CHECK RESULT:", isLoggedIn ? "LOGGED IN" : "NOT LOGGED IN");
      if (isLoggedIn) {
        localStorage.setItem('foxy_login_check_time', now.toString());
        resolve(true);
      } else {
        localStorage.removeItem('foxy_customer_id');
        localStorage.removeItem('foxy_login_check_time');
        localStorage.removeItem('foxy_customer_email');
        resolve(false);
      }
    };

    const portalWrapper = document.getElementById('foxy-customer-portal') ||
      document.querySelector('#login-modal #foxy-customer-portal');
    const portalElement = portalWrapper?.querySelector('foxy-customer-portal') ||
      document.querySelector('#login-modal foxy-customer-portal') ||
      document.querySelector('foxy-customer-portal');

    if (portalElement) {
      console.log("🔐 Found portal element on page");
      try {
        const shadow = portalElement.shadowRoot;
        console.log("🔐 Shadow root found:", !!shadow);
        if (shadow) {
          evaluateShadow(shadow);
        } else {
          console.log("🔐 No shadow root found, trying direct query");
          evaluateShadow(portalElement);
        }
      } catch (err) {
        console.log("🔐 Error in login check:", err);
        resolve(false);
      }
      return;
    }

    console.log("🔐 No existing portal element found, trying fallback");
    if (customElements.get('foxy-customer-portal')) {
      console.log("🔐 Foxy Customer Portal element found");
      const tempPortal = document.createElement('foxy-customer-portal');
      tempPortal.setAttribute('base', 'https://tailorfit.foxycart.com/s/customer/');
      tempPortal.style.cssText = 'position:absolute;left:-9999px;top:-9999px;width:1px;height:1px;opacity:0;pointer-events:none;visibility:hidden;';
      document.body.appendChild(tempPortal);
      console.log("🔐 Portal element created and added to DOM");
      setTimeout(() => {
        try {
          const shadow = tempPortal.shadowRoot;
          console.log("🔐 Shadow root found:", !!shadow);
          if (shadow) evaluateShadow(shadow);
          else {
            console.log("🔐 No shadow root found, trying direct query");
            evaluateShadow(tempPortal);
          }
        } catch (err) {
          console.log("🔐 Error in login check:", err);
          resolve(false);
        } finally {
          document.body.removeChild(tempPortal);
        }
      }, 5000);
      return;
    }
    console.log("🔐 No Foxy customer portal element found");
    resolve(false);
  });
}

// ---------- Preset entry visibility ----------
let presetVisibilityTimeout = null;

function updatePresetEntryVisibility() {
  if (presetVisibilityTimeout) clearTimeout(presetVisibilityTimeout);
  if (selected.length === 0) {
    if (els.openPresetBtn) els.openPresetBtn.style.display = "none";
    if (els.loginText) els.loginText.style.display = "none";
    return;
  }
  presetVisibilityTimeout = setTimeout(() => {
    checkFoxyLoginStatus().then(loggedIn => {
      if (loggedIn) {
        if (els.openPresetBtn) els.openPresetBtn.style.display = "inline-block";
        if (els.loginText) els.loginText.style.display = "none";
      } else {
        if (els.openPresetBtn) els.openPresetBtn.style.display = "none";
        if (els.loginText) els.loginText.style.display = "inline-block";
      }
    });
  }, 300);
}

function updatePresetVisibilityAfterLogin(forceState) {
  const applyState = loggedIn => {
    console.log("🔐 Updating preset visibility, logged in:", loggedIn);
    if (loggedIn) {
      if (els.openPresetBtn) els.openPresetBtn.style.display = "inline-block";
      if (els.loginText) els.loginText.style.display = "none";
    } else {
      if (els.openPresetBtn) els.openPresetBtn.style.display = "none";
      if (els.loginText) els.loginText.style.display = "inline-block";
    }
  };
  if (typeof forceState === 'boolean') {
    applyState(forceState);
    return;
  }
  checkFoxyLoginStatus().then(applyState);
}

function syncPresetUIWithLogin() {
  checkFoxyLoginStatus().then(loggedIn => {
    if (loggedIn) populateUserPresets();
    else showLoginPrompt();
    updatePresetVisibilityAfterLogin(loggedIn);
  });
}

function getCustomerId() {
  const params = new URLSearchParams(window.location.search);
  const fromUrl = params.get('fc_customer_id') || params.get('customer_id');
  if (fromUrl) {
    localStorage.setItem('foxy_customer_id', fromUrl);
    localStorage.setItem('foxy_login_check_time', Date.now().toString());
    return fromUrl;
  }
  const cookieCustomerId = getCookie('foxy_customer_id');
  if (cookieCustomerId) {
    localStorage.setItem('foxy_customer_id', cookieCustomerId);
    localStorage.setItem('foxy_login_check_time', Date.now().toString());
    return cookieCustomerId;
  }
  return localStorage.getItem('foxy_customer_id');
}

function checkPortalForCustomerData(portal) {
  if (!portal) return null;
  if (portal.href) {
    const match = portal.href.match(/\/customer\/(\d+)/);
    if (match) {
      localStorage.setItem('foxy_customer_id', match[1]);
      document.cookie = `foxy_customer_id=${encodeURIComponent(match[1])}; Path=/; Secure; SameSite=Lax; Max-Age=86400`;
      localStorage.setItem('foxy_login_check_time', Date.now().toString());
      console.log("🔐 Customer ID from portal href:", match[1]);
      return match[1];
    }
  }
  if (portal.customerId) {
    const customerId = String(portal.customerId);
    localStorage.setItem('foxy_customer_id', customerId);
    document.cookie = `foxy_customer_id=${encodeURIComponent(customerId)}; Path=/; Secure; SameSite=Lax; Max-Age=86400`;
    localStorage.setItem('foxy_login_check_time', Date.now().toString());
    console.log("🔐 Customer ID from portal.customerId:", customerId);
    return customerId;
  }
  if (portal.customer) {
    const customer = portal.customer;
    const linkHref = customer?._links?.['https://api.foxycart.com/rels/customer']?.href ||
      customer?._links?.self?.href || customer?.href || null;
    const customerId = customer?.id ? String(customer.id) : (linkHref ? customerIdFromHref(linkHref) : null);
    if (customerId) {
      localStorage.setItem('foxy_customer_id', customerId);
      localStorage.setItem('foxy_login_check_time', Date.now().toString());
      if (linkHref) localStorage.setItem('foxy_customer_href', linkHref);
      document.cookie = `foxy_customer_id=${encodeURIComponent(customerId)}; Path=/; Secure; SameSite=Lax; Max-Age=86400`;
      if (customer.email) localStorage.setItem('foxy_customer_email', customer.email);
      console.log("🔐 Customer ID from portal.customer:", customerId);
      return customerId;
    }
  }
  return null;
}

function pollPortalForCustomerData(portal, maxTries = 10, interval = 300) {
  return new Promise(resolve => {
    let tries = 0;
    const run = () => {
      const customerId = checkPortalForCustomerData(portal);
      if (customerId) { resolve(customerId); return; }
      if (++tries >= maxTries) { resolve(null); return; }
      setTimeout(run, interval);
    };
    run();
  });
}

function getCustomerEmailFromPortal() {
  return new Promise(async resolve => {
    console.log("🔐 Getting customer email from portal...");
    const portalWrapper = document.getElementById('foxy-customer-portal') ||
      document.querySelector('#login-modal #foxy-customer-portal');
    let portalElement = null;
    if (portalWrapper && portalWrapper.querySelector) {
      portalElement = portalWrapper.querySelector('foxy-customer-portal');
    }
    if (!portalElement) {
      portalElement = document.querySelector('#login-modal foxy-customer-portal') ||
        document.querySelector('foxy-customer-portal');
    }
    const finish = email => {
      if (email) { localStorage.setItem('foxy_customer_email', email); resolve(email); }
      else resolve(null);
    };
    if (!portalElement) {
      console.log("🔐 No portal element found");
      finish(null);
      return;
    }
    console.log("🔐 Portal element found, polling for customer data...");
    const customerId = await pollPortalForCustomerData(portalElement);
    if (customerId) { finish(null); return; }

    if (portalElement.href) {
      const hrefMatch = portalElement.href.match(/\/customer\/(\d+)/);
      if (hrefMatch) {
        console.log("🔐 Customer ID from portal href:", hrefMatch[1]);
        localStorage.setItem('foxy_customer_id', hrefMatch[1]);
        document.cookie = `foxy_customer_id=${encodeURIComponent(hrefMatch[1])}; Path=/; Secure; SameSite=Lax; Max-Age=86400`;
        finish(null);
        return;
      }
    }
    if (portalElement.customerId) {
      console.log("🔐 Customer ID from portal property:", portalElement.customerId);
      localStorage.setItem('foxy_customer_id', portalElement.customerId.toString());
      document.cookie = `foxy_customer_id=${encodeURIComponent(portalElement.customerId.toString())}; Path=/; Secure; SameSite=Lax; Max-Age=86400`;
      finish(null);
      return;
    }
    if (portalElement.customer) {
      console.log("🔐 Customer object from portal:", portalElement.customer);
      const customer = portalElement.customer;
      const linkHref = customer?._links?.['https://api.foxycart.com/rels/customer']?.href ||
        customer?._links?.self?.href || customer?.href || null;
      let customerId = null;
      if (customer.id) customerId = customer.id.toString();
      else if (linkHref) customerId = customerIdFromHref(linkHref);
      if (customerId) {
        localStorage.setItem('foxy_customer_id', customerId);
        localStorage.setItem('foxy_login_check_time', Date.now().toString());
        if (linkHref) localStorage.setItem('foxy_customer_href', linkHref);
        document.cookie = `foxy_customer_id=${encodeURIComponent(customerId)}; Path=/; Secure; SameSite=Lax; Max-Age=86400`;
        if (customer.email) { localStorage.setItem('foxy_customer_email', customer.email); finish(customer.email); return; }
        finish(null);
        return;
      }
      if (customer.email) { finish(customer.email); return; }
    }
    const shadow = portalElement.shadowRoot;
    if (!shadow) { console.log("🔐 No shadow root found"); finish(null); return; }
    const loggedInView = shadow.querySelector('foxy-internal-customer-portal-logged-in-view');
    if (!loggedInView) { console.log("🔐 No logged in view found"); finish(null); return; }
    const emailRegex = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/i;
    const allText = loggedInView.textContent || loggedInView.innerText;
    console.log("🔐 Logged in view text length:", allText ? allText.length : 0);
    if (allText && allText.length > 5) {
      const emailMatch = allText.match(emailRegex);
      if (emailMatch) { console.log("🔐 Email found in text:", emailMatch[0]); finish(emailMatch[0]); return; }
    }
    const emailInputs = loggedInView.querySelectorAll('input[type=email],input[name*=email i],input[id*=email i]');
    console.log("🔐 Email inputs found:", emailInputs.length);
    for (let i = 0; i < emailInputs.length; i++) {
      const input = emailInputs[i];
      if (input.value && input.value.includes('@')) { console.log("🔐 Email from input:", input.value); finish(input.value); return; }
    }
    const allElements = loggedInView.querySelectorAll('*');
    console.log("🔐 All elements in logged in view:", allElements.length);
    const maxCheck = Math.min(allElements.length, 50);
    for (let i = 0; i < maxCheck; i++) {
      const text = allElements[i].textContent || allElements[i].innerText || '';
      if (text && text.length > 5 && text.includes('@')) {
        const emailMatch = text.match(emailRegex);
        if (emailMatch) { console.log("🔐 Email found in element:", emailMatch[0]); finish(emailMatch[0]); return; }
      }
    }
    console.log("🔐 No email found in portal");
    finish(null);
  });
}

function getCustomerIdFromPortal() {
  return new Promise(resolve => {
    persistCustomerIdFromSession();
    const storedCustomerId = localStorage.getItem('foxy_customer_id');
    if (storedCustomerId && storedCustomerId !== 'portal_element_authenticated') {
      console.log("🔐 Using stored customer ID:", storedCustomerId);
      resolve(storedCustomerId);
      return;
    }
    const storedHref = localStorage.getItem('foxy_customer_href');
    if (storedHref) {
      const derivedId = customerIdFromHref(storedHref);
      if (derivedId) {
        console.log("🔐 Customer ID from stored href:", derivedId);
        localStorage.setItem('foxy_customer_id', derivedId);
        localStorage.setItem('foxy_login_check_time', Date.now().toString());
        document.cookie = `foxy_customer_id=${encodeURIComponent(derivedId)}; Path=/; Secure; SameSite=Lax; Max-Age=86400`;
        resolve(derivedId);
        return;
      }
    }
    const cookieCustomerId = getCookie('foxy_customer_id');
    if (cookieCustomerId) {
      console.log("🔐 Customer ID from cookie:", cookieCustomerId);
      localStorage.setItem('foxy_customer_id', cookieCustomerId);
      localStorage.setItem('foxy_login_check_time', Date.now().toString());
      resolve(cookieCustomerId);
      return;
    }
    const fetchByEmail = email => {
      if (!email) { resolve(null); return; }
      const endpoint = NETLIFY_FUNCTION_URL + '?email=' + encodeURIComponent(email);
      fetch(endpoint).then(res => res.json()).then(data => {
        if (data.success && data.customerId) {
          console.log("🔐 Customer ID from email lookup:", data.customerId);
          localStorage.setItem('foxy_customer_id', data.customerId);
          localStorage.setItem('foxy_login_check_time', Date.now().toString());
          document.cookie = `foxy_customer_id=${encodeURIComponent(data.customerId)}; Path=/; Secure; SameSite=Lax; Max-Age=86400`;
          resolve(data.customerId);
        } else {
          console.warn("🔐 Email lookup did not return a customer ID");
          resolve(null);
        }
      }).catch(err => {
        console.error("🔐 Error during email lookup:", err);
        resolve(null);
      });
    };
    fetchCustomerFromFoxyApi().then(apiCustomerId => {
      if (apiCustomerId) { resolve(apiCustomerId); return; }
      const storedEmail = localStorage.getItem('foxy_customer_email');
      if (storedEmail) {
        console.log("🔐 Using stored customer email for lookup:", storedEmail);
        fetchByEmail(storedEmail);
        return;
      }
      getCustomerEmailFromPortal().then(email => {
        if (email) { console.log("🔐 Email discovered from portal:", email); fetchByEmail(email); return; }
        console.warn("🔐 No customer ID or email found");
        resolve(null);
      });
    });
  });
}

// ---------- Preset save / load (Foxy customer attributes via Netlify) ----------
function savePresetToFoxyAPI(presetSlot, presetData) {
  return new Promise(resolve => {
    getCustomerIdFromPortal().then(customerId => {
      if (!customerId) {
        const email = prompt("To save presets to your account, enter the email you use for Tailor Fit:");
        if (!email || !email.trim()) {
          console.error("🔐 No customer ID found");
          resolve(false);
          return;
        }
        fetch(NETLIFY_FUNCTION_URL + '?email=' + encodeURIComponent(email.trim())).then(res => res.json()).then(data => {
          if (data.success && data.customerId) {
            localStorage.setItem('foxy_customer_id', data.customerId);
            localStorage.setItem('foxy_login_check_time', Date.now().toString());
            localStorage.setItem('foxy_customer_email', email.trim());
            document.cookie = 'foxy_customer_id=' + encodeURIComponent(data.customerId) + '; Path=/; Secure; SameSite=Lax; Max-Age=86400';
            savePresetToFoxyAPI(presetSlot, presetData).then(resolve);
          } else {
            resolve(false);
          }
        }).catch(() => resolve(false));
        return;
      }
      fetch(NETLIFY_FUNCTION_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ customerId, slot: presetSlot, preset: presetData })
      }).then(res => res.json()).then(data => {
        if (data.success) { console.log("🔐 Preset saved to FoxyCart"); resolve(true); }
        else { console.error("🔐 Failed to save preset:", data.error); resolve(false); }
      }).catch(err => {
        console.error("🔐 Error saving preset:", err);
        resolve(false);
      });
    });
  });
}

function loadPresetsFromFoxyAPI() {
  return new Promise(resolve => {
    getCustomerIdFromPortal().then(customerId => {
      if (!customerId) {
        console.log("🔐 No customer ID found, returning empty presets");
        resolve({ p1: null, p2: null, p3: null });
        return;
      }
      fetch(NETLIFY_FUNCTION_URL + '?customerId=' + customerId).then(res => res.json()).then(data => {
        if (data.success && data.presets) {
          console.log("🔐 Presets loaded from FoxyCart:", data.presets);
          resolve({ p1: data.presets['1'] || null, p2: data.presets['2'] || null, p3: data.presets['3'] || null });
        } else {
          resolve({ p1: null, p2: null, p3: null });
        }
      }).catch(err => {
        console.error("🔐 Error loading presets:", err);
        resolve({ p1: null, p2: null, p3: null });
      });
    }).catch(err => {
      console.error("🔐 Error obtaining customer ID:", err);
      resolve({ p1: null, p2: null, p3: null });
    });
  });
}

// Loads presets from Foxy, falling back to localStorage.
function loadPresets() {
  return new Promise(resolve => {
    loadPresetsFromFoxyAPI().then(apiPresets => {
      if (Object.values(apiPresets).some(v => v !== null)) { resolve(apiPresets); return; }
      const customerId = getCustomerId();
      const presets = { p1: null, p2: null, p3: null };
      if (customerId) {
        ['1', '2', '3'].forEach(slot => {
          const data = localStorage.getItem(`presets_${customerId}_${slot}`);
          if (data) presets[`p${slot}`] = JSON.parse(data);
        });
      } else {
        ['1', '2', '3'].forEach(slot => {
          const data = localStorage.getItem(`supplement_preset_${slot}`);
          if (data) presets[`p${slot}`] = JSON.parse(data);
        });
      }
      resolve(presets);
    });
  });
}

function populatePresetInputs(presets) {
  ['1', '2', '3'].forEach(slot => {
    const input = els[`presetInput${slot}`];
    if (input) {
      input.value = "";
      input.placeholder = presets[`p${slot}`] ? presets[`p${slot}`].name : `Preset ${slot}`;
    }
  });
}

// Saves to Foxy, falling back to localStorage.
function savePreset(slot, presetData) {
  return new Promise(resolve => {
    savePresetToFoxyAPI(slot, presetData).then(apiSuccess => {
      if (apiSuccess) { resolve(true); return; }
      try {
        const customerId = getCustomerId();
        const key = customerId ? `presets_${customerId}_${slot}` : `supplement_preset_${slot}`;
        localStorage.setItem(key, JSON.stringify(presetData));
        resolve(true);
      } catch (err) {
        resolve(false);
      }
    }).catch(err => {
      console.error("🔐 Error saving preset:", err);
      resolve(false);
    });
  });
}

// ---------- User preset UI ----------
function loadUserPresetsSection() {
  const userPresets = document.getElementById('user-presets');
  if (!userPresets) return;
  userPresets.style.display = 'block';
  checkFoxyLoginStatus().then(loggedIn => {
    if (loggedIn) populateUserPresets();
    else showLoginPrompt();
  });
}

function populateUserPresets() {
  const loginPrompt = document.getElementById('login-prompt');
  const userPresets = document.getElementById('user-presets');
  if (loginPrompt) loginPrompt.style.display = 'none';
  if (userPresets) userPresets.style.display = 'block';
  if (els.lastOrderBtn) els.lastOrderBtn.style.display = "block";
  loadPresets().then(presets => {
    const template = document.getElementById('preset-button-template');
    if (!userPresets || !template) return;
    template.style.display = 'none';
    userPresets.querySelectorAll('.generated-preset').forEach(btn => btn.remove());
    ['1', '2', '3'].forEach(slot => {
      const preset = presets[`p${slot}`];
      if (!preset) return;
      const btn = template.cloneNode(true);
      btn.removeAttribute('id');
      btn.classList.add('generated-preset');
      btn.textContent = preset.name;
      btn.style.display = 'block';
      btn.dataset.presetSlot = slot;
      btn.addEventListener('click', () => loadUserPreset(slot, preset));
      userPresets.appendChild(btn);
    });
  });
}

function loadUserPreset(slot, presetData) {
  selected = [];
  presetData.ingredients.forEach(item => {
    const cmsItem = els.ingredientList?.querySelector(`.ingredient-item[data-name="${item.name}"]`);
    if (cmsItem) {
      const totalWeight = item.dosage * SERVINGS;
      const totalPrice = totalWeight * parseFloat(cmsItem.dataset.price || 0);
      selected.push({ name: item.name, dosage: item.dosage, totalWeight, totalPrice, costPerGram: item.costPerGram });
    }
  });
  if (presetData.flavor && els.flavorSelect) {
    flavor = presetData.flavor;
    els.flavorSelect.value = presetData.flavor;
    els.flavorSelect.dispatchEvent(new Event('change'));
  }
  // renderSelected / updateServingSize / updateSubmitButtonState / closeIngredientSelector
  // live in the DOMContentLoaded scope and are exposed on window at the bottom of this file.
  if (window.renderSelected) window.renderSelected();
  if (window.updateServingSize) window.updateServingSize();
  updatePriceInfo();
  updateCaloriesDisplay();
  if (window.updateSubmitButtonState) window.updateSubmitButtonState();
  if (window.closeIngredientSelector) window.closeIngredientSelector();
}

// Convert a cart-option dose label ("5.00g" / "500mg") back to grams.
function parseDoseToGrams(label) {
  if (!label) return 0;
  const s = String(label).trim().toLowerCase();
  const num = parseFloat(s.replace(/[^0-9.]/g, "")) || 0;
  return s.endsWith("mg") ? num / 1000 : num; // "g" or bare = grams
}

// Build a preset-shaped object from a Foxy "Custom" line item and load it
// into the builder by reusing the existing loadUserPreset() path.
function loadLastOrderFromItem(item) {
  const ingredients = [];
  (item.options || []).forEach(opt => {
    if (!/^Ingredient\d+$/i.test(opt.name)) return;          // value: "Creatine Monohydrate - 5.00g"
    const sep = opt.value.lastIndexOf(" - ");
    if (sep === -1) return;
    const name = opt.value.slice(0, sep).trim();
    const dosage = parseDoseToGrams(opt.value.slice(sep + 3));
    if (!name || !(dosage > 0)) return;
    const cmsItem = els.ingredientList?.querySelector(`.ingredient-item[data-name="${name}"]`);
    const costPerGram = cmsItem ? parseFloat(cmsItem.dataset.costPerGram) || 0 : 0;
    ingredients.push({ name, dosage, costPerGram });
  });
  if (ingredients.length === 0) return false;
  const flavorOpt = (item.options || []).find(o => o.name === "Flavor");
  loadUserPreset("last-order", { name: "Last Order", ingredients, flavor: flavorOpt ? flavorOpt.value : null });
  return true;
}

function loadLastOrder() {
  getCustomerIdFromPortal().then(customerId => {
    if (!customerId) { alert("Please log in to load your last order."); return; }
    fetch(`${FOXY_LAST_ORDER_FUNCTION_URL}?customerId=${encodeURIComponent(customerId)}`)
      .then(res => res.json())
      .then(data => {
        if (!data.success) { console.error("Last order error:", data.error); alert("Sorry, we couldn't load your last order."); return; }
        if (!data.found)   { alert("We couldn't find a previous order on your account."); return; }
        const customItem = (data.order.items || []).find(it =>
          it.name === "Custom" || (it.options || []).some(o => /^Ingredient\d+$/i.test(o.name))
        );
        if (!customItem) {
          alert("Your last order was one of our ready-made blends — you can re-order it from the Shop.");
          return;
        }
        if (!loadLastOrderFromItem(customItem)) {
          alert("We couldn't read the ingredients from your last order.");
        }
      })
      .catch(err => { console.error("Last order fetch failed:", err); alert("Sorry, we couldn't load your last order."); });
  });
}

function showLoginPrompt() {
  const loginPrompt = document.getElementById('login-prompt');
  const userPresets = document.getElementById('user-presets');
  if (loginPrompt) loginPrompt.style.display = 'block';
  if (userPresets) userPresets.style.display = 'none';
  if (els.lastOrderBtn) els.lastOrderBtn.style.display = "none";
}

console.log("✅ Script loaded and executing");

// Capture customer id passed back in the URL (e.g. after Foxy redirect)
(function captureCustomerIdFromUrl() {
  const params = new URLSearchParams(window.location.search);
  const customerId = params.get('fc_customer_id') || params.get('customer_id');
  if (customerId) {
    localStorage.setItem('foxy_customer_id', customerId);
    localStorage.setItem('foxy_login_check_time', Date.now().toString());
    document.cookie = `foxy_customer_id=${encodeURIComponent(customerId)}; Path=/; Secure; SameSite=Lax; Max-Age=86400`;
    console.log("🔐 Customer ID from URL:", customerId);
  }
})();

// ---------- Builder UI (runs after DOM is ready) ----------
document.addEventListener("DOMContentLoaded", function () {
  console.log("✅ DOMContentLoaded fired");

  function debounce(fn, wait) {
    let timer;
    return function (...args) {
      clearTimeout(timer);
      timer = setTimeout(() => fn.apply(this, args), wait);
    };
  }

  let pricingTimeout = null;

  function debouncedUpdateSubtotal() {
    if (pricingTimeout) clearTimeout(pricingTimeout);
    pricingTimeout = setTimeout(() => {
      updateSubtotalAndCart();
      pricingTimeout = null;
    }, 50);
  }

  function updateMiniCartCount() {
    if (typeof FC !== 'undefined' && FC.client) {
      FC.client.request('https://tailorfit.foxycart.com/cart?output=json').then(cart => {
        const itemCount = cart.items ? cart.items.reduce((sum, item) => sum + item.quantity, 0) : 0;
        if (els.cartCount) els.cartCount.textContent = itemCount;
      });
    }
  }
  updateMiniCartCount();

  // Copy weight/price from the hidden flavor CMS list onto the <select> options.
  function prepFlavorAttributes() {
    if (!els.flavorSelect || !els.flavorDataList) return;
    setTimeout(() => {
      const options = els.flavorSelect.querySelectorAll("option:not([value=''])");
      options.forEach(option => {
        const flavorName = option.value.trim();
        let weightEl = els.flavorDataList.querySelector(`.flavor-weight[data-flavor-name="${flavorName}"]`);
        let priceEl = els.flavorDataList.querySelector(`.flavor-price[data-flavor-name="${flavorName}"]`);
        if (!weightEl) {
          const item = els.flavorDataList.querySelector(`[data-flavor-name="${flavorName}"]`)?.closest('.w-dyn-item');
          weightEl = item?.querySelector('.flavor-weight');
        }
        if (!priceEl) {
          const item = els.flavorDataList.querySelector(`[data-flavor-name="${flavorName}"]`)?.closest('.w-dyn-item');
          priceEl = item?.querySelector('.flavor-price');
        }
        let weight = weightEl?.textContent || "0";
        const price = priceEl?.textContent || "0";
        weight = parseFloat(weight.replace(/[^0-9.]/g, "")) || 0;
        option.setAttribute("data-price", price);
        option.setAttribute("data-weight", weight);
      });
      if (!els.flavorSelect.querySelector('option[value=""]')) {
        els.flavorSelect.innerHTML = `<option value="" disabled selected>Choose a Flavor</option>` + els.flavorSelect.innerHTML;
      }
    }, 500);
  }
  prepFlavorAttributes();

  els.addEditBtn?.addEventListener("click", () => {
    if (els.ingredientSelector) {
      els.ingredientSelector.style.display = "flex";
      els.ingredientSelector.style.opacity = "0";
      els.ingredientSelector.style.transform = "translateY(-20px)";
      els.ingredientSelector.style.transition = "opacity 0.3s ease-out, transform 0.3s ease-out";
      els.ingredientSelector.offsetHeight;
      els.ingredientSelector.style.opacity = "1";
      els.ingredientSelector.style.transform = "translateY(0)";
      els.ingredientSelector.classList.add("show");
      els.ingredientSelector.classList.remove("closing");
      resetItemVisibility();
      showIngredientItems();
      showPresetItems();
    }
  });
  els.closeSelectorBtn?.addEventListener("click", closeIngredientSelector);
  els.closeXIcon?.addEventListener("click", closeIngredientSelector);

  function closeIngredientSelector() {
    if (els.ingredientSelector) {
      els.ingredientSelector.style.opacity = "0";
      els.ingredientSelector.style.transform = "translateY(-20px)";
      els.ingredientSelector.style.transition = "opacity 0.3s ease-in, transform 0.3s ease-in";
      els.ingredientSelector.classList.add("closing");
      els.ingredientSelector.classList.remove("show");
      setTimeout(() => { els.ingredientSelector.style.display = "none"; }, 300);
      draft = [];
      renderDraft();
      if (els.ingredientDescription) els.ingredientDescription.textContent = "Select an ingredient or preset to view a description here...";
      if (els.ingredientHeader) els.ingredientHeader.textContent = "Select Ingredient";
    }
  }

  function showIngredientItems() {
    if (!els.ingredientList) return;
    els.ingredientList.querySelectorAll(".w-dyn-item").forEach(item => item.classList.add("visible"));
  }

  function showPresetItems() {
    if (!els.presetList) return;
    Array.from(els.presetList.children).filter(c => c.classList.contains("w-dyn-item")).forEach(item => item.classList.add("visible"));
  }

  function resetItemVisibility() {
    if (els.ingredientList) {
      els.ingredientList.querySelectorAll(".w-dyn-item").forEach(item => item.classList.add("visible"));
    }
    if (els.presetList) {
      Array.from(els.presetList.children).filter(c => c.classList.contains("w-dyn-item")).forEach(item => item.classList.add("visible"));
    }
  }

  // CMS preset items: AJAX-load their ingredient lists, and wire click-to-stage.
  if (els.presetList) {
    els.presetList.querySelectorAll(".preset-item").forEach(item => {
      const link = item.querySelector("a");
      const ingredientList = item.querySelector(".preset-ingredient-list");
      if (!ingredientList) return;
      const presetSlug = ingredientList.id.replace("preset-", "");
      $(document).ready(function () {
        $(`#preset-${presetSlug}`).load(`/presets/${presetSlug} .preset-ingredient-list`, function (response, status) {
          const ingredientEls = item.querySelectorAll(".preset-ingredient");
          const ingredients = status === "success" ? Array.from(ingredientEls).map(i => i.dataset.name.trim()) : [];
          presetCache.set(presetSlug, ingredients);
        });
      });
      link?.addEventListener("click", (evt) => {
        evt.preventDefault();
        const description = item.dataset.description || "No description available.";
        const amounts = item.dataset.ingredientAmounts?.split(",").map(a => parseFloat(a.trim())) || [];
        let ingredients = presetCache.get(presetSlug) || [];
        if (ingredients.length === 0) {
          const ingredientEls = item.querySelectorAll(".preset-ingredient");
          ingredients = Array.from(ingredientEls).map(i => i.dataset.name.trim());
        }
        if (ingredients.length !== amounts.length) return;
        if (els.ingredientDescription) els.ingredientDescription.textContent = description;
        draft = [];
        ingredients.forEach((ingredientName, i) => {
          if (!selected.some(sel => sel.name.trim() === ingredientName.trim())) {
            const dosage = amounts[i];
            const totalWeight = dosage * SERVINGS;
            const items = els.ingredientList?.querySelectorAll(".ingredient-item");
            const cmsItem = items && Array.from(items).find(el => el.dataset.name?.trim() === ingredientName);
            const pricePerGram = cmsItem ? parseFloat(cmsItem.dataset.price) || 0 : 0;
            const costPerGram = cmsItem ? parseFloat(cmsItem.dataset.costPerGram) || 0 : 0;
            const totalPrice = SERVINGS * dosage * pricePerGram;
            draft.push({ name: ingredientName, dosage, totalWeight, totalPrice, costPerGram });
          }
        });
        renderDraft();
      });
    });
  }

  els.flavorSelect?.addEventListener("change", (ev) => {
    flavor = ev.target.value;
    updateServingSize();
    debouncedUpdateSubtotal();
    updateSubmitButtonState();
  });

  els.ingredientList?.querySelectorAll(".ingredient-item").forEach(item => {
    item.addEventListener("click", () => {
      const name = item.dataset.name?.trim();
      if (name && els.ingredientDescription) {
        els.ingredientList.querySelectorAll(".ingredient-item").forEach(i => i.removeAttribute("selected"));
        item.setAttribute("selected", "");
        els.ingredientDescription.textContent = item.dataset.description || "No description available.";
        if (els.ingredientHeader) els.ingredientHeader.textContent = name;
        setupSlider(item);
        els.dosageSliderContainer?.classList.remove("disabled");
      }
    });
  });

  function setupSlider(ingredient) {
    if (!els.dosageSlider) return;
    let min = parseFloat(ingredient.dataset.min);
    let max = parseFloat(ingredient.dataset.max);
    let steps = parseInt(ingredient.dataset.steps);
    let suggested = parseFloat(ingredient.dataset.suggestedDosage);
    if (isNaN(min) || min < 0) min = 1;
    if (isNaN(max) || max <= min) max = min + 1;
    if (isNaN(steps) || steps < 2) steps = 10;
    if (isNaN(suggested)) suggested = min;
    suggested = Math.max(min, Math.min(max, suggested));
    const isMilligramRange = max < 1;
    if (isMilligramRange) { min *= 1000; max *= 1000; suggested *= 1000; }
    let stepSize = (max - min) / (steps - 1);
    if (!isFinite(stepSize) || stepSize <= 0) stepSize = 1;
    els.dosageSlider.min = min;
    els.dosageSlider.max = max;
    els.dosageSlider.step = stepSize;
    els.dosageSlider.value = suggested;
    els.dosageSlider.disabled = false;
    updateDosageValue();
  }
  els.dosageSlider?.addEventListener('input', updateDosageValue);
  els.dosageSlider?.addEventListener('change', updateDosageValue);

  function updateDosageValue() {
    if (els.dosageValue && els.dosageSlider) {
      const current = parseFloat(els.dosageSlider.value);
      els.dosageValue.textContent = formatDose(sliderToGrams(current));
      const min = parseFloat(els.dosageSlider.min);
      const max = parseFloat(els.dosageSlider.max);
      const pct = ((current - min) / (max - min)) * 100;
      els.dosageSlider.style.backgroundSize = `100% 100%, ${pct}% 100%`;
    }
  }

  function formatDose(value) {
    const grams = parseFloat(value);
    return grams < 1 ? `${(grams * 1000).toFixed(0)}mg` : `${grams.toFixed(2)}g`;
  }

  // Slider works in mg for sub-gram ingredients; convert back to grams.
  function sliderToGrams(value) {
    const sliderValue = parseFloat(value);
    const selectedItem = els.ingredientList?.querySelector(".ingredient-item[selected]");
    if (selectedItem) {
      const max = parseFloat(selectedItem.dataset.max) || 10;
      return max < 1 ? sliderValue / 1000 : sliderValue;
    }
    return sliderValue;
  }

  els.addIngredientBtn?.addEventListener("click", (evt) => {
    evt.preventDefault();
    const selectedItem = els.ingredientList?.querySelector(".ingredient-item[selected]");
    if (selectedItem && els.dosageSlider) {
      const name = selectedItem.dataset.name?.trim();
      const dosage = sliderToGrams(els.dosageSlider.value);
      const pricePerGram = parseFloat(selectedItem.dataset.price) || 0;
      const costPerGram = parseFloat(selectedItem.dataset.costPerGram) || 0;
      const totalWeight = dosage * SERVINGS;
      const totalPrice = totalWeight * pricePerGram;
      const existingIndex = draft.findIndex(item => item.name.trim() === name);
      if (existingIndex !== -1) draft.splice(existingIndex, 1);
      draft.push({ name, dosage, totalWeight, totalPrice, costPerGram });
      renderDraft();
      els.dosageSliderContainer?.classList.add("disabled");
      els.ingredientDescription.textContent = "Select an ingredient or preset to view a description here...";
      if (els.ingredientHeader) els.ingredientHeader.textContent = "Select Ingredient";
      els.ingredientList.querySelectorAll(".ingredient-item").forEach(i => i.removeAttribute("selected"));
    }
  });

  function renderDraft() {
    if (!els.builderSelected) return;
    const html = draft.map((item, i) => `
      <div class="ingredient-item">
        <b>${formatDose(item.dosage)}</b> - ${item.name}
        <button class="remove-ingredient" data-index="${i}" title="Remove ingredient">X</button>
      </div>`).join("");
    if (els.builderSelected.innerHTML !== html) els.builderSelected.innerHTML = html;
  }

  els.builderSelected?.addEventListener("click", (ev) => {
    if (ev.target.classList.contains("remove-ingredient")) {
      const i = parseInt(ev.target.dataset.index);
      draft.splice(i, 1);
      renderDraft();
    }
  });

  function renderSelected() {
    if (!els.reviewSelected) return;
    const html = selected.map((item, i) => {
      const cmsItem = els.ingredientList?.querySelector(`.ingredient-item[data-name="${item.name}"]`);
      const cmsWrapper = cmsItem?.closest('.w-dyn-item');
      const getAttr = (el, attr) => el?.getAttribute(attr) || cmsWrapper?.getAttribute(attr) || null;
      const sweet = getAttr(cmsItem, 'data-sweet-pillar') || '0';
      const sour = getAttr(cmsItem, 'data-sour-pillar') || '0';
      const salty = getAttr(cmsItem, 'data-salty-pillar') || '0';
      const bitter = getAttr(cmsItem, 'data-bitter-pillar') || '0';
      const earthy = getAttr(cmsItem, 'data-earthy-pillar') || '0';
      const potency = getAttr(cmsItem, 'data-potency-multiplier') || '1.0';
      return `
      <div class="ingredient-item" data-name="${item.name}" data-sweet-pillar="${sweet}" data-sour-pillar="${sour}" data-salty-pillar="${salty}" data-bitter-pillar="${bitter}" data-earthy-pillar="${earthy}" data-potency-multiplier="${potency}">
        <b>${formatDose(item.dosage)}</b> - ${item.name}
        <button class="remove-ingredient" data-index="${i}" title="Remove ingredient">X</button>
      </div>`;
    }).join("");
    if (els.reviewSelected.innerHTML !== html) els.reviewSelected.innerHTML = html;
    updatePresetEntryVisibility();
    updateSubmitButtonState();
    if (window.updateFlavorProfile) window.updateFlavorProfile();
  }

  els.reviewSelected?.addEventListener("click", (ev) => {
    if (ev.target.classList.contains("remove-ingredient")) {
      const i = parseInt(ev.target.dataset.index);
      selected.splice(i, 1);
      renderSelected();
      updateServingSize();
      updatePriceInfo();
      updateCaloriesDisplay();
      updateSubmitButtonState();
    }
  });

  function updateServingSize() {
    if (!els.servingSize) return;
    const ingredientWeight = selected.reduce((sum, item) => sum + (item.dosage || 0), 0);
    let flavorWeight = 0;
    if (flavor) {
      const option = els.flavorSelect.querySelector(`option[value="${flavor}"]`);
      flavorWeight = option ? parseFloat(option.dataset.weight) || 0 : 0;
    }
    els.servingSize.textContent = formatDose(ingredientWeight + flavorWeight);
  }

  function updateSubtotalAndCart() {
    if (!els.reviewSubtotal) return;
    if (selected.length === 0) {
      els.reviewSubtotal.textContent = "$0.00";
      updateCaloriesDisplay();
      updateSubmitButtonLink();
      return;
    }
    const total = calcPrice(selected) + flavorPrice();
    els.reviewSubtotal.textContent = `$${total.toFixed(2)}`;
    updateCaloriesDisplay();
    updateSubmitButtonLink();
  }

  function updateSubmitButtonState() {
    const count = selected.length;
    if (els.submitBtn) {
      if (count >= 3 && flavor) {
        els.submitBtn.classList.remove("disabled");
        els.submitBtn.style.opacity = "1";
        els.submitBtn.style.cursor = "pointer";
        updateSubmitButtonLink();
      } else {
        els.submitBtn.classList.add("disabled");
        els.submitBtn.style.opacity = "0.5";
        els.submitBtn.style.cursor = "not-allowed";
        els.submitBtn.removeAttribute("href");
      }
    }
    if (els.cartNotification) els.cartNotification.style.display = count < 3 ? "block" : "none";
  }

  function updateSubmitButtonLink() {
    if (!els.submitBtn || selected.length < 3 || !flavor) {
      els.submitBtn?.removeAttribute("href");
      return;
    }
    const productName = `Custom`;
    const price = parseFloat(els.reviewSubtotal?.textContent.replace('$', '')) || 0;
    let cartUrl = `https://tailorfit.foxycart.com/cart?cart=add&name=${encodeURIComponent(productName)}&price=${price}&quantity=1&item_category=${encodeURIComponent("Default for all products")}`;
    selected.forEach((item, i) => {
      const optionValue = `${item.name} - ${formatDose(item.dosage)}`;
      cartUrl += `&Ingredient${i + 1}=${encodeURIComponent(optionValue)}`;
    });
    if (flavor) {
      cartUrl += `&Flavor=${encodeURIComponent(flavor)}`;
    }
    els.submitBtn.setAttribute("href", cartUrl);
  }

  els.confirmSelectionBtn?.addEventListener("click", () => {
    try {
      draft.forEach(newItem => {
        const existingIndex = selected.findIndex(item => item.name.trim() === newItem.name.trim());
        if (existingIndex !== -1) {
          selected[existingIndex] = {
            ...selected[existingIndex],
            dosage: newItem.dosage,
            totalWeight: newItem.totalWeight,
            totalPrice: newItem.totalPrice,
            costPerGram: newItem.costPerGram
          };
        } else {
          selected.push(newItem);
        }
      });
      draft = [];
      renderDraft();
      renderSelected();
      updateServingSize();
      updatePriceInfo();
      updateCaloriesDisplay();
      updateSubmitButtonState();
      showIngredientItems();
      closeIngredientSelector();
    } catch (err) {
      console.error("Error in confirmSelection:", err);
    }
  });

  els.submitBtn?.addEventListener("click", (ev) => {
    if (els.submitBtn.classList.contains("disabled")) { ev.preventDefault(); return; }
    if (selected.length < 3 || !flavor) {
      ev.preventDefault();
      alert("Please select at least 3 ingredients and a flavor before adding to cart.");
      return;
    }
    setTimeout(() => {
      selected = [];
      flavor = null;
      renderSelected();
      updateServingSize();
      updatePriceInfo();
      updateCaloriesDisplay();
      updateSubmitButtonState();
      els.flavorSelect.value = "";
      updateMiniCartCount();
    }, 1000);
  });

  updateSubmitButtonState();
  updateCaloriesDisplay();
  updatePresetEntryVisibility();

  // ---- Presets tab activation ----
  const presetTab = document.getElementById('preset-tab');
  if (presetTab) {
    presetTab.addEventListener('click', (ev) => { ev.preventDefault(); loadUserPresetsSection(); });
    presetTab.addEventListener('w--tab-active', () => { loadUserPresetsSection(); });
  }
  const presetTabPane = document.querySelector('[data-w-tab="Presets"]');
  if (presetTabPane) {
    const observer = new MutationObserver((mutations) => {
      mutations.forEach((mutation) => {
        if (mutation.type === 'attributes' && mutation.attributeName === 'style') {
          const isVisible = presetTabPane.style.display !== 'none' && presetTabPane.style.display !== '' && !presetTabPane.classList.contains('w--tab-hidden');
          if (isVisible) loadUserPresetsSection();
        }
      });
    });
    observer.observe(presetTabPane, { attributes: true, attributeFilter: ['style', 'class'] });
  }
  document.querySelectorAll('[data-w-tab="Presets"]').forEach(tab => {
    tab.addEventListener('click', () => { loadUserPresetsSection(); });
  });

  // ---- Save-preset modal helpers ----
  if (els.closeModal) {
    els.closeModal.style.display = "none";
    els.closeModal.style.opacity = "0";
    els.closeModal.style.transition = "opacity 0.3s ease-in";
  }
  let closeModalTimeout = null;

  function showCloseModal() {
    if (!els.closeModal) return;
    clearTimeout(closeModalTimeout);
    els.closeModal.style.display = "block";
    els.closeModal.style.opacity = "0";
    els.closeModal.offsetHeight;
    setTimeout(() => { els.closeModal.style.opacity = "1"; }, 10);
  }

  function hideCloseModal() {
    if (!els.closeModal) return;
    clearTimeout(closeModalTimeout);
    els.closeModal.style.opacity = "0";
    setTimeout(() => { if (els.closeModal) els.closeModal.style.display = "none"; }, 300);
  }
  els.closeModal?.addEventListener("click", () => { syncPresetUIWithLogin(); hideCloseModal(); });

  if (els.presetModal) {
    const observer = new MutationObserver((mutations) => {
      mutations.forEach((mutation) => {
        if (mutation.type === 'attributes' && (mutation.attributeName === 'style' || mutation.attributeName === 'class')) {
          const isVisible = els.presetModal.style.display === 'flex' || els.presetModal.style.display === 'block';
          if (isVisible) {
            clearTimeout(closeModalTimeout);
            closeModalTimeout = setTimeout(showCloseModal, 1000);
          } else {
            hideCloseModal();
          }
        }
      });
    });
    observer.observe(els.presetModal, { attributes: true, attributeFilter: ['style', 'class'] });
  }

  // ---- Login modal: re-sync preset UI when it closes ----
  const loginModal = document.getElementById('login-modal') ||
    document.querySelector('[fs-modal-element="modal-2"]') ||
    document.querySelector('#fs-modal-2-popup') ||
    document.querySelector('foxy-customer-portal')?.closest('[fs-modal-element]') ||
    document.querySelector('foxy-customer-portal')?.closest('.w-modal');
  if (loginModal) {
    console.log("🔐 Login modal found:", loginModal);
    let wasVisible = false;
    const isModalVisible = () => {
      const style = getComputedStyle(loginModal);
      return style.display !== 'none' && style.visibility !== 'hidden' && loginModal.offsetParent !== null &&
        !loginModal.classList.contains('w--modal-closed') && !loginModal.classList.contains('w--modal-hidden');
    };
    const loginModalObserver = new MutationObserver(() => {
      const isVisible = isModalVisible();
      if (wasVisible && !isVisible) {
        console.log("🔐 Login modal closed, syncing preset UI");
        setTimeout(() => syncPresetUIWithLogin(), 500);
      }
      wasVisible = isVisible;
    });
    loginModalObserver.observe(loginModal, { attributes: true, attributeFilter: ['style', 'class'], childList: false, subtree: false });
    loginModal.querySelectorAll('[aria-label*="close" i],[class*="close" i],.w-modal-close,.fs-modal-close').forEach(btn => {
      btn.addEventListener('click', () => {
        console.log("🔐 Login modal close button clicked");
        setTimeout(() => syncPresetUIWithLogin(), 500);
      });
    });
    setTimeout(() => { wasVisible = isModalVisible(); console.log("🔐 Login modal initial visibility:", wasVisible); }, 500);
  }

  els.openPresetBtn?.addEventListener("click", () => {
    loadPresets().then(presets => {
      populatePresetInputs(presets);
      if (els.presetModal) {
        els.presetModal.style.display = "flex";
        clearTimeout(closeModalTimeout);
        closeModalTimeout = setTimeout(showCloseModal, 1000);
      }
    });
  });
  els.closePresetModalBtn?.addEventListener("click", () => {
    if (els.presetModal) { els.presetModal.style.display = "none"; hideCloseModal(); }
  });
  els.savePresetBtn?.addEventListener("click", () => {
    let slot = null;
    let presetName = "";
    if (els.presetInput1 && els.presetInput1.value.trim()) { slot = 1; presetName = els.presetInput1.value.trim(); }
    else if (els.presetInput2 && els.presetInput2.value.trim()) { slot = 2; presetName = els.presetInput2.value.trim(); }
    else if (els.presetInput3 && els.presetInput3.value.trim()) { slot = 3; presetName = els.presetInput3.value.trim(); }
    if (!slot) { alert("Please enter a name for your preset in one of the fields."); return; }
    if (selected.length === 0) { alert("Please add ingredients before saving a preset."); return; }
    const presetData = {
      name: presetName,
      ingredients: selected.map(item => ({ name: item.name, dosage: item.dosage, costPerGram: item.costPerGram })),
      flavor: flavor,
      createdDate: new Date().toISOString()
    };
    savePreset(slot, presetData).then(success => {
      if (success) {
        alert(`Preset "${presetName}" saved successfully!`);
        if (els.presetModal) { els.presetModal.style.display = "none"; hideCloseModal(); }
      } else {
        alert("Error saving preset. Please try again.");
      }
    });
  });
  els.lastOrderBtn?.addEventListener("click", (e) => { e.preventDefault(); loadLastOrder(); });
    if (els.lastOrderBtn) els.lastOrderBtn.style.display = "none"; // hidden until login confirmed

  // ---- Deep-link: open builder + load a preset by ?slug= ----
  const slug = getQueryParam('slug');
  if (slug) {
    if (els.ingredientSelector && !els.ingredientSelector.classList.contains('show')) {
      els.ingredientSelector.style.display = "flex";
      els.ingredientSelector.style.opacity = "0";
      els.ingredientSelector.style.transform = "translateY(-20px)";
      els.ingredientSelector.style.transition = "opacity 0.3s ease-out, transform 0.3s ease-out";
      els.ingredientSelector.offsetHeight;
      els.ingredientSelector.style.opacity = "1";
      els.ingredientSelector.style.transform = "translateY(0)";
      els.ingredientSelector.classList.add('show');
      els.ingredientSelector.classList.remove('closing');
      els.ingredientSelector.classList.remove('hide-on-load');
    }

    function loadPresetFromSlug(presetSlug) {
      const presetItem = els.presetList?.querySelector(`.preset-item[data-slug="${presetSlug}"]`);
      if (!presetItem) return;
      const amountsAttr = presetItem.dataset.ingredientAmounts;
      if (!amountsAttr) return;
      const amounts = amountsAttr.split(',').map(a => parseFloat(a.trim()) || 0);
      const tempContainer = document.createElement('div');
      tempContainer.style.display = 'none';
      document.body.appendChild(tempContainer);
      $(tempContainer).load(`/presets/${presetSlug} .preset-ingredient-list`, function (response, status, xhr) {
        if (status === "error") {
          console.error("Error loading preset data for slug:", presetSlug, xhr.status, xhr.statusText);
          return;
        }
        const list = tempContainer.querySelector('.preset-ingredient-list');
        if (list) {
          const ingredientEls = list.querySelectorAll('.preset-ingredient');
          const ingredients = Array.from(ingredientEls).map((el, idx) => {
            const name = el.dataset.name?.trim();
            const dosage = amounts[idx] || 0;
            return { name, dosage };
          }).filter(i => i.name && i.dosage > 0);
          ingredients.forEach(i => {
            const cmsItem = els.ingredientList?.querySelector(`.ingredient-item[data-name="${i.name}"]`);
            if (cmsItem) {
              const pricePerGram = parseFloat(cmsItem.dataset.price) || 0;
              const costPerGram = parseFloat(cmsItem.dataset.costPerGram) || 0;
              const totalWeight = i.dosage * SERVINGS;
              const totalPrice = totalWeight * pricePerGram;
              draft.push({ name: i.name, dosage: i.dosage, totalWeight, totalPrice, costPerGram });
            }
          });
          renderDraft();
          renderSelected();
          updateServingSize();
          updateSubtotalAndCart();
          updateCaloriesDisplay();
          updateSubmitButtonLink();
          updateSubmitButtonState();
        }
        document.body.removeChild(tempContainer);
      });
    }
    setTimeout(() => { resetItemVisibility(); showIngredientItems(); showPresetItems(); loadPresetFromSlug(slug); }, 500);
  }

  document.getElementById('presets-tab')?.addEventListener('click', () => { loadUserPresetsSection(); });

  // Expose the functions that top-level code (loadUserPreset) needs to reach.
  window.renderSelected = renderSelected;
  window.updateServingSize = updateServingSize;
  window.updateSubmitButtonState = updateSubmitButtonState;
  window.closeIngredientSelector = closeIngredientSelector;
});
