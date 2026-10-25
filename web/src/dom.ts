/** @fileoverview DOM helpers shared by the page's modules. */

/** Returns the element for `selector`; throws if the markup doesn't have it (a bug). */
export function requireElement<T extends Element = HTMLElement>(
  root: ParentNode,
  selector: string,
): T {
  const el = root.querySelector<T>(selector);
  if (!el) throw new Error(`missing element ${selector}`);
  return el;
}
