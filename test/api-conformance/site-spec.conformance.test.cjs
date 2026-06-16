'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs-extra')
const path = require('path')
const os = require('os')
const vm = require('node:vm')
const util = require('node:util')
const childProcess = require('node:child_process')
const YAML = require('yaml')
const axios = require('axios')
const Ajv = require('ajv')
const addFormats = require('ajv-formats')

const REPO_ROOT = path.resolve(__dirname, '..', '..')
const APP_ENTRY_PATH = path.join(REPO_ROOT, 'src', 'app.js')
const SITE_SPEC_PATH = path.join(REPO_ROOT, 'src', 'openapi', 'site-spec.yaml')
const SYSTEM_SPEC_PATH = path.join(REPO_ROOT, 'src', 'openapi', 'system-spec.yaml')
const SITE_DIRECTORY_NAME = '_sites'
const HTTP_METHODS = ['get', 'post', 'put', 'patch', 'delete', 'options', 'head']
const TEST_USER_NAME = process.env.HAXCMS_TEST_USERNAME || 'api-conformance-user'
const TEST_USER_PASSWORD =
  process.env.HAXCMS_TEST_PASSWORD || 'api-conformance-pass'
const TEST_GIT_AUTHOR_NAME = 'API Conformance Harness'
const TEST_GIT_AUTHOR_EMAIL = 'api-conformance@local.invalid'
const execFile = util.promisify(childProcess.execFile)

function captureEnvValue(key) {
  return {
    exists: Object.prototype.hasOwnProperty.call(process.env, key),
    value: process.env[key],
  }
}

function restoreEnvValue(key, snapshot) {
  if (!snapshot || snapshot.exists !== true) {
    delete process.env[key]
    return
  }
  process.env[key] = snapshot.value
}

function captureGlobalValue(key) {
  return {
    exists: Object.prototype.hasOwnProperty.call(globalThis, key),
    value: globalThis[key],
  }
}

function restoreGlobalValue(key, snapshot) {
  if (!snapshot || snapshot.exists !== true) {
    delete globalThis[key]
    return
  }
  globalThis[key] = snapshot.value
}

function parseJsonSafely(value) {
  try {
    return JSON.parse(String(value || ''))
  }
  catch (error) {
    return null
  }
}

function parseConnectionSettingsScript(scriptSource) {
  const sandbox = { window: {} }
  vm.runInNewContext(String(scriptSource || ''), sandbox, { timeout: 1000 })
  if (
    !sandbox.window ||
    !sandbox.window.appSettings ||
    typeof sandbox.window.appSettings !== 'object'
  ) {
    throw new Error(
      'Unable to parse appSettings from /system/api/connectionSettings response',
    )
  }
  return sandbox.window.appSettings
}

async function sendHttpRequest(requestConfig) {
  const response = await axios({
    method: requestConfig.method,
    url: requestConfig.url,
    headers: requestConfig.headers,
    data: requestConfig.body,
    validateStatus: () => true,
    responseType: 'text',
    transformResponse: [
      (data) => data,
    ],
  })
  let bodyText = ''
  if (typeof response.data === 'string') {
    bodyText = response.data
  }
  else if (typeof response.data === 'undefined' || response.data === null) {
    bodyText = ''
  }
  else {
    bodyText = JSON.stringify(response.data)
  }
  return {
    status: response.status,
    headers: response.headers || {},
    bodyText,
  }
}

async function loginForJwt(baseUrl) {
  const loginResponse = await sendHttpRequest({
    method: 'POST',
    url: `${baseUrl}/system/api/v1/session/login`,
    headers: {
      accept: 'application/json',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      username: TEST_USER_NAME,
      password: TEST_USER_PASSWORD,
    }),
  })
  assert.equal(
    loginResponse.status,
    200,
    `Expected login success but received ${loginResponse.status}: ${loginResponse.bodyText}`,
  )
  const loginBody = parseJsonSafely(loginResponse.bodyText)
  if (!loginBody) {
    assert.fail(`Unable to parse login JSON response: ${loginResponse.bodyText}`)
  }
  assert.ok(
    loginBody && typeof loginBody.jwt === 'string' && loginBody.jwt !== '',
    'Login response did not include jwt',
  )
  return loginBody.jwt
}

async function requestConnectionSettings(baseUrl, refererPath = '') {
  const headers = {
    accept: 'application/javascript',
  }
  if (refererPath && refererPath !== '') {
    headers.referer = `${baseUrl}${refererPath}`
  }
  const settingsResponse = await sendHttpRequest({
    method: 'GET',
    url: `${baseUrl}/system/api/v1/session/connection-settings`,
    headers,
  })
  assert.equal(
    settingsResponse.status,
    200,
    `Expected connectionSettings success but received ${settingsResponse.status}: ${settingsResponse.bodyText}`,
  )
  return parseConnectionSettingsScript(settingsResponse.bodyText)
}

async function createHarnessSite(baseUrl, jwt, dashboardSettings, siteName) {
  const createSitePath =
    dashboardSettings &&
    typeof dashboardSettings.createSite === 'string' &&
    dashboardSettings.createSite.trim() !== ''
      ? dashboardSettings.createSite
      : '/system/api/v1/sites'
  const createSiteHeaders =
    dashboardSettings &&
    dashboardSettings.createSiteHeaders &&
    typeof dashboardSettings.createSiteHeaders === 'object'
      ? dashboardSettings.createSiteHeaders
      : {}
  const requestHeaders = {
    accept: 'application/json',
    'content-type': 'application/json',
    Authorization: `Bearer ${jwt}`,
    ...createSiteHeaders,
  }
  const normalizedCreateSitePath = String(createSitePath || '').trim()
  const createSiteUrl = /^https?:\/\//i.test(normalizedCreateSitePath)
    ? normalizedCreateSitePath
    : `${baseUrl}${normalizedCreateSitePath.charAt(0) === '/' ? '' : '/'}${normalizedCreateSitePath}`
  if (
    (!requestHeaders || typeof requestHeaders !== 'object' || Object.keys(requestHeaders).length <= 2) &&
    dashboardSettings &&
    typeof dashboardSettings.userTokenHeader === 'string' &&
    dashboardSettings.userTokenHeader.trim() !== '' &&
    typeof dashboardSettings.userToken === 'string' &&
    dashboardSettings.userToken.trim() !== ''
  ) {
    requestHeaders[dashboardSettings.userTokenHeader] = dashboardSettings.userToken
  }
  const createSiteResponse = await sendHttpRequest({
    method: 'POST',
    url: createSiteUrl,
    headers: requestHeaders,
    body: JSON.stringify({
      jwt,
      token: dashboardSettings.token,
      site: {
        name: siteName,
        description: 'Runtime API conformance harness site',
      },
    }),
  })
  assert.equal(
    createSiteResponse.status,
    200,
    `Expected createSite success but received ${createSiteResponse.status}: ${createSiteResponse.bodyText}`,
  )
  const createSiteBody = parseJsonSafely(createSiteResponse.bodyText)
  assert.ok(
    createSiteBody &&
      createSiteBody.status === 200 &&
      createSiteBody.data &&
      createSiteBody.data.metadata &&
      createSiteBody.data.metadata.site &&
      createSiteBody.data.metadata.site.name === siteName,
    `createSite did not return expected site name "${siteName}"`,
  )
}

function getGitIdentityEnvironment(baseEnvironment) {
  const merged = { ...(baseEnvironment || process.env) }
  merged.GIT_AUTHOR_NAME = TEST_GIT_AUTHOR_NAME
  merged.GIT_AUTHOR_EMAIL = TEST_GIT_AUTHOR_EMAIL
  merged.GIT_COMMITTER_NAME = TEST_GIT_AUTHOR_NAME
  merged.GIT_COMMITTER_EMAIL = TEST_GIT_AUTHOR_EMAIL
  return merged
}

async function runGitCommand(cwd, args, options = {}) {
  const result = await execFile(
    'git',
    ['--no-pager'].concat(args || []),
    {
      cwd,
      env: getGitIdentityEnvironment(process.env),
      maxBuffer: 1024 * 1024 * 10,
    },
  )
  const stdout = typeof result.stdout === 'string' ? result.stdout : ''
  if (options && options.trim === false) {
    return stdout
  }
  return stdout.trim()
}

async function ensureSiteHasInitialCommit(runtimeRoot, siteName) {
  const siteDirectory = path.join(runtimeRoot, SITE_DIRECTORY_NAME, siteName)
  if (!fs.pathExistsSync(siteDirectory)) {
    return
  }
  try {
    await runGitCommand(siteDirectory, ['rev-parse', '--verify', 'HEAD'])
    return
  }
  catch (error) {}
  let isGitRepository = true
  try {
    const insideWorkTree = await runGitCommand(siteDirectory, [
      'rev-parse',
      '--is-inside-work-tree',
    ])
    if (insideWorkTree !== 'true') {
      isGitRepository = false
    }
  }
  catch (error) {
    isGitRepository = false
  }
  if (!isGitRepository) {
    await runGitCommand(siteDirectory, ['init'])
  }
  await runGitCommand(siteDirectory, ['add', '.'], { trim: false })
  await runGitCommand(siteDirectory, [
    'commit',
    '--no-gpg-sign',
    '--allow-empty',
    '-m',
    'Initialize API conformance runtime site',
  ])
}


function ensureSiteApiCatalog(runtimeRoot, siteName) {
  const siteDirectory = path.join(runtimeRoot, SITE_DIRECTORY_NAME, siteName)
  fs.ensureDirSync(siteDirectory)
  const sourceApiCatalogPath = path.join(
    REPO_ROOT,
    'src',
    'boilerplate',
    'site',
    '.well-known',
    'api-catalog',
  )
  const targetWellKnownDirectory = path.join(siteDirectory, '.well-known')
  const targetApiCatalogPath = path.join(targetWellKnownDirectory, 'api-catalog')
  fs.ensureDirSync(targetWellKnownDirectory)
  if (fs.pathExistsSync(sourceApiCatalogPath)) {
    fs.copyFileSync(sourceApiCatalogPath, targetApiCatalogPath)
    return
  }
  const fallbackPayload = {
    linkset: [
      {
        anchor: '/x/api',
        rel: 'service-desc',
        href: '/x/api/openapi',
        type: 'application/json',
      },
    ],
  }
  fs.writeFileSync(targetApiCatalogPath, JSON.stringify(fallbackPayload, null, 2))
}

function seedRuntimeConfig(runtimeConfigRoot) {
  fs.ensureDirSync(runtimeConfigRoot)
  fs.writeFileSync(path.join(runtimeConfigRoot, '.isHAXcmsConfig'), '')
  const configSourceRoot = path.join(REPO_ROOT, 'src', 'boilerplate', 'systemsetup')
  const configSeedFiles = [
    'config.json',
    'my-custom-elements.js',
    'userData.json',
    'config.php',
    '.htaccess',
    '.user-files-htaccess',
  ]
  for (let i = 0; i < configSeedFiles.length; i++) {
    const fileName = configSeedFiles[i]
    fs.copySync(
      path.join(configSourceRoot, fileName),
      path.join(runtimeConfigRoot, fileName),
    )
  }
  fs.ensureDirSync(path.join(runtimeConfigRoot, 'tmp'))
  fs.ensureDirSync(path.join(runtimeConfigRoot, 'cache'))
  fs.ensureDirSync(path.join(runtimeConfigRoot, 'user'))
  fs.ensureDirSync(path.join(runtimeConfigRoot, 'user', 'files'))
  fs.ensureDirSync(path.join(runtimeConfigRoot, 'user', 'skeletons'))
  fs.ensureDirSync(path.join(runtimeConfigRoot, 'skeletons'))
  fs.ensureDirSync(path.join(runtimeConfigRoot, 'settings'))
  fs.ensureDirSync(path.join(runtimeConfigRoot, 'node_modules'))
}

