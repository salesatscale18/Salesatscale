# Lead intake API

Send leads from a website form or CRM to Sales at Scale. Create a key in
**Settings → Lead intake from your website** of the seller account. Call the API
from your **server**, never from the browser, so the key stays secret.

```
POST https://<app-domain>/api/leads/<account-slug>
Authorization: Bearer <intake key>
Content-Type: application/json
```

## Body

| Field | Required | Notes |
|---|---|---|
| `full_name` | yes | Full name (`name` also accepted) |
| `phone` | yes | WhatsApp number. International format (`+972…`) or national for the account's market |
| `language` | no | `en` or `he` (also `English`, `Hebrew`). Defaults to the first selling language of the lead's market |
| `country` | no | The form's country field, e.g. `GB` or `United Kingdom`. Chooses the lead's market when it matches a market's form country values |
| `business` | no | Business name (`company` also accepted) |
| `email` | no | Email address |
| `source` | no | Label shown in the leads list. Default `Website form` |
| `source_id` | no | Your ID for this lead; used to match updates |
| `consent.given` | no | `false` if the agent must not contact this person. Default: `true` (the person asked to be called back) |
| `consent.source` | no | Where and how they agreed, e.g. the form's page. Default: the intake key's name |
| `consent.text` | no | Exact wording they agreed to. Default: "This person asked to be contacted by SMS, WhatsApp or email" |
| `consent.at` | no | ISO time they agreed. Default: now |
| `consent.page_url` | no | Page where they agreed |
| `consent.ip` | no | Defaults to the caller's IP |

Leads sent here asked to hear from the seller, so a new lead gets a consent
record automatically (the time it arrived and the intake key), unless
`consent.given` is `false`: then the lead is saved and the agent never
contacts them. A consent note that is sent is kept. A delivery for a lead that
already exists adds a consent record only when it carries its own note or
`consent.given: true`.

Every lead gets a market: the market linked to the intake key, else the market whose form country values match `country`, else the market with the longest matching phone prefix, else the home market. A lead that already exists keeps its market.

```json
{
  "full_name": "Rina Cohen",
  "phone": "+972545551842",
  "language": "he",
  "business": "Rina's Kitchen",
  "source_id": "form-88213",
  "consent": {
    "source": "yoursite.example/contact",
    "text": "I agree to be contacted on WhatsApp about temperature monitoring",
    "at": "2026-11-09T09:12:00Z"
  }
}
```

Every call (accepted or rejected) appears under **Recent deliveries** in the same Settings page.

## Responses

| Status | Meaning |
|---|---|
| `201` `{ "id", "created": true, "status" }` | New lead created |
| `200` `{ "id", "created": false, "status" }` | A lead with the same phone or `source_id` existed and was updated |
| `400` `invalid_json` | Body is not a JSON object |
| `401` `unauthorized` | Missing, wrong or revoked key, or a key for another account |
| `409` `opted_out` | This person opted out. They are never re-added without new consent |
| `409` `phone_conflict` | The `source_id` matches one lead but the phone belongs to another |
| `413` `payload_too_large` | Body over 32 KB |
| `422` `invalid_lead` | Fields failed validation (`fields` says which) |

