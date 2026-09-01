const AZDO_API_VERSION = '7.1';
const API_VERSION = AZDO_API_VERSION;
const AZDO_STABLE_API_VERSION = AZDO_API_VERSION;
const AZDO_API_MAX_RETRIES = 3;
const AZDO_API_DEFAULT_TIMEOUT_MS = 30000;
const AZDO_API_MAX_PAGES = 200;
const AZDO_API_MAX_CONCURRENCY = 6;

class AzureDevOpsApiError extends Error {
constructor(message, status = 0, details = {}) {
super(message);
this.name = 'AzureDevOpsApiError';
this.status = status;
this.statusText = details.statusText || '';
this.code = details.code || null;
this.activityId = details.activityId || null;
this.requestId = details.requestId || null;
this.rawMessage = details.rawMessage || '';
this.retryable = details.retryable === true;
this.cancelled = details.cancelled === true;
this.url = details.url || '';
this.attempts = details.attempts || 1;
}
}

function escapeHtml(value) {
return String(value ?? '').replace(/[&<>'"`]/g, ch => ({
'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;','`':'&#96;'
}[ch]));
}

function sanitizeHtml(html, contextElement = null) {
if (html == null) return '';
const source = String(html);
let root = null;
let host = null;
const tag = contextElement?.tagName?.toLowerCase() || '';
if (['tbody', 'thead', 'tfoot'].includes(tag)) {
  host = document.createElement('table');
  root = document.createElement(tag);
  host.appendChild(root);
  root.innerHTML = source;
} else if (tag === 'tr') {
  host = document.createElement('table');
  const tbody = document.createElement('tbody');
  root = document.createElement('tr');
  tbody.appendChild(root);
  host.appendChild(tbody);
  root.innerHTML = source;
} else if (['td', 'th'].includes(tag)) {
  host = document.createElement('table');
  const tbody = document.createElement('tbody');
  const tr = document.createElement('tr');
  root = document.createElement(tag);
  tr.appendChild(root);
  tbody.appendChild(tr);
  host.appendChild(tbody);
  root.innerHTML = source;
} else if (tag === 'select') {
  root = document.createElement('select');
  root.innerHTML = source;
  host = root;
} else if (tag === 'datalist') {
  root = document.createElement('datalist');
  root.innerHTML = source;
  host = root;
} else {
  const template = document.createElement('template');
  template.innerHTML = source;
  root = template.content;
  host = template;
}
const blockedTags = ['script','iframe','object','embed','applet','base','meta','link','style','form'];
blockedTags.forEach(tagName => root.querySelectorAll(tagName).forEach(node => node.remove()));
root.querySelectorAll('*').forEach(node => {
  Array.from(node.attributes).forEach(attr => {
    const name = attr.name.toLowerCase();
    const value = String(attr.value || '').trim();
    if (name.startsWith('on')) {
      node.removeAttribute(attr.name);
      return;
    }
    if (['href','src','action','formaction','xlink:href'].includes(name)) {
      if (/^(javascript|vbscript):/i.test(value) ||
          (value.toLowerCase().startsWith('data:') && !value.toLowerCase().startsWith('data:image/'))) {
        node.removeAttribute(attr.name);
      }
    }
  });
});
return host && typeof host.innerHTML === 'string' ? host.innerHTML : root.innerHTML;
}
function setSafeInnerHTML(element, html) {
if (!element) return;
element.innerHTML = sanitizeHtml(html, element);
}
function insertSafeAdjacentHTML(element, position, html) {
if (!element) return;
element.insertAdjacentHTML(position, sanitizeHtml(html, element));
}
function createBasicAuthHeader(pat) {
const token = String(pat || '').trim();
if (!token) throw new Error('Personal Access Token (PAT) is required.');
return 'Basic ' + btoa(':' + token);
}

let azdoActiveAbortController = null;
let azdoOperationSequence = 0;
let azdoApiRunState = null;
let azdoApiRunActive = false;
let azdoRequestQueue = [];
let azdoActiveRequests = 0;

