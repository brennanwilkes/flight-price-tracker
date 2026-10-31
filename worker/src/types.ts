// Worker bindings and shared shapes.

export interface Env {
  PUSH: KVNamespace;
  NOTIFY_SECRET: string;       // secret: bearer token GitHub Actions sends to /notify
  VAPID_PRIVATE_KEY: string;   // secret: JWK `d`, base64url, no trailing newline
  GH_DISPATCH_TOKEN: string;   // secret: fine-grained PAT, Actions:write on the repo
  VAPID_PUBLIC_KEY: string;    // var: 65-byte uncompressed P-256 point, base64url
}

export interface Health {
  lastPushAt: string | null;
  lastPushStatus: number | null;
  lastError: string | null;
  lastErrorAt: string | null;
  subscribed: boolean;
}
