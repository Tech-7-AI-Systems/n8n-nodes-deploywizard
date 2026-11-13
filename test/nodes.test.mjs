// Runs the compiled nodes against a mocked n8n runtime and checks the exact API calls they make.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { DeployWizard } = require('../dist/nodes/DeployWizard/DeployWizard.node.js');
const { DeployWizardTrigger } = require('../dist/nodes/DeployWizard/DeployWizardTrigger.node.js');
const { DeployWizardApi } = require('../dist/credentials/DeployWizardApi.credentials.js');

const creds = { apiKey: 'dw_live_x', baseUrl: 'http://localhost:8787/' };

function mockContext({ params = {}, items = [{ json: {} }], responses = {}, binary, staticData = {}, body, headers = {}, rawBody } = {}) {
  const calls = [];
  let responded = null;
  const ctx = {
    calls,
    staticData,
    get responded() { return responded; },
    getNode: () => ({ name: 'DeployWizard', type: 'deployWizard', typeVersion: 1, parameters: {} }),
    getCredentials: async () => creds,
    // Execute functions pass (name, itemIndex, fallback); hook functions pass (name, fallback).
    getNodeParameter: (name, a, b) => (name in params ? params[name] : typeof a === 'number' ? b : a),
    getInputData: () => items,
    continueOnFail: () => false,
    getWorkflowStaticData: () => staticData,
    getNodeWebhookUrl: () => 'http://localhost:5678/webhook/abc/webhook',
    getHeaderData: () => headers,
    getBodyData: () => body,
    getRequestObject: () => ({ rawBody }),
    getResponseObject: () => ({ status: (s) => ({ json: (b) => { responded = { status: s, body: b }; } }) }),
    helpers: {
      httpRequestWithAuthentication: async function (credType, options) {
        assert.equal(credType, 'deployWizardApi');
        calls.push(options);
        const key = `${options.method} ${options.url.replace('http://localhost:8787', '')}`;
        const match = Object.entries(responses).find(([k]) => key.startsWith(k));
        return match ? match[1] : { ok: true };
      },
      returnJsonArray: (arr) => arr.map((json) => ({ json })),
      assertBinaryData: () => binary.meta,
      getBinaryDataBuffer: async () => binary.bytes,
    },
  };
  return ctx;
}

test('credential: bearer auth and /v1/me test', () => {
  const c = new DeployWizardApi();
  assert.equal(c.authenticate.properties.headers.Authorization, '=Bearer {{$credentials.apiKey}}');
  assert.equal(c.test.request.url, '/v1/me');
});

test('trigger: subscribes the URL n8n gives it and stores the secret', async () => {
  const node = new DeployWizardTrigger();
  const ctx = mockContext({
    params: { channelId: 'chn_1', events: ['message.received'] },
    responses: { 'POST /v1/webhook-subscriptions': { id: 'whs_1', secret: 'whsec_abc' } },
  });
  assert.equal(await node.webhookMethods.default.create.call(ctx), true);
  assert.deepEqual(ctx.calls[0].body, {
    url: 'http://localhost:5678/webhook/abc/webhook',
    events: ['message.received'],
    pause_during_handoff: true,
    groups: 'off',
    channel_ids: ['chn_1'],
  });
  assert.equal(ctx.staticData.subscriptionId, 'whs_1');
  assert.equal(ctx.staticData.secret, 'whsec_abc');

  // checkExists finds it; deactivation deletes it.
  const ctx2 = mockContext({
    staticData: ctx.staticData,
    responses: { 'GET /v1/webhook-subscriptions': { data: [{ id: 'whs_1', status: 'active', url: 'http://localhost:5678/webhook/abc/webhook' }] } },
  });
  assert.equal(await node.webhookMethods.default.checkExists.call(ctx2), true);
  assert.equal(await node.webhookMethods.default.delete.call(ctx2), true);
  assert.equal(ctx2.calls.at(-1).method, 'DELETE');
  assert.equal(ctx2.staticData.subscriptionId, undefined);
});