function readSiteSpecDocument() {
  const specRaw = fs.readFileSync(SITE_SPEC_PATH, 'utf8')
  const siteSpec = YAML.parse(specRaw)
  assert.ok(siteSpec && typeof siteSpec === 'object', 'Unable to parse site-spec')
  assert.ok(
    siteSpec.paths && typeof siteSpec.paths === 'object',
    'Parsed site-spec is missing paths',
  )
  return siteSpec
}

function readSystemSpecDocument() {
  const specRaw = fs.readFileSync(SYSTEM_SPEC_PATH, 'utf8')
  const systemSpec = YAML.parse(specRaw)
  assert.ok(
    systemSpec && typeof systemSpec === 'object',
    'Unable to parse system-spec',
  )
  assert.ok(
    systemSpec.paths && typeof systemSpec.paths === 'object',
    'Parsed system-spec is missing paths',
  )
  return systemSpec
}

function decodeJsonPointerToken(value) {
  return String(value || '')
    .replace(/~1/g, '/')
    .replace(/~0/g, '~')
}

function resolveLocalReference(document, reference) {
  const referenceValue = String(reference || '')
  if (referenceValue === '#') {
    return document
  }
  if (referenceValue.indexOf('#/') !== 0) {
    throw new Error(`Unsupported reference format: ${referenceValue}`)
  }
  const tokens = referenceValue
    .substring(2)
    .split('/')
    .map((token) => decodeJsonPointerToken(token))
  let active = document
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]
    if (
      !active ||
      typeof active !== 'object' ||
      !Object.prototype.hasOwnProperty.call(active, token)
    ) {
      throw new Error(`Unable to resolve reference ${referenceValue}`)
    }
    active = active[token]
  }
  return active
}

function resolveOpenApiNode(node, document, stack = []) {
  if (Array.isArray(node)) {
    return node.map((item) => resolveOpenApiNode(item, document, stack))
  }
  if (!node || typeof node !== 'object') {
    return node
  }
  if (Object.prototype.hasOwnProperty.call(node, '$ref')) {
    const reference = String(node.$ref || '')
    if (stack.indexOf(reference) !== -1) {
      return {}
    }
    const referencedNode = resolveLocalReference(document, reference)
    const resolvedReferenceNode = resolveOpenApiNode(
      referencedNode,
      document,
      stack.concat(reference),
    )
    const merged = {}
    if (
      resolvedReferenceNode &&
      typeof resolvedReferenceNode === 'object' &&
      !Array.isArray(resolvedReferenceNode)
    ) {
      const referenceKeys = Object.keys(resolvedReferenceNode)
      for (let i = 0; i < referenceKeys.length; i++) {
        const key = referenceKeys[i]
        merged[key] = resolvedReferenceNode[key]
      }
    }
    const nodeKeys = Object.keys(node)
    for (let i = 0; i < nodeKeys.length; i++) {
      const key = nodeKeys[i]
      if (key === '$ref') {
        continue
      }
      merged[key] = resolveOpenApiNode(node[key], document, stack)
    }
    return merged
  }
  const resolvedNode = {}
  const keys = Object.keys(node)
  for (let i = 0; i < keys.length; i++) {
    const key = keys[i]
    resolvedNode[key] = resolveOpenApiNode(node[key], document, stack)
  }
  return resolvedNode
}

function buildOperationIndex(siteSpec) {
  const index = {}
  const pathKeys = Object.keys(siteSpec.paths)
  for (let p = 0; p < pathKeys.length; p++) {
    const pathKey = pathKeys[p]
    const pathItem = siteSpec.paths[pathKey]
    if (!pathItem || typeof pathItem !== 'object') {
      continue
    }
    for (let m = 0; m < HTTP_METHODS.length; m++) {
      const method = HTTP_METHODS[m]
      if (!Object.prototype.hasOwnProperty.call(pathItem, method)) {
        continue
      }
      const operation = pathItem[method]
      if (!operation || typeof operation !== 'object') {
        continue
      }
      const operationId = String(operation.operationId || '').trim()
      if (operationId === '') {
        continue
      }
      index[operationId] = {
        operationId,
        method,
        path: pathKey,
        pathItem,
        operation,
      }
    }
  }
  return index
}

function collectOperationParameters(operationMeta, siteSpec) {
  const byKey = {}
  const addParameters = (parameters) => {
    if (!Array.isArray(parameters)) {
      return
    }
    for (let i = 0; i < parameters.length; i++) {
      const parameter = parameters[i]
      if (!parameter || typeof parameter !== 'object') {
        continue
      }
      const resolvedParameter = resolveOpenApiNode(parameter, siteSpec)
      const location = String(resolvedParameter.in || '').trim()
      const name = String(resolvedParameter.name || '').trim()
      if (location === '' || name === '') {
        continue
      }
      byKey[`${location}:${name}`] = resolvedParameter
    }
  }
  addParameters(operationMeta.pathItem.parameters)
  addParameters(operationMeta.operation.parameters)
  return Object.keys(byKey).map((key) => byKey[key])
}

function assertRequiredParametersProvided(
  operationMeta,
  siteSpec,
  pathParams,
  query,
  options = {},
) {
  const skipRequiredPath = options.skipRequiredPath === true
  const skipRequiredQuery = options.skipRequiredQuery === true
  const parameters = collectOperationParameters(operationMeta, siteSpec)
  for (let i = 0; i < parameters.length; i++) {
    const parameter = parameters[i]
    if (parameter.required !== true) {
      continue
    }
    if (parameter.in === 'path') {
      if (skipRequiredPath) {
        continue
      }
      const hasValue = Object.prototype.hasOwnProperty.call(pathParams, parameter.name)
      assert.ok(
        hasValue && String(pathParams[parameter.name] || '') !== '',
        `${operationMeta.operationId} requires path parameter "${parameter.name}"`,
      )
    }
    if (parameter.in === 'query') {
      if (skipRequiredQuery) {
        continue
      }
      const hasValue = Object.prototype.hasOwnProperty.call(query, parameter.name)
      assert.ok(
        hasValue && String(query[parameter.name] || '') !== '',
        `${operationMeta.operationId} requires query parameter "${parameter.name}"`,
      )
    }
  }
}

function toRuntimeApiPath(siteApiBasePath, specPath) {
  const normalizedBasePath = String(siteApiBasePath || '/x/api').replace(/\/+$/, '')
  const normalizedSpecPath = String(specPath || '')
  const siteApiMarker = '/x/api'
  const siteApiMarkerIndex = normalizedBasePath.lastIndexOf(siteApiMarker)
  const runtimeSiteBasePath =
    siteApiMarkerIndex === -1
      ? ''
      : normalizedBasePath.substring(0, siteApiMarkerIndex)
  if (normalizedSpecPath === '/x/api') {
    return normalizedBasePath
  }
  if (normalizedSpecPath.indexOf('/x/api/') === 0) {
    return `${normalizedBasePath}${normalizedSpecPath.substring('/x/api'.length)}`
  }
  if (normalizedSpecPath.indexOf('/.well-known/') === 0) {
    return runtimeSiteBasePath === ''
      ? normalizedSpecPath
      : `${runtimeSiteBasePath}${normalizedSpecPath}`
  }
  throw new Error(`Unsupported site-spec API path: ${normalizedSpecPath}`)
}

function setQueryValue(searchParams, key, value) {
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      searchParams.append(key, String(value[i]))
    }
    return
  }
  searchParams.set(key, String(value))
}

function buildOperationUrl(runtime, operationMeta, pathParams, query) {
  const runtimePath = toRuntimeApiPath(runtime.auth.siteApiBasePath, operationMeta.path)
  const renderedPath = runtimePath.replace(/\{([A-Za-z0-9_]+)\}/g, (fullMatch, token) => {
    if (!Object.prototype.hasOwnProperty.call(pathParams, token)) {
      throw new Error(
        `${operationMeta.operationId} missing path parameter "${token}"`,
      )
    }
    return encodeURIComponent(String(pathParams[token]))
  })
  const requestUrl = new URL(`${runtime.baseUrl}${renderedPath}`)
  const queryKeys = Object.keys(query)
  for (let i = 0; i < queryKeys.length; i++) {
    const key = queryKeys[i]
    const value = query[key]
    if (typeof value === 'undefined' || value === null || value === '') {
      continue
    }
    setQueryValue(requestUrl.searchParams, key, value)
  }
  return requestUrl
}

function createValidatorState() {
  const ajv = new Ajv({
    allErrors: true,
    strict: false,
    allowUnionTypes: true,
  })
  addFormats(ajv)
  return {
    ajv,
    cache: {},
  }
}

function getResponseSchemaForStatus(siteSpec, operationMeta, statusCode) {
  const responses =
    operationMeta.operation && operationMeta.operation.responses
      ? operationMeta.operation.responses
      : {}
  let responseDefinition = responses[String(statusCode)]
  if (!responseDefinition && responses.default) {
    responseDefinition = responses.default
  }
  if (!responseDefinition) {
    return null
  }
  const resolvedResponse = resolveOpenApiNode(responseDefinition, siteSpec)
  if (
    !resolvedResponse ||
    typeof resolvedResponse !== 'object' ||
    !resolvedResponse.content ||
    typeof resolvedResponse.content !== 'object'
  ) {
    return null
  }
  let selectedContentType = ''
  if (Object.prototype.hasOwnProperty.call(resolvedResponse.content, 'application/json')) {
    selectedContentType = 'application/json'
  }
  else {
    const contentTypes = Object.keys(resolvedResponse.content)
    for (let i = 0; i < contentTypes.length; i++) {
      if (String(contentTypes[i]).toLowerCase().indexOf('json') !== -1) {
        selectedContentType = contentTypes[i]
        break
      }
    }
  }
  if (selectedContentType === '') {
    return null
  }
  const mediaType = resolvedResponse.content[selectedContentType]
  if (!mediaType || typeof mediaType !== 'object' || !mediaType.schema) {
    return null
  }
  return resolveOpenApiNode(mediaType.schema, siteSpec)
}

function getResponseValidator(runtime, operationId, statusCode) {
  const cacheKey = `${operationId}:${statusCode}`
  if (Object.prototype.hasOwnProperty.call(runtime.validatorState.cache, cacheKey)) {
    return runtime.validatorState.cache[cacheKey]
  }
  const operationMeta = runtime.operationIndex[operationId]
  if (!operationMeta) {
    return null
  }
  const schema = getResponseSchemaForStatus(
    runtime.siteSpec,
    operationMeta,
    statusCode,
  )
  if (!schema) {
    runtime.validatorState.cache[cacheKey] = null
    return null
  }
  const validator = runtime.validatorState.ajv.compile(schema)
  runtime.validatorState.cache[cacheKey] = validator
  return validator
}

