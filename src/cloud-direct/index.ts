/**
 * Public surface of the cloud-direct client: the three Cognition RPCs the
 * provider needs (`GetUserJwt`, `GetCascadeModelConfigs`, `GetChatMessage`).
 */

export { streamChatEvents } from './chat.js';
export { CloudChatError } from './types.js';
export type {
  ChatHistoryItem,
  CloudChatEvent,
  CloudChatRequest,
  CompletionOptions,
  ContentPart,
  ToolCallRef,
  ToolDef,
} from './types.js';

export { getCachedUserJwt, clearCachedUserJwt, CloudAuthError } from './auth.js';

export {
  getCachedCatalog,
  clearCachedCatalog,
  ModelNotAvailableError,
  type ModelCatalog,
  type ModelCatalogEntry,
} from './catalog.js';

export {
  getCachedQuota,
  clearCachedQuota,
  parseUserStatusResponse,
  type DevinQuota,
} from './quota.js';

export { DEFAULT_HOST, decodeJwtPayload } from './utils.js';