function beginAzDoOperation() {
if (azdoActiveAbortController) azdoActiveAbortController.abort();
azdoActiveAbortController = new AbortController();
azdoOperationSequence += 1;
azdoApiRunActive = true;
azdoApiRunState = {
  id: azdoOperationSequence,
  startedAt: Date.now(),
  requests: 0,
  succeeded: 0,
  failures: [],
  retries: 0,
  pages: 0,
  truncated: false,
  cancelled: false
};
return azdoActiveAbortController;
}
function getAzDoAbortSignal() {
return azdoActiveAbortController?.signal || null;
}
function isAzDoCancellation(error) {
return !!(error?.cancelled || error?.name === 'AbortError' || /cancelled|canceled/i.test(String(error?.message || '')));
}
function cancelAzDoOperation() {
if (!azdoActiveAbortController) return false;
azdoApiRunState && (azdoApiRunState.cancelled = true);
azdoActiveAbortController.abort();
if (typeof setStatus === 'function') setStatus('The current Azure DevOps operation was cancelled.', 'info');
return true;
}
function getAzDoApiRunState() {
return azdoApiRunState ? {
  ...azdoApiRunState,
  failures: [...azdoApiRunState.failures]
} : null;
}
function getAzDoPartialResultMessage() {
const state = azdoApiRunState;
if (!state) return '';
const parts = [];
if (state.failures.length) parts.push(`${state.failures.length} API request${state.failures.length === 1 ? '' : 's'} failed`);
if (state.truncated) parts.push('pagination stopped at the configured safety limit');
if (state.cancelled) parts.push('operation cancelled');
if (!parts.length) return '';
return ` Partial result: ${parts.join('; ')}.`;
}
function recordAzDoFailure(error, url) {
if (!azdoApiRunActive || !azdoApiRunState) return;
azdoApiRunState.failures.push({
  status: Number(error?.status || 0),
  message: String(error?.rawMessage || error?.message || 'Unknown error'),
  url: String(url || error?.url || '')
});
}
function sleep(ms, signal) {
return new Promise((resolve, reject) => {
  if (signal?.aborted) {
    reject(new AzureDevOpsApiError('Azure DevOps request cancelled.', 0, { cancelled: true }));
    return;
  }
  const timer = setTimeout(resolve, ms);
  const onAbort = () => {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
    reject(new AzureDevOpsApiError('Azure DevOps request cancelled.', 0, { cancelled: true }));
  };
  signal?.addEventListener('abort', onAbort, { once: true });
});
}
function getRetryDelayMs(response, attempt) {
const retryAfter = response?.headers?.get('Retry-After');
if (retryAfter) {
  const seconds = Number(retryAfter);
  if (Number.isFinite(seconds)) return Math.min(Math.max(seconds * 1000, 250), 30000);
  const dateMs = Date.parse(retryAfter) - Date.now();
  if (Number.isFinite(dateMs)) return Math.min(Math.max(dateMs, 250), 30000);
}
const retryAfterMs = response?.headers?.get('x-ms-retry-after-ms');
if (retryAfterMs && Number.isFinite(Number(retryAfterMs))) {
  return Math.min(Math.max(Number(retryAfterMs), 250), 30000);
}
const base = Math.min(8000, 1000 * (2 ** Math.max(0, attempt - 1)));
return base + Math.floor(Math.random() * 250);
}
function isRetryableStatus(status) {
return status === 408 || status === 425 || status === 429 || status === 500 || status === 502 || status === 503 || status === 504;
}
async function acquireAzDoRequestSlot(signal) {
if (signal?.aborted) throw new AzureDevOpsApiError('Azure DevOps request cancelled.', 0, { cancelled: true });
if (azdoActiveRequests < AZDO_API_MAX_CONCURRENCY) {
  azdoActiveRequests += 1;
  return;
}
await new Promise((resolve, reject) => {
  const entry = { resolve, reject, signal };
  azdoRequestQueue.push(entry);
  const onAbort = () => {
    const idx = azdoRequestQueue.indexOf(entry);
    if (idx >= 0) azdoRequestQueue.splice(idx, 1);
    reject(new AzureDevOpsApiError('Azure DevOps request cancelled.', 0, { cancelled: true }));
  };
  signal?.addEventListener('abort', onAbort, { once: true });
  entry.cleanup = () => signal?.removeEventListener('abort', onAbort);
});
azdoActiveRequests += 1;
}
function releaseAzDoRequestSlot() {
azdoActiveRequests = Math.max(0, azdoActiveRequests - 1);
while (azdoRequestQueue.length && azdoActiveRequests < AZDO_API_MAX_CONCURRENCY) {
  const entry = azdoRequestQueue.shift();
  if (!entry) break;
  entry.cleanup?.();
  if (entry.signal?.aborted) {
    entry.reject(new AzureDevOpsApiError('Azure DevOps request cancelled.', 0, { cancelled: true }));
    continue;
  }
  entry.resolve();
  break;
}
}
function getContinuationTokenFromResponse(response, payload) {
return response?.headers?.get('x-ms-continuationtoken') ||
       response?.headers?.get('X-MS-ContinuationToken') ||
       response?.headers?.get('x-ms-continuation-token') ||
       payload?.continuationToken ||
       payload?.continuationtoken ||
       payload?.nextContinuationToken ||
       '';
}
function addContinuationToUrl(url, token, parameterName = 'continuationToken') {
const nextUrl = new URL(url, window.location.href);
nextUrl.searchParams.set(parameterName, token);
return nextUrl.toString();
}
function getArrayProperty(payload, property = 'value') {
if (!payload || typeof payload !== 'object') return [];
const value = payload[property];
return Array.isArray(value) ? value : [];
}

