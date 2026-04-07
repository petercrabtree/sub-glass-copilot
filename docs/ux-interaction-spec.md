# SubGlass UX Interaction Spec

## Purpose

SubGlass should feel like sitting at a media light table: the content is central, the controls live at the edges, and the UI wakes up when invited instead of constantly asking for attention.

The current app has good ingredients, but the interaction model is fragmented. Different surfaces hide and reveal themselves independently, mouse movement does too much, and hover sometimes behaves like a prediction engine instead of a simple affordance. This document defines the intended UX story, with special focus on mouse interactions and mouseover behavior.

## Product Story

SubGlass is not a dashboard first. It is an immersive viewer with a quiet cockpit around it.

That means:

- The media canvas is the hero.
- Controls are discoverable, but they should feel calm and spatially reliable.
- Hover should reveal information, not create surprise.
- Click should commit actions.
- Keyboard, mouse, and focus should all point at the same interaction model.

The right mood is "confident and legible", not "mysterious but clever".

## Core Principles

### 1. One movement, one meaning

Pointer movement should not simultaneously:

- wake hidden chrome
- select a likely navigation target
- pause or reset auto-next
- open helper UI

Each of those is a different kind of intent and should have a different trigger.

### 2. Hover previews, click commits

Hover is for:

- revealing dormant UI
- highlighting an already-existing target
- showing lightweight explanatory detail

Hover is not for:

- changing selection
- switching modes
- advancing media
- inferring a command from pointer proximity alone

### 3. Critical actions must not depend on hover

If an action matters for normal use, it should remain reachable when the user:

- never hovers
- uses keyboard only
- uses focus navigation
- is on a coarse pointer device

Hover can enrich a control, but it must not be the only way to discover or use it.

### 4. Controls need stable anchors

A control can fade, dim, or expand, but it should not slide out from under the cursor or change meaning because the pointer passed nearby.

Stable spatial memory matters more than clever motion.

### 5. Secondary UI should behave like family

Top bar, context card, auto-next controls, legends, and debug tools should share one reveal model instead of each inventing its own hover rules.

### 6. Browse surfaces and utility surfaces have different posture

Viewer routes are immersive and can use compact/dormant chrome.

Discover and admin routes are utility pages. Their actions should stay visible and behave like a straightforward app, not like an ambient overlay.

## Interaction States

All viewer chrome should follow the same four-state model.

### Idle

- Media is dominant.
- Primary chrome remains in a compact, low-noise form.
- The user can still tell where navigation and controls live.
- Nothing is fully "mystery hidden".

### Awake

- Triggered by pointer entering the viewer, a click on the canvas, keyboard activity, or focus entering a control surface.
- Primary chrome becomes legible.
- No action is preselected yet.

### Engaged

- Triggered by hovering or focusing an actual interactive region.
- Only the engaged surface highlights.
- Auto-next pauses only if the engaged surface would conflict with pacing.

### Pinned

- Triggered by opening a settings panel, help panel, or debug panel.
- That surface stays open until the user dismisses it, clicks away, or moves focus away.
- Pinned UI should not collapse just because the user slightly misses the trigger on the next mouse move.

## Surface Hierarchy

The viewer should present four predictable layers.

### 1. Canvas

The media itself. It should never feel like invisible controls are scattered across it.

### 2. Primary viewer chrome

The always-relevant controls:

- top bar
- context dock
- primary navigation gutters

### 3. Secondary inspect surfaces

Helpful but nonessential UI:

- keyboard legend
- loaded-media legend
- auto-next settings

### 4. Tertiary developer surfaces

Useful in development, but visually and behaviorally separate:

- debug dock
- admin route tools

## Mouse Interaction Model

### Global Mouse Rules

- Mouseover should reveal surfaces, not choose actions.
- Hover feedback should appear only when the pointer is inside the target's actual hit area.
- `mousemove` should not be the default reveal mechanism for ordinary UI.
- Continuous pointer tracking is appropriate only for genuinely continuous behaviors.
- Surface reveal should usually be driven by `mouseenter` / `mouseleave` or equivalent pointer/focus events.
- Any compact-to-expanded transition should preserve hit area continuity while the user moves within that surface.

