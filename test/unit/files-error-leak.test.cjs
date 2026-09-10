'use strict'

// Security (HAX-SEC-006 / error-leak) unit tests for resolveClientFacingErrorMessage
// in src/siteRoutes/v1/files.js. Proves that only intentional
// createStatusError validation messages (which carry a .status) surface to
// clients; unexpected internal exceptions (no .status) get the generic
// fallback so internal paths/structure are never disclosed.
//
// Constraints honored: CommonJS (.cjs), require(), globalThis (not window),
// NO optional chaining (explicit && guards), node:test + node:assert/strict.

const { test } = require('node:test')
const assert = require('node:assert/strict')

const {
  resolveClientFacingErrorMessage,
} = require('../../src/siteRoutes/v1/files.js')

test('surfaces the intentional message for a createStatusError with a status', () => {
  const err = new Error('Invalid file path')
  err.status = 400
  assert.equal(
    resolveClientFacingErrorMessage(err, 'Unable to load file'),
    'Invalid file path',
  )
})

test('surfaces the intentional message for a 500 createStatusError (operational)', () => {
  const err = new Error('Files directory was not found')
  err.status = 500
  assert.equal(
    resolveClientFacingErrorMessage(err, 'Unable to load file'),
    'Files directory was not found',
  )
})

test('genericizes an unexpected internal Error with no status (no path leak)', () => {
  const err = new Error("EACCES: permission denied, open '/var/secret/internal.js'")
  assert.equal(
    resolveClientFacingErrorMessage(err, 'Unable to save file'),
    'Unable to save file',
  )
})

test('genericizes a plain object with a message but no status', () => {
  assert.equal(
    resolveClientFacingErrorMessage({ message: 'internal path leak' }, 'Unable to load file'),
    'Unable to load file',
  )
})

test('genericizes null/undefined errors', () => {
  assert.equal(resolveClientFacingErrorMessage(null, 'Unable to load file'), 'Unable to load file')
  assert.equal(
    resolveClientFacingErrorMessage(undefined, 'Unable to complete file operation'),
    'Unable to complete file operation',
  )
})

test('genericizes an empty error object', () => {
  assert.equal(
    resolveClientFacingErrorMessage({}, 'Unable to complete file operation'),
    'Unable to complete file operation',
  )
})

test('falls back when status is present but message is empty', () => {
  assert.equal(
    resolveClientFacingErrorMessage({ status: 400, message: '' }, 'Unable to load file'),
    'Unable to load file',
  )
})

test('falls back when message is present but status is missing', () => {
  assert.equal(
    resolveClientFacingErrorMessage({ message: 'no status here' }, 'Unable to save file'),
    'Unable to save file',
  )
})
