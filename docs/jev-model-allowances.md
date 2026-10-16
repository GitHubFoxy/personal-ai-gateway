# Jev decision-модели: тарифы, бесплатные лимиты и порядок fallback

Проверено: 2026-10-16. Цены и бесплатные маршруты меняются; перед выпуском конфигурации fallback сверяйте ссылки на страницы провайдеров.

## Короткий вывод

- У моделей из списка нет отдельной гарантированной месячной бесплатной квоты.
- OpenRouter ограничивает бесплатные model routes общим лимитом: 20 запросов в минуту и 50 в день; после покупки кредитов минимум на $10 лимит становится 1 000 запросов в день. Это дневные ограничения, не месячный кредит. Платные маршруты оплачиваются по токенам.
- Vercel AI Gateway предоставляет команде общий кредит $5 в месяц, но он покрывает только модели с отметкой в столбце **Free AI Gateway Credit** каталога. Это кредит аккаунта/команды, а не каждой модели. На приложенном пользователем снимке среди моделей из списка отметка есть у `liquid/d1-ultra` и `perplexity/pplx-decider-v1.1-27b`; у Jev 1.14, Microsoft Decision-1, GPT-6 Luna Decisions и `liquid/d1` стоит крестик.
- Cloudflare Workers AI включает 10 000 Neurons в день на аккаунт. Лимит общий для всех моделей Workers AI и сбрасывается ежедневно в 00:00 UTC. Workers Paid стоит $5 в месяц, но эта сумма не является месячной квотой inference: дневные 10 000 Neurons остаются включёнными, а превышение оплачивается отдельно.
- Единственный найденный явный бесплатный OpenRouter SKU среди моделей списка — `inception/mercury-decide:free`. Его доступность может измениться; он подчиняется общим ограничениям бесплатных маршрутов.

## Модели и доступность

Цены ниже — опубликованные цены за 1 млн входных токенов на указанном маршруте. Для некоторых decision-моделей выходные токены бесплатны. Цены и доступные провайдеры маршрутизации могут меняться.

