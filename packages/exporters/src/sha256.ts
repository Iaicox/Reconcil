/**
 * Content hashing for the audit manifest (P2): every emitted file records a
 * sha256 so a downstream consumer can prove the artifact is the one the manifest
 * describes. Deterministic — strings hash as UTF-8.
 */
import { createHash } from 'node:crypto';

export function sha256(content: string | Uint8Array): string {
  return createHash('sha256').update(content).digest('hex');
}
