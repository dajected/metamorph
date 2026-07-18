# Metamorph

[Project site](https://dajected.github.io/metamorph/) · [Download latest main](https://github.com/dajected/metamorph/archive/refs/heads/main.zip)

Metamorph is a SillyTavern extension that tracks irreversible transformation progress and exposes exactly one active tier to SillyTavern World Info.

It does not decide or apply individual transformation changes. The character model makes those choices using World Info entries activated by the current tier key.

## How It Works

1. A setup defines one ordered tier hierarchy and one or more stats.
2. The helper judge scans only the latest assistant message for concrete transformation changes that have not been counted before.
3. Each affected stat increases by exactly one point, with a maximum of one point per stat per assistant message.
4. A new change may increment several stats when appropriate.
5. Metamorph selects the highest tier whose conditions are all satisfied.
6. Only that tier's World Info key is injected into context.
7. SillyTavern scans the injected key and activates matching World Info entries.

Stats never decrease. Resetting the tracker is the only way to return to lower values.

## Sidebar

The sidebar shows:

- Tracker name, subject, judge status, and context status
- The single current tier and its World Info key
- Monotonic stat progress toward the next relevant threshold
- Every condition for the next tier, with met/unmet status
- The complete hierarchy marked Passed, Active, or Locked
- Collapsed context preview and counted-change memory
- Collapsed reset and stop controls

It intentionally has no available-changes, active-lore, effects, undo, or recent-history sections.

## World Info Setup

Each hierarchy tier has a unique `world_info_key`, for example:

```text
METAMORPH_TIER_2
```

Use that exact value as a primary key on the SillyTavern World Info entries that belong to Tier 2. Metamorph registers its context block with World Info scanning enabled, so the current key participates in the normal SillyTavern World Info scan.

Only the current tier's key is injected. Passed and locked tier keys are omitted.

## Judge Rules

The judge receives:

- The latest assistant message only
- Stat definitions and judge guidance
- A compact memory of changes already counted

The default judge uses SillyTavern's raw-generation API, so previous chat messages, World Info, and Author's Note are not added to the judging request. A selected Connection Manager profile likewise receives only the constructed judge prompt.

A qualifying change must be concrete, newly established in the latest assistant message, and relevant to the stat. Repeated descriptions, continuing traits, intentions, hypotheticals, and comments about existing changes do not count.

The engine, not the judge, enforces:

- `+1` exactly for each affected stat
- Maximum `+1` per stat per message
- No negative or variable-sized changes
- Idempotency for an unchanged assistant message
- Exact normalized duplicate rejection
- Monotonic stat values

Semantic duplicate detection is instructed through the judge prompt using the stored counted-change memory.

## Setup Schema

```json
{
  "id": "vanity-progression",
  "name": "Vanity Progression",
  "version": "1.0.0",
  "schema_version": 3,
  "description": "Example setup",
  "stats": [
    {
      "key": "vanity",
      "label": "Vanity",
      "min": 0,
      "max": 30,
      "default": 0,
      "description": "What this stat represents.",
      "judge_guidance": "What qualifies as a new change."
    }
  ],
  "tiers": [
    {
      "id": "tier_1",
      "label": "Tier 1",
      "description": "Starting tier",
      "world_info_key": "METAMORPH_TIER_1",
      "requires": []
    },
    {
      "id": "tier_2",
      "label": "Tier 2",
      "description": "Second tier",
      "world_info_key": "METAMORPH_TIER_2",
      "requires": [
        { "stat": "vanity", "op": ">=", "value": 10 }
      ]
    }
  ],
  "judge": {
    "prompt_guidance": "Optional setup-wide judging guidance."
  }
}
```

Tiers are evaluated in array order. The highest tier whose conditions all pass is active. Because stats only increase, tier conditions support only `>=` and `>`.

The first tier should normally have no conditions. Later tiers should contain cumulative thresholds; upper bounds are unnecessary because a later satisfied tier replaces the earlier one.

## Installation

Copy the `metamorph` folder to:

```text
public/scripts/extensions/third-party/metamorph/
```

Reload SillyTavern and enable **Metamorph** under **Manage Extensions**.

Requirements:

- SillyTavern 1.18.0 or later
- A one-on-one character chat
- An existing SillyTavern API connection when helper judging is enabled

No API keys are stored by Metamorph.

## Development

```text
npm run verify
```

This runs syntax checks and the deterministic engine test suite.

## Migration

Schema versions 1 and 2 are migrated to schema version 3. Existing stat values are preserved and clamped to the current stat definitions. Time, autonomy, beats, embedded tier lore, options, effects, applied changes, undo data, and event history are removed.

Existing settings stored under the former extension key are migrated to `metamorph`.