test('trigger: "All Channels" subscribes without a channel filter', async () => {
  const node = new DeployWizardTrigger();
  const ctx = mockContext({ params: { channelId: '__all__', events: ['message.received'] }, responses: { 'POST /v1/webhook-subscriptions': { id: 'w', secret: 's' } } });
  await node.webhookMethods.default.create.call(ctx);
  assert.equal(ctx.calls[0].body.channel_ids, undefined);
});

test('trigger: accepts signed events, adds shortcuts, rejects bad signatures', async () => {
  const node = new DeployWizardTrigger();
  const event = {
    id: 'evt_1', type: 'message.received',
    contact: { phone: '+923001234567', name: 'Sara', chat_id: '1@lid' },
    conversation: { id: 'cnv_1', seq: 1 },
    message: { id: 'msg_1', type: 'text', text: { body: 'Salam' } },
  };
  const raw = JSON.stringify(event);
  const ts = String(Math.floor(Date.now() / 1000));
  const sig = `v1=${createHmac('sha256', 'whsec_abc').update(`${ts}.${raw}`).digest('hex')}`;

  const ok = mockContext({ staticData: { secret: 'whsec_abc' }, body: event, rawBody: Buffer.from(raw), headers: { 'dw-timestamp': ts, 'dw-signature': sig } });
  const res = await node.webhook.call(ok);
  const out = res.workflowData[0][0].json;
  assert.equal(out.text, 'Salam');
  assert.equal(out.from, '+923001234567');
  assert.equal(out.conversation_id, 'cnv_1');
  assert.equal(out.message_id, 'msg_1');
  assert.equal(out.event, 'message.received');
  assert.equal(out.details.message.text.body, 'Salam', 'full event under details');
  assert.equal(out.message, undefined, 'no duplicated top-level copy');

  const bad = mockContext({ staticData: { secret: 'whsec_abc' }, body: event, rawBody: Buffer.from(raw), headers: { 'dw-timestamp': ts, 'dw-signature': 'v1=00' } });
  assert.deepEqual(await node.webhook.call(bad), { noWebhookResponse: true });
  assert.equal(bad.responded.status, 401);

  const old = String(Math.floor(Date.now() / 1000) - 3600);
  const oldSig = `v1=${createHmac('sha256', 'whsec_abc').update(`${old}.${raw}`).digest('hex')}`;
  const replay = mockContext({ staticData: { secret: 'whsec_abc' }, body: event, rawBody: Buffer.from(raw), headers: { 'dw-timestamp': old, 'dw-signature': oldSig } });
  await node.webhook.call(replay);
  assert.equal(replay.responded.status, 401, 'old requests are rejected');
});

test('action: reply in conversation with typing first and an idempotency key', async () => {
  const node = new DeployWizard();
  const ctx = mockContext({
    params: {
      resource: 'message', operation: 'sendText', recipient: 'conversation', conversationId: 'cnv_1',
      text: 'Walaikum salam!', options: { typingMs: 10, idempotencyKey: 'evt_1' },
    },
    responses: { 'POST /v1/messages': { id: 'msg_out', status: 'queued' } },
  });
  const [[item]] = await node.execute.call(ctx);
  assert.equal(item.json.id, 'msg_out');
  assert.equal(ctx.calls[0].url, 'http://localhost:8787/v1/conversations/cnv_1/typing');
  assert.deepEqual(ctx.calls[1].body, { conversation_id: 'cnv_1', type: 'text', text: { body: 'Walaikum salam!' } });
  assert.equal(ctx.calls[1].headers['Idempotency-Key'], 'evt_1');
});

test('action: new chat by phone number, location', async () => {
  const node = new DeployWizard();
  const ctx = mockContext({
    params: {
      resource: 'message', operation: 'sendLocation', recipient: 'phone', channelId: 'chn_1', to: '+923001234567',
      latitude: 31.5204, longitude: 74.3587, placeName: 'Tech 7 Academy', address: '', options: {},
    },
  });
  await node.execute.call(ctx);
  assert.equal(ctx.calls.length, 1, 'no typing for new chats');
  assert.deepEqual(ctx.calls[0].body, {
    channel_id: 'chn_1', to: '+923001234567', type: 'location',
    location: { latitude: 31.5204, longitude: 74.3587, name: 'Tech 7 Academy' },
  });
});

