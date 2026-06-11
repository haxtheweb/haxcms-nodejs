const { HAXCMS } = require('../../lib/HAXCMS.js');
const { readEffectiveApiKeys } = require('../../lib/apiKeys.js');

const RESERVED_QUERY_PARAMS = [
  'provider',
  'appstore_token',
  'site_token',
  'siteName',
  'jwt',
  'token',
  '__HAXJWT__',
];

const BLOCKED_AUTH_PARAMS = [
  'key',
  'access_token',
  'api_key',
  'client_id',
];

const PROVIDER_DEFINITIONS = {
  youtube: {
    method: 'GET',
    protocol: 'https',
    host: 'www.googleapis.com/youtube/v3',
    endPoint: 'search',
    apiKeyProvider: 'youtube',
    apiKeyParam: 'key',
  },
  vimeo: {
    method: 'GET',
    protocol: 'https',
    host: 'api.vimeo.com',
    endPoint: 'videos',
    apiKeyProvider: 'vimeo',
    apiKeyParam: 'access_token',
  },
  giphy: {
    method: 'GET',
    protocol: 'https',
    host: 'api.giphy.com',
    endPoint: 'v1/gifs/search',
    apiKeyProvider: 'giphy',
    apiKeyParam: 'api_key',
  },
  unsplash: {
    method: 'GET',
    protocol: 'https',
    host: 'api.unsplash.com',
    endPoint: 'search/photos',
    apiKeyProvider: 'unsplash',
    apiKeyParam: 'client_id',
  },
  flickr: {
    method: 'GET',
    protocol: 'https',
    host: 'api.flickr.com',
    endPoint: 'services/rest',
    apiKeyProvider: 'flickr',
    apiKeyParam: 'api_key',
  },
  nasa: {
    method: 'GET',
    protocol: 'https',
    host: 'images-api.nasa.gov',
    endPoint: 'search',
  },
  sketchfab: {
    method: 'GET',
    protocol: 'https',
    host: 'api.sketchfab.com',
    endPoint: 'v3/search',
  },
  dailymotion: {
    method: 'GET',
    protocol: 'https',
    host: 'api.dailymotion.com',
    endPoint: 'videos',
  },
  wikipedia: {
    method: 'GET',
    protocol: 'https',
    host: 'en.wikipedia.org',
    endPoint: 'w/api.php',
  },
  ccmixter: {
    method: 'GET',
    protocol: 'https',
    host: 'ccmixter.org',
    endPoint: 'api/query',
  },
};

function mergeRequestParams(req) {
  const merged = {};
  if (req && req.query && typeof req.query === 'object') {
    Object.assign(merged, req.query);
  }
  if (
    req &&
    req.body &&
    typeof req.body === 'object' &&
    !Array.isArray(req.body)
  ) {
    Object.assign(merged, req.body);
  }
  return merged;
}

function appendSearchParam(params, key, value) {
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      appendSearchParam(params, key, value[i]);
    }
    return;
  }
  if (value === null || typeof value === 'undefined') {
    return;
  }
  if (typeof value === 'object') {
    return;
  }
  params.append(key, `${value}`);
}

function buildForwardedSearchParams(source = {}) {
  const searchParams = new URLSearchParams();
  const keys = Object.keys(source);
  for (let i = 0; i < keys.length; i++) {
    const key = keys[i];
    if (RESERVED_QUERY_PARAMS.indexOf(key) !== -1) {
      continue;
    }
    if (BLOCKED_AUTH_PARAMS.indexOf(key) !== -1) {
      continue;
    }
    appendSearchParam(searchParams, key, source[key]);
  }
  return searchParams;
}

function getProviderFromRequest(req) {
  const provider =
    req &&
    req.params &&
    Object.prototype.hasOwnProperty.call(req.params, 'provider')
      ? String(req.params.provider || '').trim().toLowerCase()
      : '';
  return provider;
}

async function appStoreProviderSearch(req, res) {
  const requestParams = mergeRequestParams(req);
  const provider = getProviderFromRequest(req);
  if (
    !provider ||
    !Object.prototype.hasOwnProperty.call(PROVIDER_DEFINITIONS, provider)
  ) {
    return res.status(400).json({
      status: 400,
      message: 'Unsupported app store provider',
    });
  }

  const providerConfig = PROVIDER_DEFINITIONS[provider];
  const providerMethod = providerConfig.method
    ? `${providerConfig.method}`.toUpperCase()
    : 'GET';
  const forwardedSearchParams = buildForwardedSearchParams(requestParams);
  if (providerConfig.apiKeyProvider && providerConfig.apiKeyParam) {
    const effectiveApiKeys = await readEffectiveApiKeys(HAXCMS);
    const apiKeyValue = effectiveApiKeys[providerConfig.apiKeyProvider]
      ? `${effectiveApiKeys[providerConfig.apiKeyProvider]}`.trim()
      : '';
    if (!apiKeyValue) {
      return res.status(400).json({
        status: 400,
        message: `Missing API key for ${provider}`,
      });
    }
    forwardedSearchParams.set(providerConfig.apiKeyParam, apiKeyValue);
  }

  let requestUrl = `${providerConfig.protocol}://${providerConfig.host}/${providerConfig.endPoint}`;
  const requestOptions = {
    method: providerMethod,
    headers: {
      Accept: 'application/json',
    },
  };
  const queryString = forwardedSearchParams.toString();
  if (providerMethod === 'POST') {
    requestOptions.headers['Content-Type'] = 'application/x-www-form-urlencoded;charset=UTF-8';
    requestOptions.body = queryString;
  }
  else if (queryString !== '') {
    requestUrl += `?${queryString}`;
  }

  let upstreamResponse = null;
  try {
    upstreamResponse = await fetch(requestUrl, requestOptions);
  }
  catch (e) {
    return res.status(502).json({
      status: 502,
      message: 'Unable to reach upstream provider',
    });
  }

  let upstreamText = '';
  try {
    upstreamText = await upstreamResponse.text();
  }
  catch (e) {
    upstreamText = '';
  }

  let upstreamJson = null;
  if (upstreamText && upstreamText.trim() !== '') {
    try {
      upstreamJson = JSON.parse(upstreamText);
    }
    catch (e) {
      upstreamJson = null;
    }
  }

  if (!upstreamResponse.ok) {
    let message = `Upstream provider request failed (${upstreamResponse.status})`;
    if (
      upstreamJson &&
      typeof upstreamJson === 'object' &&
      upstreamJson.message &&
      typeof upstreamJson.message === 'string'
    ) {
      message = upstreamJson.message;
    }
    else if (
      upstreamJson &&
      typeof upstreamJson === 'object' &&
      upstreamJson.error &&
      typeof upstreamJson.error === 'object' &&
      upstreamJson.error.message &&
      typeof upstreamJson.error.message === 'string'
    ) {
      message = upstreamJson.error.message;
    }
    return res.status(upstreamResponse.status).json({
      status: upstreamResponse.status,
      message: message,
    });
  }

  if (upstreamJson === null) {
    return res.status(502).json({
      status: 502,
      message: 'Upstream provider response was not valid JSON',
    });
  }

  return res.status(upstreamResponse.status).json(upstreamJson);
}

module.exports = {
  appStoreProviderSearch,
};
