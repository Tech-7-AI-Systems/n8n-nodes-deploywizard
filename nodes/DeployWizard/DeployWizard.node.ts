import {
  NodeApiError,
  NodeConnectionTypes,
  NodeOperationError,
  sleep,
  type IDataObject,
  type IExecuteFunctions,
  type ILoadOptionsFunctions,
  type INodeExecutionData,
  type INodeProperties,
  type INodeType,
  type INodeTypeDescription,
} from 'n8n-workflow';
import { CREDENTIAL, channelOptions, dwRequest } from './GenericFunctions';

const sendOps = ['sendText', 'sendMedia', 'sendLocation'];
const onMessage = (operation: string[]) => ({ show: { resource: ['message'], operation } });

const recipientFields: INodeProperties[] = [
  {
    displayName: 'Send To',
    name: 'recipient',
    type: 'options',
    displayOptions: onMessage(sendOps),
    options: [
      { name: 'Reply in Conversation', value: 'conversation', description: 'Answer the chat that triggered this workflow' },
      { name: 'Phone Number', value: 'phone', description: 'Start or continue a chat with a number' },
    ],
    default: 'conversation',
  },
  {
    displayName: 'Conversation ID',
    name: 'conversationId',
    type: 'string',
    displayOptions: { show: { resource: ['message'], operation: sendOps, recipient: ['conversation'] } },
    default: '={{ $json.conversation_id }}',
    required: true,
    description: 'Comes from the DeployWizard Trigger as conversation_id',
  },
  {
    displayName: 'Channel Name or ID',
    name: 'channelId',
    type: 'options',
    typeOptions: { loadOptionsMethod: 'getChannels' },
    displayOptions: { show: { resource: ['message'], operation: sendOps, recipient: ['phone'] } },
    default: '',
    required: true,
    description:
      'The WhatsApp number to send from. Choose from the list, or specify an ID using an <a href="https://docs.n8n.io/code/expressions/">expression</a>.',
  },
  {
    displayName: 'Phone Number',
    name: 'to',
    type: 'string',
    displayOptions: { show: { resource: ['message'], operation: sendOps, recipient: ['phone'] } },
    default: '',
    required: true,
    placeholder: '+923001234567',
    description: 'International format, with country code',
  },
];

const sendOptions: INodeProperties = {
  displayName: 'Options',
  name: 'options',
  type: 'collection',
  placeholder: 'Add Option',
  default: {},
  displayOptions: onMessage(sendOps),
  options: [
    {
      displayName: 'Idempotency Key',
      name: 'idempotencyKey',
      type: 'string',
      default: '',
      description: 'If the same key is sent twice, the message is only sent once. Use a value unique to this message.',
    },
    {
      displayName: 'Mention the Author (Groups)',
      name: 'mentionAuthor',
      type: 'boolean',
      default: false,
      description: 'Whether to @tag the person whose message is quoted, so they get notified. Text messages in groups only.',
    },
    {
      displayName: 'Quote the Question (Groups)',
      name: 'quote',
      type: 'boolean',
      default: true,
      description: 'Whether to quote the latest message that tagged this number, if it has not been answered yet. Groups only.',
    },
    {
      displayName: 'Reply To Message ID',
      name: 'replyTo',
      type: 'string',
      default: '',
      description: 'Quote this message (a msg_… ID), e.g. {{ $JSON.message_id }}',
    },
    {
      displayName: 'Show Typing First (Ms)',
      name: 'typingMs',
      type: 'number',
      typeOptions: { minValue: 0, maxValue: 20000 },
      default: 1500,
      description: 'Shows "typing…" for this long before sending, so replies feel human. Only when replying in a conversation.',
    },
  ],
};