function assertSchemaConformance(runtime, operationId, statusCode, invocationResult) {
  const validator = getResponseValidator(runtime, operationId, statusCode)
  if (!validator) {
    return
  }
  assert.ok(
    invocationResult.bodyJson && typeof invocationResult.bodyJson === 'object',
    `${operationId} expected JSON response body for schema validation`,
  )
  const valid = validator(invocationResult.bodyJson)
  if (valid) {
    return
  }
  assert.fail(
    `${operationId} response did not match site-spec schema:\n${JSON.stringify(validator.errors, null, 2)}\nResponse:\n${invocationResult.bodyText}`,
  )
}

async function invokeOperation(runtime, operationId, options = {}) {
  const operationMeta = runtime.operationIndex[operationId]
  assert.ok(operationMeta, `Unknown operationId: ${operationId}`)
  const pathParams =
    options.pathParams && typeof options.pathParams === 'object'
      ? options.pathParams
      : {}
  const query =
    options.query && typeof options.query === 'object' ? options.query : {}
  assertRequiredParametersProvided(
    operationMeta,
    runtime.siteSpec,
    pathParams,
    query,
    {
      skipRequiredPath: options.skipRequiredPath === true,
      skipRequiredQuery: options.skipRequiredQuery === true,
    },
  )
  const requestUrl = buildOperationUrl(runtime, operationMeta, pathParams, query)
  const headers = {}
  headers.accept =
    typeof options.accept === 'string' && options.accept.trim() !== ''
      ? options.accept
      : 'application/json'
  if (options.headers && typeof options.headers === 'object') {
    const headerNames = Object.keys(options.headers)
    for (let i = 0; i < headerNames.length; i++) {
      const headerName = headerNames[i]
      headers[headerName] = options.headers[headerName]
    }
  }
  let requestBody = undefined
  if (Object.prototype.hasOwnProperty.call(options, 'body')) {
    const bodyValue = options.body
    if (
      bodyValue &&
      typeof bodyValue === 'object' &&
      !Array.isArray(bodyValue) &&
      !Buffer.isBuffer(bodyValue)
    ) {
      if (!Object.prototype.hasOwnProperty.call(headers, 'content-type')) {
        headers['content-type'] = 'application/json'
      }
      requestBody = JSON.stringify(bodyValue)
    }
    else {
      requestBody = bodyValue
    }
  }
  const response = await sendHttpRequest({
    method: String(operationMeta.method).toUpperCase(),
    url: String(requestUrl),
    headers,
    body: requestBody,
  })
  return {
    operationMeta,
    requestUrl: String(requestUrl),
    status: response.status,
    bodyText: response.bodyText,
    bodyJson: parseJsonSafely(response.bodyText),
    responseHeaders: response.headers,
  }
}

function deriveSearchQueryToken(value) {
  const parts = String(value || '')
    .split(/[^A-Za-z0-9]+/g)
    .map((part) => part.trim())
    .filter((part) => part !== '')
  for (let i = 0; i < parts.length; i++) {
    if (parts[i].length >= 3) {
      return parts[i]
    }
  }
  if (parts.length > 0) {
    return parts[0]
  }
  return 'welcome'
}

function getBearerAuthHeaders(runtime) {
  return {
    Authorization: `Bearer ${runtime.auth.jwt}`,
  }
}

function getSiteAuthHeaders(runtime) {
  return {
    Authorization: `Bearer ${runtime.auth.jwt}`,
    'X-HAXCMS-Site-Token': runtime.auth.siteToken,
  }
}

function getInvalidSiteAuthHeaders(runtime) {
  return {
    Authorization: `Bearer ${runtime.auth.jwt}`,
    'X-HAXCMS-Site-Token': `invalid-${runtime.testStartTimestamp}`,
  }
}

function mergeInvocationOptions(baseOptions = {}, overrides = {}) {
  const merged = { ...(baseOptions || {}) }
  const overrideKeys = Object.keys(overrides || {})
  for (let i = 0; i < overrideKeys.length; i++) {
    const key = overrideKeys[i]
    merged[key] = overrides[key]
  }
  if (baseOptions && typeof baseOptions === 'object') {
    if (baseOptions.query && typeof baseOptions.query === 'object') {
      merged.query = { ...baseOptions.query }
    }
    if (baseOptions.pathParams && typeof baseOptions.pathParams === 'object') {
      merged.pathParams = { ...baseOptions.pathParams }
    }
    if (baseOptions.headers && typeof baseOptions.headers === 'object') {
      merged.headers = { ...baseOptions.headers }
    }
  }
  if (overrides && typeof overrides === 'object') {
    if (overrides.query && typeof overrides.query === 'object') {
      merged.query = { ...(merged.query || {}), ...overrides.query }
    }
    if (overrides.pathParams && typeof overrides.pathParams === 'object') {
      merged.pathParams = {
        ...(merged.pathParams || {}),
        ...overrides.pathParams,
      }
    }
    if (overrides.headers && typeof overrides.headers === 'object') {
      merged.headers = { ...(merged.headers || {}), ...overrides.headers }
    }
  }
  return merged
}

function getResponseHeaderValue(responseHeaders, headerName) {
  const normalizedHeaders =
    responseHeaders && typeof responseHeaders === 'object'
      ? responseHeaders
      : {}
  const targetKey = String(headerName || '').trim().toLowerCase()
  if (
    targetKey !== '' &&
    Object.prototype.hasOwnProperty.call(normalizedHeaders, targetKey)
  ) {
    return normalizedHeaders[targetKey]
  }
  const headerKeys = Object.keys(normalizedHeaders)
  for (let i = 0; i < headerKeys.length; i++) {
    if (String(headerKeys[i]).trim().toLowerCase() === targetKey) {
      return normalizedHeaders[headerKeys[i]]
    }
  }
  return ''
}

function assertContainsIgnoreCase(value, searchValue, message) {
  const source = String(value || '').toLowerCase()
  const token = String(searchValue || '').toLowerCase()
  assert.ok(source.indexOf(token) !== -1, message)
}

function assertRepresentationHeaders(result, expectedPathFragment = '') {
  const varyHeader = getResponseHeaderValue(result.responseHeaders, 'vary')
  const contentLocationHeader = getResponseHeaderValue(
    result.responseHeaders,
    'content-location',
  )
  const linkHeader = getResponseHeaderValue(result.responseHeaders, 'link')
  assertContainsIgnoreCase(
    varyHeader,
    'accept',
    `Expected Vary header to include Accept for ${result.operationMeta.operationId}`,
  )
  assert.ok(
    String(contentLocationHeader || '').trim() !== '',
    `Expected Content-Location header for ${result.operationMeta.operationId}`,
  )
  if (String(expectedPathFragment || '').trim() !== '') {
    assertContainsIgnoreCase(
      contentLocationHeader,
      expectedPathFragment,
      `Expected Content-Location to reference ${expectedPathFragment} for ${result.operationMeta.operationId}`,
    )
  }
  assertContainsIgnoreCase(
    linkHeader,
    'rel=\"alternate\"',
    `Expected Link header to contain alternate representations for ${result.operationMeta.operationId}`,
  )
}

function assertContentTypeIncludes(result, expectedFragment) {
  const contentType = getResponseHeaderValue(result.responseHeaders, 'content-type')
  assertContainsIgnoreCase(
    contentType,
    expectedFragment,
    `Expected Content-Type to include ${expectedFragment} for ${result.operationMeta.operationId}`,
  )
}

function buildMultipartBody(options = {}) {
  const boundary = `----haxcms-conformance-${Date.now()}-${Math.floor(Math.random() * 1000000)}`
  const fieldName =
    typeof options.fieldName === 'string' && options.fieldName.trim() !== ''
      ? options.fieldName
      : 'file-upload'
  const fileName =
    typeof options.fileName === 'string' && options.fileName.trim() !== ''
      ? options.fileName
      : 'harness-upload.txt'
  const mimeType =
    typeof options.mimeType === 'string' && options.mimeType.trim() !== ''
      ? options.mimeType
      : 'text/plain'
  const fileContents =
    typeof options.fileContents === 'string'
      ? options.fileContents
      : `haxcms conformance upload ${Date.now()}`
  const extraFields =
    options.extraFields && typeof options.extraFields === 'object'
      ? options.extraFields
      : {}
  const parts = []
  parts.push(`--${boundary}`)
  parts.push(
    `Content-Disposition: form-data; name=\"${fieldName}\"; filename=\"${fileName}\"`,
  )
  parts.push(`Content-Type: ${mimeType}`)
  parts.push('')
  parts.push(fileContents)
  const fieldNames = Object.keys(extraFields)
  for (let i = 0; i < fieldNames.length; i++) {
    const fieldKey = fieldNames[i]
    parts.push(`--${boundary}`)
    parts.push(`Content-Disposition: form-data; name=\"${fieldKey}\"`)
    parts.push('')
    parts.push(String(extraFields[fieldKey]))
  }
  parts.push(`--${boundary}--`)
  parts.push('')
  return {
    body: parts.join('\r\n'),
    boundary,
    fileName,
  }
}

async function assertSecuredOperationAuthMatrix(
  runtime,
  operationId,
  baseOptions = {},
) {
  const unauthorizedResult = await invokeOperation(
    runtime,
    operationId,
    mergeInvocationOptions(baseOptions, {
      headers: {},
    }),
  )
  assert.equal(
    unauthorizedResult.status,
    401,
    `${operationId} should return 401 without auth headers`,
  )
  assertSchemaConformance(runtime, operationId, 401, unauthorizedResult)

  const bearerOnlyResult = await invokeOperation(
    runtime,
    operationId,
    mergeInvocationOptions(baseOptions, {
      headers: getBearerAuthHeaders(runtime),
    }),
  )
  assert.equal(
    bearerOnlyResult.status,
    403,
    `${operationId} should return 403 with bearer token only`,
  )
  assertSchemaConformance(runtime, operationId, 403, bearerOnlyResult)

  const invalidSiteTokenResult = await invokeOperation(
    runtime,
    operationId,
    mergeInvocationOptions(baseOptions, {
      headers: getInvalidSiteAuthHeaders(runtime),
    }),
  )
  assert.equal(
    invalidSiteTokenResult.status,
    403,
    `${operationId} should return 403 with invalid site token`,
  )
  assertSchemaConformance(runtime, operationId, 403, invalidSiteTokenResult)
}

function getSystemUserAuthHeaders(runtime) {
  return {
    Authorization: `Bearer ${runtime.auth.jwt}`,
    'X-HAXCMS-User-Token': runtime.auth.userToken,
  }
}

function getInvalidSystemUserAuthHeaders(runtime) {
  return {
    Authorization: `Bearer ${runtime.auth.jwt}`,
    'X-HAXCMS-User-Token': `invalid-${runtime.testStartTimestamp}`,
  }
}

function getSystemResponseValidator(runtime, operationId, statusCode) {
  const cacheKey = `${operationId}:${statusCode}`
  if (
    Object.prototype.hasOwnProperty.call(
      runtime.systemValidatorState.cache,
      cacheKey,
    )
  ) {
    return runtime.systemValidatorState.cache[cacheKey]
  }
  const operationMeta = runtime.systemOperationIndex[operationId]
  if (!operationMeta) {
    return null
  }
  const schema = getResponseSchemaForStatus(
    runtime.systemSpec,
    operationMeta,
    statusCode,
  )
  if (!schema) {
    runtime.systemValidatorState.cache[cacheKey] = null
    return null
  }
  const validator = runtime.systemValidatorState.ajv.compile(schema)
  runtime.systemValidatorState.cache[cacheKey] = validator
  return validator
}