async function fetchAzDo(url, authHeader, options = {}) {
const {
  retry = true,
  maxRetries = AZDO_API_MAX_RETRIES,
  timeoutMs = AZDO_API_DEFAULT_TIMEOUT_MS,
  signal: providedSignal = null,
  ...fetchOptions
} = options || {};
const signal = providedSignal || getAzDoAbortSignal();
let lastError = null;
const maxAttempts = retry ? Math.max(1, Number(maxRetries) + 1) : 1;
for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
  if (signal?.aborted) {
    const error = new AzureDevOpsApiError('Azure DevOps request cancelled.', 0, { cancelled: true, url, attempts: attempt });
    if (azdoApiRunActive && azdoApiRunState) azdoApiRunState.cancelled = true;
    throw error;
  }
  await acquireAzDoRequestSlot(signal);
  let timeoutId = null;
  let timedOut = false;
  const timeoutController = new AbortController();
  const abortFromCaller = () => timeoutController.abort();
  signal?.addEventListener('abort', abortFromCaller, { once: true });
  if (timeoutMs > 0) timeoutId = setTimeout(() => { timedOut = true; timeoutController.abort(); }, timeoutMs);
  try {
    if (azdoApiRunActive && azdoApiRunState) azdoApiRunState.requests += 1;
    let res;
    try {
      res = await fetch(url, {
        ...fetchOptions,
        signal: timeoutController.signal,
        headers: {
          'Authorization': authHeader,
          'Accept': 'application/json',
          'Content-Type': 'application/json',
          ...(fetchOptions.headers || {})
        }
      });
    } catch (networkError) {
      if (signal?.aborted) throw new AzureDevOpsApiError('Azure DevOps request cancelled.', 0, { cancelled: true, url, attempts: attempt });
      if (timedOut) {
        throw new AzureDevOpsApiError(`Azure DevOps request timed out after ${Math.round(timeoutMs / 1000)} seconds.`, 408, { retryable: true, retryDelayMs: getRetryDelayMs(null, attempt), url, attempts: attempt });
      }
      throw new AzureDevOpsApiError(`Unable to reach Azure DevOps. Check network connectivity and the request URL. ${networkError?.message || ''}`.trim(), 0, { rawMessage: networkError?.message || '', retryable: true, retryDelayMs: getRetryDelayMs(null, attempt), url, attempts: attempt });
    }
    if (!res.ok) {
      let payload = null;
      try { payload = await res.json(); } catch (_) {}
      const headers = res.headers;
      const activityId = headers.get('ActivityId') || headers.get('X-VSS-ActivityId') || null;
      const requestId = headers.get('X-VSS-E2EID') || headers.get('X-MSEdge-Ref') || null;
      const apiMessage = payload?.message || payload?.error?.message || payload?.error_description || '';
      let message;
      switch (res.status) {
        case 400: message = `Bad request sent to Azure DevOps${apiMessage ? `: ${apiMessage}` : '.'}`; break;
        case 401:
        case 203: message = 'Authentication failed: Invalid PAT or missing required PAT scopes.'; break;
        case 403: message = `Access denied: Your PAT/user does not have permission to access this Azure DevOps resource${apiMessage ? ` (${apiMessage})` : '.'}`; break;
        case 404: message = `Resource not found: Verify your Organization, Project, Repository, or resource name${apiMessage ? ` (${apiMessage})` : '.'}`; break;
        case 409: message = `Azure DevOps reported a conflict${apiMessage ? `: ${apiMessage}` : '.'}`; break;
        case 408: message = `Azure DevOps request timed out${apiMessage ? `: ${apiMessage}` : '.'}`; break;
        case 429: message = `Azure DevOps rate limit reached (HTTP 429). Retrying automatically when possible${apiMessage ? `: ${apiMessage}` : '.'}`; break;
        default: message = res.status >= 500
          ? `Azure DevOps server error (${res.status}). Retrying automatically when possible${apiMessage ? `: ${apiMessage}` : '.'}`
          : `Azure DevOps API error ${res.status}${res.statusText ? ` (${res.statusText})` : ''}${apiMessage ? `: ${apiMessage}` : '.'}`;
      }
      const context = [activityId ? `ActivityId: ${activityId}` : '', requestId ? `RequestId: ${requestId}` : ''].filter(Boolean).join(' | ');
      if (context) message += ` ${context}`;
      throw new AzureDevOpsApiError(message, res.status, {
        statusText: res.statusText, activityId, requestId, rawMessage: apiMessage,
        retryable: isRetryableStatus(res.status), retryDelayMs: getRetryDelayMs(res, attempt), url, attempts: attempt
      });
    }
    const text = await res.text();
    let data = {};
    if (text) {
      try { data = JSON.parse(text); }
      catch (_) { data = { value: [], rawText: text }; }
    }
    const continuationToken = getContinuationTokenFromResponse(res, data);
    try {
      Object.defineProperty(data, '__azdoContinuationToken', { value: continuationToken || '', enumerable: false, configurable: true });
      Object.defineProperty(data, '__azdoStatus', { value: res.status, enumerable: false, configurable: true });
    } catch (_) {}
    if (azdoApiRunActive && azdoApiRunState) azdoApiRunState.succeeded += 1;
    return data;
  } catch (error) {
    lastError = error;
    if (isAzDoCancellation(error)) {
      if (azdoApiRunActive && azdoApiRunState) azdoApiRunState.cancelled = true;
      throw error;
    }
    const canRetry = retry && attempt < maxAttempts && (error?.retryable === true || isRetryableStatus(error?.status));
    if (!canRetry) {
      recordAzDoFailure(error, url);
      throw error;
    }
    if (azdoApiRunActive && azdoApiRunState) azdoApiRunState.retries += 1;
    await sleep(error?.retryDelayMs || getRetryDelayMs(null, attempt), signal);
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
    signal?.removeEventListener('abort', abortFromCaller);
    releaseAzDoRequestSlot();
  }
}
throw lastError || new AzureDevOpsApiError('Azure DevOps request failed.', 0, { url });
}

