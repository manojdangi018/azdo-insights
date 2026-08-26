const API_VERSION = '7.1';
const GRAPH_API_VERSION = '7.1-preview.1';

function extractOrgName(input) {
  let cleaned = String(input || '').trim().replace(/^https?:\/\//i, '');
  cleaned = cleaned.replace(/^dev\.azure\.com\//i, '').replace(/\/+$/, '');
  return cleaned.split('/')[0] || '';
}

function buildAuthHeader(pat) {
  return 'Basic ' + btoa(':' + String(pat || ''));
}

function encodePath(value) {
  return encodeURIComponent(String(value || '')).replace(/%2F/gi, '/');
}

async function fetchAzDo(url, authHeader, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeout || 45000);
  const headers = {
    Authorization: authHeader,
    Accept: 'application/json',
    'Content-Type': 'application/json',
    ...(options.headers || {})
  };

  try {
    const { timeout: _timeout, ...fetchOptions } = options;
    const res = await fetch(url, { ...fetchOptions, headers, signal: controller.signal });
    const bodyText = await res.text();
    let body = null;
    try { body = bodyText ? JSON.parse(bodyText) : null; } catch (_) { body = null; }

    if (!res.ok) {
      const apiMessage = body?.message || body?.error?.message;
      if (res.status === 401 || res.status === 203) throw new Error('Authentication failed. Check the PAT and its Azure DevOps scopes.');
      if (res.status === 403) throw new Error('Access denied. The PAT does not have permission for this Azure DevOps resource.');
      if (res.status === 404) throw new Error('Resource not found. Verify the organization, project, or requested item.');
      if (res.status === 429) throw new Error('Azure DevOps rate limit reached. Please wait a moment and retry.');
      throw new Error(apiMessage || `Azure DevOps API error (${res.status}).`);
    }

    return body || {};
  } catch (err) {
    if (err?.name === 'AbortError') throw new Error('Azure DevOps request timed out. Please retry.');
    if (err instanceof TypeError) throw new Error('Unable to reach Azure DevOps. Check network access and CORS policy.');
    throw err;
  } finally {
    clearTimeout(timeout);
  }
}

function normalizeDisplayName(identity) {
  if (!identity) return 'Unknown';
  if (typeof identity === 'string') return identity;
  return identity.displayName || identity.name || identity.uniqueName || identity.mail || identity.email || 'Unknown';
}

function statusClass(value) {
  const v = String(value || '').toLowerCase();
  if (['completed', 'succeeded', 'success', 'closed', 'done', 'resolved'].includes(v)) return 'success';
  if (['active', 'in progress', 'running', 'queued', 'new'].includes(v)) return 'info';
  if (['failed', 'failure', 'error', 'canceled', 'cancelled'].includes(v)) return 'error';
  if (['stale', 'warning'].includes(v)) return 'warning';
  return 'neutral';
}
