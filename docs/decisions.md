# Decisions API

PAG handles **structured decisions**, not chat completions. A single local PAG API key and a stable virtual model (e.g. `decision`) work across supported upstream providers. Routes can fall back to another configured, compatible Decisions provider.

## Configure provider accounts

Two upstream wire protocols are supported; **choose explicitly** when registering the account:

- `systemone`: named questions in an object and `state`. This covers OpenRouter's alpha Decisions API, Cloudflare Clef/Workers AI and Vercel Gateway's `/v1/evaluate` compatibility endpoint.
- `openai`: native OpenAI Decisions `input` and named `questions[]`, returned as `answers[]`. Used by the direct OpenAI Platform API and Vercel Gateway's native-compatible `/v1/decisions`.

Examples (**replace model IDs with models currently enabled for your accounts**):

~~~sh
# PAG_HOME defaults to ~/.config/pag
npm run pag -- init

# OpenRouter System One
npm run pag -- auth add openrouter-dc --kind decisions \
  --protocol systemone \
  --decisions-url https://openrouter.ai/api/alpha/decisions --key-stdin < /path/to/openrouter-key

# Direct OpenAI Decisions: requires an OpenAI *Platform* API key, NOT a ChatGPT Plus subscription
npm run pag -- auth add openai-dc --kind decisions \
  --protocol openai \
  --base-url https://api.openai.com/v1 --key-stdin < /path/to/openai-platform-key

# Vercel AI Gateway legacy System One: --decisions-url https://ai-gateway.vercel.sh/v1/evaluate
# Vercel AI Gateway native Decisions: --protocol openai --base-url https://ai-gateway.vercel.sh/v1

# Choose route priority; provider/model names may change independently of the alias.
npm run pag -- route set decision decisions \
  openai-dc:gpt-6-luna \
  openrouter-dc:typesafe/jev-1.13

npm run pag -- route fallback decision on
npm start
~~~

CLI credentials are stored locally and never exposed to callers. If the first provider rate-limits or fails, the gateway advances to the next eligible route. Explicit disabled routes and incompatible input shapes are skipped.

**ChatGPT OAuth does not grant native Decisions API entitlement.** Use documented provider API keys.

## Public format 1: PAG System One (backwards compatible)

~~~sh
curl http://127.0.0.1:4000/v1/decisions \
 -H "Authorization: Bearer $PAG_KEY" -H "Content-Type: application/json" \
 -d '{
   "model":"decision",
   "state": {"ticket":"Checkout fails with HTTP 500"},
   "questions": {
      "urgent":{"type":"predicate","instructions":"Is this urgent?"},
      "team":{"type":"choice","instructions":"Which team?","choices":{"billing":"Payments","engineering":"Application defects"}},
      "severity":{"type":"score","instructions":"Rate impact","levels":["Low","Medium","High"]}
   }
 }'
~~~

Possible response (illustrative):

~~~json
{
  "model": "decision",
  "answers": {
    "urgent": { "type": "predicate", "probability": 0.92 },
    "team": { "type": "choice", "choice": "engineering", "confidence": 0.84 },
    "severity": { "type": "score", "score": 1.7 }
  }
}
~~~

Probabilities, confidence, distributions and usage are included only if returned by the upstream. A question may yield a `{ "type": "refusal" }` rather than a fabricated guess. System One upstream uses `noul` for predicate; PAG translates it.

## Public format 2: OpenAI-compatible Decisions shape

~~~sh
curl http://127.0.0.1:4000/v1/decisions \
 -H "Authorization: Bearer $PAG_KEY" -H "Content-Type: application/json" \
 -d '{
   "model":"decision",
   "input": "Checkout fails with HTTP 500",
   "questions": [
     {"name":"urgent","type":"predicate","instructions":"Is this urgent?"},
     {"name":"team","type":"choice","instructions":"Which team?",
       "choices":[{"value":"billing","description":"Payments"},{"value":"engineering","description":"Application defects"}]},
     {"name":"severity","type":"score","instructions":"Rate impact",
       "levels":[{"label":"Low"},{"label":"Medium"},{"label":"High"}]}
   ]
 }'
~~~

This shape returns `answers[]` in question order with their `name` properties. PAG preserves upstream probability arrays and score labels when supplied. For safety and System One interoperability, **v0.1 accepts only string-valued choices**, with named questions, and supports up to 64 questions. The direct OpenAI API may support additional values/media not yet handled by PAG.

## Input compatibility

- The System One shape accepts text and JSON `state`.
- Native requests accept text `input` or message arrays, but **native message-array inputs cannot fall back to System One** without lossy transformation, so PAG skips those routes.
- When converting JSON `state` to direct OpenAI, PAG serializes it as JSON text. This preserves information but changes the textual representation seen by the upstream model.
- For score questions, level indices are zero-based. Scores are probability-weighted and may be fractional.
- A requested choice must be among provided values. An incomplete/invalid upstream answer is treated as a failed attempt eligible for fallback.
- Cross-provider probability distributions can vary; treat thresholds as model-dependent and evaluate them before using them for high-impact automation.

References: [OpenAI Decisions API](https://developers.openai.com/api/reference/resources/decisions/methods/create), [OpenRouter Decisions](https://openrouter.ai/blog/insights/what-is-jev/), [Vercel endpoints](https://vercel.com/i/ai-sdk-evaluation-to-decisions), [Cloudflare Clef](https://developers.cloudflare.com/workers-ai/models/clef-omni/).
