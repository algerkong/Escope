import type { ModelProtocol } from './models';

export const MAX_DISCOVERED_MODELS = 512;

/** Secret changes are separate from metadata; omission in save means keep. */
export type ModelCredentialChange =
  | { kind: 'keep' }
  | { kind: 'clear' }
  | { kind: 'replace'; apiKey: string };

/** Stored keys may only be used for their existing saved endpoint and protocol. */
export type ModelDiscoveryCredential =
  | { kind: 'none' }
  | { kind: 'stored'; modelProfileId: string }
  | { kind: 'provided'; apiKey: string };

export interface ModelDiscoveryRequest {
  requestId: string;
  protocol: ModelProtocol;
  endpoint: string;
  credential: ModelDiscoveryCredential;
}

export interface ModelDiscoveryResponse {
  requestId: string;
  protocol: ModelProtocol;
  endpoint: string;
  modelIds: string[];
  truncated: boolean;
}
