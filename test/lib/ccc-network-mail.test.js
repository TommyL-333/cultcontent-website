'use strict';
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { useIsolatedDataDir } = require('../helpers/isolated-data-dir');

let cleanup;
before(() => {
  cleanup = useIsolatedDataDir('ccc-mail-');
  delete process.env.GHL_API_KEY; // force the dev-fallback path — no real network calls in this suite
});
after(() => cleanup());

const net = require('../../lib/ccc-network');
const mail = require('../../lib/ccc-network-mail');

function approvedPerson(email) {
  const r = net.signup({ role: 'creator', first_name: 'Mail', last_name: 'Test', email, looking_for: 'x' });
  return net.setStatus(r.uuid, { status: 'approved' }).person;
}

describe('email delivery degrades safely with no GHL configured', () => {
  test('sendMagicLinkEmail does not throw, reports devFallback', async () => {
    const p = approvedPerson('mailmagic@example.com');
    const r = await mail.sendMagicLinkEmail(p, 'sometoken');
    assert.equal(r.ok, false);
    assert.equal(r.devFallback, true);
  });
  test('sendApprovalEmail does not throw', async () => {
    const p = approvedPerson('mailapproval@example.com');
    const r = await mail.sendApprovalEmail(p, 'sometoken');
    assert.equal(r.devFallback, true);
  });
  test('connection-request email is skipped entirely when the recipient opted out', async () => {
    const recipient = approvedPerson('mailoptout@example.com');
    net.setNotificationPrefs(recipient.id, { notify_request: false, notify_approval: true, notify_message: true });
    const requester = approvedPerson('mailrequester@example.com');
    const r = await mail.sendConnectionRequestEmail(net.getPerson(recipient.id), requester);
    assert.equal(r.ok, true);
    assert.equal(r.skipped, 'opted_out');
  });
  test('connection-request email attempts to send (and falls back safely) when notifications are on', async () => {
    const recipient = approvedPerson('mailoptin@example.com'); // notify_request defaults to 1
    const requester = approvedPerson('mailrequester2@example.com');
    const r = await mail.sendConnectionRequestEmail(net.getPerson(recipient.id), requester);
    assert.equal(r.devFallback, true);
  });
  test('connection-accepted and new-message emails respect their own opt-out flags', async () => {
    const recipient = approvedPerson('mailflags@example.com');
    net.setNotificationPrefs(recipient.id, { notify_request: true, notify_approval: false, notify_message: false });
    const other = approvedPerson('mailflagsother@example.com');

    const accepted = await mail.sendConnectionAcceptedEmail(net.getPerson(recipient.id), other);
    assert.equal(accepted.skipped, 'opted_out');

    const message = await mail.sendNewMessageEmail(net.getPerson(recipient.id), other);
    assert.equal(message.skipped, 'opted_out');
  });
  test('sendEmailChangeVerification does not throw and falls back safely', async () => {
    const p = approvedPerson('mailchange@example.com');
    const r = await mail.sendEmailChangeVerification(p, 'newaddress@example.com', 'sometoken');
    assert.equal(r.devFallback, true);
  });
  test('magicLinkUrl builds the expected path', () => {
    assert.match(mail.magicLinkUrl('abc123'), /\/ccc-network\/auth\/abc123$/);
  });
});