### Auto-Next Rules

The current behavior treats almost any mouse movement as a signal to reset pacing. That makes the app feel jittery and overreactive.

The intended behavior is:

- Moving the mouse across empty canvas wakes UI, but does not reset or pause auto-next by itself.
- Hovering an actual interactive control pauses auto-next.
- Opening a panel or settings surface pauses auto-next.
- Using scroll, scrubbing video controls, or focusing a field pauses auto-next.
- Leaving controls resumes auto-next after a short grace period, not instantly.

Presence is not the same thing as intent.

### Mouseover Rules By Surface

#### Viewer Canvas

Hovering empty canvas should do one thing: wake the primary chrome.

It should not:

- infer a nearest navigation command
- highlight a corner target from a distance
- change the current post
- reset auto-next on every small movement

Center canvas is for looking, not for guessing.

#### Navigation Gutters

Fill and wild modes should use explicit edge gutters instead of proximity-based zone selection.

Recommended layout:

- left gutter: previous post
- right gutter: next post
- top gutter: previous gallery item, only when gallery navigation exists
- bottom gutter: next gallery item, only when gallery navigation exists
- center: no navigation command

Important rules:

- Corners do not invent combined actions.
- Top and bottom gutters should not silently fall back to post navigation when a gallery is absent.
- Hovering a gutter highlights only that gutter.
- Clicking commits the action.
- Labels and arrows appear in stable positions inside the gutter.

This gives the mouse a readable map instead of a predictive field.

#### Top Bar

The top bar should always have a compact presence in viewer routes.

Compact state:

- logo
- current path or subreddit
- current mode indicator

Expanded state:

- path form
- navigation links
- display mode switcher

Rules:

- Hovering the top bar expands it.
- Moving between its children should not collapse it.
- Leaving the bar compacts it after a short delay.
- Discover and admin should keep the bar fully visible rather than using viewer-style concealment.

The top bar should feel like a cockpit shelf, not a startled animal.

#### Context Dock

Viewer routes should use one bottom-left context dock as the source of truth for:

- current title
- subreddit and metadata
- rating actions
- outbound actions
- mode or state kicker

Rules:

- Compact state keeps the kicker, title, and at least the primary actions visible.
- Hover or focus expands detail density.
- Hover should never make the title or primary actions disappear.
- Scroll, masonry, and wild modes should use the same context dock family, even if the styling differs slightly.

The user should learn one place for "what am I looking at and what can I do with it?"

#### Pace Dock

Auto-next belongs in its own dock, but it should behave like a sibling of the context dock.

Rules:

- Compact state always shows that pacing exists.
- Hover or click reveals detailed timing and settings.
- Entering the dock pauses pacing.
- Leaving the dock resumes after a grace period.
- The dock should not become more hidden just because some unrelated surface is not hovered.

The user should feel they can inspect pacing without racing against it.

#### Secondary Popovers

Help, shortcut, and legend surfaces should not rely on fragile hover-only timing.

Rules:

- Click and focus must open them reliably.
- Fine-pointer hover may preview them after a small delay.
- Once open, the user can move into the panel without it collapsing.
- Click-away, `Escape`, or leaving both trigger and panel closes them.
- Panels are informational and should not block neighboring primary controls.

If a panel is worth rendering, it is worth making stable.

#### Debug Dock

The debug dock should behave like a tertiary tool:

- always available in dev
- visually quieter than primary chrome
- easy to expand intentionally
- never competing with media navigation for attention

Compacting is fine here, but it should use the same compact/expanded logic as other docks instead of a completely different hover personality.

## Mode-Specific Behavior

### Fill Mode

This is the clearest expression of the product.

Expected mouse behavior:

- moving over the viewer wakes chrome
- moving into left or right gutter previews previous or next post
- moving into top or bottom gutter previews gallery navigation only when available
- moving across center canvas keeps the content clean
- clicking center canvas toggles chrome only if a direct canvas click behavior is needed
- video controls count as explicit engagement