test('action: binary file is uploaded, then sent by media_id', async () => {
  const node = new DeployWizard();
  const ctx = mockContext({
    params: {
      resource: 'message', operation: 'sendMedia', recipient: 'conversation', conversationId: 'cnv_1',
      mediaType: 'document', mediaSource: 'binary', binaryProperty: 'data', caption: 'Your invoice', fileName: '', options: {},
    },
    binary: { meta: { mimeType: 'application/pdf', fileName: 'invoice.pdf' }, bytes: Buffer.from('%PDF') },
    responses: { 'POST /v1/media': JSON.stringify({ id: 'med_1' }), 'POST /v1/messages': { id: 'msg_2' } },
  });
  await node.execute.call(ctx);
  assert.equal(ctx.calls[0].headers['Content-Type'], 'application/pdf');
  assert.deepEqual(ctx.calls[0].qs, { filename: 'invoice.pdf' });
  assert.ok(Buffer.isBuffer(ctx.calls[0].body));
  assert.deepEqual(ctx.calls[1].body.document, { media_id: 'med_1', filename: 'invoice.pdf', caption: 'Your invoice' });
});

test('action: voice note', async () => {
  const node = new DeployWizard();
  const ctx = mockContext({
    params: { resource: 'message', operation: 'sendMedia', recipient: 'conversation', conversationId: 'cnv_1', mediaType: 'audio', mediaSource: 'url', mediaUrl: 'https://x/a.ogg', voice: true, options: {} },
  });
  await node.execute.call(ctx);
  assert.deepEqual(ctx.calls[0].body.audio, { url: 'https://x/a.ogg', voice: true });
});

test('action: empty conversation ID gives a helpful error', async () => {
  const node = new DeployWizard();
  const ctx = mockContext({ params: { resource: 'message', operation: 'sendText', recipient: 'conversation', conversationId: '', text: 'x', options: {} } });
  await assert.rejects(node.execute.call(ctx), /Connect this node after a DeployWizard Trigger/);
});

test('action: react and check number', async () => {
  const node = new DeployWizard();
  const r = mockContext({ params: { resource: 'message', operation: 'react', messageId: 'msg_1', emoji: '👍' } });
  await node.execute.call(r);
  assert.equal(r.calls[0].url, 'http://localhost:8787/v1/messages/msg_1/reaction');
  assert.deepEqual(r.calls[0].body, { emoji: '👍' });

  const c = mockContext({ params: { resource: 'channel', operation: 'checkNumber', channelId: 'chn_1', checkPhone: '+923001234567' }, responses: { 'GET /v1/channels/chn_1/check': { on_whatsapp: true } } });
  const [[item]] = await node.execute.call(c);
  assert.deepEqual(c.calls[0].qs, { phone: '+923001234567' });
  assert.equal(item.json.on_whatsapp, true);
});

test('action: hand off to a person and return to the agent', async () => {
  const node = new DeployWizard();
  const h = mockContext({ params: { resource: 'conversation', operation: 'handoff', conversationId: 'cnv_1', handoffReason: 'Refund', handoffSummary: 'Order #123', notifyCustomer: true, handoffMessage: '' } });
  await node.execute.call(h);
  assert.equal(h.calls[0].url, 'http://localhost:8787/v1/conversations/cnv_1/handoff');
  assert.deepEqual(h.calls[0].body, { notify_customer: true, reason: 'Refund', summary: 'Order #123' });

  const r = mockContext({ params: { resource: 'conversation', operation: 'release', conversationId: 'cnv_1', agentNote: 'Refund approved' } });
  await node.execute.call(r);
  assert.deepEqual(r.calls[0].body, { note: 'Refund approved' });
});

test('trigger: subscribes with pause_during_handoff', async () => {
  const node = new DeployWizardTrigger();
  const ctx = mockContext({ params: { channelId: '__all__', events: ['message.received'], pauseDuringHandoff: false }, responses: { 'POST /v1/webhook-subscriptions': { id: 'w', secret: 's' } } });
  await node.webhookMethods.default.create.call(ctx);
  assert.equal(ctx.calls[0].body.pause_during_handoff, false);
});

