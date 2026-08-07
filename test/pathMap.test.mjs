// config.pathMap — canonical (Mac) <-> local path translation.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyPathMap } from '../src/config.js';

const MAP = { '/Volumes/Public': '/run/user/1000/gvfs/smb-share:server=nas,share=public' };

test('maps a path under a mapped prefix', () => {
  assert.equal(
    applyPathMap('/Volumes/Public/Transmission/Schedules/Test.xpls', MAP),
    '/run/user/1000/gvfs/smb-share:server=nas,share=public/Transmission/Schedules/Test.xpls',
  );
});

test('maps the prefix itself exactly', () => {
  assert.equal(applyPathMap('/Volumes/Public', MAP),
    '/run/user/1000/gvfs/smb-share:server=nas,share=public');
});

test('does not map sibling paths that merely share characters', () => {
  assert.equal(applyPathMap('/Volumes/PublicOld/x.mp4', MAP), '/Volumes/PublicOld/x.mp4');
});

test('leaves unmapped paths and non-strings untouched', () => {
  assert.equal(applyPathMap('/tmp/x', MAP), '/tmp/x');
  assert.equal(applyPathMap('/tmp/x', undefined), '/tmp/x');
  assert.equal(applyPathMap(null, MAP), null);
});

test('longest prefix wins', () => {
  const map = { '/Volumes': '/mnt/all', '/Volumes/Public': '/mnt/public' };
  assert.equal(applyPathMap('/Volumes/Public/a', map), '/mnt/public/a');
  assert.equal(applyPathMap('/Volumes/Other/a', map), '/mnt/all/Other/a');
});

test('trailing slashes in the map are tolerated', () => {
  const map = { '/Volumes/Public/': '/mnt/public/' };
  assert.equal(applyPathMap('/Volumes/Public/a', map), '/mnt/public/a');
});

test('inverted map round-trips back to canonical', () => {
  const local = applyPathMap('/Volumes/Public/Movies/x.mp4', MAP);
  const inverse = Object.fromEntries(Object.entries(MAP).map(([f, t]) => [t, f]));
  assert.equal(applyPathMap(local, inverse), '/Volumes/Public/Movies/x.mp4');
});