| Модель с диаграммы | Вероятный API ID / маршрут | Текущая информация о бесплатном использовании и цене |
|---|---|---|
| `ai-ultra` (65) | Вероятно, Liquid AI `liquid/d1-ultra` | Соответствие подписи диаграммы — предположение. В каталоге Vercel отмечен как подходящий для общего месячного AI Gateway Credit $5; цена около $0.04/M input. Это кредит, а не бесплатная цена без ограничений. Liquid AI отдельно упоминает $2 стартовых кредитов новым организациям; это разовый кредит. |
| Jev 1.14 (57) | OpenRouter `typesafe/jev-1.14`; Vercel `typesafe-ai/jev-1.14.0` | Около $0.04/M input. На снимке каталога Vercel у модели стоит крестик в столбце Free AI Gateway Credit: общий месячный кредит её не покрывает. |
| GLiDE (54) | Вероятно, Fastino Labs GLiDE | Идентификация по названию диаграммы. В публичных каталогах OpenRouter/Vercel на дату проверки модель не найдена. Fastino API: около $0.15/M input; отдельная месячная квота не опубликована. |
| Microsoft Decision-1 (54) | `microsoft/microsoft-decision-1` | Около $0.04/M input. На снимке каталога Vercel у модели стоит крестик в столбце Free AI Gateway Credit: общий месячный кредит её не покрывает. |
| Decider V1.27B (53) | Вероятно, Perplexity `pplx-decider-v1.1-27b` | Вероятное соответствие — Decider V1.1 27B. Около $0.02/M input. На снимке каталога Vercel у модели есть отметка Free AI Gateway Credit: она подходит под общий месячный кредит $5, пока этот кредит доступен. |
| Mercury Decide (53) | `inception/mercury-decide` | Платный OpenRouter SKU: около $0.02/M input (страница указывает промоцену, обычная опубликованная цена около $0.04/M). Отдельный SKU `inception/mercury-decide:free` сейчас стоит $0; общий бесплатный лимит OpenRouter, не месячная квота. В публичном каталоге Vercel не найден. |
| Celeris-Decision (52) | Celeris `celeris-1-decision` | Прямой API Celeris: около $0.04/M input, output бесплатен. Модель не найдена в публичных каталогах OpenRouter/Vercel. Celeris описывает рекламные кредиты с ограниченным сроком, но постоянную месячную квоту не публикует. |
| d1 (50) | Liquid AI `liquid/d1` | Около $0.02/M input. На снимке каталога Vercel у модели стоит крестик в столбце Free AI Gateway Credit: общий месячный кредит её не покрывает. У Liquid AI возможны разовые стартовые кредиты $2 новым организациям; это не recurring monthly allowance. |
| Clef (49) | Cloudflare `@cf/cloudflare/clef`; OpenRouter `cloudflare/clef` | Через Cloudflare: около $0.24/M input; через OpenRouter цены зависят от маршрута и провайдера (примерно $0.042–$0.24/M). Не обнаружен бесплатный SKU OpenRouter или опубликованная карточка Vercel. При прямом запуске в Workers AI расходует общую квоту 10 000 Neurons/day. |
| GPT-6 Luna Decisions (48) | `openai/gpt-6-luna-decisions` | Около $0.10/M input. На снимке каталога Vercel у модели стоит крестик в столбце Free AI Gateway Credit: общий месячный кредит её не покрывает. |
| Clef Flash (46) | Cloudflare `@cf/cloudflare/clef-flash`; OpenRouter `cloudflare/clef-flash` | Cloudflare direct: около $0.038/M input; цена на OpenRouter зависит от провайдера и промо (примерно $0.019–$0.038/M на дату проверки). Самая низкая цена — промо и может исчезнуть. При прямом запуске в Workers AI расходует общую квоту 10 000 Neurons/day. |
| Clef Omni (44) | Cloudflare `@cf/cloudflare/clef-omni`; OpenRouter `cloudflare/clef-omni` | Около $0.15/M input. В публичном каталоге Vercel не найден. При прямом запуске в Workers AI расходует общую квоту 10 000 Neurons/day. |

`M` означает миллион токенов. Значения указаны для маршрута/провайдера, где доступна опубликованная цена; OpenRouter может направлять запрос к разным провайдерам с разными ценами и ограничениями. Отсутствие модели в публичном каталоге не исключает частные или будущие интеграции.

## Ранжирование для начального fallback

Порядок ниже повторяет баллы на приложенной диаграмме Artificial Analysis; это не новая независимая оценка качества. Модели с равными баллами оставлены в визуальном порядке диаграммы.

| Уровень | Порядок | Модель | Балл |
|---|---:|---|---:|
| S | 1 | `ai-ultra` (вероятно, Liquid AI `d1-ultra`) | 65 |
| A | 2 | Jev 1.14 | 57 |
| B | 3 | GLiDE | 54 |
| B | 4 | Microsoft Decision-1 | 54 |
| C | 5 | Decider V1.1 27B (вероятное соответствие `Decider V1.27B`) | 53 |
| C | 6 | Mercury Decide | 53 |
| C | 7 | Celeris-1 Decision | 52 |
| C | 8 | d1 | 50 |
| D | 9 | Clef | 49 |
| D | 10 | GPT-6 Luna Decisions | 48 |
| D | 11 | Clef Flash | 46 |
| D | 12 | Clef Omni | 44 |

Используйте этот список как начальную сортировку fallback. Перед фиксацией порядка проверьте качество на своём наборе решений, фактическую доступность API, задержку, стоимость и поведение при отказе. Баллы взяты с пользовательской диаграммы, а не пересчитаны в рамках этой заметки.

## Источники

### Общие лимиты и планы