export class DeployWizard implements INodeType {
  description: INodeTypeDescription = {
    displayName: 'DeployWizard',
    name: 'deployWizard',
    icon: { light: 'file:deploywizard.svg', dark: 'file:deploywizard.dark.svg' },
    group: ['output'],
    version: 1,
    subtitle: '={{ $parameter["operation"] + ": " + $parameter["resource"] }}',
    description: 'Send WhatsApp messages, typing indicators and read receipts through DeployWizard',
    defaults: { name: 'DeployWizard' },
    // Lets n8n's AI Agent call DeployWizard actions as tools, e.g. "Hand Off to Human".
    usableAsTool: true,
    inputs: [NodeConnectionTypes.Main],
    outputs: [NodeConnectionTypes.Main],
    credentials: [{ name: CREDENTIAL, required: true }],
    properties: [
      {
        displayName: 'Resource',
        name: 'resource',
        type: 'options',
        noDataExpression: true,
        options: [
          { name: 'Message', value: 'message' },
          { name: 'Conversation', value: 'conversation' },
          { name: 'Channel', value: 'channel' },
        ],
        default: 'message',
      },
      {
        displayName: 'Operation',
        name: 'operation',
        type: 'options',
        noDataExpression: true,
        displayOptions: { show: { resource: ['message'] } },
        options: [
          { name: 'Get', value: 'get', action: 'Get a message and its status' },
          { name: 'Mark as Read', value: 'markRead', action: 'Mark a message as read' },
          { name: 'React', value: 'react', action: 'React to a message with an emoji' },
          { name: 'Send Location', value: 'sendLocation', action: 'Send a location' },
          { name: 'Send Media', value: 'sendMedia', action: 'Send an image video document or voice note' },
          { name: 'Send Text', value: 'sendText', action: 'Send a text message' },
        ],
        default: 'sendText',
      },
      {
        displayName: 'Operation',
        name: 'operation',
        type: 'options',
        noDataExpression: true,
        displayOptions: { show: { resource: ['conversation'] } },
        options: [
          { name: 'Get', value: 'get', action: 'Get a conversation' },
          {
            name: 'Get History',
            value: 'history',
            action: 'Get the recent messages in a chat',
            description:
              'Recent messages, oldest first, each marked with who wrote it: customer, agent, person (staff), system, or a staff note. Use it to catch up after a person handled the chat.',
          },
          {
            name: 'Hand Off to Human',
            value: 'handoff',
            action: 'Hand the chat to a person and pause the agent',
            description:
              'Use when the customer asks for a person, is upset, or needs something you cannot do (refunds, payments, complaints). Tells the customer a person will reply and pauses you for this chat.',
          },
          { name: 'Return to Agent', value: 'release', action: 'Give the chat back to the agent' },
          { name: 'Set Typing', value: 'typing', action: 'Show or hide the typing indicator' },
        ],
        default: 'typing',
      },
      {
        displayName: 'Operation',
        name: 'operation',
        type: 'options',
        noDataExpression: true,
        displayOptions: { show: { resource: ['channel'] } },
        options: [
          { name: 'Get Many', value: 'getAll', action: 'Get many numbers' },
          { name: 'Get', value: 'get', action: 'Get a number and its status' },
          { name: 'Check Number', value: 'checkNumber', action: 'Check if a phone number is on whats app' },
        ],
        default: 'getAll',
      },

      ...recipientFields,

      // Send Text
      {
        displayName: 'Text',
        name: 'text',
        type: 'string',
        typeOptions: { rows: 4 },
        displayOptions: onMessage(['sendText']),
        default: '',
        required: true,
      },

      // Send Media
      {
        displayName: 'Media Type',
        name: 'mediaType',
        type: 'options',
        displayOptions: onMessage(['sendMedia']),
        options: [
          { name: 'Image', value: 'image' },
          { name: 'Video', value: 'video' },
          { name: 'Document', value: 'document' },
          { name: 'Audio / Voice Note', value: 'audio' },
        ],
        default: 'image',
      },
      {
        displayName: 'Source',
        name: 'mediaSource',
        type: 'options',
        displayOptions: onMessage(['sendMedia']),
        options: [
          { name: 'URL', value: 'url' },
          { name: 'Binary File From Previous Node', value: 'binary' },
        ],
        default: 'url',
      },
      {
        displayName: 'File URL',
        name: 'mediaUrl',
        type: 'string',
        displayOptions: { show: { resource: ['message'], operation: ['sendMedia'], mediaSource: ['url'] } },
        default: '',
        required: true,
        placeholder: 'https://example.com/menu.jpg',
      },
      {
        displayName: 'Input Binary Field',
        name: 'binaryProperty',
        type: 'string',
        displayOptions: { show: { resource: ['message'], operation: ['sendMedia'], mediaSource: ['binary'] } },
        default: 'data',
        required: true,
      },
      {
        displayName: 'Caption',
        name: 'caption',
        type: 'string',
        displayOptions: { show: { resource: ['message'], operation: ['sendMedia'], mediaType: ['image', 'video', 'document'] } },
        default: '',
      },
      {
        displayName: 'File Name',
        name: 'fileName',
        type: 'string',
        displayOptions: { show: { resource: ['message'], operation: ['sendMedia'], mediaType: ['document'] } },
        default: '',
        placeholder: 'invoice.pdf',
      },
      {
        displayName: 'Send as Voice Note',
        name: 'voice',
        type: 'boolean',
        displayOptions: { show: { resource: ['message'], operation: ['sendMedia'], mediaType: ['audio'] } },
        default: true,
        description: 'Whether to send as a voice note (converted to WhatsApp format) rather than an audio file',
      },

      // Send Location
      {
        displayName: 'Latitude',
        name: 'latitude',
        type: 'number',
        typeOptions: { numberPrecision: 6 },
        displayOptions: onMessage(['sendLocation']),
        default: 0,
        required: true,
      },
      {
        displayName: 'Longitude',
        name: 'longitude',
        type: 'number',
        typeOptions: { numberPrecision: 6 },
        displayOptions: onMessage(['sendLocation']),
        default: 0,
        required: true,
      },
      {
        displayName: 'Place Name',
        name: 'placeName',
        type: 'string',
        displayOptions: onMessage(['sendLocation']),
        default: '',
      },
      {
        displayName: 'Address',
        name: 'address',
        type: 'string',
        displayOptions: onMessage(['sendLocation']),
        default: '',
      },

      sendOptions,

      // Message: mark read / get
      {
        displayName: 'Message ID',
        name: 'messageId',
        type: 'string',
        displayOptions: onMessage(['markRead', 'get', 'react']),
        default: '={{ $json.message_id }}',
        required: true,
      },
      {
        displayName: 'Emoji',
        name: 'emoji',
        type: 'string',
        displayOptions: onMessage(['react']),
        default: '👍',
        description: 'Leave empty to remove your reaction',
      },

      // Conversation
      {
        displayName: 'Conversation ID',
        name: 'conversationId',
        type: 'string',
        displayOptions: { show: { resource: ['conversation'] } },
        default: '={{ $json.conversation_id }}',
        required: true,
      },
      {
        displayName: 'Reason',
        name: 'handoffReason',
        type: 'string',
        displayOptions: { show: { resource: ['conversation'], operation: ['handoff'] } },
        default: '',
        placeholder: 'Customer wants a refund',
        description: 'Why a person is needed. Shown to whoever picks it up.',
      },
      {
        displayName: 'Summary for the Person',
        name: 'handoffSummary',
        type: 'string',
        typeOptions: { rows: 3 },
        displayOptions: { show: { resource: ['conversation'], operation: ['handoff'] } },
        default: '',
        description: 'What the agent learned so far, so the customer does not have to repeat themselves',
      },
      {
        displayName: 'Tell the Customer',
        name: 'notifyCustomer',
        type: 'boolean',
        displayOptions: { show: { resource: ['conversation'], operation: ['handoff'] } },
        default: true,
        description: 'Whether to send the customer a message that a person will reply',
      },
      {
        displayName: 'Message to Customer',
        name: 'handoffMessage',
        type: 'string',
        displayOptions: { show: { resource: ['conversation'], operation: ['handoff'], notifyCustomer: [true] } },
        default: '',
        placeholder: 'Connecting you to a team member. They will reply here shortly.',
        description: 'Leave empty for the default message',
      },
      {
        displayName: 'Messages',
        name: 'historyLimit',
        type: 'number',
        typeOptions: { minValue: 1, maxValue: 100 },
        displayOptions: { show: { resource: ['conversation'], operation: ['history'] } },
        default: 20,
        description: 'How many of the most recent messages to return (1–100)',
      },
      {
        displayName: 'Note for the Agent',
        name: 'agentNote',
        type: 'string',
        typeOptions: { rows: 3 },
        displayOptions: { show: { resource: ['conversation'], operation: ['release'] } },
        default: '',
        description: 'What the person did or decided. Saved in the conversation history as a staff note, where the agent reads it.',
      },
      {
        displayName: 'Typing',
        name: 'typingState',
        type: 'options',
        displayOptions: { show: { resource: ['conversation'], operation: ['typing'] } },
        options: [
          { name: 'On', value: 'on' },
          { name: 'Off', value: 'off' },
        ],
        default: 'on',
      },

      // Channel
      {
        displayName: 'Phone Number',
        name: 'checkPhone',
        type: 'string',
        displayOptions: { show: { resource: ['channel'], operation: ['checkNumber'] } },
        default: '',
        required: true,
        placeholder: '+923001234567',
      },
      {
        displayName: 'Channel Name or ID',
        name: 'channelId',
        type: 'options',
        typeOptions: { loadOptionsMethod: 'getChannels' },
        displayOptions: { show: { resource: ['channel'], operation: ['get', 'checkNumber'] } },
        default: '',
        required: true,
        description: 'Choose from the list, or specify an ID using an <a href="https://docs.n8n.io/code/expressions/">expression</a>',
      },
    ],
  };

