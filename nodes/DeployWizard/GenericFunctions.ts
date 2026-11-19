import {
  NodeApiError,
  type IDataObject,
  type IExecuteFunctions,
  type IHookFunctions,
  type IHttpRequestMethods,
  type IHttpRequestOptions,
  type ILoadOptionsFunctions,
  type INodePropertyOptions,
  type IWebhookFunctions,
  type JsonObject,
} from 'n8n-workflow';

type Ctx = IExecuteFunctions | ILoadOptionsFunctions | IHookFunctions | IWebhookFunctions;

export const CREDENTIAL = 'deployWizardApi';

type ApiError = { message?: string; code?: string; retryable?: boolean };

/** Calls the DeployWizard API with the node's credential and turns API errors into readable n8n errors. */
export async function dwRequest(
  this: Ctx,
  method: IHttpRequestMethods,
  path: string,
  body?: IDataObject | Buffer,
  extra: Partial<IHttpRequestOptions> = {},
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- API responses vary by endpoint
): Promise<any> {
  const creds = await this.getCredentials(CREDENTIAL);
  const baseUrl = String(creds.baseUrl).replace(/\/$/, '');
  const options: IHttpRequestOptions = {
    method,
    url: `${baseUrl}${path}`,
    json: !Buffer.isBuffer(body),
    ...(body !== undefined ? { body } : {}),
    ...extra,
  };
  try {
    return await this.helpers.httpRequestWithAuthentication.call(this, CREDENTIAL, options);
  } catch (error) {
    const e = error as {
      message?: string;
      response?: { body?: { error?: ApiError }; data?: { error?: ApiError } };
      cause?: { response?: { data?: { error?: ApiError } } };
    };
    const apiError = e?.response?.body?.error ?? e?.cause?.response?.data?.error ?? e?.response?.data?.error;
    throw new NodeApiError(this.getNode(), error as JsonObject, {
      message: apiError?.message ?? e?.message,
      description: apiError ? `DeployWizard error code: ${apiError.code}${apiError.retryable ? ' (safe to retry)' : ''}` : undefined,
    });
  }
}

export async function channelOptions(this: ILoadOptionsFunctions, includeAll: boolean): Promise<INodePropertyOptions[]> {
  const res = await dwRequest.call(this, 'GET', '/v1/channels');
  const channels = res.data as IDataObject[];
  // Real numbers first; the Sandbox (DeployWizard's test chat) last, clearly named.
  const real = channels.filter((c) => !c.test).map((c) => ({
    name: `${c.name} (${c.phone ?? c.status})`,
    value: c.id as string,
    description: `Status: ${c.status}`,
  }));
  const sandbox = channels.filter((c) => c.test).map((c) => ({
    name: 'Sandbox (test chat, nothing is sent on WhatsApp)',
    value: c.id as string,
    description: 'Write as a customer on the Sandbox page in DeployWizard; replies show up there',
  }));
  const options: INodePropertyOptions[] = [...real, ...sandbox];
  return includeAll ? [{ name: 'All Channels', value: '__all__' }, ...options] : options;
}

/**
 * What the trigger outputs: the fields people actually map, each with one clear meaning,
 * and the complete event under `details` for anything else.
 */
export function withShortcuts(event: IDataObject): IDataObject {
  const message = (event.message ?? {}) as IDataObject;
  const contact = (event.contact ?? {}) as IDataObject;
  const conversation = (event.conversation ?? {}) as IDataObject;
  const hints = (event.hints ?? {}) as IDataObject;
  const group = event.group as IDataObject | undefined;
  const channel = (event.channel ?? {}) as IDataObject;
  const type = message.type as string | undefined;
  const body = (type ? message[type] : undefined) as IDataObject | undefined;
  return {
    event: event.type ?? null,
    text: (type === 'text' ? body?.body : body?.caption) ?? null,
    from: contact.phone ?? contact.chat_id ?? null,
    contact_name: contact.name ?? null,
    message_type: type ?? null,
    media_url: body?.url ?? null,
    conversation_id: conversation.id ?? null,
    // The message came from the Sandbox (DeployWizard's test chat), not a real customer.
    sandbox: Boolean(channel.test),
    message_id: message.id ?? null,
    // Who handles this chat right now: "agent", "waiting" (for a person) or "person".
    chat_owner: conversation.owner ?? 'agent',
    // DeployWizard thinks the customer asked for a person. Your agent decides what to do.
    asked_for_person: Boolean(hints.asked_for_person),
    // Groups: the group's name, and whether the message tagged this number or replied to it.
    is_group: Boolean(group),
    group_name: group?.name ?? null,
    mentioned_me: Boolean(message.mentioned_me),
    replied_to_me: Boolean(message.replied_to_me),
    details: event,
  };
}
