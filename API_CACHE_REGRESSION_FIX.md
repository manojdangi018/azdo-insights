# API Cache Fix

Fixed a regression in the cache-enabled central API client.

The cache implementation now explicitly initializes `useCache`, `cacheKey`, and `cacheTtlMs` before the request loop. Cache is enabled only for GET requests and can be disabled with `cache: false` or `cacheMode: no-store`. Cache hits return before network fetch and update the operation cache-hit counter.

The previous build referenced `useCache`, `cacheKey`, and `cacheTtlMs` without defining `useCache`/`cacheKey` in the request scope, causing successful API calls to throw a JavaScript ReferenceError before returning data. This prevented Azure DevOps connection/project loading.