Fill mode should feel deliberate and quiet, almost like a gallery kiosk.

### Scroll Mode

Scroll mode is a browsing mode, not an overlay mode.

Expected mouse behavior:

- scroll wheel or trackpad is the primary navigation
- hovering a slide may enrich metadata presentation
- the active slide is determined by viewport position, not by hover
- clicking a slide selects it
- context dock mirrors the active slide
- no hidden edge navigation should compete with the scroll gesture

### Masonry Mode

Masonry is exploratory and should be spatially playful, but the control rules still need to stay sane.

Expected mouse behavior:

- hovering a tile can elevate it and reveal its caption
- hover does not change the current selection by itself
- clicking a tile selects it
- auto-scroll pauses on explicit engagement
- auto-scroll resumes only after the user has clearly left the wall alone

Hover should preview, not hijack.

### Wild Modes

Wild modes can be expressive visually, but they should not be wild behaviorally.

Expected mouse behavior:

- peripheral cards behave like browse targets
- hovering a card lifts it and reveals its caption
- clicking a card selects it
- primary navigation still comes from explicit edge gutters and the shared context dock
- decorative motion never changes hit target placement

Wild should mean bold composition, not unpredictable controls.

## Discover And Admin

These routes should share the visual language of SubGlass but not the immersive conceal/reveal behavior.

Expected behavior:

- actions remain plainly visible
- row hover provides emphasis only
- tabs, buttons, and links do not depend on reveal states
- layout does not jump when hovered
- shared shell elements can be styled consistently with viewer chrome, but should behave like conventional application UI

The viewer can be cinematic. Utility pages should be honest.

## Mouseover Anti-Patterns To Avoid

- No distance-based "nearest action" highlighting.
- No surfaces that fully disappear when the pointer is still traveling within their neighborhood.
- No hover state that changes the meaning of a region before click.
- No essential popover that closes when the user tries to enter it.
- No timer reset tied to generic mouse jitter.
- No essential action available only through hover reveal.
- No layout shift caused purely by hover.
- No separate reveal logic for top bar, context dock, pace dock, and debug dock unless there is a strong reason.

## Recommended Event Strategy

This is not implementation code, but it should guide implementation choices.

- Use `mouseenter` / `mouseleave` or pointer equivalents for surface reveal.
- Use `focusin` / `focusout` for keyboard parity.
- Use `mousemove` only when the behavior truly depends on continuous position.
- Use one shared viewer idle timer for compacting primary chrome.
- Use explicit open/close state for popovers and panels.
- Keep hover state local to the surface being hovered.

If an interaction can be expressed without high-frequency pointer tracking, it probably should be.

## Current Mismatches This Spec Is Meant To Resolve

- Viewer mouse movement currently acts like both wake-up signal and pacing control.
- Navigation affordance is partly proximity-based, which makes the UI feel like it is guessing.
- Top bar, selection card, auto-next dock, and debug dock each compact independently, so the viewer reads as multiple unrelated chrome islands.
- Some secondary information is hover-fragile instead of feeling intentionally inspectable.
- Discover and admin already behave like straightforward app pages, while the viewer behaves like a set of ambient overlays; the gap is larger than it needs to be.

## Acceptance Criteria

This document is working if a future implementation produces the following:

- A new user can predict what hover will do before trying it.
- Moving the mouse across the viewer never feels like issuing an accidental command.
- Every viewer surface has a compact state and an expanded state, but the rules feel shared.
- Auto-next feels calm and fair rather than eager or defensive.
- Fill, scroll, masonry, and wild modes feel like members of one product family.
- Discover and admin feel simpler, but still recognizably part of SubGlass.

## Implementation Priority

If this is implemented incrementally, the highest-value order is:

1. Replace proximity-based navigation inference with explicit gutters.
2. Stop resetting auto-next from generic viewer mouse movement.
3. Unify top bar, context dock, and auto-next dock under one compact/expanded state model.
4. Make help and legend surfaces stable on hover, focus, and click.
5. Keep utility routes visually aligned, but behaviorally conventional.

That sequence should remove most of the "discombobulated" feeling before any visual polish work starts.
