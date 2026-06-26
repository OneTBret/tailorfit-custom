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

// Convert a cart-option dose label ("5.00g" / "500mg") back to grams.
function parseDoseToGrams(label) {
  if (!label) return 0;
  const s = String(label).trim().toLowerCase();
  const num = parseFloat(s.replace(/[^0-9.]/g, "")) || 0;
  return s.endsWith("mg") ? num / 1000 : num; // "g" or bare = grams
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
/* =====================================================================
 * Tailor Fit — Custom Supplement Builder · UI layer (redesign)
 * Renders presets/catalog/flavors/summary from the hidden Webflow CMS
 * lists into the #tf-builder embed, reusing the backend half verbatim.
 * ===================================================================== */

/* ---------- state ---------- */
let selected = [];               // [{name, dosage(g/serving)}]
let flavor = null;               // flavor name
let INGREDIENTS = [], FLAVORS = [], PRESETS = [], byName = {};
let activeFilter = 'all', search = '';
const presetCache = new Map();   // slug -> [ingredient names]
const CAT_ORDER = ["Energy & Focus","Pumps & Performance","Strength & Aminos","Hydration & Electrolytes","Recovery & Sleep","Vitamins & Minerals","Carbs & Extras"];

/* ---------- helpers ---------- */
const esc = s => String(s==null?'':s).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const cssEsc = s => (window.CSS && CSS.escape) ? CSS.escape(s) : String(s).replace(/["\\]/g,'\\$&');
const $id = id => document.getElementById(id);
function fmtDose(g){ g = parseFloat(g)||0; return g<1 ? `${Math.round(g*1000)}mg` : `${g.toFixed(2)}g`; }

/* ---------- CMS readers (no hardcoding) ---------- */
function readIngredients(){
  return Array.from(document.querySelectorAll('.ingredient-list .ingredient-item')).map(el=>{
    const d=el.dataset, num=v=>parseFloat(v)||0;
    return {
      name:(d.name||'').trim(), blurb:d.description||'', cat:(d.category||'').trim()||'Other',
      type:(d.supplementType||'').toLowerCase(), min:num(d.min), max:num(d.max),
      steps:parseInt(d.steps)||10, suggested:(d.suggestedDosage!=null&&d.suggestedDosage!=='')?num(d.suggestedDosage):null,
      price:num(d.price), cost:num(d.costPerGram), cal:num(d.calories),
      sweet:num(d.sweetPillar), sour:num(d.sourPillar), salty:num(d.saltyPillar),
      bitter:num(d.bitterPillar), earthy:num(d.earthyPillar), potency:num(d.potencyMultiplier)||1
    };
  }).filter(i=>i.name);
}
function readFlavors(){
  return Array.from(document.querySelectorAll('#flavor-data-list .w-dyn-item')).map(it=>{
    const txt=s=>(it.querySelector(s)?.textContent||'').trim();
    const num=s=>parseFloat(txt(s).replace(/[^0-9.\-]/g,''))||0;
    const cEl=it.querySelector('.flavor-color');
    let color=cEl?cEl.textContent.trim():'';
    if(cEl && !/^#|^rgb/.test(color)) color=getComputedStyle(cEl).backgroundColor||color;
    return { name:txt('.flavor-name'), price:num('.flavor-price'), weight:num('.flavor-weight'),
      cal:num('.flavor-calories'), sweet:num('.flavor-sweet-pillar'), sour:num('.flavor-sour-pillar'),
      salty:num('.flavor-salty-pillar'), bitter:num('.flavor-bitter-pillar'), earthy:num('.flavor-earthy-pillar'),
      color:color||'#7e8585' };
  }).filter(f=>f.name);
}
function readPresets(){
  return Array.from(document.querySelectorAll('.preset-item')).map(el=>{
    const d=el.dataset;
    const amounts=(d.ingredientAmounts||'').split(',').map(a=>parseFloat(a.trim())).filter(n=>!isNaN(n));
    return { name:(d.name||d.slug||'').trim(), slug:(d.slug||'').trim(),
      type:(d.supplementType||'').toLowerCase().trim(), desc:d.description||'', amounts, el };
  }).filter(p=>p.slug);
}

/* ---------- pricing / calories / serving (new data model) ---------- */
function pricedItems(){ return selected.map(s=>({ dosage:s.dosage, costPerGram:(byName[s.name]||{}).cost||0 })); }
function flavorPrice(){ const f=FLAVORS.find(x=>x.name===flavor); return f ? f.price*SERVINGS*0.1 : 0; }
function calcCalories(){ let t=0; selected.forEach(s=>{ const ing=byName[s.name]; if(ing) t+=s.dosage*(ing.cal||0); }); const f=FLAVORS.find(x=>x.name===flavor); if(f) t+=f.cal||0; return Math.round(t); }
function servingSize(){ let w=selected.reduce((a,s)=>a+(s.dosage||0),0); const f=FLAVORS.find(x=>x.name===flavor); if(f) w+=f.weight||0; return w; }

/* ---------- render: Tailor Fit presets ---------- */
function renderPresets(){
  const rail=$id('presetRail'); if(!rail) return;
  const tagCls=t=>t.includes('pre')&&t.includes('post')?'both':t.includes('post')?'post':'pre';
  const tagLbl=t=>t.includes('pre')&&t.includes('post')?'Pre / Post':t.includes('post')?'Post-Workout':t.includes('pre')?'Pre-Workout':'Blend';
  rail.innerHTML=PRESETS.map((p,i)=>`
    <div class="preset-card" data-i="${i}">
      <span class="accent"></span>
      <span class="tag ${tagCls(p.type)}">${tagLbl(p.type)}</span>
      <h3>${esc(p.name)}</h3>
      <div class="desc">${esc(p.desc)}</div>
      <div class="meta">${p.amounts.length} ingredients</div>
      <button class="apply">Load this blend</button>
    </div>`).join('');
  rail.querySelectorAll('.preset-card').forEach(c=>c.querySelector('.apply').addEventListener('click',()=>applyPreset(PRESETS[+c.dataset.i])));
}

/* ---------- render: saved blends (login-gated) ---------- */
function renderUserPresets(loggedIn){
  const el=$id('userPresets'); if(!el) return;
  if(!loggedIn){
  el.innerHTML=`<button class="up-btn ghost" id="tfDoLogin">🔒 Log in to save blends &amp; reload past orders</button>`;
  el.querySelector('#tfDoLogin')?.addEventListener('click',()=>document.getElementById('tfLoginTrigger')?.click());
  return;
}
  el.innerHTML=`<span class="login-note">Loading your blends…</span>`;
  loadPresets().then(presets=>{
    let html='';
    ['1','2','3'].forEach(slot=>{ const p=presets['p'+slot]; if(p) html+=`<button class="up-btn" data-slot="${slot}"><span class="star">★</span> ${esc(p.name)}</button>`; });
    html+=`<button class="up-btn ghost" id="loadLastOrderBtn">↺ Load last order</button>`;
    if(!Object.values(presets).some(Boolean)) html=`<span class="login-note">No saved blends yet — build one and tap <b>Save as preset</b>.</span>`+html;
    el.innerHTML=html;
    ['1','2','3'].forEach(slot=>{ const p=presets['p'+slot]; const b=el.querySelector(`.up-btn[data-slot="${slot}"]`); if(p&&b) b.addEventListener('click',()=>loadUserPreset(slot,p)); });
    el.querySelector('#loadLastOrderBtn')?.addEventListener('click',()=>loadLastOrder());
  });
}
function showLoginPrompt(){ renderUserPresets(false); }
function populateUserPresets(){ renderUserPresets(true); }
function syncPresetUIWithLogin(){ checkFoxyLoginStatus().then(li=>renderUserPresets(li)); }

/* ---------- apply a blend (shared by presets / saved / last order) ---------- */
function applyBlend(items, flavorName){
  selected = (items||[]).filter(it=>byName[it.name]).map(it=>({name:it.name, dosage:it.dosage}));
  if(flavorName){ const f=FLAVORS.find(x=>x.name===flavorName); flavor = f ? f.name : flavor; }
  renderCatalog(); renderFlavors(); renderSummary();
  $id('tf-builder')?.scrollIntoView({behavior:'smooth',block:'nearest'});
}
function applyPreset(p){
  const finish=names=>{
    const items=[]; names.forEach((nm,idx)=>{ const dose=p.amounts[idx]; if(nm&&dose>0&&byName[nm]) items.push({name:nm,dosage:dose}); });
    applyBlend(items, null); toast(`Loaded “${p.name}” — ${items.length} ingredients`);
  };
  const cached=presetCache.get(p.slug);
  if(cached&&cached.length){ finish(cached); return; }
  if(window.jQuery){
    const tmp=document.createElement('div'); tmp.style.display='none'; document.body.appendChild(tmp);
    jQuery(tmp).load(`/presets/${p.slug} .preset-ingredient-list`, function(r,st){
      let names=[]; if(st!=='error'){ names=Array.from(tmp.querySelectorAll('.preset-ingredient')).map(i=>(i.dataset.name||'').trim()).filter(Boolean); presetCache.set(p.slug,names); }
      document.body.removeChild(tmp); finish(names);
    });
  } else { finish(Array.from(p.el.querySelectorAll('.preset-ingredient')).map(i=>(i.dataset.name||'').trim()).filter(Boolean)); }
}
function loadUserPreset(slot, presetData){
  applyBlend((presetData.ingredients||[]).map(i=>({name:i.name,dosage:i.dosage})), presetData.flavor||null);
  toast(`Loaded “${presetData.name||'preset'}”`);
}
function loadLastOrderFromItem(item){
  const items=[];
  (item.options||[]).forEach(opt=>{
    if(!/^Ingredient\d+$/i.test(opt.name)) return;
    const sep=opt.value.lastIndexOf(' - '); if(sep===-1) return;
    const nm=opt.value.slice(0,sep).trim(); const dose=parseDoseToGrams(opt.value.slice(sep+3));
    if(nm&&dose>0) items.push({name:nm,dosage:dose});
  });
  if(!items.length) return false;
  const fo=(item.options||[]).find(o=>o.name==='Flavor');
  applyBlend(items, fo?fo.value:null); toast('Loaded your last order'); return true;
}

/* ---------- render: catalog ---------- */
function ingredientMatches(ing){ if(search && !ing.name.toLowerCase().includes(search)) return false; return activeFilter==='all' ? true : ing.type.includes(activeFilter); }
function renderCatalog(){
  const root=$id('catalog'); if(!root) return;
  const cats=CAT_ORDER.slice(); INGREDIENTS.forEach(i=>{ if(i.cat && !cats.includes(i.cat)) cats.push(i.cat); });
  let html='', shown=0;
  cats.forEach(cat=>{
    const list=INGREDIENTS.filter(i=>i.cat===cat && ingredientMatches(i)); if(!list.length) return; shown+=list.length;
    html+=`<div class="cat-group"><div class="cat-title">${esc(cat)}<span class="ln"></span><span style="color:var(--muted);font-weight:700">${list.length}</span></div><div class="cards">${list.map(cardHTML).join('')}</div></div>`;
  });
  root.innerHTML = shown ? html : `<div style="padding:40px;text-align:center;color:var(--muted)">No ingredients match “${esc(search)}”.</div>`;
  wireCards();
}
function cardHTML(ing){
  const sel=selected.find(s=>s.name===ing.name);
  const impacts=[['Sweet',ing.sweet],['Sour',ing.sour],['Salty',ing.salty],['Bitter',ing.bitter],['Earthy',ing.earthy]].filter(([,v])=>v>=25).map(([k])=>`<span class="fi">${k}</span>`).join('');
  return `<div class="icard ${sel?'in-blend':''}" data-name="${esc(ing.name)}">
    <div class="check">✓</div>
    <div class="top"><div><h4>${esc(ing.name)}</h4></div><button class="add">${sel?'Added ✓':'Add'}</button></div>
    <div class="blurb">${esc(ing.blurb)}</div>
    <div class="range">Dose range ${fmtDose(ing.min)} – ${fmtDose(ing.max)}</div>
    <div class="editor">
      <div class="dose-row"><span class="lbl">Your dose</span><span class="dose-val">—</span></div>
      <input type="range">
      <div class="suggested"></div>
      ${impacts?`<div class="flavor-impact">${impacts}</div>`:''}
      <button class="confirm">${sel?'Update dose':'Add to blend'}</button>
    </div></div>`;
}
function wireCards(){
  document.querySelectorAll('#tf-builder .icard').forEach(card=>{
    const ing=byName[card.dataset.name]; if(!ing) return;
    const range=card.querySelector('input[type=range]'), val=card.querySelector('.dose-val'), sug=card.querySelector('.suggested');
    const isMg=ing.max<1, toG=v=>isMg?v/1000:v;
    function setup(){
      let min=ing.min, max=ing.max, steps=ing.steps>1?ing.steps:10;
      let sd=ing.suggested!=null?ing.suggested:(min+max)/2; sd=Math.max(min,Math.min(max||min+1,sd));
      if(isMg){ min*=1000; max*=1000; sd*=1000; } if(!(max>min)) max=min+1;
      const existing=selected.find(s=>s.name===ing.name);
      range.min=min; range.max=max; let step=(max-min)/(steps-1); if(!(step>0)) step=1; range.step=step;
      range.value = existing ? (isMg?existing.dosage*1000:existing.dosage) : sd;
      sug.textContent=`Suggested ≈ ${fmtDose(ing.suggested!=null?ing.suggested:(ing.min+ing.max)/2)}`; upd();
    }
    function upd(){ const g=toG(parseFloat(range.value)); val.textContent=fmtDose(g);
      const pct=((range.value-range.min)/((range.max-range.min)||1))*100; range.style.backgroundSize=`${pct}% 100%`; }
    range.addEventListener('input',upd);
    card.querySelector('.add').addEventListener('click',e=>{ e.stopPropagation();
      const open=card.classList.contains('open'); document.querySelectorAll('#tf-builder .icard.open').forEach(c=>c.classList.remove('open'));
      if(!open){ card.classList.add('open'); setup(); } });
    card.querySelector('.confirm').addEventListener('click',()=>{ addToBlend(ing.name, toG(parseFloat(range.value))); card.classList.remove('open'); });
  });
}
function addToBlend(name,dosage){
  const i=selected.findIndex(s=>s.name===name); const isNew=i===-1;
  if(isNew) selected.push({name,dosage}); else selected[i].dosage=dosage;
  renderCatalog(); renderSummary();
  const card=document.querySelector(`#tf-builder .icard[data-name="${cssEsc(name)}"]`);
  if(card){ card.classList.remove('flash'); void card.offsetWidth; card.classList.add('flash'); }
  toast(isNew?`Added ${name}`:`Updated ${name}`);
}
function removeFromBlend(name){ selected=selected.filter(s=>s.name!==name); renderCatalog(); renderSummary(); toast(`Removed ${name}`); }

/* ---------- render: flavors + summary ---------- */
function renderFlavors(){
  const box=$id('flavors'); if(!box) return;
  box.innerHTML=FLAVORS.map(f=>`<button class="fl ${flavor===f.name?'active':''}" data-f="${esc(f.name)}"><span class="sw" style="background:${esc(f.color)}"></span>${esc(f.name)}</button>`).join('');
  box.querySelectorAll('.fl').forEach(b=>b.addEventListener('click',()=>{ flavor=b.dataset.f; renderFlavors(); renderSummary(); }));
}
function renderSummary(){
  const list=$id('blendList');
  if(list){ list.innerHTML=selected.map(s=>`<li class="bl-item"><span><span class="nm">${esc(s.name)}</span><span class="ds">${fmtDose(s.dosage)}</span></span><button class="rm" data-name="${esc(s.name)}" title="Remove">×</button></li>`).join('');
    list.querySelectorAll('.rm').forEach(b=>b.addEventListener('click',()=>removeFromBlend(b.dataset.name))); }
  const n=selected.length, pct=Math.min(100,(n/3)*100);
  const bar=$id('progBar'); if(bar) bar.style.width=pct+'%';
  const note=$id('progNote'); if(note){ if(n>=3){ note.textContent=`✓ ${n} ingredients — ready when you are`; note.classList.add('ready'); } else { note.textContent=`Add at least 3 ingredients to continue (${n}/3)`; note.classList.remove('ready'); } }
  const ss=$id('servingSize'); if(ss) ss.textContent=fmtDose(servingSize());
  const cal=$id('calories'); if(cal) cal.textContent=calcCalories();
  const price = n ? calcPrice(pricedItems()) + flavorPrice() : 0;
  const sub=$id('subtotal'); if(sub) sub.textContent=`$${price.toFixed(2)}`;
  const per=$id('perServ'); if(per) per.textContent = n ? `$${(price/SERVINGS).toFixed(2)} / serving` : '—';
  renderTaste();
  const ok=n>=3 && !!flavor, btn=$id('addCart');
  if(btn){ btn.disabled=!ok; btn.textContent = ok ? `Add to Cart · $${price.toFixed(2)}` : (n<3?'Add 3+ ingredients':'Choose a flavor'); }
  const fc=$id('fabCount'); if(fc){ fc.style.display=n?'inline-flex':'none'; fc.textContent=n; }
  const dc=$id('doneCatalog'); if(dc) dc.textContent = n?`Done · ${n} in blend`:'Done';
}
function renderTaste(){
  const box=$id('taste'); if(!box) return;
  if(!selected.length){ box.style.display='none'; return; } box.style.display='block';
  const colors={Sweet:'#f6a623',Sour:'#7bc043',Salty:'#4aa3df',Bitter:'#9b59b6',Earthy:'#8d6e4f'};
  const keys={Sweet:'sweet',Sour:'sour',Salty:'salty',Bitter:'bitter',Earthy:'earthy'};
  const tot={}; Object.values(keys).forEach(k=>tot[k]=0);
  selected.forEach(s=>{ const ing=byName[s.name]; if(!ing) return; const w=ing.potency||1; Object.values(keys).forEach(k=>tot[k]+=Math.max(0,ing[k])*w); });
  const f=FLAVORS.find(x=>x.name===flavor); if(f){ Object.values(keys).forEach(k=>tot[k]+=Math.max(0,f[k]||0)); }
  const maxv=Math.max(1,...Object.values(tot));
  $id('tasteBars').innerHTML=Object.keys(colors).map(label=>{ const v=tot[keys[label]], pct=Math.round((v/maxv)*100); return `<div class="t-row"><span class="tl">${label}</span><div class="t-bar"><span style="width:${pct}%;background:${colors[label]}"></span></div></div>`; }).join('');
}

/* ---------- cart (same Foxy URL the old builder produced) ---------- */
function addToCart(){
  if(selected.length<3 || !flavor){ toast(selected.length<3?'Add at least 3 ingredients':'Choose a flavor'); return; }
  const price=(calcPrice(pricedItems())+flavorPrice()).toFixed(2);
  let url=`https://tailorfit.foxycart.com/cart?cart=add&name=${encodeURIComponent('Custom')}&price=${price}&quantity=1&item_category=${encodeURIComponent('Default for all products')}`;
  selected.forEach((s,i)=>{ url+=`&Ingredient${i+1}=${encodeURIComponent(`${s.name} - ${fmtDose(s.dosage)}`)}`; });
  url+=`&Flavor=${encodeURIComponent(flavor)}`;
  window.location.href=url;
}

/* ---------- toast + drawer ---------- */
function toast(msg){ const wrap=$id('toasts'); if(!wrap) return; const t=document.createElement('div'); t.className='toast'; t.innerHTML=`<span class="ic">✓</span>${esc(msg)}`; wrap.appendChild(t); setTimeout(()=>t.remove(),2800); }
function openDrawer(){ $id('catalogPanel')?.classList.add('open'); document.body.classList.add('tf-drawer-open'); }
function closeDrawer(){ $id('catalogPanel')?.classList.remove('open'); document.body.classList.remove('tf-drawer-open'); }

/* ---------- init ---------- */
document.addEventListener('DOMContentLoaded', function(){
  if(!$id('tf-builder')) return;                       // not on the builder page
  INGREDIENTS=readIngredients(); FLAVORS=readFlavors(); PRESETS=readPresets();
  byName=Object.fromEntries(INGREDIENTS.map(i=>[i.name,i]));
  const s=$id('search'); if(s) s.placeholder=`Search ${INGREDIENTS.length} ingredients — caffeine, creatine, magnesium…`;
  renderPresets(); renderFlavors(); renderCatalog(); renderSummary();

  $id('search')?.addEventListener('input', e=>{ search=e.target.value.toLowerCase().trim(); renderCatalog(); });
  document.querySelectorAll('#chips .chip').forEach(c=>c.addEventListener('click',()=>{ document.querySelectorAll('#chips .chip').forEach(x=>x.classList.remove('active')); c.classList.add('active'); activeFilter=c.dataset.f; renderCatalog(); }));
  $id('addCart')?.addEventListener('click', addToCart);
  $id('openCatalog')?.addEventListener('click', openDrawer);
  $id('closeCatalog')?.addEventListener('click', closeDrawer);
  $id('doneCatalog')?.addEventListener('click', closeDrawer);
  window.addEventListener('resize',()=>{ if(window.innerWidth>900) closeDrawer(); });

  /* Save as preset → existing 3-slot Foxy modal */
  const modal=()=>$id('fs-modal-2-popup');
  $id('savePreset')?.addEventListener('click',()=>{ if(!selected.length){ toast('Add ingredients first'); return; } loadPresets().then(populatePresetInputs); const m=modal(); if(m) m.style.display='flex'; });
  $id('save-preset')?.addEventListener('click',()=>{
    let slot=null,name=''; const i1=$id('preset-1'),i2=$id('preset-2'),i3=$id('preset-3');
    if(i1&&i1.value.trim()){slot=1;name=i1.value.trim();} else if(i2&&i2.value.trim()){slot=2;name=i2.value.trim();} else if(i3&&i3.value.trim()){slot=3;name=i3.value.trim();}
    if(!slot){ alert('Please enter a name for your preset in one of the fields.'); return; }
    if(!selected.length){ alert('Please add ingredients before saving a preset.'); return; }
    const data={ name, ingredients:selected.map(s=>({name:s.name,dosage:s.dosage,costPerGram:(byName[s.name]||{}).cost||0})), flavor, createdDate:new Date().toISOString() };
    savePreset(slot,data).then(ok=>{ if(ok){ alert(`Preset "${name}" saved!`); const m=modal(); if(m) m.style.display='none'; syncPresetUIWithLogin(); } else alert('Error saving preset. Please try again.'); });
  });
  $id('close-preset-modal')?.addEventListener('click',()=>{ const m=modal(); if(m) m.style.display='none'; });

  /* saved blends + re-sync when the login modal closes */
  syncPresetUIWithLogin();
  const lm=$id('login-modal')||document.querySelector('[fs-modal-element="modal-2"]');
if(lm){ let t; new MutationObserver(()=>{ clearTimeout(t); t=setTimeout(syncPresetUIWithLogin,600); }).observe(lm,{attributes:true,attributeFilter:['style','class']}); }
  /* deep link ?slug= */
  const slug=getQueryParam('slug'); if(slug){ const p=PRESETS.find(x=>x.slug===slug); if(p) setTimeout(()=>applyPreset(p),400); }
});
