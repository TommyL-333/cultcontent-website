'use strict';
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { useIsolatedDataDir } = require('../helpers/isolated-data-dir');

let cleanup;
before(() => { cleanup = useIsolatedDataDir('ccc-challenges-'); });
after(() => cleanup());

const net = require('../../lib/ccc-network');
const ch = require('../../lib/ccc-challenges');

function approvedCreator(email) {
  const r = net.signup({ role: 'creator', first_name: 'C', last_name: 'One', email, looking_for: 'x', terms_accepted: true });
  return net.setStatus(r.uuid, { status: 'approved' }).person;
}
function approvedBrand(email, brandName = 'Brand Co') {
  const r = net.signup({ role: 'brand', first_name: 'B', last_name: 'One', email, brand_name: brandName, looking_for: 'x', terms_accepted: true });
  return net.setStatus(r.uuid, { status: 'approved' }).person;
}

describe('normalizeUrl', () => {
  test('accepts a bare domain and adds https', () => {
    assert.equal(ch.normalizeUrl('tiktok.com/@a/video/1'), 'https://tiktok.com/@a/video/1');
  });
  test('keeps an existing scheme', () => {
    assert.equal(ch.normalizeUrl('http://example.com/x'), 'http://example.com/x');
  });
  test('rejects anything that is not http(s)', () => {
    // The URL ends up in an href on the brand's screen, so a javascript: or
    // data: value must never survive normalization.
    assert.equal(ch.normalizeUrl('javascript:alert(1)'), null);
    assert.equal(ch.normalizeUrl('data:text/html,<script>'), null);
    assert.equal(ch.normalizeUrl('  '), null);
    assert.equal(ch.normalizeUrl('notadomain'), null);
  });
});

describe('creating challenges', () => {
  test('only brands can create one', () => {
    const creator = approvedCreator('chcreator1@example.com');
    assert.equal(ch.createChallenge(creator, { title: 'Nope' }).error, 'brands_only');
  });

  test('a title is required', () => {
    const brand = approvedBrand('chbrand1@example.com');
    assert.equal(ch.createChallenge(brand, { title: '   ' }).error, 'title_required');
  });

  test('a created challenge shows up in the roster feed with its brand', () => {
    const brand = approvedBrand('chbrand2@example.com', 'Oceanblue');
    const creator = approvedCreator('chcreator2@example.com');
    const r = ch.createChallenge(brand, { title: 'Film it', description: 'do the thing', reward: '$500' });
    assert.equal(r.ok, true);

    const feed = ch.listChallenges(creator);
    const found = feed.find((c) => c.uuid === r.challenge.uuid);
    assert.ok(found);
    assert.equal(found.brand_name, 'Oceanblue');
    assert.equal(found.entry_count, 0);
  });
});

describe('entering challenges', () => {
  test('a creator can enter, and the brand sees the entry', () => {
    const brand = approvedBrand('chbrand3@example.com');
    const creator = approvedCreator('chcreator3@example.com');
    const { challenge } = ch.createChallenge(brand, { title: 'Enter me' });

    const entered = ch.submitEntry(creator, challenge.uuid, { url: 'tiktok.com/@c/video/9', note: 'here you go' });
    assert.equal(entered.ok, true);
    assert.equal(entered.challenge.entry_count, 1);

    const listed = ch.listEntries(brand, challenge.uuid);
    assert.equal(listed.ok, true);
    assert.equal(listed.entries.length, 1);
    assert.equal(listed.entries[0].url, 'https://tiktok.com/@c/video/9');
    assert.equal(listed.entries[0].note, 'here you go');
  });

  test('re-entering replaces the link instead of creating a second entry', () => {
    const brand = approvedBrand('chbrand4@example.com');
    const creator = approvedCreator('chcreator4@example.com');
    const { challenge } = ch.createChallenge(brand, { title: 'Fix my typo' });

    ch.submitEntry(creator, challenge.uuid, { url: 'tiktok.com/@c/video/typo' });
    const second = ch.submitEntry(creator, challenge.uuid, { url: 'tiktok.com/@c/video/correct' });

    assert.equal(second.challenge.entry_count, 1, 'should still be one entry');
    const listed = ch.listEntries(brand, challenge.uuid);
    assert.equal(listed.entries[0].url, 'https://tiktok.com/@c/video/correct');
  });

  test('brands cannot enter their own challenge', () => {
    const brand = approvedBrand('chbrand5@example.com');
    const { challenge } = ch.createChallenge(brand, { title: 'Mine' });
    assert.equal(ch.submitEntry(brand, challenge.uuid, { url: 'tiktok.com/x' }).error, 'creators_only');
  });

  test('a bad url is refused and no entry is recorded', () => {
    const brand = approvedBrand('chbrand6@example.com');
    const creator = approvedCreator('chcreator6@example.com');
    const { challenge } = ch.createChallenge(brand, { title: 'Strict' });

    assert.equal(ch.submitEntry(creator, challenge.uuid, { url: 'javascript:alert(1)' }).error, 'bad_url');
    assert.equal(ch.listEntries(brand, challenge.uuid).entries.length, 0);
  });

  test('a closed challenge takes no new entries', () => {
    const brand = approvedBrand('chbrand7@example.com');
    const creator = approvedCreator('chcreator7@example.com');
    const { challenge } = ch.createChallenge(brand, { title: 'Closing time' });
    ch.setChallengeStatus(brand, challenge.uuid, 'closed');

    assert.equal(ch.submitEntry(creator, challenge.uuid, { url: 'tiktok.com/x' }).error, 'closed');
  });

  test('withdrawing removes the entry', () => {
    const brand = approvedBrand('chbrand8@example.com');
    const creator = approvedCreator('chcreator8@example.com');
    const { challenge } = ch.createChallenge(brand, { title: 'Second thoughts' });

    ch.submitEntry(creator, challenge.uuid, { url: 'tiktok.com/x' });
    ch.withdrawEntry(creator, challenge.uuid);
    assert.equal(ch.listEntries(brand, challenge.uuid).entries.length, 0);
  });
});

describe('entry visibility', () => {
  test('a different brand cannot read someone else’s entries', () => {
    const owner = approvedBrand('chowner@example.com');
    const nosy = approvedBrand('chnosy@example.com');
    const creator = approvedCreator('chcreator9@example.com');
    const { challenge } = ch.createChallenge(owner, { title: 'Private' });
    ch.submitEntry(creator, challenge.uuid, { url: 'tiktok.com/secret' });

    const attempt = ch.listEntries(nosy, challenge.uuid);
    assert.equal(attempt.ok, false);
    assert.equal(attempt.error, 'not_yours');
  });

  test('a creator cannot close a brand’s challenge', () => {
    const brand = approvedBrand('chbrand10@example.com');
    const creator = approvedCreator('chcreator10@example.com');
    const { challenge } = ch.createChallenge(brand, { title: 'Not yours to close' });
    assert.equal(ch.setChallengeStatus(creator, challenge.uuid, 'closed').error, 'not_yours');
  });

  test('entries never carry the creator’s email or phone', () => {
    const brand = approvedBrand('chbrand11@example.com');
    const creator = approvedCreator('chcreator11@example.com');
    const { challenge } = ch.createChallenge(brand, { title: 'No contact leak' });
    ch.submitEntry(creator, challenge.uuid, { url: 'tiktok.com/x' });

    const [entry] = ch.listEntries(brand, challenge.uuid).entries;
    assert.equal(entry.email, undefined);
    assert.equal(entry.phone, undefined);
  });
});