function assertSystemSchemaConformance(
  runtime,
  operationId,
  statusCode,
  invocationResult,
) {
  const validator = getSystemResponseValidator(runtime, operationId, statusCode)
  if (!validator) {
    return
  }
  if (!invocationResult.bodyJson || typeof invocationResult.bodyJson !== 'object') {
    return
  }
  const valid = validator(invocationResult.bodyJson)
  if (valid) {
    return
  }
  assert.fail(
    `${operationId} response did not match system-spec schema:\n${JSON.stringify(validator.errors, null, 2)}\nResponse:\n${invocationResult.bodyText}`,
  )
}

function buildSystemOperationUrl(runtime, operationMeta, pathParams, query) {
  const renderedPath = String(operationMeta.path || '').replace(
    /\{([A-Za-z0-9_]+)\}/g,
    (fullMatch, token) => {
      if (!Object.prototype.hasOwnProperty.call(pathParams, token)) {
        throw new Error(
          `${operationMeta.operationId} missing path parameter \"${token}\"`,
        )
      }
      return encodeURIComponent(String(pathParams[token]))
    },
  )
  const requestUrl = new URL(`${runtime.baseUrl}${renderedPath}`)
  const queryKeys = Object.keys(query)
  for (let i = 0; i < queryKeys.length; i++) {
    const key = queryKeys[i]
    const value = query[key]
    if (typeof value === 'undefined' || value === null || value === '') {
      continue
    }
    setQueryValue(requestUrl.searchParams, key, value)
  }
  return requestUrl
}

async function invokeSystemOperation(runtime, operationId, options = {}) {
  const operationMeta = runtime.systemOperationIndex[operationId]
  assert.ok(operationMeta, `Unknown system operationId: ${operationId}`)
  const pathParams =
    options.pathParams && typeof options.pathParams === 'object'
      ? options.pathParams
      : {}
  const query =
    options.query && typeof options.query === 'object' ? options.query : {}
  assertRequiredParametersProvided(
    operationMeta,
    runtime.systemSpec,
    pathParams,
    query,
    {
      skipRequiredPath: options.skipRequiredPath === true,
      skipRequiredQuery: options.skipRequiredQuery === true,
    },
  )
  const requestUrl = buildSystemOperationUrl(
    runtime,
    operationMeta,
    pathParams,
    query,
  )
  const headers = {}
  headers.accept =
    typeof options.accept === 'string' && options.accept.trim() !== ''
      ? options.accept
      : 'application/json'
  if (options.headers && typeof options.headers === 'object') {
    const headerNames = Object.keys(options.headers)
    for (let i = 0; i < headerNames.length; i++) {
      const headerName = headerNames[i]
      headers[headerName] = options.headers[headerName]
    }
  }
  let requestBody = undefined
  if (Object.prototype.hasOwnProperty.call(options, 'body')) {
    const bodyValue = options.body
    if (
      bodyValue &&
      typeof bodyValue === 'object' &&
      !Array.isArray(bodyValue) &&
      !Buffer.isBuffer(bodyValue)
    ) {
      if (!Object.prototype.hasOwnProperty.call(headers, 'content-type')) {
        headers['content-type'] = 'application/json'
      }
      requestBody = JSON.stringify(bodyValue)
    }
    else {
      requestBody = bodyValue
    }
  }
  const response = await sendHttpRequest({
    method: String(operationMeta.method).toUpperCase(),
    url: String(requestUrl),
    headers,
    body: requestBody,
  })
  return {
    operationMeta,
    requestUrl: String(requestUrl),
    status: response.status,
    bodyText: response.bodyText,
    bodyJson: parseJsonSafely(response.bodyText),
    responseHeaders: response.headers,
  }
}

async function assertSystemUserSecuredOperationAuthMatrix(
  runtime,
  operationId,
  baseOptions = {},
) {
  const unauthorizedResult = await invokeSystemOperation(
    runtime,
    operationId,
    mergeInvocationOptions(baseOptions, {
      headers: {},
    }),
  )
  assert.ok(
    unauthorizedResult.status === 401 || unauthorizedResult.status === 403,
    `${operationId} should return 401 or 403 without auth headers`,
  )
  assertSystemSchemaConformance(
    runtime,
    operationId,
    unauthorizedResult.status,
    unauthorizedResult,
  )

  const bearerOnlyResult = await invokeSystemOperation(
    runtime,
    operationId,
    mergeInvocationOptions(baseOptions, {
      headers: getBearerAuthHeaders(runtime),
    }),
  )
  assert.ok(
    bearerOnlyResult.status === 401 || bearerOnlyResult.status === 403,
    `${operationId} should return 401 or 403 with bearer token only`,
  )
  assertSystemSchemaConformance(
    runtime,
    operationId,
    bearerOnlyResult.status,
    bearerOnlyResult,
  )

  const invalidUserTokenResult = await invokeSystemOperation(
    runtime,
    operationId,
    mergeInvocationOptions(baseOptions, {
      headers: getInvalidSystemUserAuthHeaders(runtime),
    }),
  )
  assert.ok(
    invalidUserTokenResult.status === 401 || invalidUserTokenResult.status === 403,
    `${operationId} should return 401 or 403 with invalid user token`,
  )
  assertSystemSchemaConformance(
    runtime,
    operationId,
    invalidUserTokenResult.status,
    invalidUserTokenResult,
  )
}

async function setupRuntime() {
  const runtime = {
    originalCwd: process.cwd(),
    envSnapshots: {
      PORT: captureEnvValue('PORT'),
      HOME: captureEnvValue('HOME'),
      HAXCMS_ROOT: captureEnvValue('HAXCMS_ROOT'),
      HAXCMS_DISABLE_JWT_CHECKS: captureEnvValue('HAXCMS_DISABLE_JWT_CHECKS'),
      HAXCMS_ALLOW_DEFAULT_CREDS: captureEnvValue('HAXCMS_ALLOW_DEFAULT_CREDS'),
      GIT_AUTHOR_NAME: captureEnvValue('GIT_AUTHOR_NAME'),
      GIT_AUTHOR_EMAIL: captureEnvValue('GIT_AUTHOR_EMAIL'),
      GIT_COMMITTER_NAME: captureEnvValue('GIT_COMMITTER_NAME'),
      GIT_COMMITTER_EMAIL: captureEnvValue('GIT_COMMITTER_EMAIL'),
    },
    globalSnapshots: {
      HAXCMS_RUNTIME_CREDENTIALS: captureGlobalValue(
        'HAXCMS_RUNTIME_CREDENTIALS',
      ),
      HAXCMS_RUNTIME_USERNAME: captureGlobalValue('HAXCMS_RUNTIME_USERNAME'),
      HAXCMS_RUNTIME_PASSWORD: captureGlobalValue('HAXCMS_RUNTIME_PASSWORD'),
    },
  }
  runtime.testStartTimestamp = Date.now()
  runtime.createdSiteName = `haxcms-test-harness-${runtime.testStartTimestamp}`
  runtime.tempDirectory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'haxcms-nodejs-conformance-'),
  )
  runtime.runtimeRoot = path.join(runtime.tempDirectory, 'runtime')
  runtime.homeDirectory = path.join(runtime.tempDirectory, 'home')
  runtime.runtimeConfigRoot = path.join(runtime.runtimeRoot, '_config')

  fs.ensureDirSync(runtime.runtimeRoot)
  fs.ensureDirSync(runtime.homeDirectory)
  fs.ensureDirSync(path.join(runtime.runtimeRoot, SITE_DIRECTORY_NAME))
  seedRuntimeConfig(runtime.runtimeConfigRoot)

  process.chdir(runtime.runtimeRoot)
  process.env.HOME = runtime.homeDirectory
  process.env.HAXCMS_ROOT = runtime.runtimeRoot
  process.env.PORT = '0'
  process.env.GIT_AUTHOR_NAME = TEST_GIT_AUTHOR_NAME
  process.env.GIT_AUTHOR_EMAIL = TEST_GIT_AUTHOR_EMAIL
  process.env.GIT_COMMITTER_NAME = TEST_GIT_AUTHOR_NAME
  process.env.GIT_COMMITTER_EMAIL = TEST_GIT_AUTHOR_EMAIL
  delete process.env.HAXCMS_DISABLE_JWT_CHECKS

  globalThis.HAXCMS_RUNTIME_CREDENTIALS = {
    username: TEST_USER_NAME,
    password: TEST_USER_PASSWORD,
  }
  globalThis.HAXCMS_RUNTIME_USERNAME = TEST_USER_NAME
  globalThis.HAXCMS_RUNTIME_PASSWORD = TEST_USER_PASSWORD

  delete require.cache[require.resolve(APP_ENTRY_PATH)]
  runtime.appModule = require(APP_ENTRY_PATH)
  runtime.port = await runtime.appModule.serverReady
  runtime.baseUrl = `http://127.0.0.1:${runtime.port}`

  runtime.jwt = await loginForJwt(runtime.baseUrl)
  runtime.dashboardSettings = await requestConnectionSettings(runtime.baseUrl)
  await createHarnessSite(
    runtime.baseUrl,
    runtime.jwt,
    runtime.dashboardSettings,
    runtime.createdSiteName,
  )
  ensureSiteApiCatalog(runtime.runtimeRoot, runtime.createdSiteName)
  await ensureSiteHasInitialCommit(runtime.runtimeRoot, runtime.createdSiteName)
  runtime.siteSettings = await requestConnectionSettings(
    runtime.baseUrl,
    `/${SITE_DIRECTORY_NAME}/${runtime.createdSiteName}/`,
  )
  runtime.auth = {
    jwt: runtime.jwt,
    userToken: runtime.dashboardSettings.userToken,
    siteToken: runtime.siteSettings.siteToken,
    siteApiBasePath: runtime.siteSettings.siteApiBasePath,
  }
  runtime.siteSpec = readSiteSpecDocument()
  runtime.operationIndex = buildOperationIndex(runtime.siteSpec)
  runtime.validatorState = createValidatorState()
  runtime.systemSpec = readSystemSpecDocument()
  runtime.systemOperationIndex = buildOperationIndex(runtime.systemSpec)
  runtime.systemValidatorState = createValidatorState()
  runtime.dynamicContext = {}

  return runtime
}

async function teardownRuntime(runtime) {
  if (!runtime) {
    return
  }
  if (
    runtime.appModule &&
    runtime.appModule.server &&
    typeof runtime.appModule.server.close === 'function'
  ) {
    await new Promise((resolve) => {
      runtime.appModule.server.close(() => {
        resolve()
      })
    })
  }
  if (runtime.originalCwd) {
    process.chdir(runtime.originalCwd)
  }
  restoreGlobalValue(
    'HAXCMS_RUNTIME_CREDENTIALS',
    runtime.globalSnapshots.HAXCMS_RUNTIME_CREDENTIALS,
  )
  restoreGlobalValue(
    'HAXCMS_RUNTIME_USERNAME',
    runtime.globalSnapshots.HAXCMS_RUNTIME_USERNAME,
  )
  restoreGlobalValue(
    'HAXCMS_RUNTIME_PASSWORD',
    runtime.globalSnapshots.HAXCMS_RUNTIME_PASSWORD,
  )
  restoreEnvValue('PORT', runtime.envSnapshots.PORT)
  restoreEnvValue('HOME', runtime.envSnapshots.HOME)
  restoreEnvValue('HAXCMS_ROOT', runtime.envSnapshots.HAXCMS_ROOT)
  restoreEnvValue(
    'HAXCMS_DISABLE_JWT_CHECKS',
    runtime.envSnapshots.HAXCMS_DISABLE_JWT_CHECKS,
  )
  restoreEnvValue(
    'HAXCMS_ALLOW_DEFAULT_CREDS',
    runtime.envSnapshots.HAXCMS_ALLOW_DEFAULT_CREDS,
  )
  restoreEnvValue('GIT_AUTHOR_NAME', runtime.envSnapshots.GIT_AUTHOR_NAME)
  restoreEnvValue('GIT_AUTHOR_EMAIL', runtime.envSnapshots.GIT_AUTHOR_EMAIL)
  restoreEnvValue('GIT_COMMITTER_NAME', runtime.envSnapshots.GIT_COMMITTER_NAME)
  restoreEnvValue('GIT_COMMITTER_EMAIL', runtime.envSnapshots.GIT_COMMITTER_EMAIL)
  if (runtime.tempDirectory && fs.pathExistsSync(runtime.tempDirectory)) {
    fs.removeSync(runtime.tempDirectory)
  }
}

