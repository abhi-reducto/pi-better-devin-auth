/**
 * `exa.codeium_common_pb.Metadata` protobuf builder.
 */

import * as crypto from 'node:crypto';
import { encodeMessage, encodeString, encodeTimestampBody, encodeVarintField } from './wire.js';

/**
 * Cognition rejects unknown version strings with `failed_precondition`.
 * Keep pinned to a known-good Windsurf version.
 */
const WINDSURF_VERSION = '2.0.0';

export interface MetadataInput {
  apiKey: string;
  userJwt?: string;
  /** Stable per conversation; a random one is used when omitted. */
  sessionId?: string;
}

function osName(): string {
  return process.platform === 'win32' ? 'windows' : process.platform;
}

export function buildMetadata(input: MetadataInput): Buffer {
  const parts: Buffer[] = [
    encodeString(1, 'windsurf'), // ide_name
    encodeString(2, WINDSURF_VERSION), // extension_version
    encodeString(3, input.apiKey), // api_key
    encodeString(4, 'en'), // locale
    encodeString(5, osName()), // os
    encodeString(7, WINDSURF_VERSION), // ide_version
    encodeVarintField(9, BigInt(Date.now())), // request_id
    encodeString(10, input.sessionId ?? crypto.randomUUID()), // session_id
    encodeString(12, 'windsurf'), // extension_name
    encodeMessage(16, encodeTimestampBody()), // ls_timestamp
    encodeString(25, crypto.randomUUID()), // trigger_id
    encodeString(26, 'Unset'), // plan_name
    encodeString(28, 'windsurf'), // ide_type
  ];
  if (input.userJwt) parts.push(encodeString(21, input.userJwt));
  return Buffer.concat(parts);
}