- [OpenRouter: pricing и лимиты бесплатных маршрутов](https://openrouter.ai/pricing)
- [OpenRouter: free model variant](https://openrouter.ai/docs/guides/routing/model-variants/free)
- [OpenRouter: Mercury Decide free SKU](https://openrouter.ai/inception/mercury-decide:free)
- [Vercel AI Gateway: pricing и ежемесячный командный кредит](https://vercel.com/docs/ai-gateway/pricing)
- [Vercel AI Gateway: каталог decision-моделей с колонкой Free AI Gateway Credit](https://vercel.com/ai-gateway/models?capabilities=decision)
- [Vercel AI Gateway: rate limits](https://vercel.com/docs/ai-gateway/rate-limits)
- [Cloudflare Workers AI: pricing, дневные Neurons и оплата сверх лимита](https://developers.cloudflare.com/workers-ai/platform/pricing/)
- [Cloudflare: Workers Paid за $5 в месяц сохраняет дневные 10 000 Neurons](https://developers.cloudflare.com/changelog/post/2026-07-28-models-require-workers-paid/)
- [Cloudflare AI Gateway: цены базовых функций](https://developers.cloudflare.com/ai-gateway/reference/pricing/)
- [Cloudflare Workers AI: ошибка исчерпания дневной квоты](https://developers.cloudflare.com/workers-ai/platform/errors/)

### Карточки моделей и тарифы

- [Liquid AI d1-ultra на OpenRouter](https://openrouter.ai/liquid/d1-ultra) · [Vercel](https://vercel.com/ai-gateway/models/d1-ultra) · [Liquid AI pricing](https://www.liquid.ai/pricing)
- [Jev 1.14 на OpenRouter](https://openrouter.ai/typesafe/jev-1.14) · [Vercel](https://vercel.com/ai-gateway/models/jev-1.14.0)
- [Fastino pricing](https://docs.fastino.ai/pricing) · [Fastino inference docs](https://docs.fastino.ai/inference/systemone)
- [Microsoft Decision-1 на OpenRouter](https://openrouter.ai/microsoft/microsoft-decision-1) · [Vercel](https://vercel.com/ai-gateway/models/microsoft-decision-1) · [Microsoft announcement/pricing](https://commandline.microsoft.com/microsoft-decision-1-model-foundry/)
- [Perplexity Decider V1.1 27B на OpenRouter](https://openrouter.ai/perplexity/pplx-decider-v1.1-27b) · [Vercel](https://vercel.com/ai-gateway/models/pplx-decider-v1.1-27b)
- [Mercury Decide paid SKU](https://openrouter.ai/inception/mercury-decide) · [Mercury Decide free SKU](https://openrouter.ai/inception/mercury-decide:free)
- [Celeris Decisions](https://celeris.ai/decisions) · [Celeris pricing](https://docs.celeris.ai/pricing) · [rate limits](https://docs.celeris.ai/rate-limits)
- [Liquid AI d1 на OpenRouter](https://openrouter.ai/liquid/d1) · [Vercel](https://vercel.com/ai-gateway/models/d1)
- [Cloudflare Clef на OpenRouter](https://openrouter.ai/cloudflare/clef) · [Workers AI pricing](https://developers.cloudflare.com/workers-ai/platform/pricing/)
- [GPT-6 Luna Decisions на OpenRouter](https://openrouter.ai/openai/gpt-6-luna-decisions) · [Vercel](https://vercel.com/ai-gateway/models/gpt-6-luna-decisions) · [OpenAI Decisions guide](https://developers.openai.com/api/docs/guides/decisions)
- [Cloudflare Clef Flash на OpenRouter](https://openrouter.ai/cloudflare/clef-flash) · [Cloudflare changelog/pricing update](https://developers.cloudflare.com/changelog/2/)
- [Cloudflare Clef Omni на OpenRouter](https://openrouter.ai/cloudflare/clef-omni) · [Cloudflare model page](https://developers.cloudflare.com/workers-ai/models/clef-omni/)
