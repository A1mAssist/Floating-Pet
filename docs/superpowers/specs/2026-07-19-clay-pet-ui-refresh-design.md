# Clay Pet UI Refresh Design

## Goal

Make the Electron window read as a desktop pet first and a utility second, using a restrained high-fidelity clay material while preserving every existing behavior.

## Direction

Use a pet-anchored composition: assistance and settings surfaces grow from the pet's upper-left, while quick controls form a compact clay tray beside its base. The pet remains the strongest visual element.

The visual language uses cool lavender-white surfaces, soft charcoal text, violet primary actions, and the pet's teal/coral accents. Depth comes from four-part light/shadow stacks rather than gradients. Inputs and selected controls are recessed; buttons and message bubbles are raised.

## Scope

- Modify only `desktop/src/renderer/styles.css`.
- Preserve all HTML, JavaScript, IPC, state, copy, and media behavior.
- Preserve every ID, class, data attribute, focus path, and test hook.
- Use installed/system assets and fonts; add no dependency or remote font.
- Keep the transparent desktop canvas; add no landing-page blobs or full-window background.

## Components

### Pet and status

The pet stays at the lower-right with a softer, colored grounding shadow. Status becomes a compact pill visually attached above the pet rather than a detached debug label.

### Assistance and settings

Large surfaces use 26px outer radii, a subtle lavender tint, and restrained multi-layer shadows. The assistance card narrows and aligns toward the pet. A CSS tail connects temporary speech surfaces to their source. Settings remain scrollable at both `460×640` and `390×640`.

### Conversation

Assistant messages become raised white clay bubbles; user messages become recessed lavender bubbles. Sender labels remain visible but quiet. The composer is recessed, while Send is the single saturated action.

### Controls

Quick controls use a rounded clay tray. Buttons meet a 44px target, lift slightly on hover, and depress with inset shadows on press. Violet denotes the primary action; neutral controls do not compete with the pet.

## Motion and Accessibility

- Preserve pointer tracking, velocity handoff, edge snapping, transform origins, and keyboard-specific zero-motion behavior.
- Preserve `prefers-reduced-motion`, `prefers-reduced-transparency`, and `prefers-contrast` fallbacks.
- Keep visible focus rings and accessible text contrast.
- Do not use `transition: all`, `ease-in`, `scale(0)`, `linear-gradient`, or `radial-gradient`.

## Verification

Run `npm run check`, `npm run test:unit`, and `npm run test:e2e`. Inspect the generated `desktop/release-preview.png` at original resolution, then attack the design for hierarchy, clipping, contrast, shadow dirtiness, and pet/control separation before finalizing.
