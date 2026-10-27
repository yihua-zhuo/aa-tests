import type { SessionUser, TokenScope } from '../shared/types.ts';

export type AppEnv = {
  Variables: {
    reqId: string;
    user?: SessionUser;
    sessionHash?: string;
    authKind?: 'session' | 'token';
    tokenId?: string;
    tokenScopes?: TokenScope[];
  };
};