let runtime = null
const SKIP_GET_API_CATALOG_SUBTEST = false

test.before(async () => {
  runtime = await setupRuntime()
})

test.after(async () => {
  await teardownRuntime(runtime)
})

test('site API conformance against site-spec', async (t) => {
  const requiredOperationIds = [
    'getSiteApiDiscovery',
    'getSiteOpenApi',
    'getSiteOpenApiJson',
    'getSiteOpenApiYaml',
    'getApiCatalog',
    'getSiteSummary',
    'listEntityDescriptors',
    'listSchemas',
    'listItems',
    'getItemByIdOrSlug',
    'listContent',
    'getContentByIdOrSlug',
    'listTags',
    'searchContent',
    'listCustomElements',
    'getCustomElementByName',
    'listBlocks',
    'getBlockByName',
    'getBlockUsage',
    'listRegions',
    'getRegionByName',
    'listThemes',
    'getActiveTheme',
    'getThemeByName',
    'listFiles',
    'createFile',
    'getFileByUuid',
    'updateFileByUuid',
    'deleteFileByUuid',
    'listReports',
    'getReportByName',
    'getAnalyticsCapabilities',
    'listViews',
    'getViewById',
    'getViewResults',
    'listDisplaysAlias',
    'getDisplayResultsAlias',
    'listItemRevisions',
    'getItemRevisionById',
    'restoreItemRevision',
    'searchAppStoreProvider',
  ]
  for (let i = 0; i < requiredOperationIds.length; i++) {
    const operationId = requiredOperationIds[i]
    assert.ok(
      runtime.operationIndex[operationId],
      `Missing required operationId "${operationId}" in site-spec`,
    )
  }

  await t.test('creates runtime-named harness site before endpoint tests', async () => {
    assert.ok(
      runtime.createdSiteName.indexOf('haxcms-test-harness-') === 0,
      `Expected runtime site name prefix, got "${runtime.createdSiteName}"`,
    )
    assert.ok(
      runtime.auth.siteApiBasePath.indexOf(
        `/${SITE_DIRECTORY_NAME}/${runtime.createdSiteName}/x/api`,
      ) === 0,
      `Expected siteApiBasePath to target runtime-created site, got "${runtime.auth.siteApiBasePath}"`,
    )
  })
  await t.test('getSiteApiDiscovery returns API capabilities payload', async () => {
    const result = await invokeOperation(runtime, 'getSiteApiDiscovery')
    assert.equal(result.status, 200, result.bodyText)
    assert.ok(result.bodyJson && result.bodyJson.data)
    assertSchemaConformance(runtime, 'getSiteApiDiscovery', 200, result)
  })

  await t.test('getSiteOpenApi returns JSON OpenAPI document', async () => {
    const result = await invokeOperation(runtime, 'getSiteOpenApi', {
      query: {
        format: 'json',
      },
    })
    assert.equal(result.status, 200, result.bodyText)
    assert.ok(result.bodyJson && typeof result.bodyJson.openapi === 'string')
    assertSchemaConformance(runtime, 'getSiteOpenApi', 200, result)
  })

  await t.test('getSiteOpenApiJson returns JSON OpenAPI document', async () => {
    const result = await invokeOperation(runtime, 'getSiteOpenApiJson')
    assert.equal(result.status, 200, result.bodyText)
    assert.ok(result.bodyJson && typeof result.bodyJson === 'object')
    assert.ok(typeof result.bodyJson.openapi === 'string')
    assertSchemaConformance(runtime, 'getSiteOpenApiJson', 200, result)
  })
  await t.test('getSiteOpenApiYaml returns YAML content', async () => {
    const result = await invokeOperation(runtime, 'getSiteOpenApiYaml', {
      accept: 'application/yaml',
    })
    assert.equal(result.status, 200, result.bodyText)
    assert.ok(
      typeof result.bodyText === 'string' &&
        result.bodyText.indexOf('openapi:') !== -1,
      'Expected YAML OpenAPI response body',
    )
  })

  if (SKIP_GET_API_CATALOG_SUBTEST) {
    await t.test(
      'getApiCatalog returns linkset payload',
      { skip: 'Temporarily unstable while .well-known api-catalog fixture is finalized' },
      async () => {},
    )
  }
  else {
    await t.test('getApiCatalog returns linkset payload', async () => {
      const result = await invokeOperation(runtime, 'getApiCatalog', {
        accept: 'application/linkset+json',
      })
      assert.equal(result.status, 200, result.bodyText)
      assert.ok(result.bodyJson && typeof result.bodyJson === 'object')
      assertSchemaConformance(runtime, 'getApiCatalog', 200, result)
    })
  }

  await t.test('getSiteSummary returns site-level metadata', async () => {
    const result = await invokeOperation(runtime, 'getSiteSummary')
    assert.equal(result.status, 200, result.bodyText)
    assert.ok(result.bodyJson && result.bodyJson.data)
    assertSchemaConformance(runtime, 'getSiteSummary', 200, result)
  })
  await t.test('listEntityDescriptors returns entities collection', async () => {
    const result = await invokeOperation(runtime, 'listEntityDescriptors')
    assert.equal(result.status, 200, result.bodyText)
    assert.ok(
      result.bodyJson &&
        result.bodyJson.data &&
        Array.isArray(result.bodyJson.data.entities),
      'Expected entity descriptors array',
    )
    const integrationDescriptor = result.bodyJson.data.entities.find(
      (entity) => entity && entity.name === 'integration',
    )
    assert.ok(
      integrationDescriptor,
      'Expected integration entity descriptor to be present',
    )
    assert.equal(
      integrationDescriptor.auth,
      'authenticated-site',
      'Expected integration entity descriptor to require authenticated-site auth',
    )
    assert.ok(
      Array.isArray(integrationDescriptor.endpoints) &&
        integrationDescriptor.endpoints.some(
          (endpoint) =>
            String(endpoint || '').indexOf(
              '/v1/integrations/app-store/providers/{provider}/search',
            ) !== -1,
        ),
      'Expected integration descriptor to include app-store provider search endpoint',
    )
    assertSchemaConformance(runtime, 'listEntityDescriptors', 200, result)
  })

  await t.test('listSchemas returns schema descriptors', async () => {
    const result = await invokeOperation(runtime, 'listSchemas')
    assert.equal(result.status, 200, result.bodyText)
    assert.ok(
      result.bodyJson &&
        result.bodyJson.data &&
        Array.isArray(result.bodyJson.data.schemas),
      'Expected schema descriptor array',
    )
    assertSchemaConformance(runtime, 'listSchemas', 200, result)
  })

  await t.test('listItems returns at least one item from created site', async () => {
    const result = await invokeOperation(runtime, 'listItems', {
      query: {
        'page.limit': '10',
      },
    })
    assert.equal(result.status, 200, result.bodyText)
    assert.ok(
      result.bodyJson &&
        result.bodyJson.data &&
        Array.isArray(result.bodyJson.data.items),
      'Expected listItems data.items array',
    )
    assert.ok(
      result.bodyJson.data.items.length > 0,
      'Expected runtime-created site to include at least one item',
    )
    const firstItem = result.bodyJson.data.items[0]
    assert.ok(
      firstItem &&
        (String(firstItem.slug || '').trim() !== '' ||
          String(firstItem.id || '').trim() !== ''),
      'Expected first item to include slug or id',
    )
    runtime.dynamicContext.firstItemLookup =
      String(firstItem.slug || '').trim() !== ''
        ? String(firstItem.slug)
        : String(firstItem.id)
    runtime.dynamicContext.searchQuery = deriveSearchQueryToken(
      firstItem.title || runtime.dynamicContext.firstItemLookup,
    )
    assertSchemaConformance(runtime, 'listItems', 200, result)
  })
  await t.test('listItems supports alternate formats with representation headers', async () => {
    const formatExpectations = [
      { format: 'yaml', contentType: 'application/yaml' },
      { format: 'xml', contentType: 'application/xml' },
      { format: 'md', contentType: 'text/markdown' },
      { format: 'html', contentType: 'text/html' },
    ]
    for (let i = 0; i < formatExpectations.length; i++) {
      const formatExpectation = formatExpectations[i]
      const result = await invokeOperation(runtime, 'listItems', {
        query: {
          format: formatExpectation.format,
          'page.limit': '1',
        },
        accept: formatExpectation.contentType,
      })
      assert.equal(result.status, 200, result.bodyText)
      assert.ok(String(result.bodyText || '').trim() !== '')
      assertContentTypeIncludes(result, formatExpectation.contentType)
      assertRepresentationHeaders(result, '/v1/items')
    }
  })

  await t.test('listItems pagination bounds are clamped to supported range', async () => {
    const result = await invokeOperation(runtime, 'listItems', {
      query: {
        'page.limit': '999',
        'page.offset': '-10',
      },
    })
    assert.equal(result.status, 200, result.bodyText)
    assert.ok(
      result.bodyJson &&
        result.bodyJson.data &&
        result.bodyJson.data.page &&
        Number(result.bodyJson.data.page.limit) <= 200,
      'Expected page.limit to be clamped to max <= 200',
    )
    assert.ok(
      Number(result.bodyJson.data.page.offset) >= 0,
      'Expected page.offset to be clamped to non-negative value',
    )
    assertSchemaConformance(runtime, 'listItems', 200, result)
  })

  await t.test('getItemByIdOrSlug returns item detail payload', async () => {
    const result = await invokeOperation(runtime, 'getItemByIdOrSlug', {
      pathParams: {
        idOrSlug: runtime.dynamicContext.firstItemLookup,
      },
      query: {
        include: 'jsonld',
      },
    })
    assert.equal(result.status, 200, result.bodyText)
    assertSchemaConformance(runtime, 'getItemByIdOrSlug', 200, result)
  })

  await t.test('getItemByIdOrSlug returns 404 for unknown item', async () => {
    const result = await invokeOperation(runtime, 'getItemByIdOrSlug', {
      pathParams: {
        idOrSlug: `missing-item-${runtime.testStartTimestamp}`,
      },
    })
    assert.equal(result.status, 404, result.bodyText)
    assertSchemaConformance(runtime, 'getItemByIdOrSlug', 404, result)
  })

  await t.test('listContent returns bundle content records', async () => {
    const result = await invokeOperation(runtime, 'listContent', {
      query: {
        mode: 'bundle',
      },
    })
    assert.equal(result.status, 200, result.bodyText)
    assert.ok(
      result.bodyJson &&
        result.bodyJson.data &&
        Array.isArray(result.bodyJson.data.content),
      'Expected listContent bundle payload',
    )
    assertSchemaConformance(runtime, 'listContent', 200, result)
  })

  await t.test('listContent supports html concat representation and response headers', async () => {
    const result = await invokeOperation(runtime, 'listContent', {
      query: {
        mode: 'concat',
        format: 'html',
      },
      accept: 'text/html',
    })
    assert.equal(result.status, 200, result.bodyText)
    assertContentTypeIncludes(result, 'text/html')
    assertRepresentationHeaders(result, '/v1/content')
  })

  await t.test('getContentByIdOrSlug returns content detail record', async () => {
    const result = await invokeOperation(runtime, 'getContentByIdOrSlug', {
      pathParams: {
        idOrSlug: runtime.dynamicContext.firstItemLookup,
      },
    })
    assert.equal(result.status, 200, result.bodyText)
    assertSchemaConformance(runtime, 'getContentByIdOrSlug', 200, result)
  })

  await t.test('getContentByIdOrSlug returns 404 for unknown item content', async () => {
    const result = await invokeOperation(runtime, 'getContentByIdOrSlug', {
      pathParams: {
        idOrSlug: `missing-content-${runtime.testStartTimestamp}`,
      },
    })
    assert.equal(result.status, 404, result.bodyText)
    assertSchemaConformance(runtime, 'getContentByIdOrSlug', 404, result)
  })

  await t.test('searchContent rejects missing required query parameter', async () => {
    const result = await invokeOperation(runtime, 'searchContent', {
      skipRequiredQuery: true,
    })
    assert.equal(result.status, 400, result.bodyText)
    assertSchemaConformance(runtime, 'searchContent', 400, result)
  })

  await t.test('searchContent enforces max query length', async () => {
    const result = await invokeOperation(runtime, 'searchContent', {
      query: {
        q: 'a'.repeat(257),
      },
    })
    assert.equal(result.status, 400, result.bodyText)
    assertSchemaConformance(runtime, 'searchContent', 400, result)
  })

  await t.test('searchContent accepts required query parameter and returns schema-compliant output', async () => {
    const result = await invokeOperation(runtime, 'searchContent', {
      query: {
        q: runtime.dynamicContext.searchQuery || 'welcome',
      },
    })
    assert.equal(result.status, 200, result.bodyText)
    assertSchemaConformance(runtime, 'searchContent', 200, result)
  })
  await t.test('listTags returns tag collection', async () => {
    const result = await invokeOperation(runtime, 'listTags', {
      query: {
        include: 'items',
      },
    })
    assert.equal(result.status, 200, result.bodyText)
    assertSchemaConformance(runtime, 'listTags', 200, result)
  })

  await t.test('listCustomElements returns available element descriptors', async () => {
    const result = await invokeOperation(runtime, 'listCustomElements')
    assert.equal(result.status, 200, result.bodyText)
    assert.ok(
      result.bodyJson &&
        result.bodyJson.data &&
        Array.isArray(result.bodyJson.data.customElements),
      'Expected customElements array',
    )
    assert.ok(
      result.bodyJson.data.customElements.length > 0,
      'Expected at least one custom element descriptor',
    )
    runtime.dynamicContext.firstCustomElementTag = String(
      result.bodyJson.data.customElements[0].tag || '',
    )
    assert.ok(
      runtime.dynamicContext.firstCustomElementTag !== '',
      'Expected first custom element tag',
    )
    assertSchemaConformance(runtime, 'listCustomElements', 200, result)
  })

  await t.test('getCustomElementByName returns detail for known element', async () => {
    const result = await invokeOperation(runtime, 'getCustomElementByName', {
      pathParams: {
        webcomponentName: runtime.dynamicContext.firstCustomElementTag,
      },
      query: {
        include: 'haxProperties,haxSchema,haxElementSchema',
      },
    })
    assert.equal(result.status, 200, result.bodyText)
    assertSchemaConformance(runtime, 'getCustomElementByName', 200, result)
  })

  await t.test('getCustomElementByName returns 404 for unknown element', async () => {
    const result = await invokeOperation(runtime, 'getCustomElementByName', {
      pathParams: {
        webcomponentName: `missing-element-${runtime.testStartTimestamp}`,
      },
    })
    assert.equal(result.status, 404, result.bodyText)
    assertSchemaConformance(runtime, 'getCustomElementByName', 404, result)
  })

  await t.test('listBlocks returns block records', async () => {
    const result = await invokeOperation(runtime, 'listBlocks')
    assert.equal(result.status, 200, result.bodyText)
    assert.ok(
      result.bodyJson &&
        result.bodyJson.data &&
        Array.isArray(result.bodyJson.data.blocks),
      'Expected blocks array',
    )
    assert.ok(result.bodyJson.data.blocks.length > 0, 'Expected at least one block')
    runtime.dynamicContext.firstBlockTag = String(
      result.bodyJson.data.blocks[0].tag || '',
    )
    assert.ok(runtime.dynamicContext.firstBlockTag !== '', 'Expected block tag')
    assertSchemaConformance(runtime, 'listBlocks', 200, result)
  })

  await t.test('getBlockByName returns block detail', async () => {
    const result = await invokeOperation(runtime, 'getBlockByName', {
      pathParams: {
        webcomponentName: runtime.dynamicContext.firstBlockTag,
      },
      query: {
        include: 'haxProperties,haxSchema',
      },
    })
    assert.equal(result.status, 200, result.bodyText)
    assertSchemaConformance(runtime, 'getBlockByName', 200, result)
  })

  await t.test('getBlockUsage returns block usage collection', async () => {
    const result = await invokeOperation(runtime, 'getBlockUsage', {
      pathParams: {
        webcomponentName: runtime.dynamicContext.firstBlockTag,
      },
    })
    assert.equal(result.status, 200, result.bodyText)
    assertSchemaConformance(runtime, 'getBlockUsage', 200, result)
  })

  await t.test('listRegions returns region records', async () => {
    const result = await invokeOperation(runtime, 'listRegions')
    assert.equal(result.status, 200, result.bodyText)
    assert.ok(
      result.bodyJson &&
        result.bodyJson.data &&
        Array.isArray(result.bodyJson.data.regions),
      'Expected regions array',
    )
    assert.ok(
      result.bodyJson.data.regions.length > 0,
      'Expected at least one region descriptor',
    )
    runtime.dynamicContext.firstRegionName = String(
      result.bodyJson.data.regions[0].name || '',
    )
    assert.ok(runtime.dynamicContext.firstRegionName !== '', 'Expected region name')
    assertSchemaConformance(runtime, 'listRegions', 200, result)
  })

  await t.test('getRegionByName returns region detail', async () => {
    const result = await invokeOperation(runtime, 'getRegionByName', {
      pathParams: {
        regionName: runtime.dynamicContext.firstRegionName,
      },
    })
    assert.equal(result.status, 200, result.bodyText)
    assertSchemaConformance(runtime, 'getRegionByName', 200, result)
  })

  await t.test('getRegionByName returns 404 for unknown region', async () => {
    const result = await invokeOperation(runtime, 'getRegionByName', {
      pathParams: {
        regionName: `missing-region-${runtime.testStartTimestamp}`,
      },
    })
    assert.equal(result.status, 404, result.bodyText)
    assertSchemaConformance(runtime, 'getRegionByName', 404, result)
  })

  await t.test('listThemes returns theme records', async () => {
    const result = await invokeOperation(runtime, 'listThemes', {
      query: {
        includeDisabled: 'true',
      },
    })
    assert.equal(result.status, 200, result.bodyText)
    assert.ok(
      result.bodyJson &&
        result.bodyJson.data &&
        Array.isArray(result.bodyJson.data.themes),
      'Expected themes array',
    )
    assert.ok(result.bodyJson.data.themes.length > 0, 'Expected at least one theme')
    runtime.dynamicContext.firstThemeName = String(
      result.bodyJson.data.themes[0].machineName || '',
    )
    assert.ok(runtime.dynamicContext.firstThemeName !== '', 'Expected theme name')
    assertSchemaConformance(runtime, 'listThemes', 200, result)
  })

  await t.test('getActiveTheme returns active theme record', async () => {
    const result = await invokeOperation(runtime, 'getActiveTheme')
    assert.equal(result.status, 200, result.bodyText)
    assertSchemaConformance(runtime, 'getActiveTheme', 200, result)
  })

  await t.test('getThemeByName returns theme detail', async () => {
    const result = await invokeOperation(runtime, 'getThemeByName', {
      pathParams: {
        themeName: runtime.dynamicContext.firstThemeName,
      },
    })
    assert.equal(result.status, 200, result.bodyText)
    assertSchemaConformance(runtime, 'getThemeByName', 200, result)
  })

  await t.test('getThemeByName returns 404 for unknown theme', async () => {
    const result = await invokeOperation(runtime, 'getThemeByName', {
      pathParams: {
        themeName: `missing-theme-${runtime.testStartTimestamp}`,
      },
    })
    assert.equal(result.status, 404, result.bodyText)
    assertSchemaConformance(runtime, 'getThemeByName', 404, result)
  })

  await t.test('listViews returns available view descriptors', async () => {
    const result = await invokeOperation(runtime, 'listViews')
    assert.equal(result.status, 200, result.bodyText)
    assert.ok(
      result.bodyJson &&
        result.bodyJson.data &&
        Array.isArray(result.bodyJson.data.views),
      'Expected listViews data.views array',
    )
    assert.ok(result.bodyJson.data.views.length > 0, 'Expected at least one view')
    runtime.dynamicContext.firstViewId = String(
      result.bodyJson.data.views[0].id || '',
    )
    assert.ok(
      runtime.dynamicContext.firstViewId !== '',
      'Expected first view to include id',
    )
    assertSchemaConformance(runtime, 'listViews', 200, result)
  })
  await t.test('getViewById returns one view descriptor', async () => {
    const result = await invokeOperation(runtime, 'getViewById', {
      pathParams: {
        viewId: runtime.dynamicContext.firstViewId,
      },
    })
    assert.equal(result.status, 200, result.bodyText)
    assertSchemaConformance(runtime, 'getViewById', 200, result)
  })

  await t.test('getViewById returns 404 for unknown id', async () => {
    const result = await invokeOperation(runtime, 'getViewById', {
      pathParams: {
        viewId: `missing-view-${runtime.testStartTimestamp}`,
      },
    })
    assert.equal(result.status, 404, result.bodyText)
    assertSchemaConformance(runtime, 'getViewById', 404, result)
  })

  await t.test('getViewResults resolves view output by id', async () => {
    const result = await invokeOperation(runtime, 'getViewResults', {
      pathParams: {
        viewId: runtime.dynamicContext.firstViewId,
      },
    })
    assert.equal(result.status, 200, result.bodyText)
    assertSchemaConformance(runtime, 'getViewResults', 200, result)
  })
  await t.test('listDisplaysAlias returns views collection alias', async () => {
    const result = await invokeOperation(runtime, 'listDisplaysAlias')
    assert.equal(result.status, 200, result.bodyText)
    assertSchemaConformance(runtime, 'listDisplaysAlias', 200, result)
  })

  await t.test('getDisplayResultsAlias returns view results alias', async () => {
    const result = await invokeOperation(runtime, 'getDisplayResultsAlias', {
      pathParams: {
        viewId: runtime.dynamicContext.firstViewId,
      },
    })
    assert.equal(result.status, 200, result.bodyText)
    assertSchemaConformance(runtime, 'getDisplayResultsAlias', 200, result)
  })
  await t.test('searchAppStoreProvider enforces bearer and site token auth matrix', async () => {
    await assertSecuredOperationAuthMatrix(runtime, 'searchAppStoreProvider', {
      pathParams: {
        provider: 'nasa',
      },
    })
  })
  await t.test('searchAppStoreProvider rejects unknown provider with site auth', async () => {
    const result = await invokeOperation(runtime, 'searchAppStoreProvider', {
      pathParams: {
        provider: `missing-provider-${runtime.testStartTimestamp}`,
      },
      headers: getSiteAuthHeaders(runtime),
    })
    assert.equal(result.status, 400, result.bodyText)
    assertSchemaConformance(runtime, 'searchAppStoreProvider', 400, result)
  })

  await t.test('listFiles enforces bearer and site token auth matrix', async () => {
    await assertSecuredOperationAuthMatrix(runtime, 'listFiles')
  })

  await t.test('listFiles succeeds with site-authenticated headers', async () => {
    const result = await invokeOperation(runtime, 'listFiles', {
      headers: getSiteAuthHeaders(runtime),
    })
    assert.equal(result.status, 200, result.bodyText)
    assertRepresentationHeaders(result, '/v1/files')
    assertSchemaConformance(runtime, 'listFiles', 200, result)
  })

  await t.test('listFiles supports yaml representation with metadata headers', async () => {
    const result = await invokeOperation(runtime, 'listFiles', {
      headers: getSiteAuthHeaders(runtime),
      query: {
        format: 'yaml',
      },
      accept: 'application/yaml',
    })
    assert.equal(result.status, 200, result.bodyText)
    assertContentTypeIncludes(result, 'application/yaml')
    assertRepresentationHeaders(result, '/v1/files')
  })

  await t.test('listReports enforces bearer and site token auth matrix', async () => {
    await assertSecuredOperationAuthMatrix(runtime, 'listReports')
  })

  await t.test('listReports returns report descriptors with site auth', async () => {
    const result = await invokeOperation(runtime, 'listReports', {
      headers: getSiteAuthHeaders(runtime),
    })
    assert.equal(result.status, 200, result.bodyText)
    assert.ok(
      result.bodyJson &&
        result.bodyJson.data &&
        Array.isArray(result.bodyJson.data.reports),
      'Expected report descriptors array',
    )
    assert.ok(result.bodyJson.data.reports.length > 0, 'Expected at least one report')
    runtime.dynamicContext.firstReportName = String(
      result.bodyJson.data.reports[0].id || '',
    )
    assert.ok(runtime.dynamicContext.firstReportName !== '', 'Expected report id')
    assertSchemaConformance(runtime, 'listReports', 200, result)
  })

  await t.test('getReportByName enforces bearer and site token auth matrix', async () => {
    await assertSecuredOperationAuthMatrix(runtime, 'getReportByName', {
      pathParams: {
        report: runtime.dynamicContext.firstReportName,
      },
    })
  })

  await t.test('getReportByName returns report payload with site auth', async () => {
    const result = await invokeOperation(runtime, 'getReportByName', {
      pathParams: {
        report: runtime.dynamicContext.firstReportName,
      },
      headers: getSiteAuthHeaders(runtime),
    })
    assert.equal(result.status, 200, result.bodyText)
    assertSchemaConformance(runtime, 'getReportByName', 200, result)
  })

  await t.test('getReportByName supports xml representation', async () => {
    const result = await invokeOperation(runtime, 'getReportByName', {
      pathParams: {
        report: runtime.dynamicContext.firstReportName,
      },
      headers: getSiteAuthHeaders(runtime),
      query: {
        format: 'xml',
      },
      accept: 'application/xml',
    })
    assert.equal(result.status, 200, result.bodyText)
    assertContentTypeIncludes(result, 'application/xml')
  })

  await t.test('getAnalyticsCapabilities returns analytics metadata', async () => {
    const result = await invokeOperation(runtime, 'getAnalyticsCapabilities')
    assert.equal(result.status, 200, result.bodyText)
    assertSchemaConformance(runtime, 'getAnalyticsCapabilities', 200, result)
  })

  await t.test('listItemRevisions enforces bearer and site token auth matrix', async () => {
    await assertSecuredOperationAuthMatrix(runtime, 'listItemRevisions', {
      pathParams: {
        idOrSlug: runtime.dynamicContext.firstItemLookup,
      },
    })
  })

  await t.test('listItemRevisions succeeds with site-authenticated headers', async () => {
    const result = await invokeOperation(runtime, 'listItemRevisions', {
      pathParams: {
        idOrSlug: runtime.dynamicContext.firstItemLookup,
      },
      headers: getSiteAuthHeaders(runtime),
    })
    assert.equal(result.status, 200, result.bodyText)
    assertSchemaConformance(runtime, 'listItemRevisions', 200, result)
    const revisions =
      result.bodyJson &&
      result.bodyJson.data &&
      Array.isArray(result.bodyJson.data.revisions)
        ? result.bodyJson.data.revisions
        : []
    assert.ok(revisions.length > 0, 'Expected at least one item revision')
    runtime.dynamicContext.firstItemRevisionHash = String(
      revisions[0] && revisions[0].hash ? revisions[0].hash : '',
    )
    assert.ok(
      runtime.dynamicContext.firstItemRevisionHash !== '',
      'Expected first item revision hash',
    )
  })

  await t.test('getItemRevisionById enforces bearer and site token auth matrix', async () => {
    await assertSecuredOperationAuthMatrix(runtime, 'getItemRevisionById', {
      pathParams: {
        idOrSlug: runtime.dynamicContext.firstItemLookup,
        revisionId: runtime.dynamicContext.firstItemRevisionHash,
      },
    })
  })

  await t.test('getItemRevisionById succeeds with site-authenticated headers', async () => {
    const result = await invokeOperation(runtime, 'getItemRevisionById', {
      pathParams: {
        idOrSlug: runtime.dynamicContext.firstItemLookup,
        revisionId: runtime.dynamicContext.firstItemRevisionHash,
      },
      headers: getSiteAuthHeaders(runtime),
    })
    assert.equal(result.status, 200, result.bodyText)
    assertSchemaConformance(runtime, 'getItemRevisionById', 200, result)
  })

  await t.test('restoreItemRevision enforces bearer and site token auth matrix', async () => {
    await assertSecuredOperationAuthMatrix(runtime, 'restoreItemRevision', {
      pathParams: {
        idOrSlug: runtime.dynamicContext.firstItemLookup,
        revisionId: runtime.dynamicContext.firstItemRevisionHash,
      },
    })
  })

  await t.test('restoreItemRevision succeeds with site-authenticated headers', async () => {
    const result = await invokeOperation(runtime, 'restoreItemRevision', {
      pathParams: {
        idOrSlug: runtime.dynamicContext.firstItemLookup,
        revisionId: runtime.dynamicContext.firstItemRevisionHash,
      },
      headers: getSiteAuthHeaders(runtime),
    })
    assert.equal(result.status, 200, result.bodyText)
    assertSchemaConformance(runtime, 'restoreItemRevision', 200, result)
  })

  await t.test('create/get/update/delete file lifecycle with auth matrix and reset checks', async () => {
    const upload = buildMultipartBody({
      fileName: `api-conformance-${runtime.testStartTimestamp}.txt`,
      fileContents: `conformance runtime upload ${runtime.testStartTimestamp}`,
    })
    const createBaseOptions = {
      headers: {
        'content-type': `multipart/form-data; boundary=${upload.boundary}`,
      },
      body: upload.body,
    }

    await assertSecuredOperationAuthMatrix(
      runtime,
      'createFile',
      createBaseOptions,
    )

    const createResult = await invokeOperation(
      runtime,
      'createFile',
      mergeInvocationOptions(createBaseOptions, {
        headers: getSiteAuthHeaders(runtime),
      }),
    )
    assert.equal(createResult.status, 200, createResult.bodyText)
    assertSchemaConformance(runtime, 'createFile', 200, createResult)
    assert.ok(
      createResult.bodyJson &&
        createResult.bodyJson.data &&
        createResult.bodyJson.data.file,
      'Expected createFile to return uploaded file payload',
    )
    runtime.dynamicContext.uploadedFileName = String(
      createResult.bodyJson.data.file.name || upload.fileName,
    )

    const createdFileLookup = await invokeOperation(runtime, 'listFiles', {
      headers: getSiteAuthHeaders(runtime),
      query: {
        'filter.nameContains': runtime.dynamicContext.uploadedFileName,
      },
    })
    assert.equal(createdFileLookup.status, 200, createdFileLookup.bodyText)
    assert.ok(
      createdFileLookup.bodyJson &&
        createdFileLookup.bodyJson.data &&
        Array.isArray(createdFileLookup.bodyJson.data.files) &&
        createdFileLookup.bodyJson.data.files.length > 0,
      'Expected uploaded file to be discoverable via listFiles',
    )
    runtime.dynamicContext.uploadedFileUuid = String(
      createdFileLookup.bodyJson.data.files[0].uuid || '',
    )
    assert.ok(
      runtime.dynamicContext.uploadedFileUuid !== '',
      'Expected uploaded file uuid',
    )

    await assertSecuredOperationAuthMatrix(runtime, 'getFileByUuid', {
      pathParams: {
        fileUuid: runtime.dynamicContext.uploadedFileUuid,
      },
    })

    const getFileResult = await invokeOperation(runtime, 'getFileByUuid', {
      pathParams: {
        fileUuid: runtime.dynamicContext.uploadedFileUuid,
      },
      headers: getSiteAuthHeaders(runtime),
    })
    assert.equal(getFileResult.status, 200, getFileResult.bodyText)
    assertSchemaConformance(runtime, 'getFileByUuid', 200, getFileResult)

    const renamedFileName = `api-conformance-renamed-${runtime.testStartTimestamp}.txt`
    const updateBaseOptions = {
      pathParams: {
        fileUuid: runtime.dynamicContext.uploadedFileUuid,
      },
      body: {
        operation: 'rename',
        newName: renamedFileName,
      },
    }
    await assertSecuredOperationAuthMatrix(
      runtime,
      'updateFileByUuid',
      updateBaseOptions,
    )

    const updateResult = await invokeOperation(
      runtime,
      'updateFileByUuid',
      mergeInvocationOptions(updateBaseOptions, {
        headers: getSiteAuthHeaders(runtime),
      }),
    )
    assert.equal(updateResult.status, 200, updateResult.bodyText)
    assertSchemaConformance(runtime, 'updateFileByUuid', 200, updateResult)
    assert.ok(
      updateResult.bodyJson &&
        updateResult.bodyJson.data &&
        updateResult.bodyJson.data.file &&
        updateResult.bodyJson.data.file.uuid,
      'Expected updateFileByUuid rename response with updated file payload',
    )
    runtime.dynamicContext.renamedFileUuid = String(
      updateResult.bodyJson.data.file.uuid,
    )

    const deleteBaseOptions = {
      pathParams: {
        fileUuid: runtime.dynamicContext.renamedFileUuid,
      },
    }
    await assertSecuredOperationAuthMatrix(
      runtime,
      'deleteFileByUuid',
      deleteBaseOptions,
    )

    const deleteResult = await invokeOperation(
      runtime,
      'deleteFileByUuid',
      mergeInvocationOptions(deleteBaseOptions, {
        headers: getSiteAuthHeaders(runtime),
      }),
    )
    assert.equal(deleteResult.status, 200, deleteResult.bodyText)
    assertSchemaConformance(runtime, 'deleteFileByUuid', 200, deleteResult)

    const deletedLookupResult = await invokeOperation(runtime, 'getFileByUuid', {
      pathParams: {
        fileUuid: runtime.dynamicContext.renamedFileUuid,
      },
      headers: getSiteAuthHeaders(runtime),
    })
    assert.equal(deletedLookupResult.status, 404, deletedLookupResult.bodyText)
    assertSchemaConformance(runtime, 'getFileByUuid', 404, deletedLookupResult)
  })
})
test('system API site lifecycle routes use siteName path templates', async () => {
  const expectedOperationPaths = {
    siteInfoGet: '/system/api/v1/sites/{siteName}',
    siteInfoPost: '/system/api/v1/sites/{siteName}',
    cloneSite: '/system/api/v1/sites/{siteName}/clone',
    archiveSite: '/system/api/v1/sites/{siteName}/archive',
    downloadSite: '/system/api/v1/sites/{siteName}/download',
    downloadSiteSkeleton: '/system/api/v1/sites/{siteName}/download-skeleton',
    saveSiteAsTemplate: '/system/api/v1/sites/{siteName}/save-as-template',
  }
  const operationIds = Object.keys(expectedOperationPaths)
  for (let i = 0; i < operationIds.length; i++) {
    const operationId = operationIds[i]
    const operationMeta = runtime.systemOperationIndex[operationId]
    assert.ok(
      operationMeta,
      `Missing required operationId "${operationId}" in system-spec`,
    )
    assert.equal(
      operationMeta.path,
      expectedOperationPaths[operationId],
      `${operationId} must use ${expectedOperationPaths[operationId]}`,
    )
  }
  const legacyPaths = [
    '/system/api/v1/sites/clone',
    '/system/api/v1/sites/archive',
    '/system/api/v1/sites/download',
    '/system/api/v1/sites/download-skeleton',
    '/system/api/v1/sites/save-as-template',
  ]
  for (let i = 0; i < legacyPaths.length; i++) {
    const legacyPath = legacyPaths[i]
    assert.ok(
      !Object.prototype.hasOwnProperty.call(runtime.systemSpec.paths, legacyPath),
      `Legacy system-spec path should be removed: ${legacyPath}`,
    )
  }
})
test('system API route groups match normalized v1 path structure', async () => {
  const expectedOperationPaths = {
    generateAppStore: '/system/api/v1/integrations/app-store',
    systemStatusGet: '/system/api/v1/status',
    getApiKeys: '/system/api/v1/configuration/api-keys',
    getMediaSettings: '/system/api/v1/configuration/media',
    schemaFileOperation: '/system/api/v1/configuration/schema-files/operations',
    systemThemesGet: '/system/api/v1/themes',
    saveEnabledThemesPost: '/system/api/v1/themes',
    systemBlocksGet: '/system/api/v1/blocks',
    saveEnabledBlocksPost: '/system/api/v1/blocks',
    systemSkeletonsPost: '/system/api/v1/skeletons',
    saveEnabledSkeletonsPatch: '/system/api/v1/skeletons',
  }
  const operationIds = Object.keys(expectedOperationPaths)
  for (let i = 0; i < operationIds.length; i++) {
    const operationId = operationIds[i]
    const operationMeta = runtime.systemOperationIndex[operationId]
    assert.ok(
      operationMeta,
      `Missing required operationId "${operationId}" in system-spec`,
    )
    assert.equal(
      operationMeta.path,
      expectedOperationPaths[operationId],
      `${operationId} must use ${expectedOperationPaths[operationId]}`,
    )
  }
  const legacyPaths = [
    '/system/api/v1/system/app-store',
    '/system/api/v1/system/status',
    '/system/api/v1/settings/api-keys',
    '/system/api/v1/settings/media',
    '/system/api/v1/settings/schema-files/operations',
    '/system/api/v1/settings/enabled-themes',
    '/system/api/v1/settings/enabled-blocks',
    '/system/api/v1/settings/enabled-skeletons',
    '/system/api/v1/system/themes',
    '/system/api/v1/system/blocks',
  ]
  for (let i = 0; i < legacyPaths.length; i++) {
    const legacyPath = legacyPaths[i]
    assert.ok(
      !Object.prototype.hasOwnProperty.call(runtime.systemSpec.paths, legacyPath),
      `Legacy system-spec path should be removed: ${legacyPath}`,
    )
  }
})
test('system API conformance for skeleton resource semantics', async (t) => {
  const requiredOperationIds = [
    'systemSkeletonsGet',
    'systemSkeletonsPost',
    'systemSkeletonDetailGet',
    'systemSkeletonDetailPatch',
    'systemSkeletonDetailPut',
    'systemSkeletonDetailDelete',
  ]
  for (let i = 0; i < requiredOperationIds.length; i++) {
    const operationId = requiredOperationIds[i]
    assert.ok(
      runtime.systemOperationIndex[operationId],
      `Missing required operationId "${operationId}" in system-spec`,
    )
  }

  await t.test(
    'skeleton operations declare bearer plus user token header security in system-spec',
    async () => {
      for (let i = 0; i < requiredOperationIds.length; i++) {
        const operationId = requiredOperationIds[i]
        const operationMeta = runtime.systemOperationIndex[operationId]
        const security = Array.isArray(operationMeta.operation.security)
          ? operationMeta.operation.security
          : []
        assert.ok(
          security.some(
            (entry) =>
              entry &&
              typeof entry === 'object' &&
              Object.prototype.hasOwnProperty.call(entry, 'bearerAuth') &&
              Object.prototype.hasOwnProperty.call(entry, 'userTokenHeader'),
          ),
          `${operationId} must declare bearerAuth + userTokenHeader security`,
        )
      }
    },
  )

  await t.test('systemSkeletonsGet enforces auth matrix and returns data', async () => {
    await assertSystemUserSecuredOperationAuthMatrix(runtime, 'systemSkeletonsGet')
    const listResult = await invokeSystemOperation(runtime, 'systemSkeletonsGet', {
      headers: getSystemUserAuthHeaders(runtime),
    })
    assert.equal(listResult.status, 200, listResult.bodyText)
    assertSystemSchemaConformance(runtime, 'systemSkeletonsGet', 200, listResult)
  })

  await t.test('systemSkeletonsPost uploads a skeleton resource', async () => {
    const upload = buildMultipartBody({
      fieldName: 'file',
      fileName: `api-conformance-skeleton-${runtime.testStartTimestamp}.json`,
      mimeType: 'application/json',
      fileContents: JSON.stringify({
        title: 'Conformance Skeleton',
        metadata: {
          generatedBy: 'api-conformance',
        },
      }),
      extraFields: {
        action: 'upload',
        schema: 'skeleton',
      },
    })
    const uploadBaseOptions = {
      headers: {
        'content-type': `multipart/form-data; boundary=${upload.boundary}`,
      },
      body: upload.body,
    }

    await assertSystemUserSecuredOperationAuthMatrix(
      runtime,
      'systemSkeletonsPost',
      uploadBaseOptions,
    )

    const uploadResult = await invokeSystemOperation(
      runtime,
      'systemSkeletonsPost',
      mergeInvocationOptions(uploadBaseOptions, {
        headers: getSystemUserAuthHeaders(runtime),
      }),
    )
    assert.equal(uploadResult.status, 200, uploadResult.bodyText)
    assertSystemSchemaConformance(runtime, 'systemSkeletonsPost', 200, uploadResult)
    const uploadedMachineName =
      uploadResult &&
      uploadResult.bodyJson &&
      uploadResult.bodyJson.data &&
      typeof uploadResult.bodyJson.data.machineName === 'string' &&
      uploadResult.bodyJson.data.machineName.trim() !== ''
        ? uploadResult.bodyJson.data.machineName.trim()
        : ''
    assert.ok(uploadedMachineName !== '', 'Expected uploaded skeleton machineName')
    runtime.dynamicContext.systemSkeletonName = uploadedMachineName
  })

  await t.test('systemSkeletonDetailGet returns uploaded skeleton detail', async () => {
    const detailBaseOptions = {
      pathParams: {
        skeletonName: runtime.dynamicContext.systemSkeletonName,
      },
    }
    await assertSystemUserSecuredOperationAuthMatrix(
      runtime,
      'systemSkeletonDetailGet',
      detailBaseOptions,
    )

    const detailResult = await invokeSystemOperation(
      runtime,
      'systemSkeletonDetailGet',
      mergeInvocationOptions(detailBaseOptions, {
        headers: getSystemUserAuthHeaders(runtime),
      }),
    )
    assert.equal(detailResult.status, 200, detailResult.bodyText)
    assertSystemSchemaConformance(runtime, 'systemSkeletonDetailGet', 200, detailResult)
  })

  await t.test('systemSkeletonDetailPatch renames uploaded skeleton', async () => {
    const renamedMachineName = `api-conformance-skeleton-renamed-${runtime.testStartTimestamp}`
    const renameBaseOptions = {
      pathParams: {
        skeletonName: runtime.dynamicContext.systemSkeletonName,
      },
      body: {
        newName: renamedMachineName,
      },
    }
    await assertSystemUserSecuredOperationAuthMatrix(
      runtime,
      'systemSkeletonDetailPatch',
      renameBaseOptions,
    )
    const renameResult = await invokeSystemOperation(
      runtime,
      'systemSkeletonDetailPatch',
      mergeInvocationOptions(renameBaseOptions, {
        headers: getSystemUserAuthHeaders(runtime),
      }),
    )
    assert.equal(renameResult.status, 200, renameResult.bodyText)
    assertSystemSchemaConformance(runtime, 'systemSkeletonDetailPatch', 200, renameResult)
    runtime.dynamicContext.systemSkeletonRenamed = renamedMachineName
  })

  await t.test('systemSkeletonDetailDelete removes renamed skeleton', async () => {
    const deleteBaseOptions = {
      pathParams: {
        skeletonName: runtime.dynamicContext.systemSkeletonRenamed,
      },
    }
    await assertSystemUserSecuredOperationAuthMatrix(
      runtime,
      'systemSkeletonDetailDelete',
      deleteBaseOptions,
    )
    const deleteResult = await invokeSystemOperation(
      runtime,
      'systemSkeletonDetailDelete',
      mergeInvocationOptions(deleteBaseOptions, {
        headers: getSystemUserAuthHeaders(runtime),
      }),
    )
    assert.equal(deleteResult.status, 200, deleteResult.bodyText)
    assertSystemSchemaConformance(runtime, 'systemSkeletonDetailDelete', 200, deleteResult)

    const deletedLookup = await invokeSystemOperation(runtime, 'systemSkeletonDetailGet', {
      pathParams: {
        skeletonName: runtime.dynamicContext.systemSkeletonRenamed,
      },
      headers: getSystemUserAuthHeaders(runtime),
    })
    assert.equal(deletedLookup.status, 404, deletedLookup.bodyText)
    assertSystemSchemaConformance(runtime, 'systemSkeletonDetailGet', 404, deletedLookup)
  })
})
