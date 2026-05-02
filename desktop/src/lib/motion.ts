import type { Variants } from "framer-motion";

/**
 * S33 (2026-05-01) — shared Framer Motion presets.
 *
 * The presets here are the only ones screens / components should reach
 * for. They map onto the `--duration-fast | --duration-medium | --easing-out`
 * tokens declared in `globals.css`, so a reduced-motion user automatically
 * collapses to no-op transitions through the global CSS override.
 *
 * Reference patterns (`specs/linear-ux-reference/README.md` § Microinteractions):
 *   - "Hover: bg opacity change ONLY (no scale, no shadow, no rotate)"
 *   - "Click: bg darkens slightly more"
 *   - "Transitions: 150ms cubic-bezier(0.16, 1, 0.3, 1) on bg / opacity / transform"
 *   - "Page enter: fadeIn 200ms"
 */

/** Linear's "ease-out" curve — matches the `--easing-out` CSS var. */
const EASE_OUT = [0.16, 1, 0.3, 1] as const;

const DURATION_FAST = 0.15;
const DURATION_MEDIUM = 0.20;

/** Plain fade — for page transitions, modal opens, simple reveals. */
export const fadeIn: Variants = {
  initial: { opacity: 0 },
  animate: { opacity: 1, transition: { duration: DURATION_MEDIUM, ease: EASE_OUT } },
  exit:    { opacity: 0, transition: { duration: DURATION_FAST,   ease: EASE_OUT } },
};

/** Slide in from right + fade — for popovers, side panels, list-item enter. */
export const slideInRight: Variants = {
  initial: { opacity: 0, x: 20 },
  animate: { opacity: 1, x: 0, transition: { duration: DURATION_MEDIUM, ease: EASE_OUT } },
  exit:    { opacity: 0, x: 20, transition: { duration: DURATION_FAST,  ease: EASE_OUT } },
};

/** Slide up from below + fade — toast entrances. */
export const slideUp: Variants = {
  initial: { opacity: 0, y: 8 },
  animate: { opacity: 1, y: 0, transition: { duration: DURATION_MEDIUM, ease: EASE_OUT } },
  exit:    { opacity: 0, y: 8, transition: { duration: DURATION_FAST,   ease: EASE_OUT } },
};

/** Tab/route content swap — quick small-y shift + fade. */
export const pageEnter: Variants = {
  initial: { opacity: 0, y: 4 },
  animate: { opacity: 1, y: 0, transition: { duration: DURATION_MEDIUM, ease: EASE_OUT } },
  exit:    { opacity: 0, y: -4, transition: { duration: DURATION_FAST,  ease: EASE_OUT } },
};

/**
 * Stagger preset — apply to a parent container so its children animate in
 * one after the other. Pair with `fadeIn` or `slideInRight` on each child.
 *
 *   <motion.ul variants={stagger} initial="initial" animate="animate">
 *     {items.map(...) => (
 *       <motion.li key={...} variants={fadeIn}>...
 *     )}
 *   </motion.ul>
 */
export const stagger: Variants = {
  initial: {},
  animate: {
    transition: {
      staggerChildren: 0.03,
      delayChildren: 0.02,
    },
  },
};

/**
 * Hover lift — bg/opacity ONLY (no scale, no shadow). Use for hoverable
 * tiles where you want a subtle "lift" without violating the Linear
 * anti-pattern rule. Drives a `whileHover` Framer prop, NOT a variants
 * lookup.
 */
export const hoverLift = {
  whileHover: { backgroundColor: "var(--card-elevated)" },
  transition: { duration: DURATION_FAST, ease: EASE_OUT },
};
