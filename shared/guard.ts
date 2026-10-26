export const guardRegistry = 'https://npm.flatt.tech/';

export type GuardState = 'configured' | 'available' | 'blocked' | 'unsupported';

// The status never carries .npmrc contents, registry URLs found in it, or credentials.
export type GuardStatus = { state: GuardState; message: string; revision: string; warnings: string[] };

export type GuardApplyResult = GuardStatus & { backup?: string };
