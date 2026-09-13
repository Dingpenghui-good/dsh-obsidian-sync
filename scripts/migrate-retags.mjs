#!/usr/bin/env node
/**
 * Fix the npm dist-tag `latest` for dsh-obsidian-sync after a publish that
 * succeeded but left the tag on an older version.
 * Reads the token from NPM_TOKEN env (sourced from .npmrc, never committed).
 */
import https from 'node:https'

const token = process.env.NPM_TOKEN
if (!token) {
  console.error('NPM_TOKEN env var required')
  process.exit(1)
}
const pkg = 'dsh-obsidian-sync'
const tag = process.argv[2] || 'latest'
const ver = process.argv[3] || '2.0.2'

function api(method, urlPath, body) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : JSON.stringify(body)
    const req = https.request('https://registry.npmjs.org' + urlPath, {
      method,
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
        'User-Agent': 'dsh-obsidian-sync-tagfix',
        ...(data !== null ? { 'Content-Length': Buffer.byteLength(data) } : {}),
      },
    }, res => {
      let chunks = ''
      res.on('data', d => chunks += d)
      res.on('end', () => {
        try {
          const parsed = chunks ? JSON.parse(chunks) : null
          if (res.statusCode >= 200 && res.statusCode < 300) resolve(parsed)
          else reject(new Error(`${method} ${urlPath} -> ${res.statusCode}: ${chunks.slice(0, 300)}`))
        } catch {
          reject(new Error(`${method} ${urlPath} -> ${res.statusCode}: ${chunks.slice(0, 200)}`))
        }
      })
    })
    req.on('error', reject)
    if (data !== null) req.write(data)
    req.end()
  })
}

async function main() {
  // 1. confirm the target version exists
  const doc = await api('GET', `/${pkg}`)
  const versions = Object.keys(doc.versions)
  console.log('versions:', versions.join(', '))
  if (versions.indexOf(ver) < 0) {
    throw new Error(`version ${ver} not in registry; cannot retag`)
  }
  // 2. put the dist tag on it
  const putBody = JSON.stringify({ [tag]: ver })
  await api('PUT', `/-/package/${pkg}/dist-tags`, JSON.parse(putBody))
  // 3. re-read and print
  const after = await api('GET', `/${pkg}`)
  console.log('dist-tags now:', JSON.stringify(after['dist-tags']))
}

main().catch(e => {
  console.error('FAILED:', e.message)
  process.exit(1)
})