  methods = {
    loadOptions: {
      async getChannels(this: ILoadOptionsFunctions) {
        return channelOptions.call(this, false);
      },
    },
  };

  async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
    const items = this.getInputData();
    const out: INodeExecutionData[] = [];

    for (let i = 0; i < items.length; i++) {
      try {
        const resource = this.getNodeParameter('resource', i) as string;
        const operation = this.getNodeParameter('operation', i) as string;
        let result: IDataObject;

        if (resource === 'message' && sendOps.includes(operation)) {
          result = await sendMessage.call(this, i, operation);
        } else if (resource === 'message' && operation === 'markRead') {
          const id = this.getNodeParameter('messageId', i) as string;
          await dwRequest.call(this, 'POST', `/v1/messages/${encodeURIComponent(id)}/read`);
          result = { ok: true, message_id: id };
        } else if (resource === 'message' && operation === 'react') {
          const id = this.getNodeParameter('messageId', i) as string;
          result = await dwRequest.call(this, 'POST', `/v1/messages/${encodeURIComponent(id)}/reaction`, { emoji: this.getNodeParameter('emoji', i, '') as string });
        } else if (resource === 'channel' && operation === 'checkNumber') {
          const ch = this.getNodeParameter('channelId', i) as string;
          const phone = this.getNodeParameter('checkPhone', i) as string;
          result = await dwRequest.call(this, 'GET', `/v1/channels/${encodeURIComponent(ch)}/check`, undefined, { qs: { phone } });
        } else if (resource === 'message' && operation === 'get') {
          result = await dwRequest.call(this, 'GET', `/v1/messages/${encodeURIComponent(this.getNodeParameter('messageId', i) as string)}`);
        } else if (resource === 'conversation' && operation === 'typing') {
          const id = this.getNodeParameter('conversationId', i) as string;
          const state = this.getNodeParameter('typingState', i) as string;
          result = await dwRequest.call(this, 'POST', `/v1/conversations/${encodeURIComponent(id)}/typing`, { state });
        } else if (resource === 'conversation' && operation === 'handoff') {
          const id = this.getNodeParameter('conversationId', i) as string;
          const notify = this.getNodeParameter('notifyCustomer', i, true) as boolean;
          const body: IDataObject = { notify_customer: notify };
          for (const [param, key] of [['handoffReason', 'reason'], ['handoffSummary', 'summary'], ['handoffMessage', 'message']] as const) {
            const v = this.getNodeParameter(param, i, '') as string;
            if (v) body[key] = v;
          }
          result = await dwRequest.call(this, 'POST', `/v1/conversations/${encodeURIComponent(id)}/handoff`, body);
        } else if (resource === 'conversation' && operation === 'release') {
          const id = this.getNodeParameter('conversationId', i) as string;
          const note = this.getNodeParameter('agentNote', i, '') as string;
          result = await dwRequest.call(this, 'POST', `/v1/conversations/${encodeURIComponent(id)}/release`, note ? { note } : {});
        } else if (resource === 'conversation' && operation === 'history') {
          const id = this.getNodeParameter('conversationId', i) as string;
          const limit = this.getNodeParameter('historyLimit', i, 20) as number;
          result = await dwRequest.call(this, 'GET', `/v1/conversations/${encodeURIComponent(id)}/history`, undefined, { qs: { limit } });
        } else if (resource === 'conversation' && operation === 'get') {
          result = await dwRequest.call(this, 'GET', `/v1/conversations/${encodeURIComponent(this.getNodeParameter('conversationId', i) as string)}`);
        } else if (resource === 'channel' && operation === 'getAll') {
          const res = await dwRequest.call(this, 'GET', '/v1/channels');
          for (const c of res.data as IDataObject[]) out.push({ json: c, pairedItem: { item: i } });
          continue;
        } else if (resource === 'channel' && operation === 'get') {
          result = await dwRequest.call(this, 'GET', `/v1/channels/${encodeURIComponent(this.getNodeParameter('channelId', i) as string)}`);
        } else {
          throw new NodeOperationError(this.getNode(), `Unsupported operation ${resource}.${operation}`, { itemIndex: i });
        }
        out.push({ json: result, pairedItem: { item: i } });
      } catch (error) {
        if (this.continueOnFail()) {
          out.push({ json: { error: (error as Error).message }, pairedItem: { item: i } });
          continue;
        }
        // Keeps DeployWizard's message and error code from dwRequest, tied to the failing item.
        throw new NodeOperationError(this.getNode(), error as Error, {
          itemIndex: i,
          description: error instanceof NodeApiError ? (error.description ?? undefined) : undefined,
        });
      }
    }
    return [out];
  }
}

