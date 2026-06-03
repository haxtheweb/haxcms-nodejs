#!/usr/bin/env node

const { spawn } = require('child_process')
const net = require('net')

const DEFAULT_PORT = 3000
const MAX_PORT = 65535

function getStartPort() {
  const parsedPort = Number.parseInt(process.env.PORT, 10)
  if (Number.isNaN(parsedPort) || parsedPort < 1 || parsedPort > MAX_PORT) {
    return DEFAULT_PORT
  }
  return parsedPort
}

function canListenOnPort(port) {
  return new Promise((resolve, reject) => {
    const tester = net.createServer()
    tester.once('error', (e) => {
      if (e && (e.code === 'EADDRINUSE' || e.code === 'EACCES')) {
        resolve(false)
      }
      else {
        reject(e)
      }
    })
    tester.once('listening', () => {
      tester.close((closeError) => {
        if (closeError) {
          reject(closeError)
        }
        else {
          resolve(true)
        }
      })
    })
    tester.listen(port, '0.0.0.0')
  })
}

async function findAvailablePort(startPort) {
  let port = startPort
  while (port <= MAX_PORT) {
    const available = await canListenOnPort(port)
    if (available) {
      return port
    }
    port += 1
  }
  throw new Error(`No available port found after trying ${startPort}-${MAX_PORT}`)
}

async function openBrowser(port) {
  try {
    const openPkg = await import('open')
    const open = openPkg.default
    await open(`http://localhost:${port}`)
  }
  catch (e) {
    console.warn(`Unable to auto-open browser on http://localhost:${port}`)
  }
}

function spawnDevServer(port) {
  const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm'
  const env = Object.assign({}, process.env, { PORT: `${port}` })
  const child = spawn(npmCommand, ['run', 'dev'], {
    stdio: 'inherit',
    env
  })

  process.on('SIGINT', () => child.kill('SIGINT'))
  process.on('SIGTERM', () => child.kill('SIGTERM'))

  child.on('exit', (code, signal) => {
    if (signal) {
      process.kill(process.pid, signal)
      return
    }
    process.exit(code || 0)
  })

  child.on('error', (e) => {
    console.error(e)
    process.exit(1)
  })
}

async function start() {
  const port = await findAvailablePort(getStartPort())
  spawnDevServer(port)
  setTimeout(() => {
    openBrowser(port)
  }, 1200)
}

start().catch((e) => {
  console.error(e)
  process.exit(1)
})
