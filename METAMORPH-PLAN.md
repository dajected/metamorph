# Metamorph Product Plan

## Product Purpose

Metamorph tracks irreversible transformation progress during a SillyTavern chat. It maintains multiple numeric stats within one ordered hierarchy and injects exactly one active tier key into context. SillyTavern World Info uses that key to decide which transformation possibilities the character model may portray.

Metamorph does not select, offer, or apply individual transformation changes.

## State Model

- One ordered tier hierarchy per tracker
- One or more monotonic stats
- Exactly one active tier: the highest ordered tier whose conditions all pass
- All conditions on a tier must be satisfied
- Passed tiers remain passed because stats cannot decrease
- Only reset may return stats to their defaults
- Each tier provides one unique World Info activation key

Tier ranges are represented by cumulative lower thresholds. For example:

- Tier 1: no conditions, effectively below 10
- Tier 2: `vanity >= 10`, effectively 10–19
- Tier 3: `vanity >= 20`, effectively 20–29
- Tier 4: `vanity >= 30`

Explicit upper bounds are unnecessary because the highest satisfied tier wins.

## Judge Model

The judge is a new-change detector.

- Scan only the latest assistant message
- Compare against compact internal counted-change memory
- Count only concrete changes first established in that message
- Do not count repetitions, continued traits, intentions, hypotheticals, or comments about existing changes
- Record every distinct new change for future deduplication
- Add exactly one point to each affected stat
- Add at most one point per stat per assistant message
- Allow one change to affect multiple stats
- Never return or apply negative values
- Make repeated processing of the same unchanged message idempotent

The counted-change memory is available in a collapsed troubleshooting section, not a recent-history feed.

## World Info Integration

Metamorph injects two compact context blocks:

- The current tier's exact `world_info_key`, with World Info scanning enabled
- Active counted changes as established character facts, with World Info scanning disabled

Raw stat values and the tier label are not sent to the character model. They remain available to the helper judge and sidebar. Only the active tier key participates in World Info scanning, so only entries keyed to that tier are eligible through Metamorph. Each tier's World Info entry should therefore contain the cumulative permissions still available at that tier.

## Sidebar Layout

1. Header and close control
2. Tracker identity, subject, judge/context statuses, and primary actions
3. Current-tier card with label, description, and World Info key
4. Stat progress bars measured against each next-tier threshold
5. Next-tier conditions with met/unmet indicators
6. Compact hierarchy showing Passed, Active, and Locked tiers
7. Collapsed context preview
8. Collapsed counted-change memory with controls for excluding superseded facts from character context
9. Collapsed tracker controls

The sidebar contains no available changes, embedded lore, effects, undo, or recent history.

## Setup Editor

The focused setup schema contains:

- Description, with identity and version managed internally
- Stats
- Ordered tiers
- Tier World Info keys
- Tier conditions using `>=` or `>`
- Per-stat judge guidance

The editor uses form-based stat, tier, and condition builders. Users can add, remove, and configure the full hierarchy without editing JSON. One save action applies the setup to the current chat and updates its reusable library entry. JSON remains only as an optional import/export format.

## Migration

Schema version 3 removes:

- Fictional time and day parts
- Autonomy and narrative beats
- Embedded tier lore
- Options and available changes
- Effects and appearance layers
- Applied changes and undo
- Recent event history
- Simultaneously active tiers

Schema version 4 removes setup-wide judge guidance. Internal setup identity and version fields remain in the schema but are no longer exposed in the UI.

Existing stat progress is preserved when the setup ID remains unchanged.

## Acceptance Criteria

- Exactly one tier is active at every configured point in the hierarchy
- A tier activates only after all its conditions pass
- Stats cannot be lowered manually or by the judge
- One assistant message can add no more than one point to any stat
- A message can add one point to several stats
- Repeated changes do not increment stats again
- Rejudging an unchanged message is idempotent
- Only the active tier key appears in the World Info-scannable block
- Established changes are injected separately and excluded from World Info scanning
- No change-selection or history UI remains
- Desktop sidebar and mobile bottom sheet remain usable and accessible
