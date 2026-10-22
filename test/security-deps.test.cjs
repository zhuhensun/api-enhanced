const assert = require('node:assert/strict')
const net = require('node:net')
const { once } = require('node:events')
const path = require('node:path')
const { test } = require('node:test')

test('PAC FTP loading and Unix listing work with patched basic-ftp', async () => {
  const getUriPath = require.resolve('get-uri', {
    paths: [path.dirname(require.resolve('pac-proxy-agent'))],
  })
  const { getUri } = require(getUriPath)
  const { Client } = require(
    require.resolve('basic-ftp', { paths: [path.dirname(getUriPath)] }),
  )
  const sockets = new Set()
  const listeners = new Set()
  const commands = []
  const payload = 'function FindProxyForURL() { return "DIRECT"; }\n'
  const server = net.createServer((control) => {
    sockets.add(control)
    control.on('error', () => {})
    control.on('close', () => sockets.delete(control))
    control.write('220 Local test FTP\r\n')
    let pending = ''
    let passive
    let dataSocket
    const transfer = (body) => {
      control.write('150 Opening data connection\r\n')
      const send = (socket) => {
        socket.end(body, () => control.write('226 Transfer complete\r\n'))
      }
      if (dataSocket) send(dataSocket)
      else passive.once('connection', send)
    }
    control.on('data', async (chunk) => {
      pending += chunk.toString()
      while (pending.includes('\r\n')) {
        const end = pending.indexOf('\r\n')
        const line = pending.slice(0, end)
        pending = pending.slice(end + 2)
        const command = line.split(' ')[0]
        commands.push(command)
        if (command === 'USER') control.write('331 Password required\r\n')
        else if (command === 'PASS') control.write('230 Logged in\r\n')
        else if (command === 'FEAT') control.write('211 No extensions\r\n')
        else if (command === 'MDTM') control.write('213 20261022000000\r\n')
        else if (command === 'PWD') control.write('257 "/"\r\n')
        else if (command === 'EPSV') {
          dataSocket = undefined
          passive = net.createServer((socket) => {
            dataSocket = socket
            sockets.add(socket)
            socket.on('error', () => {})
            socket.on('close', () => sockets.delete(socket))
            passive.close()
          })
          listeners.add(passive)
          passive.listen(0, '127.0.0.1')
          await once(passive, 'listening')
          control.write(
            `229 Entering Extended Passive Mode (|||${passive.address().port}|)\r\n`,
          )
        } else if (command === 'LIST') {
          transfer(
            `-rw-r--r-- 1 test test ${payload.length} Oct 22 2026 probe.pac\r\n`,
          )
        } else if (command === 'RETR') transfer(payload)
        else if (command === 'QUIT') control.end('221 Bye\r\n')
        else control.write('200 OK\r\n')
      }
    })
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  try {
    const stream = await getUri(
      `ftp://127.0.0.1:${server.address().port}/probe.pac`,
      {
        timeout: 3000,
      },
    )
    let actual = ''
    for await (const chunk of stream) actual += chunk.toString()
    assert.equal(actual, payload)
    const client = new Client(3000)
    try {
      await client.access({ host: '127.0.0.1', port: server.address().port })
      const entries = await client.list('/')
      assert.equal(entries[0].name, 'probe.pac')
      assert.equal(entries[0].size, payload.length)
    } finally {
      client.close()
    }
    assert.ok(
      commands.includes('LIST'),
      'the Unix directory parser is exercised',
    )
    assert.ok(commands.includes('RETR'))
  } finally {
    for (const socket of sockets) socket.destroy()
    for (const listener of listeners) if (listener.listening) listener.close()
    server.close()
  }
})
