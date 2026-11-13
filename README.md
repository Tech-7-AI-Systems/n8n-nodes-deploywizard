# n8n-nodes-deploywizard

n8n nodes for DeployWizard: receive and send WhatsApp messages through one API.

## Nodes

**DeployWizard Trigger** — starts a workflow when a message or status update arrives.
- Pick a number (or All Channels) and the events to listen for.
- Activating the workflow registers the webhook with DeployWizard automatically; deactivating removes it.
- Every request is checked against its HMAC signature and rejected if older than 5 minutes.
- Output: the fields you map, plus the full event under `details`:

  | Field | Meaning |
  | --- | --- |
  | `event` | What happened, e.g. `message.received` |
  | `text`, `from`, `contact_name` | The message text (or caption), the customer's number and name |
  | `message_type`, `media_url` | `text`, `image`, `audio`…, and a download link for media |
  | `conversation_id`, `message_id` | IDs to reply, react or hand off |
  | `chat_owner` | Who handles the chat: `agent`, `waiting` (for a person) or `person` |
  | `asked_for_person` | DeployWizard thinks the customer asked for a human. Your agent decides |
  | `details` | The complete event, for anything else |

**DeployWizard** — actions.

| Resource | Operations |
| --- | --- |
| Message | Send Text · Send Media (image, video, document, voice note; from a URL or a binary file) · Send Location · Mark as Read · Get |
| Conversation | Set Typing (on/off) · Get |
| Channel | Get Many · Get |

Sends reply in the trigger's conversation by default (`{{ $json.conversation_id }}`), or to any phone number.
Options: show "typing…" first, quote a message, idempotency key.

## WhatsApp groups

The trigger's **WhatsApp Groups** option is **Off** by default.

- **When Tagged:** the workflow runs when someone @tags the number in a group, or replies to one of its messages. `@all` doesn't count.
- **All Messages:** every message in groups the number is in.

Group items include `is_group`, `group_name`, `mentioned_me` and `replied_to_me`. `from` and `contact_name` are the person who wrote the message. The number's own @tag is removed from `text`.

Replying with **Send Text** in the trigger's conversation goes to the group. It automatically quotes the latest message that tagged the number, if that message hasn't been answered yet. Turn on **Mention the Author (Groups)** to @tag the person who asked. Handoff is for one-to-one chats only.

## Credential

| Field | Value |
| --- | --- |
| API Key | Your DeployWizard API key (starts with `dw_live_`), from the dashboard |
| Base URL | `https://api.deploywizard.io` for DeployWizard cloud, or your own address if you self-host |

## Install

**n8n cloud and self-hosted:** Settings → Community Nodes → Install → `n8n-nodes-deploywizard`.

**From a local build (self-hosted):**

```bash
npm install && npm run build && npm pack
mkdir -p ~/.n8n/custom && cd ~/.n8n/custom && npm init -y
npm install --legacy-peer-deps /path/to/n8n-nodes-deploywizard-<version>.tgz
# restart n8n
```

`--legacy-peer-deps` matters: n8n must use its own copy of `n8n-workflow`, not a second one.

## Example

[`examples/group-helper-agent.json`](examples/group-helper-agent.json) is a student group helper: it answers when someone tags the number in a WhatsApp group. Import it in n8n, then pick your DeployWizard and OpenAI credentials.

## Develop

```bash
npm test   # builds, then runs the nodes against a mocked n8n runtime
npm run lint
```

## Release

Releases are published to npm by GitHub Actions with provenance (`.github/workflows/publish.yml`).
Run `npm run release` locally: it bumps the version, tags and pushes, and the tag triggers the publish.

## AI agents and human handoff

The agent decides when a person should take over. DeployWizard carries it out reliably.

1. In n8n, add an **AI Agent** node after the **DeployWizard Trigger**.
2. Under **Tools**, add **DeployWizard Tool** → Resource **Conversation** → Operation **Hand Off to Human**.
   - Conversation ID: `{{ $('DeployWizard Trigger').item.json.conversation_id }}`
   - Reason, Summary, Message to Customer: click the ✨ button so the model fills them in.
3. Give the agent a rule in its system message, for example:

   > If the customer asks for a person, is upset, or needs something you cannot do (refunds, payments, complaints),
   > call "Hand Off to Human" with a one-line reason and a short summary of the conversation. Do not reply further.
   > `{{ $json.asked_for_person }}` is true when the customer's message looks like a request for a person.

When the tool runs, DeployWizard:
- tells the customer a person will reply (your message, or the default),
- pauses the trigger for that chat, so the agent can't talk over the person,
- sends `conversation.handoff_requested` with the reason and summary, for alerting staff.

A person can then reply from the business phone (DeployWizard notices and marks the chat as theirs) or via the API.
**Return to Agent** hands it back, optionally with a note saved in the history. Chats also return after 30
minutes without a staff reply, or if nobody picks up a waiting chat.

Give the agent the **DeployWizard Tool → Conversation → Get History** tool too (Conversation ID from the trigger,
Messages: 20). It returns recent messages oldest first, each marked `customer`, `agent`, `person`, `system` or `note`,
including what staff typed on the phone, so the agent can pick up where a person left off.
