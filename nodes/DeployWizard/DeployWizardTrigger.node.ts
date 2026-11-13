import { createHmac, timingSafeEqual } from 'crypto';
import {
  NodeConnectionTypes,
  type IDataObject,
  type IHookFunctions,
  type ILoadOptionsFunctions,
  type INodeType,
  type INodeTypeDescription,
  type IWebhookFunctions,
  type IWebhookResponseData,
} from 'n8n-workflow';
import { CREDENTIAL, channelOptions, dwRequest, withShortcuts } from './GenericFunctions';

/** Requests older than this are rejected, so a captured request cannot be replayed later. */
const MAX_AGE_S = 300;

/** The URL n8n wants events on: its test URL while you listen, its production URL while published. */
const targetUrl = async (ctx: IHookFunctions): Promise<string> => ctx.getNodeWebhookUrl('default') as string;

export class DeployWizardTrigger implements INodeType {
  description: INodeTypeDescription = {
    displayName: 'DeployWizard Trigger',
    name: 'deployWizardTrigger',
    icon: { light: 'file:deploywizard.svg', dark: 'file:deploywizard.dark.svg' },
    group: ['trigger'],
    version: 1,
    subtitle: '={{ $parameter["events"].join(", ") }}',
    description: 'Starts the workflow when a WhatsApp message or status update arrives through DeployWizard',
    defaults: { name: 'DeployWizard Trigger' },
    inputs: [],
    outputs: [NodeConnectionTypes.Main],
    credentials: [{ name: CREDENTIAL, required: true }],
    webhooks: [{ name: 'default', httpMethod: 'POST', responseMode: 'onReceived', path: 'webhook' }],
    properties: [
      {
        displayName: 'Channel Name or ID',
        name: 'channelId',
        type: 'options',
        typeOptions: { loadOptionsMethod: 'getChannelsWithAll' },
        default: '__all__',
        description:
          'Which WhatsApp number to listen to. Choose from the list, or specify an ID using an <a href="https://docs.n8n.io/code/expressions/">expression</a>.',
      },
      {
        displayName: 'Events',
        name: 'events',
        type: 'multiOptions',
        default: ['message.received'],
        required: true,
        options: [
          { name: 'Chat Claimed by a Person', value: 'conversation.claimed', description: 'A person took over, e.g. by replying on the phone' },
          { name: 'Chat Returned to Agent', value: 'conversation.returned_to_agent', description: 'The person handed the chat back, with an optional note' },
          { name: 'Connection Stalled', value: 'channel.stale', description: 'The number stopped responding; DeployWizard is restarting it' },
          { name: 'Handoff Requested', value: 'conversation.handoff_requested', description: 'A chat needs a person (asked by the agent, the customer, or a rule)' },
          { name: 'Logged Out on Phone', value: 'channel.logged_out', description: 'The linked device was removed in WhatsApp' },
          { name: 'Message Deleted', value: 'message.deleted', description: 'A customer deleted a message for everyone' },
          { name: 'Message Delivered', value: 'message.delivered', description: 'Your message reached the phone' },
          { name: 'Message Edited', value: 'message.edited', description: 'A customer edited a message they sent' },
          { name: 'Message Failed', value: 'message.failed', description: 'Your message could not be sent' },
          { name: 'Message Read', value: 'message.read', description: 'The customer read your message' },
          { name: 'Message Received', value: 'message.received', description: 'A customer sent a message' },
          { name: 'Message Sent', value: 'message.sent', description: 'WhatsApp accepted your message' },
          { name: 'Number Connected', value: 'channel.connected' },
          { name: 'Number Disconnected', value: 'channel.disconnected', description: 'Logged out or phone offline too long' },
          { name: 'QR Code Needed', value: 'channel.qr_required', description: 'The number must be linked again' },
          { name: 'Reaction', value: 'message.reaction', description: 'A customer reacted to a message with an emoji' },
        ],
      },
      {
        displayName: 'Pause While a Person Handles the Chat',
        name: 'pauseDuringHandoff',
        type: 'boolean',
        default: true,
        description: "Whether to stop receiving a chat's messages while it's handed off to a person. Keep on for AI agents; turn off for logging or CRM workflows.",
      },
      {
        displayName: 'WhatsApp Groups',
        name: 'groups',
        type: 'options',
        default: 'off',
        options: [
          { name: 'All Messages', value: 'all', description: 'Everything said in groups the number is in' },
          { name: 'Off', value: 'off', description: 'Only one-to-one chats' },
          { name: 'When Tagged', value: 'mentions', description: 'Messages that @tag the number or reply to its messages. @all is ignored.' },
        ],
        description: 'Which group messages start this workflow',
      },
    ],
  };

