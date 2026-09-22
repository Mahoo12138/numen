import { describe, expect, it } from 'vitest'
import { compileProxyBypass } from '../src/proxy-routing.js'

describe('host proxy bypass rules', () => {
  it.each([
    ['example.com', 'https://example.com', true],
    ['example.com', 'https://api.example.com', true],
    ['example.com', 'https://notexample.com', false],
    ['example.com', 'https://example.com.evil.test', false],
    ['.example.com', 'http://example.com', true],
    ['*.example.com', 'http://example.com', false],
    ['*.example.com', 'http://api.example.com', true],
    ['EXAMPLE.com.', 'https://API.EXAMPLE.COM.', true],
    ['例子.测试', 'https://例子.测试', true],
    ['localhost:80', 'http://localhost', true],
    ['localhost:443', 'https://localhost', true],
    ['localhost:443', 'wss://localhost', true],
    ['localhost:80', 'ws://localhost', true],
    ['localhost:443', 'http://localhost', false],
    ['localhost:8123', 'http://localhost:8123', true],
    ['localhost:8123', 'http://localhost:8124', false],
    ['127.0.0.1', 'http://127.0.0.1:8123', true],
    ['127.0.0.1', 'http://x.127.0.0.1.test', false],
    ['[::1]:8123', 'http://[::1]:8123', true],
    ['[::1]:8123', 'http://[::1]:8124', false],
    ['::1', 'http://[::1]', true],
    ['[0:0:0:0:0:0:0:1]', 'http://[::1]', true],
    ['::1', 'http://[::2]', false],
    [' foo.test, , localhost\nbar.test ', 'http://localhost', true],
    ['*', 'https://anywhere.test', true],
    ['', 'http://localhost', false],
    [' ,  ', 'http://localhost', false],
  ])('%s against %s → %s', (rules, target, expected) => {
    expect(compileProxyBypass(rules)(new URL(target))).toBe(expected)
  })

  it.each(['http://secret@host', 'host/path', 'host?key=secret', 'host:0', 'host:65536', 'host:abc', '[invalid]', '10.0.0.0/8', 'foo*bar', '..example.com'])('rejects invalid rules without exposing their contents: %s', value => {
    expect(() => compileProxyBypass(value)).toThrow(/^Invalid HTTP noProxy (rule|port)$/)
  })
})
