'use strict';
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { useIsolatedDataDir } = require('../helpers/isolated-data-dir');

let cleanup;
before(() => { cleanup = useIsolatedDataDir('ccc-messages-'); });
after(() => cleanup());

const net = require('../../lib/ccc-network');
const msg = require('../../lib/ccc-network-messages');

function approvedCreator(email) {
  const r = net.signup({ role: 'creator', first_name: 'M', last_name: 'Creator', email, looking_for: 'x' , terms_accepted: true });
  return net.setStatus(r.uuid, { status: 'approved' }).person;
}
function approvedBrand(email) {
  const r = net.signup({ role: 'brand', first_name: 'M', last_name: 'Brand', email, brand_name: 'B', looking_for: 'x' , terms_accepted: true });
  return net.setStatus(r.uuid, { status: 'approved' }).person;
}

describe('messaging requires an accepted connection', () => {
  let a, b;
  before(() => {
    a = approvedCreator('msgA@example.com');
    b = approvedBrand('msgB@example.com');
  });

  test('sendMessage blocked with no connection at all', () => {
    const r = msg.sendMessage(a.id, b.uuid, 'hi');
    assert.equal(r.ok, false);
    assert.equal(r.error, 'not_connected');
  });
  test('sendMessage blocked while the connection is only pending', () => {
    net.connect(a.id, b.uuid);
    const r = msg.sendMessage(a.id, b.uuid, 'hi');
    assert.equal(r.ok, false);
    assert.equal(r.error, 'not_connected');
  });
  test('sendMessage rejects an empty/whitespace-only body', () => {
    net.respondToConnection(b.id, a.uuid, true); // now accepted
    const r = msg.sendMessage(a.id, b.uuid, '   ');
    assert.equal(r.ok, false);
    assert.equal(r.error, 'empty_message');
  });
  test('sendMessage works once accepted; listThread returns it and marks it read', () => {
    const sent = msg.sendMessage(a.id, b.uuid, 'Hello there');
    assert.equal(sent.ok, true);
    assert.equal(sent.otherPerson.uuid, b.uuid);

    const threadForB = msg.listThread(b.id, a.uuid);
    assert.equal(threadForB.ok, true);
    assert.equal(threadForB.messages.length, 1);
    assert.equal(threadForB.messages[0].body, 'Hello there');

    const inboxForB = msg.listInbox(b.id);
    assert.equal(inboxForB[0].unread, 0); // listThread above already marked it read
  });
  test('unreadCount reflects an unread message until the thread is opened', () => {
    msg.sendMessage(b.id, a.uuid, 'Reply');
    assert.equal(msg.unreadCount(a.id), 1);
    msg.listThread(a.id, b.uuid);
    assert.equal(msg.unreadCount(a.id), 0);
  });
  test('listInbox reports the last message with a correct fromMe flag', () => {
    const inboxForA = msg.listInbox(a.id);
    assert.equal(inboxForA.length, 1);
    assert.equal(inboxForA[0].lastMessage.body, 'Reply');
    assert.equal(inboxForA[0].lastMessage.fromMe, false); // last message was sent by b
  });
  test('listThread/sendMessage reject an unknown person uuid', () => {
    assert.equal(msg.sendMessage(a.id, 'not-a-real-uuid', 'hi').error, 'not_found');
    assert.equal(msg.listThread(a.id, 'not-a-real-uuid').error, 'not_found');
  });
});