async function fetchAzDoPaged(url, authHeader, options = {}) {
const {
  itemProperty = 'value',
  continuationParameter = 'continuationToken',
  maxPages = AZDO_API_MAX_PAGES,
  pageSize = null,
  maxItems = null,
  ...requestOptions
} = options || {};
let currentUrl = url;
let continuation = '';
let pageCount = 0;
const items = [];
let lastResponse = {};
const seenTokens = new Set();
do {
  if (pageCount >= maxPages) {
    if (azdoApiRunActive && azdoApiRunState) azdoApiRunState.truncated = true;
    break;
  }
  pageCount += 1;
  const data = await fetchAzDo(currentUrl, authHeader, requestOptions);
  lastResponse = data || {};
  const pageItems = getArrayProperty(data, itemProperty);
  if (maxItems !== null && maxItems !== undefined && Number.isFinite(Number(maxItems)) && Number(maxItems) >= 0) {
    items.push(...pageItems.slice(0, Math.max(0, Number(maxItems) - items.length)));
  } else {
    items.push(...pageItems);
  }
  if (azdoApiRunActive && azdoApiRunState) azdoApiRunState.pages += 1;
  continuation = data?.__azdoContinuationToken || getContinuationTokenFromResponse(null, data);
  // fetchAzDo returns the payload for backward compatibility. Azure DevOps commonly
  // places continuation tokens in headers, so also allow callers to supply a token
  // extractor when the API uses a non-standard response shape.
  if (!continuation && typeof options.getContinuationToken === 'function') {
    continuation = options.getContinuationToken(data) || '';
  }
  if (!continuation || (maxItems !== null && maxItems !== undefined && Number.isFinite(Number(maxItems)) && items.length >= Number(maxItems))) break;
  if (seenTokens.has(continuation)) {
    if (azdoApiRunActive && azdoApiRunState) azdoApiRunState.truncated = true;
    break;
  }
  seenTokens.add(continuation);
  currentUrl = addContinuationToUrl(currentUrl.replace(new RegExp(`([?&])${continuationParameter}=[^&]*`, 'i'), '$1').replace(/[?&]$/, ''), continuation, continuationParameter);
  if (pageSize) {
    const parsed = new URL(currentUrl, window.location.href);
    parsed.searchParams.set('$top', String(pageSize));
    currentUrl = parsed.toString();
  }
} while (continuation);
return { ...lastResponse, [itemProperty]: items, items: itemProperty === 'items' ? items : lastResponse.items, _pagination: { pages: pageCount, itemCount: items.length, complete: !azdoApiRunState?.truncated } };
}
function normalizeIdentityText(value) {
  return String(value ?? '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .replace(/[^a-z0-9@._' -]+/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
function getIdentityCandidates(identity = {}) {
  const values = [
    identity.displayName,
    identity.name,
    identity.mailAddress,
    identity.email,
    identity.uniqueName,
    identity.principalName,
    identity.accountName,
    identity.descriptor
  ].filter(Boolean).map(normalizeIdentityText).filter(Boolean);
  const expanded = new Set(values);
  values.forEach(v => {
    if (v.includes('@')) expanded.add(v.split('@')[0]);
    if (v.includes('\\')) expanded.add(v.split('\\').pop());
    if (v.includes('.')) expanded.add(v.replace(/[._-]+/g, ' '));
  });
  return [...expanded];
}
function identityMatchesQuery(query, identity = {}) {
  const q = normalizeIdentityText(query);
  if (!q) return true;
  const qTokens = q.split(/[\s._-]+/).filter(Boolean);
  const candidates = getIdentityCandidates(identity);
  if (candidates.some(c => c === q || c.includes(q))) return true;
  if (q.includes('@')) {
    const prefix = q.split('@')[0];
    if (candidates.some(c => c === prefix || c.includes(prefix))) return true;
  }
  return qTokens.length > 1 && candidates.some(c => qTokens.every(token => c.includes(token)));
}
function buildIdentitySearchVariants(query) {
  const q = String(query || '').trim();
  const n = normalizeIdentityText(q);
  if (!n) return [];
  const variants = new Set([q, n]);
  if (n.includes('@')) {
    variants.add(n.split('@')[0]);
  }
  const tokens = n.split(/[\s._-]+/).filter(t => t.length >= 2);
  if (tokens.length) {
    variants.add(tokens.join(' '));
    variants.add(tokens.join('.'));
  }
  return [...variants];
}
window.normalizeIdentityText = normalizeIdentityText;
window.getIdentityCandidates = getIdentityCandidates;
window.identityMatchesQuery = identityMatchesQuery;
window.buildIdentitySearchVariants = buildIdentitySearchVariants;
window.fetchAzDoPaged = fetchAzDoPaged;
window.beginAzDoOperation = beginAzDoOperation;
window.cancelAzDoOperation = cancelAzDoOperation;
window.getAzDoApiRunState = getAzDoApiRunState;
window.getAzDoPartialResultMessage = getAzDoPartialResultMessage;
