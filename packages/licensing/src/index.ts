/**
 * Placeholder API until the Lemon Squeezy client lands (Phase 2, see README.md).
 * Extensions may already call `getEntitlements()`; it resolves to the free tier.
 */
export interface Entitlements {
  readonly pro: boolean;
}

export const FREE_ENTITLEMENTS: Readonly<Entitlements> = Object.freeze({ pro: false });

export async function getEntitlements(): Promise<Entitlements> {
  return { ...FREE_ENTITLEMENTS };
}
