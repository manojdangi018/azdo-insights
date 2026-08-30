const API_VERSION = "7.1-preview.1";

async function fetchAzDo(url, authHeader, options = {}) {
  const res = await fetch(url, { 
    ...options,
    headers: { 
      'Authorization': authHeader, 
      'Accept': 'application/json',
      'Content-Type': 'application/json',
      ...(options.headers || {})
    } 
  });
  if (!res.ok) {
    if (res.status === 401 || res.status === 203) throw new Error('Authentication failed: Invalid PAT or missing scopes.');
    if (res.status === 404) throw new Error('Resource not found: Verify your Organization & Project names.');
    throw new Error(`Azure DevOps API Error: ${res.statusText}`);
  }
  return await res.json();
}