  methods = {
    loadOptions: {
      async getChannelsWithAll(this: ILoadOptionsFunctions) {
        return channelOptions.call(this, true);
      },
    },
  };

  webhookMethods = {
    default: {
      async checkExists(this: IHookFunctions): Promise<boolean> {
        const data = this.getWorkflowStaticData('node');
        if (!data.subscriptionId) return false;
        const url = await targetUrl(this);
        const res = await dwRequest.call(this, 'GET', '/v1/webhook-subscriptions');
        const groups = this.getNodeParameter('groups', 'off') as string;
        const found = (res.data as IDataObject[]).some(
          (s) => s.id === data.subscriptionId && s.status === 'active' && s.url === url && (s.groups ?? 'off') === groups,
        );
        // A changed setting means a new endpoint: remove the old one so it stops receiving.
        if (!found && data.subscriptionId) {
          await dwRequest.call(this, 'DELETE', `/v1/webhook-subscriptions/${data.subscriptionId}`).catch(() => undefined);
        }
        if (!found) {
          delete data.subscriptionId;
          delete data.secret;
        }
        return found;
      },

      async create(this: IHookFunctions): Promise<boolean> {
        const channelId = this.getNodeParameter('channelId') as string;
        const body: IDataObject = {
          url: await targetUrl(this),
          events: this.getNodeParameter('events') as string[],
          pause_during_handoff: this.getNodeParameter('pauseDuringHandoff', true) as boolean,
          groups: this.getNodeParameter('groups', 'off') as string,
          ...(channelId && channelId !== '__all__' ? { channel_ids: [channelId] } : {}),
        };
        const res = await dwRequest.call(this, 'POST', '/v1/webhook-subscriptions', body);
        const data = this.getWorkflowStaticData('node');
        data.subscriptionId = res.id;
        data.secret = res.secret;
        return true;
      },

      async delete(this: IHookFunctions): Promise<boolean> {
        const data = this.getWorkflowStaticData('node');
        if (data.subscriptionId) {
          try {
            await dwRequest.call(this, 'DELETE', `/v1/webhook-subscriptions/${data.subscriptionId}`);
          } catch (error) {
            // Usually already gone on the DeployWizard side; nothing left to clean up.
            this.logger.debug('DeployWizard: could not remove webhook subscription', { error: (error as Error).message });
          }
        }
        delete data.subscriptionId;
        delete data.secret;
        return true;
      },
    },
  };

  async webhook(this: IWebhookFunctions): Promise<IWebhookResponseData> {
    const data = this.getWorkflowStaticData('node');
    const secret = data.secret as string | undefined;
    const headers = this.getHeaderData() as IDataObject;
    const body = this.getBodyData() as IDataObject;

    if (secret) {
      const req = this.getRequestObject() as unknown as { rawBody?: Buffer };
      const raw = req.rawBody ? req.rawBody.toString('utf8') : JSON.stringify(body);
      const ts = String(headers['dw-timestamp'] ?? '');
      const sig = String(headers['dw-signature'] ?? '');
      const expected = `v1=${createHmac('sha256', secret).update(`${ts}.${raw}`).digest('hex')}`;
      const fresh = Math.abs(Date.now() / 1000 - Number(ts)) <= MAX_AGE_S;
      const valid = sig.length === expected.length && timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
      if (!fresh || !valid) {
        const res = this.getResponseObject();
        res.status(401).json({ error: 'Invalid or expired DeployWizard signature' });
        return { noWebhookResponse: true };
      }
    }

    return { workflowData: [this.helpers.returnJsonArray([withShortcuts(body)])] };
  }
}
