const fs = require('fs')
const path = require('path')

const { sanitizeHTMLForStorage } = require('../src/lib/sanitizeContent')

const payloadFile = path.join(__dirname, 'sanitize-policy-payloads.json')
const payloads = JSON.parse(fs.readFileSync(payloadFile, 'utf8'))

let hasFailure = false

payloads.forEach(function (payload) {
  const name = payload && payload.name ? payload.name : 'unnamed'
  const input = payload && payload.input ? payload.input : ''
  const output = sanitizeHTMLForStorage(input)
  const mustContain = payload && Array.isArray(payload.mustContain) ? payload.mustContain : []
  const mustNotContain = payload && Array.isArray(payload.mustNotContain) ? payload.mustNotContain : []

  mustContain.forEach(function (requiredSnippet) {
    if (output.indexOf(requiredSnippet) === -1) {
      hasFailure = true
      console.error('FAIL [' + name + '] missing snippet: ' + requiredSnippet)
      console.error('Output:', output)
    }
  })

  mustNotContain.forEach(function (forbiddenSnippet) {
    if (output.indexOf(forbiddenSnippet) !== -1) {
      hasFailure = true
      console.error('FAIL [' + name + '] found forbidden snippet: ' + forbiddenSnippet)
      console.error('Output:', output)
    }
  })
})

if (hasFailure) {
  process.exit(1)
}

console.log('Sanitizer policy verification passed for ' + payloads.length + ' payloads.')
