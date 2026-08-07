// OtavClient address normalization — operators paste api_ip in many shapes.
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.SCHEDULER_DB = process.env.SCHEDULER_DB
  || `/tmp/otav-client-test-${process.pid}.sqlite`;
const { OtavClient } = await import('../src/services/otavClient.js');

const base = (channel) => new OtavClient(channel).base;

test('plain IP + port', () => {
  assert.equal(base({ api_ip: '192.168.75.5', api_port: 8000 }), 'http://192.168.75.5:8000');
});

test('strips a pasted http:// scheme', () => {
  assert.equal(base({ api_ip: 'http://192.168.75.5', api_port: 8000 }), 'http://192.168.75.5:8000');
  assert.equal(base({ api_ip: 'HTTPS://192.168.75.5', api_port: 8000 }), 'http://192.168.75.5:8000');
});

test('strips trailing slash / path', () => {
  assert.equal(base({ api_ip: '192.168.75.5/', api_port: 8000 }), 'http://192.168.75.5:8000');
  assert.equal(base({ api_ip: 'http://192.168.75.5/info', api_port: 8000 }), 'http://192.168.75.5:8000');
});

test('host:port pasted into api_ip does not double the port', () => {
  assert.equal(base({ api_ip: '192.168.75.5:8000', api_port: 8000 }), 'http://192.168.75.5:8000');
  assert.equal(base({ api_ip: 'http://192.168.75.5:8000', api_port: null }), 'http://192.168.75.5:8000');
});

test('whitespace is trimmed', () => {
  assert.equal(base({ api_ip: ' 192.168.75.5 ', api_port: 8000 }), 'http://192.168.75.5:8000');
});