test('the action node is offered to n8n AI Agents as a tool; the trigger exposes chat_owner and asked_for_person', async () => {
  assert.equal(new DeployWizard().description.usableAsTool, true);
  const node = new DeployWizardTrigger();
  const event = { id: 'evt_9', type: 'message.received', hints: { asked_for_person: true }, conversation: { id: 'cnv_1', owner: 'agent', note_from_staff: 'Refund approved' }, message: { id: 'msg_1', type: 'text', text: { body: 'real person pls' } } };
  const ctx = mockContext({ staticData: {}, body: event });
  const out = (await node.webhook.call(ctx)).workflowData[0][0].json;
  assert.equal(out.asked_for_person, true);
  assert.equal(out.chat_owner, 'agent');
  assert.equal(out.note_from_staff, undefined, 'notes live in the history now');
});

test('action: get conversation history with a message limit', async () => {
  const node = new DeployWizard();
  const ctx = mockContext({
    params: { resource: 'conversation', operation: 'history', conversationId: 'cnv_1', historyLimit: 10 },
    responses: { 'GET /v1/conversations/cnv_1/history': { messages: [{ from: 'customer', text: 'hi' }], has_more: false } },
  });
  const [[item]] = await node.execute.call(ctx);
  assert.deepEqual(ctx.calls[0].qs, { limit: 10 });
  assert.equal(item.json.messages[0].from, 'customer');
});

test('groups: the trigger subscribes with its groups setting, and a changed setting replaces the endpoint', async () => {
  const node = new DeployWizardTrigger();
  const ctx = mockContext({
    params: { channelId: '__all__', events: ['message.received'], groups: 'mentions' },
    responses: { 'POST /v1/webhook-subscriptions': { id: 'whs_g', secret: 'whsec_g' } },
  });
  await node.webhookMethods.default.create.call(ctx);
  assert.equal(ctx.calls[0].body.groups, 'mentions');

  // The workflow now asks for all group messages: the old endpoint no longer matches and is removed.
  const ctx2 = mockContext({
    params: { groups: 'all' },
    staticData: ctx.staticData,
    responses: { 'GET /v1/webhook-subscriptions': { data: [{ id: 'whs_g', status: 'active', url: 'http://localhost:5678/webhook/abc/webhook', groups: 'mentions' }] } },
  });
  assert.equal(await node.webhookMethods.default.checkExists.call(ctx2), false);
  assert.equal(ctx2.calls.at(-1).method, 'DELETE');
  assert.equal(ctx2.staticData.subscriptionId, undefined);
});

test('groups: trigger output says it is a group, its name, and whether the number was tagged', async () => {
  const { withShortcuts } = await import('../dist/nodes/DeployWizard/GenericFunctions.js');
  const out = withShortcuts({
    type: 'message.received',
    conversation: { id: 'cnv_g', owner: 'agent', type: 'group' },
    group: { id: '1203@g.us', name: 'Tech 7 Students' },
    contact: { chat_id: '777@lid', phone: '+923009991111', name: 'Ali' },
    message: { id: 'msg_g', type: 'text', text: { body: 'what is the fee?' }, mentioned_me: true, replied_to_me: false },
  });
  assert.equal(out.is_group, true);
  assert.equal(out.group_name, 'Tech 7 Students');
  assert.equal(out.mentioned_me, true);
  assert.equal(out.from, '+923009991111');
  assert.equal(out.contact_name, 'Ali');
  assert.equal(out.text, 'what is the fee?');
});

test('groups: send can @mention the author or skip quoting', async () => {
  const node = new DeployWizard();
  const ctx = mockContext({
    params: { resource: 'message', operation: 'sendText', recipient: 'conversation', conversationId: 'cnv_g', text: 'Next batch is 1 Dec', options: { mentionAuthor: true, quote: false } },
    responses: { 'POST /v1/messages': { id: 'msg_1' } },
  });
  await node.execute.call(ctx);
  const send = ctx.calls.find((c) => c.url.endsWith('/v1/messages'));
  assert.equal(send.body.mention_author, true);
  assert.equal(send.body.quote, false);
});