async function sendMessage(this: IExecuteFunctions, i: number, operation: string): Promise<IDataObject> {
  const recipient = this.getNodeParameter('recipient', i) as string;
  const options = this.getNodeParameter('options', i, {}) as IDataObject;
  const body: IDataObject = {};

  if (recipient === 'conversation') {
    const conversationId = String(this.getNodeParameter('conversationId', i) ?? '').trim();
    if (!conversationId) {
      throw new NodeOperationError(this.getNode(), 'Conversation ID is empty. Connect this node after a DeployWizard Trigger, or choose "Phone Number".', { itemIndex: i });
    }
    body.conversation_id = conversationId;
  } else {
    body.channel_id = this.getNodeParameter('channelId', i) as string;
    body.to = this.getNodeParameter('to', i) as string;
  }

  if (operation === 'sendText') {
    body.type = 'text';
    body.text = { body: this.getNodeParameter('text', i) as string };
  } else if (operation === 'sendLocation') {
    body.type = 'location';
    const name = this.getNodeParameter('placeName', i, '') as string;
    const address = this.getNodeParameter('address', i, '') as string;
    body.location = {
      latitude: this.getNodeParameter('latitude', i) as number,
      longitude: this.getNodeParameter('longitude', i) as number,
      ...(name ? { name } : {}),
      ...(address ? { address } : {}),
    };
  } else {
    const type = this.getNodeParameter('mediaType', i) as string;
    const source = this.getNodeParameter('mediaSource', i) as string;
    const media: IDataObject = {};
    if (source === 'url') {
      media.url = this.getNodeParameter('mediaUrl', i) as string;
    } else {
      const prop = this.getNodeParameter('binaryProperty', i) as string;
      const meta = this.helpers.assertBinaryData(i, prop);
      const bytes = await this.helpers.getBinaryDataBuffer(i, prop);
      const uploaded = await dwRequest.call(this, 'POST', '/v1/media', bytes, {
        headers: { 'Content-Type': meta.mimeType },
        qs: meta.fileName ? { filename: meta.fileName } : {},
        json: false,
      });
      const parsed = typeof uploaded === 'string' ? JSON.parse(uploaded) : uploaded;
      media.media_id = parsed.id;
      if (meta.fileName) media.filename = meta.fileName;
    }
    if (type === 'audio') {
      media.voice = this.getNodeParameter('voice', i) as boolean;
    } else {
      const caption = this.getNodeParameter('caption', i, '') as string;
      if (caption) media.caption = caption;
    }
    if (type === 'document') {
      const fileName = this.getNodeParameter('fileName', i, '') as string;
      if (fileName) media.filename = fileName;
    }
    body.type = type;
    body[type] = media;
  }

  if (options.replyTo) body.reply_to = options.replyTo;
  if (options.mentionAuthor) body.mention_author = true;
  if (options.quote === false) body.quote = false;

  const typingMs = Number(options.typingMs ?? 0);
  if (recipient === 'conversation' && typingMs > 0) {
    // Best effort: a failed typing indicator should never block the actual reply.
    await dwRequest.call(this, 'POST', `/v1/conversations/${encodeURIComponent(body.conversation_id as string)}/typing`, { state: 'on' }).catch(() => undefined);
    await sleep(typingMs);
  }

  const headers = options.idempotencyKey ? { 'Idempotency-Key': String(options.idempotencyKey) } : undefined;
  return dwRequest.call(this, 'POST', '/v1/messages', body, headers ? { headers } : {});
}
