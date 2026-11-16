# WhatsApp via Twilio — setup and testing

The agent talks to buyers on WhatsApp through Twilio (decision D2). One
platform Twilio account holds every seller's WhatsApp sender; the app routes
each inbound message to the seller by the number it was sent to.

## 1. Platform setup (once, by the platform owner)

In Vercel (project `salesatscale18`) → Settings → Environment Variables, set
for **Production** (and Preview if you test there; Preview shares the
production database):

| Variable | Where to find it |
| --- | --- |
| `TWILIO_ACCOUNT_SID` | Twilio Console → Account info (starts with `AC`) |
| `TWILIO_AUTH_TOKEN` | Twilio Console → Account info |
| `ANTHROPIC_API_KEY` | Anthropic Console → API keys (the agent's model) |
| `APP_URL` | Recommended: `https://salesatscale18.vercel.app` (status callbacks and signature checks use it) |

Redeploy after changing them. Never paste these values into chat, issues or
commits. The app never stores them in the database.

## 2. Point Twilio at the app

For the sender (or the **WhatsApp Sandbox**: Console → Messaging → Try it out →
Send a WhatsApp message → Sandbox settings), set:

- **When a message comes in:** `https://salesatscale18.vercel.app/api/webhooks/whatsapp`, method **HTTP POST**

Status callbacks (`…/api/webhooks/whatsapp/status`) are passed on every send;
nothing to configure. Both webhooks check `X-Twilio-Signature` and reject
anything unsigned (403).

## 3. Seller setup (in the app)

Settings › WhatsApp:

1. **Add a number:** the WhatsApp sender in E.164, e.g. `+14155238886` for
   the Twilio Sandbox. Optional: a Messaging Service SID (`MG…`) and a market.
2. **Tester phones:** your team's phones on that number. Sandbox testers must
   first join the sandbox from their phone (send `join <code>` to the sandbox
   number).
3. **Templates** (needed only to *start* conversations with real leads): build
   them in Twilio's Content Template Builder, submit for WhatsApp approval,
   then add the Content SID (`HX…`) here as an *Opening message*. Variables:
   `{{1}}` = lead's first name, `{{2}}` = your company name. "Check approval
   status" re-reads Twilio.

## 4. Test the agent from a phone (test lab)

Works before the account is live, with no lead and no template:

1. A tester phone sends any message to the number.
2. Setup › Test lab lists a new chat marked WhatsApp, running the **draft**
   agent. The agent's reply arrives on the phone; refresh the page to follow
   along with the tool trace and deal state.
3. Take over / reply as a person / hand back work from the test lab too.

Tester chats use a hidden test lead and never touch a real lead with the same
phone. Removing a phone from the tester list stops sends to it at once.

## 5. Real leads

After go-live, on a lead card: **Start on WhatsApp** sends the approved
opening template once every gate passes (consent, not opted out, account
live, contact hours, number, approved opener, live agent). The card says
which gate is missing. When the buyer replies, the agent continues within the
24-hour window; after it closes, free text is refused (only templates).
"STOP" opts the lead out at once with one confirmation.

Before go-live, messages from real leads are ignored.

## Not done yet

- Conversations inbox, and sending a template by hand outside the window (P6.6).
- Background job runner for retries (P6.7, decision D6): a failed send is
  stored on the message ("Not sent: …") and on the number ("Last error").
- Media is described to the agent, not downloaded.
